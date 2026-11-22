import { nearestTideStation } from "./_lib/tide-stations.js";

const KHOA_PRE_TAB =
  "https://www.khoa.go.kr/api/oceangrid/tideObsPreTab/search.do";
const KHOA_PRE_TAB_ALT =
  "https://www.khoa.go.kr/oceangrid/grid/api/tideObsPreTab/search.do";
const DATA_GO_HL =
  "https://apis.data.go.kr/1192136/tideFcstHghLw/GetTideFcstHghLwApiService";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const date = String(req.query.date || "").replace(/-/g, "");

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || date.length !== 8) {
    res.status(400).json({ error: "invalid_params", need: "lat, lon, date(YYYYMMDD)" });
    return;
  }

  const serviceKey = (process.env.KHOA_SERVICE_KEY || process.env.DATA_GO_KR_SERVICE_KEY || "").trim();
  const { station, distanceKm } = nearestTideStation(lat, lon);

  if (!serviceKey) {
    res.status(200).json({
      configured: false,
      station,
      distanceKm,
      message: "KHOA_SERVICE_KEY 환경 변수를 Vercel에 설정하면 조석 예보를 불러옵니다.",
      items: []
    });
    return;
  }

  const base = { station, distanceKm, date, configured: true };

  try {
    const pre = await fetchKhoaPreTab(serviceKey, station.code, date);
    if (pre.ok) {
      const direct = pre.items;
      const typed = direct.filter((i) => i.type === "high" || i.type === "low");
      const items = typed.length ? typed : extractHighLowFromSeries(pre.rows);
      res.status(200).json({ ...base, items, source: pre.source });
      return;
    }

    const hl = await fetchDataGoHighLow(serviceKey, station.code, date);
    if (hl.ok) {
      res.status(200).json({ ...base, items: hl.items, source: "data.go.kr/tideFcstHghLw" });
      return;
    }

    res.status(200).json({
      ...base,
      items: [],
      error: "upstream_failed",
      message:
        "KHOA 조회에 실패했습니다. Vercel의 KHOA_SERVICE_KEY에 공공데이터 **일반 인증키(디코딩)** 를 넣었는지 확인하세요. (Encoding 키를 넣으면 %가 두 번 인코딩될 수 있습니다.)",
      hint: pre.hint || hl.hint
    });
  } catch (err) {
    res.status(502).json({
      error: "fetch_failed",
      message: String(err?.message || err),
      station,
      configured: true
    });
  }
}

/** @returns {string[]} */
function serviceKeyVariants(raw) {
  const k = raw.trim();
  const out = [];
  const add = (v) => {
    if (v && !out.includes(v)) out.push(v);
  };
  add(k);
  if (k.includes("%")) {
    try {
      add(decodeURIComponent(k));
    } catch {
      /* ignore */
    }
  } else {
    add(encodeURIComponent(k));
  }
  return out;
}

function buildKhoaUrl(base, serviceKey, obsCode, date) {
  return `${base}?ServiceKey=${serviceKey}&ObsCode=${encodeURIComponent(obsCode)}&Date=${encodeURIComponent(date)}&ResultType=json`;
}

function buildDataGoHlUrl(serviceKey, obsCode, date) {
  const q = new URLSearchParams({
    type: "json",
    obsCode,
    reqDate: date,
    numOfRows: "24",
    pageNo: "1"
  });
  if (/%[0-9A-Fa-f]{2}/.test(serviceKey)) {
    return `${DATA_GO_HL}?serviceKey=${serviceKey}&${q.toString()}`;
  }
  return `${DATA_GO_HL}?${q.toString()}&serviceKey=${encodeURIComponent(serviceKey)}`;
}

async function fetchText(url) {
  const upstream = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await upstream.text();
  return { text, status: upstream.status };
}

function parseJson(text) {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function fetchKhoaPreTab(serviceKey, obsCode, date) {
  const bases = [KHOA_PRE_TAB, KHOA_PRE_TAB_ALT];
  const keys = serviceKeyVariants(serviceKey);
  let lastHint = "";

  for (const base of bases) {
    for (const key of keys) {
      const url = buildKhoaUrl(base, key, obsCode, date);
      const { text, status } = await fetchText(url);
      const data = parseJson(text);
      if (!data) {
        lastHint = text.slice(0, 120).replace(/\s+/g, " ");
        continue;
      }
      const rows = normalizeRows(data);
      const items = rows.map(normalizeTideRow).filter(Boolean);
      return { ok: true, items, rows, source: "khoa/tideObsPreTab" };
    }
  }

  return { ok: false, hint: lastHint, items: [], rows: [] };
}

async function fetchDataGoHighLow(serviceKey, obsCode, date) {
  const keys = serviceKeyVariants(serviceKey);
  let lastHint = "";

  for (const key of keys) {
    const url = buildDataGoHlUrl(key, obsCode, date);
    const { text } = await fetchText(url);
    const data = parseJson(text);
    if (!data) {
      lastHint = text.slice(0, 120).replace(/\s+/g, " ");
      continue;
    }
    const items = parseDataGoHlItems(data);
    if (items.length) {
      return { ok: true, items };
    }
  }
  return { ok: false, hint: lastHint, items: [] };
}

function normalizeRows(data) {
  const result = data?.result ?? data?.response?.body ?? data;
  const records = result?.data ?? result?.items ?? result?.item ?? result?.record ?? [];
  return Array.isArray(records) ? records : records ? [records] : [];
}

function parseDataGoHlItems(data) {
  const body = data?.response?.body ?? data?.body ?? data;
  const items = body?.items?.item ?? body?.item ?? [];
  const list = Array.isArray(items) ? items : items ? [items] : [];
  return list.map(normalizeTideRow).filter(Boolean);
}

function normalizeTideRow(row) {
  if (!row || typeof row !== "object") return null;
  const time =
    row.tph_time || row.hl_time || row.time || row.obs_time || row.TIDE_TIME || row.datetime || row.record_time;
  let level = row.tph_level || row.tide_level || row.level || row.TIDE_LEVEL || row.height;
  if (level != null && Number(level) < 50 && String(level).includes(".")) {
    level = Math.round(Number(level) * 100);
  }
  const label = row.hl_code || row.tide_type || row.type || row.HL_CODE;
  if (!time) return null;

  const timeStr = formatTimeCell(time);
  const type = inferTideType(label) !== "unknown" ? inferTideType(label) : undefined;

  if (type) {
    return {
      time: timeStr,
      levelCm: level != null ? Number(level) : null,
      type
    };
  }

  return {
    time: timeStr,
    levelCm: level != null ? Number(level) : null,
    type: "unknown"
  };
}

function formatTimeCell(raw) {
  const s = String(raw);
  const m = s.match(/(\d{1,2}):(\d{2})/);
  if (m) return `${m[1].padStart(2, "0")}:${m[2]}`;
  const digits = s.replace(/\D/g, "");
  if (digits.length >= 4) {
    const tail = digits.slice(-4);
    return `${tail.slice(0, 2)}:${tail.slice(2)}`;
  }
  return s.slice(0, 8);
}

function inferTideType(raw) {
  const s = String(raw || "").toUpperCase();
  if (s.includes("고") || s === "H" || s === "HIGH" || s === "2") return "high";
  if (s.includes("저") || s === "L" || s === "LOW" || s === "1") return "low";
  return "unknown";
}

/** @param {{ time: string, levelCm: number | null, type?: string }[]} rows */
function extractHighLowFromSeries(rows) {
  const points = rows
    .map((row) => {
      const time = formatTimeCell(row.record_time || row.obs_time || row.time);
      const level = Number(row.tide_level ?? row.tide_obs_level ?? row.level);
      if (!time || !Number.isFinite(level)) return null;
      return { time, levelCm: level < 50 ? Math.round(level * 100) : Math.round(level) };
    })
    .filter(Boolean);

  if (points.length < 3) return [];

  const out = [];
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1].levelCm;
    const cur = points[i].levelCm;
    const next = points[i + 1].levelCm;
    if (cur >= prev && cur >= next) {
      out.push({ time: points[i].time, levelCm: cur, type: "high" });
    }
    if (cur <= prev && cur <= next) {
      out.push({ time: points[i].time, levelCm: cur, type: "low" });
    }
  }
  return out.slice(0, 8);
}
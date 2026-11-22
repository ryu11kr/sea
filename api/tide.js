import { nearestTideStation } from "./_lib/tide-stations.js";

/** 공공데이터포털 신규 (2025~) — 활용신청 화면 End Point 와 동일 */
const DATA_GO_SURVEY =
  "https://apis.data.go.kr/1192136/surveyTideLevel/GetSurveyTideLevelApiService";
const DATA_GO_HL =
  "https://apis.data.go.kr/1192136/tideFcstHghLw/GetTideFcstHghLwApiService";
/** 구 바다누리 URL (예전 키·신규 조합은 HTML 오류) */
const KHOA_PRE_TAB =
  "https://www.khoa.go.kr/api/oceangrid/tideObsPreTab/search.do";

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
    const hl = await fetchDataGoHighLow(serviceKey, station.code, date);
    if (hl.ok && hl.items.length) {
      res.status(200).json({ ...base, items: hl.items, source: "data.go.kr/tideFcstHghLw" });
      return;
    }

    const survey = await fetchDataGoSurvey(serviceKey, station.code, date);
    if (survey.ok && survey.items.length) {
      res.status(200).json({ ...base, items: survey.items, source: "data.go.kr/surveyTideLevel" });
      return;
    }

    const legacy = await fetchKhoaPreTab(serviceKey, station.code, date);
    if (legacy.ok && legacy.items.length) {
      res.status(200).json({ ...base, items: legacy.items, source: "khoa/tideObsPreTab(legacy)" });
      return;
    }

    const msg =
      survey.apiMessage ||
      hl.apiMessage ||
      "공공데이터 조회 실패. 마이페이지 **일반 인증키** 를 Vercel KHOA_SERVICE_KEY에 그대로 넣고 Redeploy 하세요. (Decoding/Encoding 구분 없이 키 한 줄만 있어도 됩니다.)";

    res.status(200).json({
      ...base,
      items: [],
      error: "upstream_failed",
      message: msg,
      hint: survey.hint || hl.hint || legacy.hint
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

function buildDataGoUrls(endpoint, serviceKey, params) {
  const q = new URLSearchParams(params);
  const base = `${endpoint}?${q.toString()}&serviceKey=`;
  const keys = serviceKeyVariants(serviceKey);
  return keys.map((key) => `${base}${key}`);
}

/** @returns {string[]} */
function serviceKeyVariants(raw) {
  const k = raw.trim();
  const out = [];
  const add = (v) => {
    if (v && !out.includes(v)) out.push(v);
  };
  add(encodeURIComponent(k));
  add(k);
  if (k.includes("%")) {
    try {
      add(encodeURIComponent(decodeURIComponent(k)));
    } catch {
      /* ignore */
    }
  }
  return out;
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

function dataGoHeader(data) {
  return data?.response?.header ?? data?.header ?? {};
}

function dataGoOk(data) {
  const code = String(dataGoHeader(data).resultCode ?? "");
  return code === "00" || code === "0";
}

function dataGoMessage(data) {
  return dataGoHeader(data).resultMsg || "";
}

function dataGoRows(data) {
  const body = data?.response?.body ?? data?.body ?? {};
  const items = body?.items?.item ?? body?.item ?? [];
  return Array.isArray(items) ? items : items ? [items] : [];
}

async function fetchDataGoSurvey(serviceKey, obsCode, date) {
  const params = {
    type: "json",
    obsCode,
    reqDate: date,
    pageNo: "1",
    numOfRows: "300",
    min: "1"
  };
  let hint = "";
  let apiMessage = "";

  for (const url of buildDataGoUrls(DATA_GO_SURVEY, serviceKey, params)) {
    const { text } = await fetchText(url);
    const data = parseJson(text);
    if (!data) {
      hint = text.slice(0, 160).replace(/\s+/g, " ");
      continue;
    }
    if (!dataGoOk(data)) {
      apiMessage = dataGoMessage(data);
      continue;
    }
    const rows = dataGoRows(data);
    const items = extractHighLowFromSeries(rows);
    if (items.length) {
      return { ok: true, items, hint, apiMessage };
    }
  }
  return { ok: false, items: [], hint, apiMessage };
}

async function fetchDataGoHighLow(serviceKey, obsCode, date) {
  const params = {
    type: "json",
    obsCode,
    reqDate: date,
    pageNo: "1",
    numOfRows: "24"
  };
  let hint = "";
  let apiMessage = "";

  for (const url of buildDataGoUrls(DATA_GO_HL, serviceKey, params)) {
    const { text } = await fetchText(url);
    const data = parseJson(text);
    if (!data) {
      hint = text.slice(0, 160).replace(/\s+/g, " ");
      continue;
    }
    if (!dataGoOk(data)) {
      apiMessage = dataGoMessage(data);
      continue;
    }
    const items = dataGoRows(data).map(normalizeTideRow).filter((i) => i && (i.type === "high" || i.type === "low"));
    if (items.length) {
      return { ok: true, items, hint, apiMessage };
    }
  }
  return { ok: false, items: [], hint, apiMessage };
}

async function fetchKhoaPreTab(serviceKey, obsCode, date) {
  let hint = "";
  for (const key of serviceKeyVariants(serviceKey)) {
    const url = `${KHOA_PRE_TAB}?ServiceKey=${key}&ObsCode=${encodeURIComponent(obsCode)}&Date=${encodeURIComponent(date)}&ResultType=json`;
    const { text } = await fetchText(url);
    const data = parseJson(text);
    if (!data) {
      hint = text.slice(0, 120).replace(/\s+/g, " ");
      continue;
    }
    const rows = normalizeRows(data);
    const direct = rows.map(normalizeTideRow).filter(Boolean);
    const typed = direct.filter((i) => i.type === "high" || i.type === "low");
    const items = typed.length ? typed : extractHighLowFromSeries(rows);
    if (items.length) {
      return { ok: true, items, hint };
    }
  }
  return { ok: false, items: [], hint };
}

function normalizeRows(data) {
  const result = data?.result ?? data?.response?.body ?? data;
  const records = result?.data ?? result?.items ?? result?.item ?? result?.record ?? [];
  return Array.isArray(records) ? records : records ? [records] : [];
}

function normalizeTideRow(row) {
  if (!row || typeof row !== "object") return null;
  const time =
    row.tph_time || row.hl_time || row.time || row.obs_time || row.obsTime || row.record_time;
  let level = row.tph_level || row.tide_level || row.tideLevel || row.level || row.TIDE_LEVEL;
  if (level != null && Number(level) < 50 && String(level).includes(".")) {
    level = Math.round(Number(level) * 100);
  }
  const label = row.hl_code || row.hl_type || row.tide_type || row.type || row.HL_CODE;
  if (!time) return null;

  const type = inferTideType(label);
  if (type === "unknown") return null;

  return {
    time: formatObsTime(time),
    levelCm: level != null ? Number(level) : null,
    type
  };
}

function formatObsTime(raw) {
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length >= 12) {
    return `${digits.slice(8, 10)}:${digits.slice(10, 12)}`;
  }
  const m = String(raw).match(/(\d{1,2}):(\d{2})/);
  if (m) return `${m[1].padStart(2, "0")}:${m[2]}`;
  if (digits.length >= 4) {
    const tail = digits.slice(-4);
    return `${tail.slice(0, 2)}:${tail.slice(2)}`;
  }
  return String(raw).slice(0, 8);
}

function inferTideType(raw) {
  const s = String(raw || "").toUpperCase();
  if (s.includes("고") || s === "H" || s === "HIGH" || s === "2") return "high";
  if (s.includes("저") || s === "L" || s === "LOW" || s === "1") return "low";
  return "unknown";
}

function extractHighLowFromSeries(rows) {
  const points = rows
    .map((row) => {
      const time = formatObsTime(row.obsTime || row.record_time || row.obs_time || row.time);
      const level = Number(
        row.tideLevel ?? row.preTideLevel ?? row.predictTideLevel ?? row.tide_level ?? row.level
      );
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
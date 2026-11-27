import { nearestTideStation } from "./_lib/tide-stations.js";

const DATA_GO_SURVEY =
  "https://apis.data.go.kr/1192136/surveyTideLevel/GetSurveyTideLevelApiService";
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

  const serviceKey = normalizeServiceKey(
    process.env.KHOA_SERVICE_KEY || process.env.DATA_GO_KR_SERVICE_KEY || ""
  );
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
    if (hl.items.length) {
      res.status(200).json({
        ...base,
        items: sanitizeTideItems(hl.items, { fromHl: true }),
        source: "data.go.kr/tideFcstHghLw"
      });
      return;
    }

    const survey = await fetchDataGoSurvey(serviceKey, station.code, date);
    if (survey.items.length) {
      const hlHint =
        hl.items.length === 0 && (hl.resultCode || hl.apiMessage || hl.rowCount)
          ? {
              hlFallback: {
                code: hl.resultCode || null,
                message: hl.apiMessage || null,
                rowCount: hl.rowCount ?? 0,
                sampleKeys: hl.sampleKeys || []
              }
            }
          : {};
      res.status(200).json({
        ...base,
        items: sanitizeTideItems(survey.items),
        source: "data.go.kr/surveyTideLevel",
        ...hlHint
      });
      return;
    }

    const detail = {
      surveyCode: survey.resultCode,
      surveyMsg: survey.apiMessage,
      surveyRows: survey.rowCount,
      hlCode: hl.resultCode,
      hlMsg: hl.apiMessage,
      sampleKeys: survey.sampleKeys
    };

    const userMsg = buildUserMessage(detail);

    res.status(200).json({
      ...base,
      items: [],
      error: survey.rowCount > 0 ? "parse_failed" : "upstream_failed",
      message: userMsg,
      publicData: detail
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

function normalizeServiceKey(raw) {
  return String(raw || "")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/\s+/g, "");
}

function buildDataGoUrls(endpoint, serviceKey, params) {
  const keys = serviceKeyVariants(serviceKey);
  const q = new URLSearchParams(params);
  const tail = q.toString();
  return keys.map((key) => `${endpoint}?serviceKey=${key}&${tail}`);
}

/** @returns {string[]} */
function serviceKeyVariants(raw) {
  const k = normalizeServiceKey(raw);
  const out = [];
  const add = (v) => {
    if (v && !out.includes(v)) out.push(v);
  };
  add(k);
  add(encodeURIComponent(k));
  if (k.includes("%")) {
    try {
      add(decodeURIComponent(k));
    } catch {
      /* ignore */
    }
  }
  return out;
}

async function fetchText(url) {
  const upstream = await fetch(url, {
    headers: {
      Accept: "application/json, text/xml, */*",
      "User-Agent": "sea.uxpwa.com/1.0 (tide proxy)"
    }
  });
  const text = await upstream.text();
  return { text, status: upstream.status };
}

function normalizeDataGoRoot(raw) {
  if (!raw || typeof raw !== "object") return raw;
  if (raw.response) return raw;
  if (raw.header || raw.body) return { response: raw };
  const topKey = Object.keys(raw).find(
    (k) =>
      /response$/i.test(k) ||
      /gettide/i.test(k) ||
      /apiservice/i.test(k) ||
      /service$/i.test(k)
  );
  if (topKey && raw[topKey] && typeof raw[topKey] === "object") {
    const inner = raw[topKey];
    if (inner.response) return inner;
    if (inner.header || inner.body) return { response: inner };
  }
  return raw;
}

function parseDataGoPayload(text) {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return normalizeDataGoRoot(JSON.parse(text));
    } catch {
      return null;
    }
  }
  if (t.startsWith("<")) {
    const resultCode = t.match(/<resultCode>([^<]+)/)?.[1]?.trim();
    const resultMsg = t.match(/<resultMsg>([^<]+)/)?.[1]?.trim();
    if (resultCode) {
      return { response: { header: { resultCode, resultMsg } } };
    }
  }
  return null;
}

function dataGoHeader(data) {
  return data?.response?.header ?? data?.header ?? {};
}

function dataGoOk(data) {
  const code = String(dataGoHeader(data).resultCode ?? "").trim();
  const msg = String(dataGoMessage(data) || "").toUpperCase();
  if (code === "00" || code === "0" || code === "00000") return true;
  if (msg.includes("NORMAL")) return true;
  return false;
}

function dataGoMessage(data) {
  return dataGoHeader(data).resultMsg || "";
}

function dataGoCode(data) {
  return String(dataGoHeader(data).resultCode ?? "");
}

function dataGoRows(data) {
  const body = data?.response?.body ?? data?.body ?? {};
  const rawItems = body?.items;
  if (rawItems == null || rawItems === "") return [];
  const items = rawItems?.item ?? body?.item ?? rawItems;
  if (Array.isArray(items)) return items;
  return items && typeof items === "object" ? [items] : [];
}

async function fetchDataGoSurvey(serviceKey, obsCode, date) {
  let apiMessage = "";
  let resultCode = "";
  let rowCount = 0;
  let httpStatus = 0;
  let sampleKeys = [];
  let lastRows = [];

  for (const min of ["60", "10"]) {
    const params = {
      type: "json",
      obsCode,
      reqDate: date,
      pageNo: "1",
      numOfRows: "300",
      min
    };

    for (const url of buildDataGoUrls(DATA_GO_SURVEY, serviceKey, params)) {
      const { text, status } = await fetchText(url);
      httpStatus = status;
      const data = parseDataGoPayload(text);
      if (!data) {
        if (status === 403) {
          resultCode = "HTTP403";
          apiMessage = "공공데이터가 요청을 거부했습니다(403). 인증키·활용신청 승인을 확인하세요.";
        }
        continue;
      }
      resultCode = dataGoCode(data);
      apiMessage = dataGoMessage(data) || apiMessage;
      if (!dataGoOk(data)) continue;

      const rows = dataGoRows(data);
      lastRows = rows;
      rowCount = rows.length;
      if (rows[0]) sampleKeys = Object.keys(rows[0]);

      const items = extractHighLowFromSeries(rows);
      if (items.length) {
        return { items, apiMessage, resultCode, rowCount, sampleKeys };
      }
    }
  }

  if (!apiMessage && httpStatus === 403) {
    apiMessage = "인증키 오류 가능성(HTTP 403). Vercel 키를 마이페이지에서 다시 복사해 넣으세요.";
  }
  if (resultCode === "00" && rowCount > 0) {
    apiMessage = apiMessage || "NORMAL_SERVICE";
  }

  return { items: [], apiMessage, resultCode, rowCount, sampleKeys, rows: lastRows };
}

async function fetchDataGoHighLow(serviceKey, obsCode, date) {
  const params = {
    type: "json",
    obsCode,
    reqDate: date,
    pageNo: "1",
    numOfRows: "300"
  };
  let apiMessage = "";
  let resultCode = "";
  let rowCount = 0;
  let sampleKeys = [];

  for (const url of buildDataGoUrls(DATA_GO_HL, serviceKey, params)) {
    const { text, status } = await fetchText(url);
    const data = parseDataGoPayload(text);
    if (!data) {
      if (status === 403) {
        resultCode = "HTTP403";
        apiMessage =
          "「조석예보(고·저조)」 API 미신청이면 이 오류가 날 수 있습니다. 조위 실측·예측 API만으로도 동작합니다.";
      }
      continue;
    }
    resultCode = dataGoCode(data);
    apiMessage = dataGoMessage(data) || apiMessage;
    if (!dataGoOk(data)) continue;

    const rows = dataGoRows(data);
    rowCount = rows.length;
    if (rows[0]) sampleKeys = Object.keys(rows[0]);

    const items = sanitizeTideItems(
      rows
        .map(normalizeTideRow)
        .filter((i) => i && (i.type === "high" || i.type === "low")),
      { fromHl: true }
    );
    if (items.length) {
      return { items, apiMessage, resultCode, rowCount, sampleKeys };
    }
    if (rowCount > 0 && !apiMessage) {
      apiMessage = `고·저조 ${rowCount}건 수신, 파싱 실패 (필드: ${sampleKeys.join(", ") || "?"})`;
    }
  }
  return { items: [], apiMessage, resultCode, rowCount, sampleKeys };
}

function buildUserMessage(detail) {
  const { surveyMsg, surveyCode, hlMsg, surveyRows, sampleKeys } = detail;
  if (surveyRows > 0 && surveyCode === "00") {
    const keys = (sampleKeys || []).join(", ");
    return `조회는 성공(00)했으나 만조·간조 추출 실패 (${surveyRows}건). 필드: ${keys || "?"}`;
  }
  if (surveyMsg) {
    return `공공데이터: [${surveyCode || "?"}] ${surveyMsg}`;
  }
  if (hlMsg) {
    return `공공데이터(고·저조): ${hlMsg}`;
  }
  if (surveyRows > 0) {
    return `조위 데이터 ${surveyRows}건은 받았지만 만조·간조 추출에 실패했습니다. (필드 형식 확인 중)`;
  }
  return "공공데이터 응답이 없습니다. Vercel KHOA_SERVICE_KEY 전체 복사 후 Redeploy, 활용신청「승인」여부를 확인하세요.";
}

function normalizeTideRow(row) {
  if (!row || typeof row !== "object") return null;
  const time = getField(
    row,
    "tph_time",
    "predcDt",
    "predc_dt",
    "hl_time",
    "time",
    "obs_time",
    "obsTime",
    "record_time"
  );
  const level = rowLevel(row, "pre");
  const label = getField(
    row,
    "hl_code",
    "extrSe",
    "extr_se",
    "hl_type",
    "tide_type",
    "type",
    "HL_CODE",
    "hlCode"
  );
  if (!time) return null;

  const type = inferTideType(label);
  if (type === "unknown") return null;

  return {
    time: formatObsTime(time),
    levelCm: Number.isFinite(level) ? level : null,
    type
  };
}

function getField(row, ...names) {
  for (const n of names) {
    const v = row?.[n];
    if (v != null && v !== "") return v;
  }
  const keys = Object.keys(row || {});
  for (const n of names) {
    const found = keys.find((k) => k.toLowerCase() === String(n).toLowerCase());
    if (found != null && row[found] != null && row[found] !== "") return row[found];
  }
  return undefined;
}

function rowLevel(row, mode = "auto") {
  const preKeys = [
    "tph_level",
    "tphLevel",
    "predcTdlvVl",
    "predc_tdlv_vl",
    "tph_hgt",
    "tphHgt",
    "tdlvHgt",
    "preTideLevel",
    "predictTideLevel",
    "pre_tide_level",
    "preTide",
    "preTideLvl",
    "preTideVal"
  ];
  const obsKeys = [
    "bscTdlvHgt",
    "tideLevel",
    "obsTideLevel",
    "tide_level",
    "obs_tide_level",
    "tideObs",
    "obsTide",
    "realTide",
    "tideLvl"
  ];
  const order =
    mode === "pre" ? [...preKeys, ...obsKeys] : mode === "obs" ? [...obsKeys, ...preKeys] : [...preKeys, ...obsKeys];
  for (const k of order) {
    const v = getField(row, k);
    if (v == null || v === "") continue;
    return normalizeLevelCm(v);
  }
  return NaN;
}

function rowTime(row) {
  return getField(
    row,
    "tph_time",
    "obsrvnDt",
    "obsTime",
    "obsDate",
    "obsDt",
    "recordTime",
    "record_time",
    "preTime",
    "preDate",
    "datetime",
    "dateTime",
    "time"
  );
}

function normalizeLevelCm(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return NaN;
  let cm = Math.round(n);
  if (n > 0 && n <= 12) {
    const s = String(v);
    if (s.includes(".") || n < 3) cm = Math.round(n * 100);
  }
  if (cm > 1200 || cm < -100) return NaN;
  return cm;
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
  if (s.includes("고") || s.includes("만") || s === "H" || s === "HIGH") return "high";
  if (s.includes("저") || s.includes("간") || s === "L" || s === "LOW") return "low";
  if (s === "HGH" || s === "HW" || s === "H") return "high";
  if (s === "LW" || s === "LWST" || s === "L") return "low";
  if (s === "1" || s === "01") return "low";
  if (s === "2" || s === "02") return "high";
  return "unknown";
}

function tideTimeToMinutes(time) {
  const m = String(time || "").match(/(\d{1,2}):(\d{2})/);
  if (!m) return NaN;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/** @param {{ time: string, levelCm?: number | null, type: string }[]} items */
function sanitizeTideItems(items, opts = {}) {
  const fromHl = Boolean(opts.fromHl);
  const valid = (items || [])
    .filter((i) => i && (i.type === "high" || i.type === "low"))
    .map((i) => ({
      time: formatObsTime(i.time),
      levelCm: Number.isFinite(i.levelCm) ? i.levelCm : null,
      type: i.type
    }))
    .filter((i) => {
      if (i.levelCm == null) return true;
      return i.levelCm >= -100 && i.levelCm <= 1200;
    })
  .map((i) => ({ ...i, _min: tideTimeToMinutes(i.time) }))
    .filter((i) => Number.isFinite(i._min));

  valid.sort((a, b) => a._min - b._min);

  if (fromHl) {
    return valid.slice(0, 8).map(({ _min, ...rest }) => rest);
  }

  const out = [];
  const MIN_GAP_MIN = 5 * 60;
  const MIN_SEQ_GAP = 2 * 60 + 30;
  for (const item of valid) {
    const last = out[out.length - 1];
    if (last && item._min - last._min < MIN_SEQ_GAP) {
      continue;
    }
    const lastSame = [...out].reverse().find((x) => x.type === item.type);
    if (lastSame && item._min - lastSame._min < MIN_GAP_MIN) {
      if (
        item.type === "high" &&
        (item.levelCm ?? 0) > (lastSame.levelCm ?? 0)
      ) {
        const idx = out.indexOf(lastSame);
        out[idx] = item;
      } else if (
        item.type === "low" &&
        (item.levelCm ?? 9999) < (lastSame.levelCm ?? 9999)
      ) {
        const idx = out.indexOf(lastSame);
        out[idx] = item;
      }
      continue;
    }
    out.push(item);
  }

  return out
    .sort((a, b) => a._min - b._min)
    .slice(0, 8)
    .map(({ _min, ...rest }) => rest);
}

function pickDailyExtremes(points, pickHigh) {
  const sorted = [...points].sort((a, b) => tideTimeToMinutes(a.time) - tideTimeToMinutes(b.time));
  const candidates = [];
  for (let i = 1; i < sorted.length - 1; i += 1) {
    const prev = sorted[i - 1].levelCm;
    const cur = sorted[i].levelCm;
    const next = sorted[i + 1].levelCm;
    if (pickHigh && cur >= prev && cur >= next) candidates.push(sorted[i]);
    if (!pickHigh && cur <= prev && cur <= next) candidates.push(sorted[i]);
  }
  candidates.sort((a, b) => (pickHigh ? b.levelCm - a.levelCm : a.levelCm - b.levelCm));
  const picked = [];
  const MIN_GAP = 5 * 60;
  for (const c of candidates) {
    const cm = tideTimeToMinutes(c.time);
    if (picked.some((p) => Math.abs(tideTimeToMinutes(p.time) - cm) < MIN_GAP)) continue;
    picked.push({
      time: c.time,
      levelCm: c.levelCm,
      type: pickHigh ? "high" : "low"
    });
    if (picked.length >= 2) break;
  }
  return picked;
}

function extractHighLowFromSeries(rows) {
  const points = rows
    .map((row) => {
      const time = formatObsTime(rowTime(row));
      let level = rowLevel(row, "pre");
      if (!Number.isFinite(level)) level = rowLevel(row, "obs");
      if (!time || !Number.isFinite(level)) return null;
      return { time, levelCm: level };
    })
    .filter(Boolean);

  if (points.length < 5) return [];

  return sanitizeTideItems([
    ...pickDailyExtremes(points, true),
    ...pickDailyExtremes(points, false)
  ]);
}
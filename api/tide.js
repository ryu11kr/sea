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
      res.status(200).json({ ...base, items: hl.items, source: "data.go.kr/tideFcstHghLw" });
      return;
    }

    const survey = await fetchDataGoSurvey(serviceKey, station.code, date);
    if (survey.items.length) {
      res.status(200).json({ ...base, items: survey.items, source: "data.go.kr/surveyTideLevel" });
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

function parseDataGoPayload(text) {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(text);
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
  const code = String(dataGoHeader(data).resultCode ?? "");
  return code === "00" || code === "0";
}

function dataGoMessage(data) {
  return dataGoHeader(data).resultMsg || "";
}

function dataGoCode(data) {
  return String(dataGoHeader(data).resultCode ?? "");
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
    min: "10"
  };
  let apiMessage = "";
  let resultCode = "";
  let rowCount = 0;
  let httpStatus = 0;
  let sampleKeys = [];
  let lastRows = [];

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

    let items = extractHighLowFromSeries(rows, "pre");
    if (!items.length) items = extractHighLowFromSeries(rows, "obs");
    if (!items.length) items = extractHighLowFromSeries(rows, "auto");
    if (items.length) {
      return { items, apiMessage, resultCode, rowCount, sampleKeys };
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
    numOfRows: "24"
  };
  let apiMessage = "";
  let resultCode = "";

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

    const items = dataGoRows(data)
      .map(normalizeTideRow)
      .filter((i) => i && (i.type === "high" || i.type === "low"));
    if (items.length) {
      return { items, apiMessage, resultCode };
    }
  }
  return { items: [], apiMessage, resultCode };
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
  const time =
    row.tph_time || row.hl_time || row.time || row.obs_time || row.obsTime || row.record_time;
  const level = rowLevel(row);
  const label = row.hl_code || row.hl_type || row.tide_type || row.type || row.HL_CODE;
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
    "preTideLevel",
    "predictTideLevel",
    "pre_tide_level",
    "preTide",
    "preTideLvl",
    "preTideVal"
  ];
  const obsKeys = [
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
  if (Math.abs(n) < 30 && String(v).includes(".")) {
    return Math.round(n * 100);
  }
  return Math.round(n);
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

function extractHighLowFromSeries(rows, mode = "auto") {
  const points = rows
    .map((row) => {
      const time = formatObsTime(rowTime(row));
      const level = rowLevel(row, mode);
      if (!time || !Number.isFinite(level)) return null;
      return { time, levelCm: level };
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

  if (out.length) return out.slice(0, 8);

  const sorted = [...points].sort((a, b) => a.time.localeCompare(b.time));
  const half = Math.floor(sorted.length / 2);
  const early = sorted.slice(0, half);
  const late = sorted.slice(half);
  const pick = (arr, pickHigh) => {
    if (!arr.length) return null;
    const best = arr.reduce((a, b) => (pickHigh ? (a.levelCm >= b.levelCm ? a : b) : a.levelCm <= b.levelCm ? a : b));
    return { ...best, type: pickHigh ? "high" : "low" };
  };
  const hi = pick(sorted, true);
  const lo = pick(sorted, false);
  return [hi, lo].filter(Boolean);
}
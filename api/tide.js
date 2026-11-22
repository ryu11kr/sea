import { nearestTideStation } from "./_lib/tide-stations.js";

const KHOA_BASE = "https://www.khoa.go.kr/api/oceangrid/tideObsPreTab/search.do";

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

  const url = new URL(KHOA_BASE);
  url.searchParams.set("ServiceKey", serviceKey);
  url.searchParams.set("Date", date);
  url.searchParams.set("ObsCode", station.code);
  url.searchParams.set("ResultType", "json");

  try {
    const upstream = await fetch(url.toString(), { headers: { Accept: "application/json" } });
    const text = await upstream.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      res.status(502).json({ error: "upstream_not_json", station, raw: text.slice(0, 200) });
      return;
    }

    const result = data?.result ?? data;
    const records = result?.data ?? result?.item ?? result?.record ?? [];
    const list = Array.isArray(records) ? records : records ? [records] : [];

    res.status(200).json({
      configured: true,
      station,
      distanceKm,
      date,
      items: list.map(normalizeTideRow).filter(Boolean)
    });
  } catch (err) {
    res.status(502).json({ error: "fetch_failed", message: String(err?.message || err), station });
  }
}

function normalizeTideRow(row) {
  if (!row || typeof row !== "object") return null;
  const time =
    row.tph_time || row.hl_time || row.time || row.obs_time || row.TIDE_TIME || row.datetime;
  const level = row.tph_level || row.tide_level || row.level || row.TIDE_LEVEL || row.height;
  const label = row.hl_code || row.tide_type || row.type || row.HL_CODE;
  if (!time) return null;
  return {
    time: String(time).slice(-5).replace(/^(\d{2})(\d{2})$/, "$1:$2"),
    levelCm: level != null ? Number(level) : null,
    type: inferTideType(label)
  };
}

function inferTideType(raw) {
  const s = String(raw || "").toUpperCase();
  if (s.includes("고") || s === "H" || s === "HIGH") return "high";
  if (s.includes("저") || s === "L" || s === "LOW") return "low";
  return "unknown";
}
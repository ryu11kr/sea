/** @typedef {{ title: string, address: string, lat: number, lon: number, kind?: string }} GeoResult */

/**
 * @param {Record<string, unknown> | null | undefined} road
 * @param {Record<string, unknown> | null | undefined} land
 */
function kakaoFormatAddressLine(road, land) {
  const roadLine = String(road?.address_name || "").trim();
  const landLine = String(land?.address_name || "").trim();
  let line = roadLine || landLine;
  const building = String(road?.building_name || "").trim();
  if (building && line && !line.includes(building)) {
    line = `${line} (${building})`;
  }
  return line;
}

/**
 * @param {string} compact
 */
function looksLikeRoadAddress(compact) {
  return /[가-힣](?:대로|로|길)\d/.test(compact) || /\d+[가-힣]*(?:대로|로|길)/.test(compact);
}

/**
 * @param {string} q
 * @returns {string[]}
 */
function buildSearchVariants(q) {
  const variants = [];
  const add = (s) => {
    const t = String(s || "").trim();
    if (t && !variants.includes(t)) variants.push(t);
  };

  add(q);
  const compact = q.replace(/\s+/g, "");
  if (compact !== q) add(compact);

  const roadNum = compact.match(/^(.+?(?:대로|로|길))(\d[\d-]*)$/);
  if (roadNum) {
    add(`${roadNum[1]} ${roadNum[2]}`);
  }

  return variants;
}

/**
 * @param {string} s
 */
function normKey(s) {
  return String(s || "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/**
 * @param {GeoResult[]} list
 * @param {string} q
 * @returns {GeoResult[]}
 */
function dedupeAndRank(list, q) {
  const nq = normKey(q);
  const seen = new Set();
  const out = [];

  for (const r of list) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
    const key = `${r.lat.toFixed(5)},${r.lon.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }

  const score = (r) => {
    const title = normKey(r.title);
    const addr = normKey(r.address);
    let s = 20;
    if (r.kind === "road_address") s += 35;
    if (addr === nq) s += 120;
    else if (addr.includes(nq)) s += 95;
    if (title === nq) s += 100;
    else if (title.startsWith(nq)) s += 85;
    else if (title.includes(nq)) s += 70;
    return s;
  };

  return out.sort((a, b) => score(b) - score(a)).slice(0, 12);
}

/**
 * @param {string} kakaoKey
 * @param {string} query
 * @returns {Promise<GeoResult[]>}
 */
/**
 * @param {Response} res
 */
async function readKakaoError(res) {
  try {
    const data = await res.json();
    return data?.message || data?.msg || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/**
 * @param {string} kakaoKey
 * @param {string} query
 * @returns {Promise<{ results: GeoResult[], errors: string[] }>}
 */
/**
 * @param {string} kakaoKey
 * @param {string} query
 * @param {{ roadFocus?: boolean }} [opts]
 */
async function kakaoSearch(kakaoKey, query, opts = {}) {
  const headers = { Authorization: `KakaoAK ${kakaoKey}` };
  const collected = /** @type {GeoResult[]} */ ([]);
  const errors = /** @type {string[]} */ ([]);
  const roadFocus = Boolean(opts.roadFocus);

  const pushAddressDoc = (d) => {
    const road = d.road_address;
    const land = d.address;
    const addr = kakaoFormatAddressLine(road, land);
    const lat = Number(road?.y ?? land?.y);
    const lon = Number(road?.x ?? land?.x);
    const building = String(road?.building_name || "").trim();
    const title = building || addr || query;
    if (Number.isFinite(lat) && Number.isFinite(lon) && addr) {
      collected.push({
        title,
        address: addr,
        lat,
        lon,
        kind: "road_address",
      });
    }
  };

  const analyzeTypes = roadFocus ? ["exact", "similar"] : ["similar"];
  for (const analyzeType of analyzeTypes) {
    const address = await fetch(
      `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(query)}&size=${roadFocus ? 15 : 10}&analyze_type=${analyzeType}`,
      { headers }
    );
    if (address.ok) {
      const data = await address.json();
      for (const d of data.documents || []) pushAddressDoc(d);
    } else {
      errors.push(`address(${analyzeType}): ${await readKakaoError(address)}`);
    }
  }

  if (!roadFocus || collected.length === 0) {
    const keyword = await fetch(
      `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(query)}&size=${roadFocus ? 8 : 15}`,
      { headers }
    );
    if (keyword.ok) {
      const data = await keyword.json();
      for (const d of data.documents || []) {
        const addr = String(d.road_address_name || d.address_name || "").trim();
        collected.push({
          title: d.place_name,
          address: addr || d.place_name,
          lat: Number(d.y),
          lon: Number(d.x),
          kind: "place",
        });
      }
    } else {
      errors.push(`keyword: ${await readKakaoError(keyword)}`);
    }
  }

  return { results: collected, errors };
}

/**
 * @param {string} q
 * @returns {Promise<GeoResult[]>}
 */
async function nominatimSearch(q) {
  const nom = await fetch(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=10&countrycodes=kr`,
    { headers: { "User-Agent": "SeaTidePWA/1.0 (sea.uxpwa.com)" } }
  );
  const list = await nom.json();
  return (list || []).map((d) => ({
    title: d.display_name.split(",")[0],
    address: d.display_name,
    lat: Number(d.lat),
    lon: Number(d.lon),
  }));
}

/**
 * 한국 근해 bbox — 보조 검색
 * @param {string} q
 * @returns {Promise<GeoResult[]>}
 */
async function photonSearch(q) {
  const r = await fetch(
    `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lang=ko&limit=10&bbox=124.5,33,131.5,39.5`
  );
  if (!r.ok) return [];
  const data = await r.json();
  return (data.features || [])
    .map((f) => {
      const p = f.properties || {};
      const name = p.name || p.street || p.city || p.locality || q;
      const addr = [p.state, p.city, p.street, p.housenumber].filter(Boolean).join(" ");
      const coords = f.geometry?.coordinates || [];
      return {
        title: String(name),
        address: addr || String(name),
        lat: Number(coords[1]),
        lon: Number(coords[0]),
      };
    })
    .filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon));
}

/**
 * @param {string} q
 * @param {string} kakaoKey
 * @returns {Promise<{ provider: string, results: GeoResult[] }>}
 */
async function searchPlaces(q, kakaoKey) {
  const variants = buildSearchVariants(q);
  const compact = q.replace(/\s+/g, "");
  const roadFocus = looksLikeRoadAddress(compact);
  let provider = kakaoKey ? "kakao" : "nominatim";
  const merged = /** @type {GeoResult[]} */ ([]);
  /** @type {string[]} */
  const kakaoErrors = [];

  if (kakaoKey) {
    const orderedVariants = roadFocus
      ? [...new Set([variants.find((v) => v.includes(" ")) || variants[0], ...variants])]
      : variants;
    for (const variant of orderedVariants) {
      const { results: part, errors } = await kakaoSearch(kakaoKey, variant, {
        roadFocus: roadFocus && variant === orderedVariants[0],
      });
      merged.push(...part);
      if (errors.length) kakaoErrors.push(...errors);
      if (roadFocus && merged.length >= 5) break;
    }
  }

  if (!kakaoKey || merged.length === 0) {
    for (const variant of variants) {
      const part = await nominatimSearch(variant);
      merged.push(...part);
      if (merged.length >= 8) break;
    }
    if (merged.length === 0) {
      const photon = await photonSearch(q);
      merged.push(...photon);
      if (photon.length && !kakaoKey) provider = "photon";
    }
    if (kakaoKey && merged.length > 0) provider = "kakao+fallback";
  }

  const results = dedupeAndRank(merged, q);
  const uniqueErrors = [...new Set(kakaoErrors)].slice(0, 3);
  return { provider, results, kakaoErrors: uniqueErrors.length ? uniqueErrors : undefined };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const q = String(req.query.q || "").trim();
  const lat = req.query.lat;
  const lon = req.query.lon;

  const kakaoKey = (process.env.KAKAO_REST_KEY || "").trim();

  const suggest =
    req.query.suggest === "1" ||
    req.query.suggest === "true" ||
    req.query.suggest === "yes";

  try {
    if (q && suggest) {
      let provider = kakaoKey ? "kakao" : "nominatim";
      let results = /** @type {GeoResult[]} */ ([]);

      if (kakaoKey) {
        const { results: part } = await kakaoSearch(kakaoKey, q);
        results = dedupeAndRank(part, q).slice(0, 10);
      } else {
        const part = await nominatimSearch(q);
        results = dedupeAndRank(part, q).slice(0, 10);
        if (results.length === 0) {
          results = dedupeAndRank(await photonSearch(q), q).slice(0, 10);
          if (results.length) provider = "photon";
        }
      }

      res.status(200).json({ provider, results, suggest: true });
      return;
    }

    if (q) {
      const { provider, results, kakaoErrors } = await searchPlaces(q, kakaoKey);
      const body = { provider, results };
      if (kakaoErrors?.length) body.kakaoErrors = kakaoErrors;
      if (kakaoKey && results.length === 0) {
        body.hint =
          "카카오 키는 설정됐지만 결과가 없습니다. developers.kakao.com 앱의 REST API 키인지, 유료 API·할당량을 확인해 주세요.";
      }
      res.status(200).json(body);
      return;
    }

    if (lat != null && lon != null) {
      if (kakaoKey) {
        const r = await fetch(
          `https://dapi.kakao.com/v2/local/geo/coord2address.json?x=${lon}&y=${lat}&input_coord=WGS84`,
          { headers: { Authorization: `KakaoAK ${kakaoKey}` } }
        );
        const data = await r.json();
        const doc = data.documents?.[0];
        const addr =
          kakaoFormatAddressLine(doc?.road_address, doc?.address) ||
          `${Number(lat).toFixed(5)}, ${Number(lon).toFixed(5)}`;
        res.status(200).json({
          provider: "kakao",
          address: addr,
          roadAddress: kakaoFormatAddressLine(doc?.road_address, null) || null,
          landAddress: String(doc?.address?.address_name || "").trim() || null,
        });
        return;
      }

      const rev = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=18&accept-language=ko`,
        { headers: { "User-Agent": "SeaTidePWA/1.0 (sea.uxpwa.com)" } }
      );
      const data = await rev.json();
      const addr = data.display_name || `${lat}, ${lon}`;
      res.status(200).json({
        provider: "nominatim",
        address: addr,
        hint: "도로명주소는 카카오 연동(서버 KAKAO_REST_KEY)이 있을 때 정확합니다.",
      });
      return;
    }

    res.status(400).json({ error: "need q or lat+lon" });
  } catch (err) {
    res.status(502).json({ error: "geocode_failed", message: String(err?.message || err) });
  }
}
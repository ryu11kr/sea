/** @typedef {{ title: string, address: string, lat: number, lon: number }} GeoResult */

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

  // 숫자로 끝나는 짧은 지명(아암2 → 아암2교) 등 낚시·해안 지명 보조 검색
  if (/[0-9]$/.test(compact)) {
    const suffixes = ["교", "대교", "방파제", "항", "선착장", "부두", "해수욕장"];
    for (const sfx of suffixes) {
      if (!compact.endsWith(sfx)) add(compact + sfx);
    }
  }

  return variants.slice(0, 7);
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
    if (title === nq) return 100;
    if (title.startsWith(nq)) return 85;
    if (title.includes(nq)) return 70;
    if (addr.includes(nq)) return 50;
    return 20;
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
async function kakaoSearch(kakaoKey, query) {
  const headers = { Authorization: `KakaoAK ${kakaoKey}` };
  const collected = /** @type {GeoResult[]} */ ([]);
  const errors = /** @type {string[]} */ ([]);

  // analyze_type 은 주소 검색 API 전용 — keyword API 에 넣으면 400 으로 실패할 수 있음
  const keyword = await fetch(
    `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(query)}&size=15`,
    { headers }
  );
  if (keyword.ok) {
    const data = await keyword.json();
    for (const d of data.documents || []) {
      collected.push({
        title: d.place_name,
        address: d.road_address_name || d.address_name || "",
        lat: Number(d.y),
        lon: Number(d.x),
      });
    }
  } else {
    errors.push(`keyword: ${await readKakaoError(keyword)}`);
  }

  const address = await fetch(
    `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(query)}&size=10&analyze_type=similar`,
    { headers }
  );
  if (address.ok) {
    const data = await address.json();
    for (const d of data.documents || []) {
      const road = d.road_address;
      const land = d.address;
      const addr = road?.address_name || land?.address_name || "";
      const lat = Number(road?.y ?? land?.y);
      const lon = Number(road?.x ?? land?.x);
      const title = road?.building_name || addr.split(" ").slice(-2).join(" ") || addr || query;
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        collected.push({ title, address: addr, lat, lon });
      }
    }
  } else {
    errors.push(`address: ${await readKakaoError(address)}`);
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
  let provider = kakaoKey ? "kakao" : "nominatim";
  const merged = /** @type {GeoResult[]} */ ([]);
  /** @type {string[]} */
  const kakaoErrors = [];

  if (kakaoKey) {
    await Promise.all(
      variants.map(async (variant) => {
        const { results: part, errors } = await kakaoSearch(kakaoKey, variant);
        merged.push(...part);
        if (errors.length) kakaoErrors.push(...errors);
      })
    );
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

  try {
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
          `https://dapi.kakao.com/v2/local/geo/coord2address.json?x=${lon}&y=${lat}`,
          { headers: { Authorization: `KakaoAK ${kakaoKey}` } }
        );
        const data = await r.json();
        const doc = data.documents?.[0];
        const addr =
          doc?.address?.address_name ||
          doc?.road_address?.address_name ||
          `${Number(lat).toFixed(5)}, ${Number(lon).toFixed(5)}`;
        res.status(200).json({ provider: "kakao", address: addr });
        return;
      }

      const rev = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=14`,
        { headers: { "User-Agent": "SeaTidePWA/1.0 (sea.uxpwa.com)" } }
      );
      const data = await rev.json();
      res.status(200).json({
        provider: "nominatim",
        address: data.display_name || `${lat}, ${lon}`,
      });
      return;
    }

    res.status(400).json({ error: "need q or lat+lon" });
  } catch (err) {
    res.status(502).json({ error: "geocode_failed", message: String(err?.message || err) });
  }
}
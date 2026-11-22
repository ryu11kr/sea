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
      if (kakaoKey) {
        const r = await fetch(
          `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(q)}&size=8`,
          { headers: { Authorization: `KakaoAK ${kakaoKey}` } }
        );
        const data = await r.json();
        const docs = (data.documents || []).map((d) => ({
          title: d.place_name,
          address: d.address_name || d.road_address_name,
          lat: Number(d.y),
          lon: Number(d.x)
        }));
        res.status(200).json({ provider: "kakao", results: docs });
        return;
      }

      const nom = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=8&countrycodes=kr`,
        { headers: { "User-Agent": "SeaTidePWA/1.0 (sea.uxpwa.com)" } }
      );
      const list = await nom.json();
      res.status(200).json({
        provider: "nominatim",
        results: (list || []).map((d) => ({
          title: d.display_name.split(",")[0],
          address: d.display_name,
          lat: Number(d.lat),
          lon: Number(d.lon)
        }))
      });
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
        address: data.display_name || `${lat}, ${lon}`
      });
      return;
    }

    res.status(400).json({ error: "need q or lat+lon" });
  } catch (err) {
    res.status(502).json({ error: "geocode_failed", message: String(err?.message || err) });
  }
}
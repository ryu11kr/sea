/** KHOA 조위관측소 (일부) — lat/lon 기준 최근접 관측소 매칭용 */
export const TIDE_STATIONS = [
  { code: "DT_0001", name: "인천", lat: 37.4519, lon: 126.5922 },
  { code: "DT_0004", name: "부산", lat: 35.0962, lon: 129.0404 },
  { code: "DT_0007", name: "목포", lat: 34.7794, lon: 126.3756 },
  { code: "DT_0012", name: "속초", lat: 38.2075, lon: 128.5942 },
  { code: "DT_0018", name: "울산", lat: 35.5014, lon: 129.3872 },
  { code: "DT_0020", name: "여수", lat: 34.7472, lon: 127.7656 },
  { code: "DT_0023", name: "통영", lat: 34.8278, lon: 128.4347 },
  { code: "DT_0028", name: "포항", lat: 36.0519, lon: 129.3769 },
  { code: "DT_0031", name: "군산", lat: 35.9736, lon: 126.5628 },
  { code: "DT_0034", name: "제주", lat: 33.5278, lon: 126.5433 },
  { code: "DT_0056", name: "동해", lat: 37.5078, lon: 129.1242 },
  { code: "DT_0062", name: "거제", lat: 34.8806, lon: 128.6217 },
  { code: "DT_0068", name: "보령", lat: 36.4533, lon: 126.4867 },
  { code: "DT_0087", name: "강릉", lat: 37.7747, lon: 128.9464 },
  { code: "DT_0091", name: "대산", lat: 37.0078, lon: 126.3528 },
  { code: "DT_0094", name: "서천", lat: 36.1139, lon: 126.495 },
  { code: "DT_0921", name: "주문진", lat: 37.8919, lon: 128.8292 }
];

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

export function nearestTideStation(lat, lon) {
  let best = TIDE_STATIONS[0];
  let bestD = Infinity;
  for (const s of TIDE_STATIONS) {
    const dLat = toRad(s.lat - lat);
    const dLon = toRad(s.lon - lon);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat)) * Math.cos(toRad(s.lat)) * Math.sin(dLon / 2) ** 2;
    const d = 2 * Math.asin(Math.sqrt(a));
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return { station: best, distanceKm: Math.round(bestD * 6371 * 10) / 10 };
}
/**
 * 해시(#) 라우팅 — PWA 단독 창에서도 뒤로가기·공유 링크 지원
 * #/  목록 · #/point/{id}  저장 포인트 · #/spot?lat&lon&n  공유 링크 · #/map · #/app-share
 */

/**
 * @typedef {{ view: 'list' }}
 * @typedef {{ view: 'point', id: string }}
 * @typedef {{ view: 'spot', params: URLSearchParams }}
 * @typedef {{ view: 'map-new' }}
 * @typedef {{ view: 'map-edit', id: string }}
 * @typedef {{ view: 'app-share' }}
 * @typedef {ReturnType<typeof parseSeaRoute>} SeaRoute
 */

export function parseSeaRoute() {
  const raw = (location.hash || "").replace(/^#/, "").trim();
  if (!raw || raw === "/") return { view: "list" };

  const qIdx = raw.indexOf("?");
  const pathPart = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
  const queryPart = qIdx >= 0 ? raw.slice(qIdx + 1) : "";
  const parts = pathPart.split("/").filter(Boolean);

  if (!parts.length) return { view: "list" };

  const head = parts[0];
  if (head === "point" && parts[1]) {
    return { view: "point", id: decodeURIComponent(parts[1]) };
  }
  if (head === "spot") {
    return { view: "spot", params: new URLSearchParams(queryPart) };
  }
  if (head === "map") {
    if (parts[1] === "edit" && parts[2]) {
      return { view: "map-edit", id: decodeURIComponent(parts[2]) };
    }
    return { view: "map-new" };
  }
  if (head === "app-share") return { view: "app-share" };

  return { view: "list" };
}

/** @param {SeaRoute} route */
export function seaRouteHash(route) {
  switch (route.view) {
    case "list":
      return "#/";
    case "point":
      return `#/point/${encodeURIComponent(route.id)}`;
    case "spot": {
      const q =
        route.params instanceof URLSearchParams
          ? route.params
          : new URLSearchParams(route.params || {});
      return `#/spot?${q.toString()}`;
    }
    case "map-new":
      return "#/map";
    case "map-edit":
      return `#/map/edit/${encodeURIComponent(route.id)}`;
    case "app-share":
      return "#/app-share";
    default:
      return "#/";
  }
}

/**
 * @param {{ name: string, lat: number, lon: number, address?: string }} point
 * @param {string} baseHref origin+pathname (query/hash 제외)
 */
export function buildSharedSpotUrl(point, baseHref) {
  const u = new URL(baseHref || location.href);
  u.search = "";
  const q = new URLSearchParams();
  q.set("lat", String(Number(point.lat).toFixed(5)));
  q.set("lon", String(Number(point.lon).toFixed(5)));
  q.set("n", String(point.name || "포인트"));
  const addr = String(point.address || "").trim();
  if (addr) q.set("a", addr);
  u.hash = `/spot?${q.toString()}`;
  return u.href;
}

/** @param {URLSearchParams} params */
export function spotPointFromParams(params) {
  const lat = Number(params.get("lat"));
  const lon = Number(params.get("lon"));
  const name = (params.get("n") || "공유 포인트").trim() || "공유 포인트";
  const address = (params.get("a") || "").trim();
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return {
    id: `shared-${lat.toFixed(5)}-${lon.toFixed(5)}`,
    name,
    lat,
    lon,
    address,
    updatedAt: "",
    _ephemeral: true,
  };
}
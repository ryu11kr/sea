import {
  SEA_STORAGE_KEY,
  ensurePointIds,
  generatePointId,
  touchLocalPointsMutatedAt,
} from "./cloud-sync-data.js";
import { initSeaPwaUpdate } from "./pwa-update.js";

const TIDE_FORECAST_DAYS = 3;
const WEATHER_FORECAST_DAYS = 7;

/**
 * @typedef {{ id: string, name: string, lat: number, lon: number, address: string, updatedAt: string }} SeaPoint
 */

/** @type {SeaPoint[]} */
let seaPoints = [];
/** @type {string | null} */
let activePointId = null;
/** @type {L.Map | null} */
let map = null;
/** @type {L.Map | null} */
let detailMap = null;
/** @type {L.Marker | null} */
let detailMapMarker = null;
/** @type {string | null} */
let editPointId = null;

let mapCenter = { lat: 37.5665, lon: 126.978 };
let addressDebounce = null;
let mapSearchHintBound = false;

const $ = (sel) => document.querySelector(sel);

function init() {
  if (!document.body.classList.contains("sea-app")) return;
  loadState();
  window.dispatchEvent(
    new CustomEvent("sea-points-changed", { detail: { count: seaPoints.length } })
  );
  bindUi();
  initSeaPwaUpdate().catch(() => {});
  bindInstall();
  bindAppShareUi();
  exposeSeaAppApi();
  showListView();
  renderPointList();
}

function loadState() {
  try {
    const raw = localStorage.getItem(SEA_STORAGE_KEY);
    seaPoints = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(seaPoints)) seaPoints = [];
    seaPoints = ensurePointIds(seaPoints);
    if (raw && seaPoints.length) {
      try {
        localStorage.setItem(SEA_STORAGE_KEY, JSON.stringify(seaPoints));
      } catch {
        /* quota */
      }
    }
  } catch {
    seaPoints = [];
  }
}

function saveState() {
  seaPoints = ensurePointIds(seaPoints);
  try {
    localStorage.setItem(SEA_STORAGE_KEY, JSON.stringify(seaPoints));
    touchLocalPointsMutatedAt();
  } catch (err) {
    console.error(err);
    setStatus("이 기기에 저장하지 못했습니다. 저장 공간을 확인해 주세요.");
    return;
  }
  if (!window.__seaCloudSyncApplying) {
    window.dispatchEvent(new Event("sea-local-state-saved"));
  }
  window.dispatchEvent(
    new CustomEvent("sea-points-changed", { detail: { count: seaPoints.length } })
  );
}

function exposeSeaAppApi() {
  window.seaAppGetLocalPoints = () => ({
    points: [...seaPoints],
    updatedAt:
      seaPoints.reduce((m, p) => Math.max(m, new Date(p.updatedAt || 0).getTime()), 0) || null,
  });
  window.seaAppApplyPoints = (points) => {
    seaPoints = ensurePointIds(Array.isArray(points) ? points : []);
    try {
      localStorage.setItem(SEA_STORAGE_KEY, JSON.stringify(seaPoints));
    } catch (err) {
      console.error(err);
    }
    renderPointList();
    window.dispatchEvent(
      new CustomEvent("sea-points-changed", { detail: { count: seaPoints.length } })
    );
    if (activePointId && !seaPoints.find((p) => p.id === activePointId)) {
      showListView();
    } else if (activePointId) {
      const point = seaPoints.find((p) => p.id === activePointId);
      if (point) {
        $("#detail-point-name").textContent = point.name;
        $("#detail-address").textContent =
          point.address || `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
        renderDetailNav(point);
      }
    }
  };
  window.setSeaStatus = setStatus;
  window.seaAppClearAllLocalData = () => {
    seaPoints = [];
    activePointId = null;
    editPointId = null;
    localStorage.removeItem(SEA_STORAGE_KEY);
    renderPointList();
    showListView();
    setStatus("");
    window.dispatchEvent(
      new CustomEvent("sea-points-changed", { detail: { count: 0 } })
    );
  };
}

function bindUi() {
  $("#btn-new-point")?.addEventListener("click", () => startNewPointOnMap());
  $("#btn-cancel-map")?.addEventListener("click", () => {
    editPointId = null;
    showListView();
  });
  $("#map-search-btn")?.addEventListener("click", () => runMapSearch());
  $("#map-search-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runMapSearch();
    }
  });
  bindMapSearchHintDialog();
  $("#btn-save-point")?.addEventListener("click", () => savePointFromMap());
  $("#point-save-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    savePointFromMap();
  });
  $("#point-name-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      savePointFromMap();
    }
  });
  $("#btn-back-list")?.addEventListener("click", showListView);
  $("#btn-delete-point")?.addEventListener("click", deleteActivePoint);
  $("#btn-edit-point")?.addEventListener("click", () => {
    if (!activePointId) return;
    editPointId = activePointId;
    startMapView();
  });
  bindDetailNavUi();
}

function navSearchLabel(point) {
  const name = String(point.name || "").trim();
  const addr = String(point.address || "").trim();
  const coord = `${Number(point.lat).toFixed(5)}, ${Number(point.lon).toFixed(5)}`;
  if (name && addr && !addr.includes(name)) return `${name} · ${addr}`;
  if (name) return name;
  if (addr) return addr;
  return coord;
}

const TMAP_PLAY_STORE =
  "https://play.google.com/store/apps/details?id=com.skt.tmap.ku&hl=ko";
const TMAP_APP_STORE = "https://apps.apple.com/app/id431589174";

function tmapGoalName(point) {
  const label = navSearchLabel(point);
  return label.length > 80 ? `${label.slice(0, 77)}…` : label;
}

function isAndroidUa() {
  return /Android/i.test(navigator.userAgent || "");
}

function isIosUa() {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent || "");
}

/** @param {SeaPoint} point */
function tmapIosRouteScheme(point) {
  const name = encodeURIComponent(tmapGoalName(point));
  const x = Number(point.lon);
  const y = Number(point.lat);
  return `tmap://route?rGoName=${name}&rGoX=${x}&rGoY=${y}`;
}

/** Android Chrome — 설치 시 앱, 미설치 시 Play 스토어 */
function tmapAndroidIntentUrl(point) {
  const name = encodeURIComponent(tmapGoalName(point));
  const x = Number(point.lon);
  const y = Number(point.lat);
  const routeQuery = `referrer=com.skt.Tmap&goalx=${x}&goaly=${y}&goalname=${name}&reqCoordType=WGS84&resCoordType=WGS84`;
  const fallback = encodeURIComponent(TMAP_PLAY_STORE);
  return `intent://route?${routeQuery}#Intent;scheme=tmap;package=com.skt.tmap.ku;S.browser_fallback_url=${fallback};end`;
}

/** @param {SeaPoint} point */
function openTmapNavigation(point) {
  if (isAndroidUa()) {
    window.location.assign(tmapAndroidIntentUrl(point));
    return;
  }
  if (isIosUa()) {
    let opened = false;
    const markOpened = () => {
      opened = true;
    };
    window.addEventListener("blur", markOpened, { once: true });
    window.addEventListener("pagehide", markOpened, { once: true });
    window.location.assign(tmapIosRouteScheme(point));
    window.setTimeout(() => {
      if (!opened) window.location.assign(TMAP_APP_STORE);
    }, 1800);
    return;
  }
  window.open(TMAP_PLAY_STORE, "_blank", "noopener,noreferrer");
  setStatus("PC에서는 Play 스토어 또는 카카오맵을 이용해 주세요.");
}

function kakaoMapHref(point) {
  const name = encodeURIComponent(point.name?.trim() || "포인트");
  return `https://map.kakao.com/link/to/${name},${point.lat},${point.lon}`;
}

/** @param {SeaPoint} point */
function renderDetailNav(point) {
  const searchText = navSearchLabel(point);
  const addr =
    point.address?.trim() || "저장된 주소 없음 (좌표로 길찾기를 이용해 주세요)";
  const coords = `${Number(point.lat).toFixed(5)}, ${Number(point.lon).toFixed(5)}`;

  const searchEl = $("#detail-nav-search-text");
  const addrEl = $("#detail-nav-address-text");
  const coordsEl = $("#detail-nav-coords-text");
  if (searchEl) searchEl.textContent = searchText;
  if (addrEl) addrEl.textContent = addr;
  if (coordsEl) coordsEl.textContent = coords;

  const kakao = $("#detail-nav-kakao");
  if (kakao) kakao.href = kakaoMapHref(point);
}

async function copyNavText(text, okMsg) {
  const value = String(text || "").trim();
  if (!value) {
    setStatus("복사할 내용이 없습니다.");
    return;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setStatus(okMsg);
  } catch {
    setStatus("복사에 실패했습니다. 길게 눌러 직접 복사해 주세요.");
  }
}

function bindDetailNavUi() {
  $("#detail-nav-copy-search")?.addEventListener("click", () => {
    const point = activePointId ? seaPoints.find((p) => p.id === activePointId) : null;
    if (!point) return;
    copyNavText(navSearchLabel(point), "티맵 검색어를 복사했습니다.");
  });
  $("#detail-nav-copy-coords")?.addEventListener("click", () => {
    const point = activePointId ? seaPoints.find((p) => p.id === activePointId) : null;
    if (!point) return;
    const coords = `${Number(point.lat).toFixed(5)}, ${Number(point.lon).toFixed(5)}`;
    copyNavText(coords, "좌표를 복사했습니다.");
  });
  $("#detail-nav-tmap")?.addEventListener("click", () => {
    const point = activePointId ? seaPoints.find((p) => p.id === activePointId) : null;
    if (!point) return;
    openTmapNavigation(point);
  });
}

function collapseListPanelDetails() {
  document.querySelectorAll("#view-list details[open]").forEach((el) => {
    el.open = false;
  });
}

function showListView() {
  destroyAllMaps();
  activePointId = null;
  $("#view-list")?.removeAttribute("hidden");
  $("#view-map")?.setAttribute("hidden", "");
  $("#view-detail")?.setAttribute("hidden", "");
  $("#view-app-share")?.setAttribute("hidden", "");
  $("#app-home-divider")?.setAttribute("hidden", "");
  renderPointList();
}

function showMapView() {
  destroyDetailMap();
  $("#view-list")?.setAttribute("hidden", "");
  $("#view-map")?.removeAttribute("hidden");
  $("#view-detail")?.setAttribute("hidden", "");
  $("#view-app-share")?.setAttribute("hidden", "");
  requestAnimationFrame(() => initMapIfNeeded());
}

function showDetailView(pointId) {
  activePointId = pointId;
  destroyMap();
  const point = seaPoints.find((p) => p.id === pointId);
  if (!point) {
    showListView();
    return;
  }
  $("#view-list")?.setAttribute("hidden", "");
  $("#view-map")?.setAttribute("hidden", "");
  $("#view-app-share")?.setAttribute("hidden", "");
  $("#view-detail")?.removeAttribute("hidden");
  $("#detail-point-name").textContent = point.name;
  $("#detail-address").textContent = point.address || `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
  renderDetailNav(point);
  $("#app-home-divider")?.removeAttribute("hidden");
  requestAnimationFrame(() => initDetailMap(point));
  loadDetailData(point);
}

function syncHomeIntro() {
  const lede = $("#app-lede");
  if (lede) lede.hidden = seaPoints.length > 0;
}

function renderPointList() {
  const empty = $("#point-empty");
  const list = $("#point-list");
  if (!empty || !list) return;

  syncHomeIntro();

  if (seaPoints.length === 0) {
    empty.hidden = false;
    list.hidden = true;
    list.replaceChildren();
    return;
  }

  empty.hidden = true;
  list.hidden = false;
  list.replaceChildren(
    ...seaPoints.map((p) => {
      const li = document.createElement("li");
      li.className = "point-list-item";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "point-list-btn";
      btn.innerHTML = `<strong>${escapeHtml(p.name)}</strong><span>${escapeHtml(p.address)}</span>`;
      btn.addEventListener("click", () => showDetailView(p.id));
      li.append(btn);
      return li;
    })
  );
}

function startNewPointOnMap() {
  editPointId = null;
  $("#point-name-input").value = "";
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        mapCenter = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        startMapView();
      },
      () => startMapView(),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 600_000 }
    );
  } else {
    startMapView();
  }
}

function startMapView() {
  showMapView();
  if (editPointId) {
    const p = seaPoints.find((x) => x.id === editPointId);
    if (p) {
      mapCenter = { lat: p.lat, lon: p.lon };
      $("#point-name-input").value = p.name;
    }
  }
  if (map) {
    map.setView([mapCenter.lat, mapCenter.lon], 15);
    refreshCenterAddress();
  }
}

function initMapIfNeeded() {
  const el = $("#map-container");
  if (!el || map) {
    map?.invalidateSize();
    return;
  }
  map = L.map(el, { zoomControl: true, attributionControl: true }).setView(
    [mapCenter.lat, mapCenter.lon],
    14
  );
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap"
  }).addTo(map);

  map.on("moveend", () => {
    const c = map.getCenter();
    mapCenter = { lat: c.lat, lon: c.lng };
    scheduleAddressLookup();
  });

  refreshCenterAddress();
}

function destroyMap() {
  if (map) {
    map.remove();
    map = null;
  }
}

function destroyDetailMap() {
  if (detailMap) {
    detailMap.remove();
    detailMap = null;
    detailMapMarker = null;
  }
}

function destroyAllMaps() {
  destroyMap();
  destroyDetailMap();
}

function initDetailMap(point) {
  const el = $("#detail-map-container");
  if (!el) return;
  destroyDetailMap();
  detailMap = L.map(el, {
    zoomControl: true,
    attributionControl: true,
    scrollWheelZoom: true
  }).setView([point.lat, point.lon], 15);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap"
  }).addTo(detailMap);
  detailMapMarker = L.marker([point.lat, point.lon]).addTo(detailMap);
  detailMapMarker.bindPopup(escapeHtml(point.name)).openPopup();
  requestAnimationFrame(() => detailMap?.invalidateSize());
}

function scheduleAddressLookup() {
  clearTimeout(addressDebounce);
  addressDebounce = setTimeout(refreshCenterAddress, 400);
}

async function refreshCenterAddress() {
  const addrEl = $("#map-center-address");
  if (addrEl) addrEl.textContent = "주소 확인 중…";
  try {
    const data = await fetchGeocode({ lat: mapCenter.lat, lon: mapCenter.lon });
    if (addrEl) addrEl.textContent = data.address || "";
    const nameInput = $("#point-name-input");
    if (nameInput && !nameInput.value.trim() && data.address) {
      const short = data.address.split(" ").slice(-2).join(" ");
      nameInput.placeholder = short || "포인트 이름";
    }
  } catch {
    if (addrEl) addrEl.textContent = `${mapCenter.lat.toFixed(5)}, ${mapCenter.lon.toFixed(5)}`;
  }
}

function bindMapSearchHintDialog() {
  if (mapSearchHintBound) return;
  mapSearchHintBound = true;
  const dialog = $("#map-search-hint-dialog");
  $("#map-search-hint-ok")?.addEventListener("click", () => {
    dialog?.close();
    const input = $("#map-search-input");
    input?.focus();
    input?.select();
  });
  dialog?.addEventListener("cancel", (e) => {
    e.preventDefault();
    dialog.close();
    $("#map-search-input")?.focus();
  });
}

function showMapSearchNoResultsDialog(query) {
  const dialog = $("#map-search-hint-dialog");
  const body = $("#map-search-hint-body");
  if (!dialog || !body) {
    setStatus("검색 결과가 없습니다. 다른 이름으로 다시 검색해 주세요.");
    return;
  }
  body.textContent =
    `「${query}」에 대한 검색 결과가 없습니다.\n\n` +
    "이름을 조금 더 넣어 보시거나, 예: 아암2 → 아암2교처럼 다리·방파제·항구 이름으로 검색해 보세요.";
  if (typeof dialog.showModal === "function" && !dialog.open) {
    dialog.showModal();
  }
}

async function runMapSearch() {
  const q = $("#map-search-input")?.value?.trim();
  const resultsEl = $("#map-search-results");
  if (!q || !resultsEl) return;
  setStatus("검색 중…");
  try {
    const data = await fetchGeocode({ q });
    const results = data.results || [];
    resultsEl.hidden = results.length === 0;
    resultsEl.replaceChildren(
      ...results.map((r) => {
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = `${r.title} — ${r.address}`;
        btn.addEventListener("click", () => {
          mapCenter = { lat: r.lat, lon: r.lon };
          map?.setView([r.lat, r.lon], 15);
          resultsEl.hidden = true;
          refreshCenterAddress();
        });
        li.append(btn);
        return li;
      })
    );
    if (results.length) {
      setStatus("");
    } else {
      setStatus("");
      showMapSearchNoResultsDialog(q);
    }
  } catch {
    setStatus("");
    showMapSearchNoResultsDialog(q);
  }
}

function showPointSaveHint(message) {
  const dialog = $("#map-search-hint-dialog");
  const body = $("#map-search-hint-body");
  const title = $("#map-search-hint-title");
  if (!dialog || !body) {
    setStatus(message);
    return;
  }
  if (title) title.textContent = "포인트 저장";
  body.textContent = message;
  if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
}

function savePointFromMap() {
  const name = $("#point-name-input")?.value?.trim();
  if (!name) {
    showPointSaveHint("포인트 이름을 입력한 뒤 «포인트 저장하기»를 눌러 주세요.");
    $("#point-name-input")?.focus();
    return;
  }
  if (!Number.isFinite(mapCenter.lat) || !Number.isFinite(mapCenter.lon)) {
    showPointSaveHint("지도에서 위치를 먼저 정해 주세요.");
    return;
  }
  let address = $("#map-center-address")?.textContent?.trim() || "";
  if (address === "주소 확인 중…") {
    address = `${mapCenter.lat.toFixed(5)}, ${mapCenter.lon.toFixed(5)}`;
  }
  const now = new Date().toISOString();

  if (editPointId) {
    const idx = seaPoints.findIndex((p) => p.id === editPointId);
    if (idx >= 0) {
      seaPoints[idx] = {
        ...seaPoints[idx],
        name,
        lat: mapCenter.lat,
        lon: mapCenter.lon,
        address,
        updatedAt: now
      };
      saveState();
      showDetailView(editPointId);
      editPointId = null;
      return;
    }
  }

  const point = {
    id: generatePointId(),
    name,
    lat: mapCenter.lat,
    lon: mapCenter.lon,
    address,
    updatedAt: now
  };
  seaPoints.unshift(point);
  saveState();
  renderPointList();
  setStatus(`「${name}」 포인트를 저장했습니다.`);
  showDetailView(point.id);
}

function deleteActivePoint() {
  if (!activePointId) return;
  if (!confirm("이 포인트를 삭제할까요?")) return;
  seaPoints = seaPoints.filter((p) => p.id !== activePointId);
  saveState();
  activePointId = null;
  showListView();
}

function showDetailLoadingPlaceholders() {
  const tideEl = $("#tide-forecast-days");
  if (tideEl) {
    tideEl.replaceChildren();
    const p = document.createElement("p");
    p.className = "forecast-loading";
    p.setAttribute("role", "status");
    p.textContent = "물때 정보를 불러오는 중…";
    tideEl.append(p);
  }
  const cur = $("#weather-current");
  if (cur) {
    cur.replaceChildren();
    const p = document.createElement("p");
    p.className = "forecast-loading";
    p.setAttribute("role", "status");
    p.textContent = "날씨 정보를 불러오는 중…";
    cur.append(p);
  }
  $("#weather-hourly")?.replaceChildren();
  const weekEl = $("#weather-forecast-days");
  if (weekEl) {
    weekEl.replaceChildren();
    const p = document.createElement("p");
    p.className = "forecast-loading";
    p.textContent = "주간 날씨를 불러오는 중…";
    weekEl.append(p);
  }
}

async function loadDetailData(point) {
  clearDetailPanels();
  showDetailLoadingPlaceholders();

  setStatus("물때·날씨 불러오는 중…");
  const tideDates = Array.from({ length: TIDE_FORECAST_DAYS }, (_, i) => addDays(new Date(), i));
  const [tideResults, weather] = await Promise.all([
    Promise.all(
      tideDates.map((d) =>
        fetchTide(point.lat, point.lon, formatYmd(d)).catch(() => null)
      )
    ),
    fetchWeather(point.lat, point.lon).catch(() => null),
  ]);
  setStatus("");

  renderTideForecast(tideResults, tideDates, point);
  renderWeather(weather);
}

function clearDetailPanels() {
  $("#tide-forecast-days")?.replaceChildren();
  $("#weather-current")?.replaceChildren();
  $("#weather-hourly")?.replaceChildren();
  $("#weather-forecast-days")?.replaceChildren();
}

function formatYmd(d) {
  return (
    String(d.getFullYear()) +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0")
  );
}

function addDays(base, offset) {
  const d = new Date(base);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
}

function tidePhaseLabel(data) {
  const items = data?.items || [];
  const highs = items.filter((i) => i.type === "high");
  const lows = items.filter((i) => i.type === "low");
  const range =
    highs.length && lows.length
      ? Math.max(...highs.map((h) => h.levelCm || 0)) - Math.min(...lows.map((l) => l.levelCm || 0))
      : 0;
  if (!items.length) return "";
  return range >= 400 ? "사리 (대조)" : range >= 250 ? "조금 (중조)" : "조금 (소조)";
}

function buildTideStationNote(data, point, isFirstDay) {
  if (!isFirstDay) return "";
  const st = data?.station;
  let note = st ? `기준 관측소: ${st.name} (${st.code}) · 약 ${data.distanceKm ?? "?"}km` : "";
  if (point && (data?.distanceKm ?? 0) > 80) {
    note += ` · 저장 좌표가 멀 수 있습니다. 「위치 다시 잡기」로 맞춰 주세요.`;
  }
  if (!data?.configured) {
    note += (note ? " · " : "") + (data?.message || "Vercel에 KHOA_SERVICE_KEY를 설정하세요.");
  } else if (data?.error && !(data.items || []).length) {
    note +=
      (note ? " · " : "") +
      (data.message || "마이페이지 일반 인증키를 Vercel에 넣고 Redeploy 해 보세요.");
  }
  return note;
}

function renderTideForecast(tideResults, dates, point) {
  const container = $("#tide-forecast-days");
  if (!container) return;

  container.replaceChildren(
    ...tideResults.map((data, index) => {
      const article = document.createElement("article");
      article.className = "forecast-day";

      const heading = document.createElement("h4");
      heading.className = "forecast-day-title";
      const dayLabel = index === 0 ? "오늘" : index === 1 ? "내일" : formatKoreanDate(dates[index]);
      heading.textContent = `${dayLabel} · ${formatKoreanDate(dates[index])}`;
      article.append(heading);

      const phase = document.createElement("p");
      phase.className = "tide-phase";

      if (!data) {
        phase.textContent = "물때 정보를 불러오지 못했습니다.";
        article.append(phase);
        return article;
      }

      if (!data.configured) {
        phase.textContent = "조석 API 키 미설정";
        article.append(phase);
      } else if (data.error && !(data.items || []).length) {
        phase.textContent = "물때 조회 실패";
        article.append(phase);
      } else {
        phase.textContent = tidePhaseLabel(data) || "물때";
        article.append(phase);

        const list = document.createElement("ul");
        list.className = "tide-times";
        const items = data.items || [];
        list.replaceChildren(
          ...items.slice(0, 8).map((row) => {
            const li = document.createElement("li");
            const label = row.type === "high" ? "만조" : row.type === "low" ? "간조" : "조석";
            const h = row.levelCm != null ? ` · ${row.levelCm}cm` : "";
            li.textContent = `${label} ${row.time}${h}`;
            return li;
          })
        );
        article.append(list);
      }

      const note = buildTideStationNote(data, point, index === 0);
      if (note) {
        const noteEl = document.createElement("p");
        noteEl.className = "data-note";
        noteEl.textContent = note;
        article.append(noteEl);
      }

      return article;
    })
  );
}

function renderWeather(data) {
  const cur = $("#weather-current");
  const hourly = $("#weather-hourly");
  const weekEl = $("#weather-forecast-days");
  if (!data || !cur || !hourly) {
    cur && (cur.textContent = "날씨 정보를 불러오지 못했습니다.");
    return;
  }

  const today = data.daily?.[0];
  const rows = [
    ["기온", `${data.current.temp}°C · ${data.current.label}`],
    ["오늘 최고/최저", today ? `${today.max}°C / ${today.min}°C` : "—"],
    ["강수 확률", today ? `${today.precipProb}%` : "—"],
    ["풍속", `${data.current.wind} m/s`],
    ["파고", data.marine.wave != null ? `${data.marine.wave} m` : "—"],
    ["습도", data.current.humidity != null ? `${data.current.humidity}%` : "—"],
  ];
  cur.replaceChildren(
    ...rows.map(([k, v]) => {
      const p = document.createElement("p");
      p.innerHTML = `<strong>${escapeHtml(k)}</strong><br>${escapeHtml(v)}`;
      return p;
    })
  );

  hourly.replaceChildren(
    ...(data.hourly || []).slice(0, 12).map((h) => {
      const li = document.createElement("li");
      li.innerHTML = `${escapeHtml(h.time)}<br>${h.temp}°<br>${escapeHtml(h.icon)}`;
      return li;
    })
  );

  if (!weekEl) return;
  weekEl.replaceChildren(
    ...(data.daily || []).map((day, index) => {
      const card = document.createElement("article");
      card.className = "forecast-day weather-day-card";
      const title = document.createElement("h4");
      title.className = "forecast-day-title";
      title.textContent =
        index === 0
          ? `오늘 · ${day.label}`
          : index === 1
            ? `내일 · ${day.label}`
            : day.label;
      card.append(title);

      const body = document.createElement("p");
      body.className = "weather-day-summary";
      body.innerHTML = `${escapeHtml(day.icon)} <strong>${day.max}°</strong> / ${day.min}° · 강수 ${day.precipProb}%`;
      card.append(body);
      return card;
    })
  );
}

function buildClientSearchVariants(q) {
  const variants = [];
  const add = (s) => {
    const t = String(s || "").trim();
    if (t && !variants.includes(t)) variants.push(t);
  };
  add(q);
  const compact = q.replace(/\s+/g, "");
  if (compact !== q) add(compact);
  if (/[0-9]$/.test(compact)) {
    for (const sfx of ["교", "대교", "방파제", "항", "선착장", "부두"]) {
      if (!compact.endsWith(sfx)) add(compact + sfx);
    }
  }
  return variants.slice(0, 6);
}

function rankClientGeocodeResults(list, q) {
  const nq = q.replace(/\s+/g, "").toLowerCase();
  const seen = new Set();
  const uniq = [];
  for (const r of list) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
    const key = `${r.lat.toFixed(5)},${r.lon.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(r);
  }
  const score = (r) => {
    const title = String(r.title || "")
      .replace(/\s+/g, "")
      .toLowerCase();
    const addr = String(r.address || "")
      .replace(/\s+/g, "")
      .toLowerCase();
    if (title.includes(nq)) return 70;
    if (addr.includes(nq)) return 40;
    return 10;
  };
  return uniq.sort((a, b) => score(b) - score(a)).slice(0, 12);
}

async function fetchGeocode(params) {
  const qs = new URLSearchParams(params);
  try {
    const res = await fetch(`/api/geocode?${qs}`);
    if (res.ok) return res.json();
  } catch {
    /* static/local — no serverless */
  }
  return fallbackGeocode(params);
}

async function fallbackGeocode(params) {
  const headers = { "User-Agent": "SeaTidePWA/1.0 (sea.uxpwa.com)" };
  if (params.q) {
    const variants = buildClientSearchVariants(params.q);
    const merged = [];
    for (const variant of variants) {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(variant)}&format=json&limit=8&countrycodes=kr`;
      const list = await fetch(url, { headers }).then((r) => r.json());
      for (const d of list || []) {
        merged.push({
          title: d.display_name.split(",")[0],
          address: d.display_name,
          lat: Number(d.lat),
          lon: Number(d.lon),
        });
      }
      if (merged.length >= 8) break;
    }
    if (merged.length === 0) {
      const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(params.q)}&lang=ko&limit=8&bbox=124.5,33,131.5,39.5`;
      const photon = await fetch(photonUrl).then((r) => r.json());
      for (const f of photon.features || []) {
        const p = f.properties || {};
        const coords = f.geometry?.coordinates || [];
        const title = p.name || p.street || params.q;
        const address = [p.state, p.city, p.street].filter(Boolean).join(" ");
        merged.push({
          title: String(title),
          address: address || String(title),
          lat: Number(coords[1]),
          lon: Number(coords[0]),
        });
      }
    }
    return { results: rankClientGeocodeResults(merged, params.q) };
  }
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${params.lat}&lon=${params.lon}&format=json&zoom=14`;
  const data = await fetch(url, { headers }).then((r) => r.json());
  return { address: data.display_name || `${params.lat}, ${params.lon}` };
}

async function fetchTide(lat, lon, ymd) {
  const qs = new URLSearchParams({ lat: String(lat), lon: String(lon), date: ymd });
  try {
    const res = await fetch(`/api/tide?${qs}`);
    const data = await res.json().catch(() => null);
    if (data) return data;
  } catch {
    /* ignore */
  }
  return { configured: false, items: [], message: "로컬 미리보기 — Vercel 배포 후 조석 API 사용" };
}

async function fetchWeather(lat, lon) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("timezone", "Asia/Seoul");
  url.searchParams.set(
    "current",
    "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m"
  );
  url.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"
  );
  url.searchParams.set("hourly", "temperature_2m,weather_code");
  url.searchParams.set("forecast_days", String(WEATHER_FORECAST_DAYS));

  const marineUrl = new URL("https://marine-api.open-meteo.com/v1/marine");
  marineUrl.searchParams.set("latitude", String(lat));
  marineUrl.searchParams.set("longitude", String(lon));
  marineUrl.searchParams.set("timezone", "Asia/Seoul");
  marineUrl.searchParams.set("current", "wave_height");

  const [wRes, mRes] = await Promise.all([fetch(url), fetch(marineUrl)]);
  const w = await wRes.json();
  const m = await mRes.json();

  const code = w.current?.weather_code ?? 0;
  const hours = w.hourly?.time || [];
  const temps = w.hourly?.temperature_2m || [];
  const codes = w.hourly?.weather_code || [];
  const nowHour = new Date().getHours();

  const hourly = hours
    .map((t, i) => ({ t, temp: temps[i], code: codes[i] }))
    .filter((row) => {
      const h = new Date(row.t).getHours();
      return h >= nowHour && h < nowHour + 12;
    })
    .map((row) => ({
      time: String(new Date(row.t).getHours()).padStart(2, "0") + ":00",
      temp: Math.round(row.temp),
      icon: weatherEmoji(row.code)
    }));

  const dailyTimes = w.daily?.time || [];
  const daily = dailyTimes.map((t, i) => {
    const d = new Date(t);
    const codeDay = w.daily?.weather_code?.[i] ?? 0;
    return {
      label: `${d.getMonth() + 1}/${d.getDate()} (${weekdayShort(d)})`,
      max: Math.round(w.daily?.temperature_2m_max?.[i] ?? 0),
      min: Math.round(w.daily?.temperature_2m_min?.[i] ?? 0),
      precipProb: w.daily?.precipitation_probability_max?.[i] ?? 0,
      icon: weatherEmoji(codeDay),
    };
  });

  return {
    current: {
      temp: Math.round(w.current?.temperature_2m ?? 0),
      label: weatherLabel(code),
      wind: Math.round((w.current?.wind_speed_10m ?? 0) * 10) / 10,
      humidity: w.current?.relative_humidity_2m,
    },
    daily,
    marine: {
      wave: m.current?.wave_height != null ? Math.round(m.current.wave_height * 10) / 10 : null,
    },
    hourly,
  };
}

function weekdayShort(d) {
  return ["일", "월", "화", "수", "목", "금", "토"][d.getDay()];
}

function formatKoreanDate(d) {
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
}

function weatherLabel(code) {
  const map = {
    0: "맑음",
    1: "대체로 맑음",
    2: "구름 조금",
    3: "흐림",
    45: "안개",
    48: "안개",
    51: "이슬비",
    61: "비",
    71: "눈",
    80: "소나기",
    95: "뇌우"
  };
  return map[code] || "흐림";
}

function weatherEmoji(code) {
  if (code === 0) return "☀️";
  if (code <= 3) return "⛅";
  if (code >= 61 && code <= 67) return "🌧";
  if (code >= 71 && code <= 77) return "❄️";
  if (code >= 95) return "⛈";
  return "☁️";
}

function setStatus(msg) {
  const el = $("#sea-status");
  if (el) el.textContent = msg;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function bindInstall() {
  const btn = $("#install-btn");
  let deferred = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    if (btn) btn.hidden = false;
  });
  btn?.addEventListener("click", async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    if (btn) btn.hidden = true;
  });
}

function getAppPublicShareUrl() {
  const canonical = document.querySelector('link[rel="canonical"]')?.href?.trim();
  if (canonical) return canonical;
  const u = new URL(location.href);
  u.search = "";
  u.hash = "";
  return u.href;
}

function qrCodeImageUrl(text, size = 512) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=14&data=${encodeURIComponent(text)}`;
}

function formatAppShareUrlDisplay(absoluteUrl) {
  try {
    const host = new URL(absoluteUrl).hostname;
    if (host) return host;
  } catch {
    /* ignore */
  }
  return absoluteUrl.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

function renderAppSharePage() {
  const url = getAppPublicShareUrl();
  const displayUrl = formatAppShareUrlDisplay(url);
  const urlEl = $("#app-share-url");
  const qrImg = $("#app-share-qr");
  if (urlEl) urlEl.textContent = displayUrl;
  if (qrImg) {
    qrImg.src = qrCodeImageUrl(url, 512);
    qrImg.alt = `물때첩 앱 주소 QR 코드 — ${displayUrl}`;
  }
}

function showAppShareView() {
  collapseListPanelDetails();
  $("#view-list")?.setAttribute("hidden", "");
  $("#view-map")?.setAttribute("hidden", "");
  $("#view-detail")?.setAttribute("hidden", "");
  $("#view-app-share")?.removeAttribute("hidden");
  renderAppSharePage();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function bindAppShareUi() {
  $("#app-share-btn")?.addEventListener("click", () => {
    showAppShareView();
  });
  $("#btn-back-from-app-share")?.addEventListener("click", () => {
    showListView();
    setStatus("");
  });
}

init();

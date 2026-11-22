const SEA_STORAGE_KEY = "sea-points-v1";

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

const $ = (sel) => document.querySelector(sel);

init();

function init() {
  if (!document.body.classList.contains("sea-app")) return;
  loadState();
  bindUi();
  registerServiceWorker();
  bindInstall();
  showListView();
  renderPointList();
}

function loadState() {
  try {
    const raw = localStorage.getItem(SEA_STORAGE_KEY);
    seaPoints = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(seaPoints)) seaPoints = [];
  } catch {
    seaPoints = [];
  }
}

function saveState() {
  localStorage.setItem(SEA_STORAGE_KEY, JSON.stringify(seaPoints));
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
  $("#point-save-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    savePointFromMap();
  });
  $("#btn-back-list")?.addEventListener("click", showListView);
  $("#btn-delete-point")?.addEventListener("click", deleteActivePoint);
  $("#btn-edit-point")?.addEventListener("click", () => {
    if (!activePointId) return;
    editPointId = activePointId;
    startMapView();
  });
}

function showListView() {
  destroyAllMaps();
  $("#view-list")?.removeAttribute("hidden");
  $("#view-map")?.setAttribute("hidden", "");
  $("#view-detail")?.setAttribute("hidden", "");
  $("#app-home-divider")?.setAttribute("hidden", "");
  renderPointList();
}

function showMapView() {
  destroyDetailMap();
  $("#view-list")?.setAttribute("hidden", "");
  $("#view-map")?.removeAttribute("hidden");
  $("#view-detail")?.setAttribute("hidden", "");
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
  $("#view-detail")?.removeAttribute("hidden");
  $("#detail-point-name").textContent = point.name;
  $("#detail-address").textContent = point.address || `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
  $("#app-home-divider")?.removeAttribute("hidden");
  requestAnimationFrame(() => initDetailMap(point));
  loadDetailData(point);
}

function renderPointList() {
  const empty = $("#point-empty");
  const list = $("#point-list");
  if (!empty || !list) return;

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
    setStatus(results.length ? "" : "검색 결과가 없습니다.");
  } catch {
    setStatus("검색에 실패했습니다. 잠시 후 다시 시도해 주세요.");
  }
}

function savePointFromMap() {
  const name = $("#point-name-input")?.value?.trim();
  if (!name) return;
  const address = $("#map-center-address")?.textContent?.trim() || "";
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
    id: crypto.randomUUID(),
    name,
    lat: mapCenter.lat,
    lon: mapCenter.lon,
    address,
    updatedAt: now
  };
  seaPoints.unshift(point);
  saveState();
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

async function loadDetailData(point) {
  clearDetailPanels();
  const date = new Date();
  const ymd =
    String(date.getFullYear()) +
    String(date.getMonth() + 1).padStart(2, "0") +
    String(date.getDate()).padStart(2, "0");
  $("#tide-date").textContent = formatKoreanDate(date);

  setStatus("물때·날씨 불러오는 중…");
  const [tide, weather] = await Promise.all([
    fetchTide(point.lat, point.lon, ymd).catch(() => null),
    fetchWeather(point.lat, point.lon).catch(() => null)
  ]);
  setStatus("");

  renderTide(tide);
  renderWeather(weather);
}

function clearDetailPanels() {
  $("#tide-phase").textContent = "";
  $("#tide-times").replaceChildren();
  $("#tide-station-note").textContent = "";
  $("#weather-current").replaceChildren();
  $("#weather-hourly").replaceChildren();
}

function renderTide(data) {
  const phaseEl = $("#tide-phase");
  const listEl = $("#tide-times");
  const noteEl = $("#tide-station-note");
  if (!data) {
    if (phaseEl) phaseEl.textContent = "물때 정보를 불러오지 못했습니다.";
    return;
  }

  if (noteEl) {
    const st = data.station;
    noteEl.textContent = st
      ? `기준 관측소: ${st.name} (${st.code}) · 약 ${data.distanceKm ?? "?"}km`
      : "";
  }

  if (!data.configured) {
    if (phaseEl) phaseEl.textContent = "조석 API 키 미설정";
    if (noteEl)
      noteEl.textContent +=
        (noteEl.textContent ? " · " : "") +
        (data.message || "Vercel에 KHOA_SERVICE_KEY를 설정하세요.");
    return;
  }

  if (data.error && !(data.items || []).length) {
    if (phaseEl) phaseEl.textContent = "물때 조회 실패 (키는 등록됨)";
    if (noteEl) {
      const extra = data.message || "공공데이터 **일반 인증키(디코딩)** 로 Vercel 값을 바꾼 뒤 Redeploy 해 보세요.";
      noteEl.textContent += (noteEl.textContent ? " · " : "") + extra;
    }
    return;
  }

  const items = data.items || [];
  const highs = items.filter((i) => i.type === "high");
  const lows = items.filter((i) => i.type === "low");
  const range =
    highs.length && lows.length
      ? Math.max(...highs.map((h) => h.levelCm || 0)) -
        Math.min(...lows.map((l) => l.levelCm || 0))
      : 0;
  if (phaseEl) {
    phaseEl.textContent =
      range >= 400 ? "사리 (대조)" : range >= 250 ? "조금 (중조)" : "조금 (소조)";
  }

  if (listEl) {
    listEl.replaceChildren(
      ...items.slice(0, 8).map((row) => {
        const li = document.createElement("li");
        const label = row.type === "high" ? "만조" : row.type === "low" ? "간조" : "조석";
        const h = row.levelCm != null ? ` · ${row.levelCm}cm` : "";
        li.textContent = `${label} ${row.time}${h}`;
        return li;
      })
    );
  }
}

function renderWeather(data) {
  const cur = $("#weather-current");
  const hourly = $("#weather-hourly");
  if (!data || !cur || !hourly) {
    cur && (cur.textContent = "날씨 정보를 불러오지 못했습니다.");
    return;
  }

  const rows = [
    ["기온", `${data.current.temp}°C · ${data.current.label}`],
    ["최고/최저", `${data.daily.max}°C / ${data.daily.min}°C`],
    ["강수 확률", `${data.daily.precipProb}%`],
    ["풍속", `${data.current.wind} m/s`],
    ["파고", data.marine.wave != null ? `${data.marine.wave} m` : "—"],
    ["습도", data.current.humidity != null ? `${data.current.humidity}%` : "—"]
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
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(params.q)}&format=json&limit=8&countrycodes=kr`;
    const list = await fetch(url, { headers }).then((r) => r.json());
    return {
      results: (list || []).map((d) => ({
        title: d.display_name.split(",")[0],
        address: d.display_name,
        lat: Number(d.lat),
        lon: Number(d.lon)
      }))
    };
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
  url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_probability_max");
  url.searchParams.set("hourly", "temperature_2m,weather_code");
  url.searchParams.set("forecast_days", "2");

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

  return {
    current: {
      temp: Math.round(w.current?.temperature_2m ?? 0),
      label: weatherLabel(code),
      wind: Math.round((w.current?.wind_speed_10m ?? 0) * 10) / 10,
      humidity: w.current?.relative_humidity_2m
    },
    daily: {
      max: Math.round(w.daily?.temperature_2m_max?.[0] ?? 0),
      min: Math.round(w.daily?.temperature_2m_min?.[0] ?? 0),
      precipProb: w.daily?.precipitation_probability_max?.[0] ?? 0
    },
    marine: {
      wave: m.current?.wave_height != null ? Math.round(m.current.wave_height * 10) / 10 : null
    },
    hourly
  };
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

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const v = await fetch("./version.json", { cache: "no-store" }).then((r) => r.json());
    await navigator.serviceWorker.register(`./sw.js?build=${v.build || 1}`);
  } catch {
    /* ignore */
  }
}
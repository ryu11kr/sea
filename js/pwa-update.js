/** 물때첩 — 새 배포 알림·서비스워커 동기화 */

const APP_VERSION_SEEN_KEY = "sea-app-version-seen-build";
const APP_UPDATE_COMPLETE_KEY = "sea-show-update-complete";

let registration = null;
let reloadOnControllerChange = false;
let appVersionPollId = null;
let appUpdateCompleteDialogBound = false;
let registeredTargetBuild = 0;
const watchedRegistrations = new WeakSet();
/** @type {{ cachePrefix?: string } | null} */
let pwaConfig = null;

function cachePrefix() {
  return pwaConfig?.cachePrefix || "sea-tide";
}

async function loadPwaConfig() {
  try {
    const res = await fetch("./pwa.config.json", { cache: "no-store" });
    if (res.ok) pwaConfig = await res.json();
  } catch {
    /* ignore */
  }
}

function markAppUpdateCompletePending() {
  try {
    sessionStorage.setItem(APP_UPDATE_COMPLETE_KEY, "1");
  } catch {
    /* ignore */
  }
}

function maybeShowAppUpdateCompleteDialog() {
  try {
    if (sessionStorage.getItem(APP_UPDATE_COMPLETE_KEY) !== "1") return;
    sessionStorage.removeItem(APP_UPDATE_COMPLETE_KEY);
  } catch {
    return;
  }
  const dialog = document.querySelector("#app-update-complete-dialog");
  const okBtn = document.querySelector("#app-update-complete-ok");
  if (!dialog || !okBtn) return;

  if (!appUpdateCompleteDialogBound) {
    appUpdateCompleteDialogBound = true;
    okBtn.addEventListener("click", () => {
      if (dialog.open) dialog.close();
    });
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      dialog.close();
    });
  }

  const banner = document.querySelector("#app-update-banner");
  if (banner) banner.hidden = true;

  if (typeof dialog.showModal === "function") {
    dialog.showModal();
    okBtn.focus();
  }
}

async function fetchAppVersionMeta() {
  for (const path of ["/api/app-version", "./version.json"]) {
    try {
      const response = await fetch(`${path}?t=${Date.now()}`, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
      });
      if (!response.ok) continue;
      const data = await response.json();
      if (data?.build != null) return data;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function readSeenAppVersion() {
  const raw = localStorage.getItem(APP_VERSION_SEEN_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* ignore */
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? { build: n } : null;
}

function writeSeenAppVersion(meta) {
  if (!meta?.build) return;
  localStorage.setItem(
    APP_VERSION_SEEN_KEY,
    JSON.stringify({
      build: meta.build,
      commitSha: meta.commitSha || null,
      updatedAt: meta.updatedAt || null,
    })
  );
}

function getPageDeployVersion() {
  const v = window.SEA_DEPLOY_VERSION;
  if (!v || typeof v !== "object") return null;
  return v;
}

/** 지금 실행 중인 번들(HTML에 박힌 deploy-version)이 서버보다 오래됐는지 */
function pageBundleIsStale(serverMeta) {
  if (!serverMeta?.build) return false;
  const embedded = getPageDeployVersion();
  if (!embedded) return false;
  if (serverMeta.commitSha && embedded.commitSha) {
    return serverMeta.commitSha !== embedded.commitSha;
  }
  if (serverMeta.updatedAt && embedded.updatedAt) {
    return serverMeta.updatedAt !== embedded.updatedAt;
  }
  return Number(serverMeta.build) !== Number(embedded.build);
}

function serverVersionIsNewer(meta, seen) {
  if (!meta?.build) return false;
  if (!seen) return true;
  if (meta.commitSha && (!seen.commitSha || meta.commitSha !== seen.commitSha)) return true;
  if (meta.updatedAt && seen.updatedAt && meta.updatedAt !== seen.updatedAt) return true;
  return Number(meta.build) !== Number(seen.build);
}

function serviceWorkerIsBehind(serverMeta) {
  if (!serverMeta?.build) return false;
  const controllerBuild = getControllerBuild();
  if (!controllerBuild) return Number(serverMeta.build) > 0;
  return Number(serverMeta.build) > controllerBuild;
}

function shouldPromptAppUpdate(serverMeta) {
  if (!serverMeta?.build) return false;
  if (pageBundleIsStale(serverMeta)) return true;
  if (serviceWorkerIsBehind(serverMeta)) return true;
  const seen = readSeenAppVersion();
  if (!seen) return false;
  return serverVersionIsNewer(serverMeta, seen);
}

function showAppUpdateBanner(meta) {
  const banner = document.querySelector("#app-update-banner");
  if (banner && !banner.hidden) return;
  if (banner) {
    banner.hidden = false;
    if (meta?.build != null) banner.dataset.pendingBuild = String(meta.build);
    if (meta?.commitSha) banner.dataset.pendingSha = meta.commitSha;
  }
  syncServiceWorker().catch(() => {});
}

async function bootstrapAppVersionCheck() {
  const meta = await fetchAppVersionMeta();
  if (!meta?.build) return;
  if (shouldPromptAppUpdate(meta)) {
    showAppUpdateBanner(meta);
    return;
  }
  const seen = readSeenAppVersion();
  if (!seen) writeSeenAppVersion(meta);
}

async function checkAppVersionUpdate() {
  const meta = await fetchAppVersionMeta();
  if (!meta?.build) return;
  if (shouldPromptAppUpdate(meta)) {
    showAppUpdateBanner(meta);
  }
}

async function purgeInstalledAppCaches() {
  if (!("caches" in window)) return;
  const prefix = cachePrefix();
  try {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((key) => key === prefix || key.startsWith(`${prefix}-`)).map((key) => caches.delete(key))
    );
  } catch (err) {
    console.error(err);
  }
  try {
    const reg = await navigator.serviceWorker?.ready;
    reg?.active?.postMessage({ type: "PURGE_CACHES" });
  } catch {
    /* ignore */
  }
}

async function applyAppUpdate() {
  const banner = document.querySelector("#app-update-banner");
  const pending = banner?.dataset.pendingBuild;
  const pendingSha = banner?.dataset.pendingSha;

  await purgeInstalledAppCaches();

  const finish = async () => {
    const meta = await fetchAppVersionMeta();
    if (meta) writeSeenAppVersion(meta);
    else if (pending || pendingSha) {
      writeSeenAppVersion({
        build: pending ? Number(pending) : 0,
        commitSha: pendingSha || null,
      });
    }
    markAppUpdateCompletePending();
    const url = new URL(location.href);
    url.search = "";
    url.hash = "";
    url.searchParams.set("v", pending || String(Date.now()));
    location.replace(url.href);
  };

  if (registration) {
    try {
      await registration.update();
    } catch {
      /* ignore */
    }
  }
  if (registration?.waiting) {
    reloadOnControllerChange = true;
    registration.waiting.postMessage({ type: "SKIP_WAITING" });
    window.setTimeout(() => finish(), 400);
    return;
  }
  await finish();
}

function getControllerBuild() {
  const script = navigator.serviceWorker.controller?.scriptURL;
  if (!script) return 0;
  const build = new URL(script, location.href).searchParams.get("build");
  return build ? Number(build) : 0;
}

async function fetchVersionInfo() {
  const response = await fetch(`./version.json?check=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) return null;
  return response.json();
}

function watchUpdates(reg) {
  if (watchedRegistrations.has(reg)) return;
  watchedRegistrations.add(reg);

  if (reg.waiting && navigator.serviceWorker.controller) {
    const build = new URL(reg.waiting.scriptURL, location.href).searchParams.get("build");
    fetchVersionInfo().then((info) => {
      showAppUpdateBanner(info || (build ? { build: Number(build) } : null));
    });
  }

  reg.addEventListener("updatefound", () => {
    const worker = reg.installing;
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed" && navigator.serviceWorker.controller) {
        syncServiceWorker().catch(() => {});
      }
    });
  });
}

async function syncServiceWorker() {
  const versionInfo = await fetchVersionInfo();
  const serverBuild = versionInfo?.build ?? 0;
  const controllerBuild = getControllerBuild();

  if (versionInfo && shouldPromptAppUpdate(versionInfo)) {
    showAppUpdateBanner(versionInfo);
  }

  if (!versionInfo?.build) return;

  const swUrl = `./sw.js?build=${serverBuild}`;
  const shouldRegister =
    !registration || (serverBuild > controllerBuild && serverBuild > registeredTargetBuild);

  if (shouldRegister) {
    registration = await navigator.serviceWorker.register(swUrl, { scope: "./" });
    registeredTargetBuild = serverBuild;
    watchUpdates(registration);
  }

  await registration?.update();
  if (registration) await navigator.serviceWorker.ready;

  const waiting = registration?.waiting && navigator.serviceWorker.controller;
  if (serverBuild > controllerBuild && waiting) {
    showAppUpdateBanner(versionInfo);
  }
}

function bindAppUpdateUi() {
  document.querySelector("#app-update-apply")?.addEventListener("click", () => {
    applyAppUpdate();
  });
  maybeShowAppUpdateCompleteDialog();
  bootstrapAppVersionCheck().catch(() => {});
  if (appVersionPollId) clearInterval(appVersionPollId);
  appVersionPollId = window.setInterval(() => {
    checkAppVersionUpdate().catch(() => {});
    syncServiceWorker().catch(() => {});
  }, 20_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      checkAppVersionUpdate().catch(() => {});
      syncServiceWorker().catch(() => {});
    }
  });
}

export async function initSeaPwaUpdate() {
  if (!("serviceWorker" in navigator)) return;
  await loadPwaConfig();
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadOnControllerChange) location.reload();
  });
  bindAppUpdateUi();
  await syncServiceWorker();
}
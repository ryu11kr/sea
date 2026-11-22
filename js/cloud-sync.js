import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.8/+esm";
import {
  bindCloudSaveListener,
  flushCloudPush,
  runFullCloudSync,
  scheduleCloudPush,
  setCloudSyncStatusCallback,
} from "./cloud-sync-data.js";
import {
  authFetch,
  hideShareAcceptBusy,
  initSeaShareUi,
  refreshIncomingForSession,
  refreshIncomingShareRequests,
  resolveSessionEmail,
  syncSeaShareTeaserVisibility,
  showShareAcceptBusy,
  startIncomingSharePolling,
  stopIncomingSharePolling,
  yieldToPaint,
} from "./cloud-share.js";

let accountDeleteUiBound = false;

const DEFAULT_CLOUD_SYNC_CONFIG = {
  enabled: true,
  showTeaser: true,
  showGoogleLogin: true,
  teaserTitle: "포인트 저장",
  teaserMessage:
    "구글로 로그인하면 바다 포인트 목록을 안전하게 보관합니다. 기기를 바꿔도 같은 구글 계정으로 다시 불러올 수 있습니다. 로그인하지 않으면 이 기기에만 저장됩니다.",
};

/** @type {typeof DEFAULT_CLOUD_SYNC_CONFIG | null} */
let cloudSyncCfg = null;
/** @type {{ configured: boolean, supabaseUrl: string | null, supabaseAnonKey: string | null } | null} */
let cloudSyncRuntime = null;
/** @type {import("@supabase/supabase-js").SupabaseClient | null} */
let supabaseClient = null;
let cloudSaveListenerBound = false;
/** @type {((text: string) => void) | null} */
let shareIncomingStatusCb = null;

async function loadCloudSyncConfig() {
  const cfg = { ...DEFAULT_CLOUD_SYNC_CONFIG };
  try {
    const response = await fetch("./cloud-sync.config.json", { cache: "no-store" });
    if (!response.ok) return cfg;
    const data = await response.json();
    if (typeof data === "object" && data) {
      if (typeof data.enabled === "boolean") cfg.enabled = data.enabled;
      if (typeof data.showTeaser === "boolean") cfg.showTeaser = data.showTeaser;
      if (typeof data.showGoogleLogin === "boolean") cfg.showGoogleLogin = data.showGoogleLogin;
      if (typeof data.teaserTitle === "string" && data.teaserTitle.trim()) {
        cfg.teaserTitle = data.teaserTitle.trim();
      }
      if (typeof data.teaserMessage === "string" && data.teaserMessage.trim()) {
        cfg.teaserMessage = data.teaserMessage.trim();
      }
    }
  } catch {
    /* ignore */
  }
  return cfg;
}

async function loadCloudSyncRuntime() {
  try {
    const response = await fetch(`./cloud-sync.runtime.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json();
    const configured = Boolean(data.configured && data.supabaseUrl && data.supabaseAnonKey);
    return {
      configured,
      supabaseUrl: configured ? String(data.supabaseUrl) : null,
      supabaseAnonKey: configured ? String(data.supabaseAnonKey) : null,
    };
  } catch {
    return null;
  }
}

function authRedirectUrl() {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  let path = url.pathname || "/";
  if (path.endsWith("/index.html")) path = path.replace(/\/index\.html$/i, "/");
  if (!path.endsWith("/")) path += "/";
  return `${url.origin}${path}`;
}

function createAuthStorage() {
  const mirror = "sea-auth-mirror:";
  return {
    getItem(key) {
      try {
        const v = window.localStorage.getItem(key);
        if (v != null) return v;
      } catch {
        /* ignore */
      }
      try {
        return window.sessionStorage.getItem(mirror + key);
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* ignore */
      }
      try {
        window.sessionStorage.setItem(mirror + key, value);
      } catch {
        /* ignore */
      }
    },
    removeItem(key) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
      try {
        window.sessionStorage.removeItem(mirror + key);
      } catch {
        /* ignore */
      }
    },
  };
}

function purgeSupabaseAuthKeys() {
  for (const store of [window.localStorage, window.sessionStorage]) {
    try {
      const remove = [];
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key?.startsWith("sb-") || key?.startsWith("sea-auth-mirror:")) remove.push(key);
      }
      remove.forEach((key) => store.removeItem(key));
    } catch {
      /* ignore */
    }
  }
}

function waitForAuthReady(client, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let settled = false;
    let subscription = null;
    const finish = (session) => {
      if (settled) return;
      settled = true;
      subscription?.unsubscribe();
      resolve(session);
    };
    const { data } = client.auth.onAuthStateChange((event, session) => {
      if (session?.user || event === "SIGNED_IN") finish(session);
    });
    subscription = data.subscription;
    client.auth.getSession().then(({ data: sessData }) => {
      if (sessData.session?.user) finish(sessData.session);
    });
    window.setTimeout(() => finish(null), timeoutMs);
  });
}

async function completeOAuthReturnIfNeeded(client) {
  const code = new URLSearchParams(window.location.search).get("code");
  if (!code) return "none";
  const existing = await client.auth.getSession();
  if (existing.data.session?.user) {
    window.history.replaceState({}, document.title, authRedirectUrl());
    return "ok";
  }
  const { error } = await client.auth.exchangeCodeForSession(code);
  if (error) {
    console.error(error);
    return "error";
  }
  window.history.replaceState({}, document.title, authRedirectUrl());
  return "ok";
}

function formatSignedInLabel(user) {
  const meta = user?.user_metadata || {};
  const name = meta.full_name || meta.name;
  const email = user?.email;
  if (name && email) return `${name} (${email})`;
  if (email) return email;
  return "구글 계정으로 로그인됨";
}

function startSessionCloudSync(session, cfg) {
  if (!cfg.enabled || !supabaseClient || !session?.user?.id) return;
  const userId = session.user.id;
  if (!cloudSaveListenerBound) {
    bindCloudSaveListener(supabaseClient, userId, cfg.enabled);
    cloudSaveListenerBound = true;
  }
  runFullCloudSync(supabaseClient, userId).catch((err) => console.error(err));
}

function bindAccountDeleteUi(client, renderSession) {
  if (accountDeleteUiBound) return;
  accountDeleteUiBound = true;

  const btn = document.querySelector("#sea-account-delete-btn");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    const ok = window.confirm(
      "정말 서비스를 탈퇴하시겠습니까?\n\n" +
        "· 구글 로그인 연동이 삭제됩니다.\n" +
        "· 클라우드에 저장된 바다 포인트가 모두 삭제됩니다.\n" +
        "· 이 기기의 포인트 목록도 지워집니다.\n\n" +
        "삭제 후에는 복구할 수 없습니다."
    );
    if (!ok) return;

    btn.disabled = true;
    showShareAcceptBusy("서비스 탈퇴를 처리하는 중입니다…", null);
    await yieldToPaint();
    try {
      showShareAcceptBusy("클라우드 데이터를 삭제하는 중입니다…", null);
      await yieldToPaint();
      await authFetch("account-delete", { method: "POST", body: JSON.stringify({}) });
      showShareAcceptBusy("이 기기의 데이터를 정리하는 중입니다…", null);
      await yieldToPaint();
      stopIncomingSharePolling();
      cloudSaveListenerBound = false;
      window.__seaCloudSyncAllowEmpty = true;
      try {
        if (typeof window.seaAppClearAllLocalData === "function") {
          window.seaAppClearAllLocalData();
        }
        try {
          await client.auth.signOut({ scope: "global" });
        } catch {
          await client.auth.signOut({ scope: "local" });
        }
        purgeSupabaseAuthKeys();
        await renderSession(null);
        hideShareAcceptBusy();
        if (typeof window.setSeaStatus === "function") {
          window.setSeaStatus("서비스 탈퇴가 완료되었습니다.");
        }
      } finally {
        window.__seaCloudSyncAllowEmpty = false;
      }
    } catch (err) {
      hideShareAcceptBusy();
      console.error(err);
      const code = err?.code || err?.message;
      let msg = "서비스 탈퇴에 실패했습니다. 잠시 후 다시 시도해 주세요.";
      if (code === "login_required") msg = "다시 로그인한 뒤 탈퇴를 진행해 주세요.";
      if (code === "server_not_configured") {
        msg = "Vercel에 SUPABASE_SERVICE_ROLE_KEY를 넣고 Redeploy 해 주세요.";
      }
      if (typeof window.setSeaStatus === "function") window.setSeaStatus(msg);
    } finally {
      hideShareAcceptBusy();
      btn.disabled = false;
    }
  });
}

async function initGoogleAuthUi(client, cfg) {
  const authRoot = document.querySelector("#cloud-sync-auth");
  const statusEl = document.querySelector("#cloud-sync-auth-status");
  const syncEl = document.querySelector("#cloud-sync-sync-status");
  const loginBtn = document.querySelector("#cloud-sync-google-login");
  const logoutBtn = document.querySelector("#cloud-sync-logout");
  const introEl = document.querySelector("#cloud-sync-teaser-intro");
  if (!authRoot || !statusEl || !loginBtn || !logoutBtn) return;

  if (!cfg.showGoogleLogin || !cloudSyncRuntime?.configured) {
    authRoot.hidden = true;
    return;
  }
  authRoot.hidden = false;

  setCloudSyncStatusCallback((text) => {
    if (!syncEl) return;
    syncEl.hidden = !text;
    syncEl.textContent = text || "";
  });

  function setAuthButtonVisible(btn, visible) {
    if (!btn) return;
    btn.hidden = !visible;
    btn.style.display = visible ? "" : "none";
  }

  async function renderSession(session) {
    const signedIn = Boolean(session?.user);
    setAuthButtonVisible(loginBtn, !signedIn);
    setAuthButtonVisible(logoutBtn, signedIn);
    loginBtn.disabled = false;
    if (introEl) introEl.hidden = signedIn;

    const deleteTeaser = document.querySelector("#sea-account-delete-teaser");
    if (deleteTeaser) {
      deleteTeaser.hidden = !signedIn;
      if (!signedIn) deleteTeaser.open = false;
    }

    if (signedIn) {
      statusEl.textContent = formatSignedInLabel(session.user);
      bindAccountDeleteUi(client, renderSession);
      if (cfg.enabled) startSessionCloudSync(session, cfg);
      else if (syncEl) syncEl.hidden = true;
      const setShareStatus = (text) => {
        if (!syncEl) return;
        if (!text) {
          syncEl.hidden = true;
          syncEl.textContent = "";
          return;
        }
        syncEl.hidden = false;
        syncEl.textContent = text;
      };
      shareIncomingStatusCb = setShareStatus;
      await initSeaShareUi(client, session, setShareStatus);
      startIncomingSharePolling(client, setShareStatus);
    } else {
      stopIncomingSharePolling();
      shareIncomingStatusCb = null;
      syncSeaShareTeaserVisibility(null);
      const incomingEl = document.querySelector("#sea-share-incoming");
      if (incomingEl) {
        incomingEl.hidden = true;
        incomingEl.replaceChildren();
      }
      cloudSaveListenerBound = false;
      if (introEl) introEl.hidden = false;
      statusEl.textContent = "구글로 로그인하면 포인트를 클라우드에 보관할 수 있습니다.";
      if (syncEl) {
        syncEl.hidden = true;
        syncEl.textContent = "";
      }
    }
  }

  loginBtn.addEventListener("click", async () => {
    loginBtn.disabled = true;
    statusEl.textContent = "구글 로그인 화면으로 이동합니다…";
    try {
      const { error } = await client.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: authRedirectUrl() },
      });
      if (error) throw error;
    } catch (err) {
      console.error(err);
      statusEl.textContent = "로그인을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.";
      loginBtn.disabled = false;
    }
  });

  logoutBtn.addEventListener("click", async () => {
    logoutBtn.disabled = true;
    try {
      const { data } = await client.auth.getSession();
      const userId = data.session?.user?.id;
      if (userId && cfg.enabled) {
        await flushCloudPush(client, userId);
      }
      await client.auth.signOut({ scope: "local" });
      purgeSupabaseAuthKeys();
      cloudSaveListenerBound = false;
      await renderSession(null);
    } finally {
      logoutBtn.disabled = false;
    }
  });

  statusEl.textContent = "로그인 상태 확인 중…";
  try {
    const oauthResult = await completeOAuthReturnIfNeeded(client);
    let session = (await client.auth.getSession()).data.session;
    if (!session?.user && oauthResult === "ok") {
      const { data: refreshed } = await client.auth.refreshSession();
      session = refreshed.session || session;
    }
    if (!session?.user && oauthResult === "none") {
      session = await waitForAuthReady(client, 2500);
    }
    await renderSession(session?.user ? session : null);
  } catch (err) {
    console.error(err);
    statusEl.textContent = "로그인을 준비하지 못했습니다. 새로고침 후 다시 시도해 주세요.";
  }

  client.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") {
      cloudSaveListenerBound = false;
      purgeSupabaseAuthKeys();
      renderSession(null).catch(() => {});
      return;
    }
    if (session?.user) renderSession(session).catch(() => {});
  });

  let lastForegroundShareCheck = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !cfg.enabled) return;
    const now = Date.now();
    client.auth.getSession().then(({ data: sessionData }) => {
      const userId = sessionData.session?.user?.id;
      if (userId) scheduleCloudPush(client, userId, 500);
      if (!userId || now - lastForegroundShareCheck < 2500) return;
      lastForegroundShareCheck = now;
      const email = resolveSessionEmail(sessionData.session?.user);
      const incoming = document.querySelector("#sea-share-incoming");
      if (!incoming || !email) return;
      refreshIncomingForSession(
        client,
        sessionData.session,
        incoming,
        shareIncomingStatusCb || (() => {})
      ).catch(() => {});
    });
  });

  window.addEventListener("pageshow", () => {
    client.auth.getSession().then(({ data: sessionData }) => {
      if (!sessionData.session?.user) return;
      const incoming = document.querySelector("#sea-share-incoming");
      if (!incoming) return;
      refreshIncomingForSession(
        client,
        sessionData.session,
        incoming,
        shareIncomingStatusCb || (() => {})
      ).catch(() => {});
    });
  });
}

async function initCloudSyncShell() {
  if (!document.body.classList.contains("sea-app")) return;
  const root = document.querySelector("#cloud-sync-teaser");
  if (!root) return;

  cloudSyncCfg = await loadCloudSyncConfig();
  cloudSyncRuntime = await loadCloudSyncRuntime();
  if (!cloudSyncCfg.showTeaser) {
    root.hidden = true;
    return;
  }
  root.hidden = false;
  const summary = root.querySelector("summary");
  const message = root.querySelector(".cloud-sync-teaser-msg");
  if (summary) summary.textContent = cloudSyncCfg.teaserTitle;
  if (message) message.textContent = cloudSyncCfg.teaserMessage;

  if (cloudSyncRuntime?.configured && cloudSyncCfg.showGoogleLogin) {
    supabaseClient = createClient(cloudSyncRuntime.supabaseUrl, cloudSyncRuntime.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        flowType: "pkce",
        storage: createAuthStorage(),
      },
    });
    window.getSupabaseClient = () => supabaseClient;
    await initGoogleAuthUi(supabaseClient, cloudSyncCfg);
  }
}

initCloudSyncShell().catch(() => {});
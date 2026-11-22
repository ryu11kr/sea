import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.8/+esm";
import {
  bindCloudSaveListener,
  runFullCloudSync,
  setCloudSyncStatusCallback,
} from "./cloud-sync-data.js";

const DEFAULT_CLOUD_SYNC_CONFIG = {
  enabled: true,
  showTeaser: true,
  showGoogleLogin: true,
  teaserTitle: "포인트 보관",
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

  async function renderSession(session) {
    const signedIn = Boolean(session?.user);
    loginBtn.hidden = signedIn;
    logoutBtn.hidden = !signedIn;
    loginBtn.disabled = false;
    if (introEl) introEl.hidden = signedIn;

    if (signedIn) {
      statusEl.textContent = formatSignedInLabel(session.user);
      if (cfg.enabled) startSessionCloudSync(session, cfg);
    } else {
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

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !cfg.enabled) return;
    client.auth.getSession().then(({ data }) => {
      const userId = data.session?.user?.id;
      if (userId) runFullCloudSync(client, userId).catch(() => {});
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
    await initGoogleAuthUi(supabaseClient, cloudSyncCfg);
  }
}

initCloudSyncShell().catch(() => {});
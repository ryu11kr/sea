/** 물때 포인트 공유 — 앱 안 팝업·목록 */

import {
  getLocalPointCount,
  pushLocalStateToCloud,
  runFullCloudSync,
} from "./cloud-sync-data.js";

let shareUiBound = false;

const SHARE_POPUP_DISMISSED_KEY = "sea-share-popup-dismissed";

/** @type {{ id: string, from_email: string } | null} */
let popupCurrentRequest = null;
let sharePopupBound = false;
let shareHintBound = false;

const SHARE_POLL_MS = 5_000;
/** @type {number | null} */
let sharePollTimer = null;
let modalScrollLockY = 0;
let modalScrollLockBound = false;

function isSeaShareModalOpen() {
  const share = document.querySelector("#sea-share-popup");
  const hint = document.querySelector("#sea-share-hint-dialog");
  return Boolean(share?.open || hint?.open);
}

function isSeaFormDialogOpen() {
  return false;
}

function syncSeaShareModalScrollLock() {
  if (isSeaShareModalOpen()) {
    if (!document.body.classList.contains("sea-modal-scroll-lock")) {
      modalScrollLockY = window.scrollY || 0;
      document.body.classList.add("sea-modal-scroll-lock");
      document.body.style.top = `-${modalScrollLockY}px`;
    }
    return;
  }
  if (isSeaFormDialogOpen()) return;
  if (document.body.classList.contains("sea-modal-scroll-lock")) {
    document.body.classList.remove("sea-modal-scroll-lock");
    document.body.style.top = "";
    window.scrollTo(0, modalScrollLockY);
  }
}

function bindSeaShareModalScrollLock() {
  if (modalScrollLockBound) return;
  modalScrollLockBound = true;
  for (const id of ["sea-share-popup", "sea-share-hint-dialog"]) {
    const dialog = document.querySelector(`#${id}`);
    if (!dialog) continue;
    dialog.addEventListener("close", () => {
      syncSeaShareModalScrollLock();
    });
  }
}

export function stopIncomingSharePolling() {
  if (sharePollTimer != null) {
    clearInterval(sharePollTimer);
    sharePollTimer = null;
  }
}

/**
 * 앱을 켜 둔 상태에서도 공유 요청·팝업이 뜨도록 주기 조회
 * @param {import("@supabase/supabase-js").SupabaseClient} client
 * @param {(text: string) => void} setStatus
 */
export function startIncomingSharePolling(client, setStatus) {
  stopIncomingSharePolling();

  const tick = async () => {
    if (document.visibilityState !== "visible") return;
    try {
      const { data } = await client.auth.getSession();
      const email = resolveSessionEmail(data.session?.user);
      if (!email) return;
      const incoming = document.querySelector("#sea-share-incoming");
      await refreshIncomingShareRequests(client, email, incoming, setStatus);
    } catch (err) {
      console.error(err);
    }
  };

  void tick();
  sharePollTimer = window.setInterval(() => {
    void tick();
  }, SHARE_POLL_MS);
}

/**
 * @param {string} message
 */
function showSeaShareHint(message) {
  const dialog = document.querySelector("#sea-share-hint-dialog");
  const bodyEl = document.querySelector("#sea-share-hint-body");
  const okBtn = document.querySelector("#sea-share-hint-ok");
  if (!dialog || !bodyEl || !okBtn) return;

  if (!shareHintBound) {
    shareHintBound = true;
    okBtn.addEventListener("click", () => {
      if (dialog.open) dialog.close();
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      dialog.close();
    });
  }

  bodyEl.textContent = message;
  if (dialog.open) dialog.close();
  bindSeaShareModalScrollLock();
  dialog.showModal();
  syncSeaShareModalScrollLock();
  okBtn.focus();
}

export function yieldToPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

let shareAcceptBusyActive = false;
let shareTableMissingNotified = false;

function resetSharePopupBusyUi() {
  const popup = document.querySelector("#sea-share-popup");
  const actions = popup?.querySelector(".sea-share-popup-actions");
  popup?.classList.remove("is-busy");
  if (actions) actions.hidden = false;
}

/**
 * @param {string} message
 * @param {(text: string) => void} [setStatus]
 */
export function showShareAcceptBusy(message, setStatus) {
  shareAcceptBusyActive = true;
  setStatus?.(message);
  const popup = document.querySelector("#sea-share-popup");
  const bodyEl = document.querySelector("#sea-share-popup-body");
  if (popup?.open) {
    popup.classList.add("is-busy");
    const actions = popup.querySelector(".sea-share-popup-actions");
    if (actions) actions.hidden = true;
    if (bodyEl) bodyEl.textContent = message;
    return;
  }
  const overlay = document.querySelector("#sea-share-busy");
  const textEl = document.querySelector("#sea-share-busy-text");
  if (overlay && textEl) {
    textEl.textContent = message;
    overlay.hidden = false;
    overlay.setAttribute("aria-busy", "true");
  }
}

/**
 * @param {(text: string) => void} [setStatus]
 */
export function hideShareAcceptBusy(setStatus) {
  if (!shareAcceptBusyActive) return;
  shareAcceptBusyActive = false;
  const overlay = document.querySelector("#sea-share-busy");
  if (overlay) {
    overlay.hidden = true;
    overlay.setAttribute("aria-busy", "false");
  }
  resetSharePopupBusyUi();
  setStatus?.("");
}

/** 소문자만 맞춤. 받는 사람 Gmail은 로그인 주소와 글자 그대로 같아야 함 */
function normalizeEmail(email) {
  let raw = String(email || "")
    .trim()
    .toLowerCase();
  if (!raw) return "";
  if (!raw.includes("@")) {
    raw = `${raw}@gmail.com`;
  }
  return raw;
}

/** 구글 로그인 세션에서 받는 사람 이메일 (user.email 없을 때 metadata 보강) */
export function resolveSessionEmail(user) {
  if (!user) return "";
  const candidates = [
    user.email,
    user.user_metadata?.email,
    user.user_metadata?.email_address,
  ];
  for (const c of candidates) {
    const n = normalizeEmail(c);
    if (n) return n;
  }
  return "";
}

let pendingShareIncomingCount = 0;

function apiBase() {
  return new URL("./api/", window.location.href).href;
}

export async function authFetch(path, options = {}) {
  const client = window.getSupabaseClient?.();
  if (!client) throw new Error("no_client");
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("login_required");

  const res = await fetch(new URL(path, apiBase()), {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.message || json.error || res.statusText);
    err.code = json.error;
    throw err;
  }
  return json;
}

function isShareTableMissingError(err) {
  const code = err?.code;
  if (code === "PGRST205") return true;
  const msg = String(err?.message || err?.details || "");
  return msg.includes("sea_share_requests");
}

function notifyShareTableMissing() {
  if (shareTableMissingNotified) return;
  shareTableMissingNotified = true;
  stopIncomingSharePolling();
  showSeaShareHint(
    "포인트 공유 DB가 아직 없습니다.\n\nSupabase 대시보드 → SQL Editor에서\nsupabase/sea-share-setup.sql 내용을 Run 해 주세요.\n\n(물때 클라우드용 sea-cloud-setup.sql 과는 별도입니다.)"
  );
}

function describeShareError(err) {
  if (isShareTableMissingError(err)) {
    return "포인트 공유 DB가 없습니다. Supabase SQL Editor에서 sea-share-setup.sql 을 Run 해 주세요.";
  }
  const code = err?.code || err?.message;
  if (code === "no_points" || code === "no_stops") {
    return "클라우드에 저장된 포인트가 없습니다. 포인트를 저장한 뒤 잠시 기다렸다가 다시 보내 주세요.";
  }
  if (code === "self_share") return "본인 이메일로는 보낼 수 없습니다.";
  if (code === "invalid_email") return "Gmail 형식을 확인해 주세요.";
  if (code === "login_required") return "다시 구글 로그인 후 시도해 주세요.";
  if (code === "server_not_configured") {
    return "Vercel에 SUPABASE_SERVICE_ROLE_KEY를 넣고 Redeploy 해 주세요. (수락 시 필요)";
  }
  if (code === "insert_failed" || code === "PGRST205") {
    return "Supabase SQL Editor에서 sea-share-setup.sql 전체를 Run 해 주세요.";
  }
  if (String(err?.message || "").includes("sea_share_requests")) {
    return "Supabase SQL Editor에서 sea-share-setup.sql 전체를 Run 해 주세요.";
  }
  if (err?.message) return `공유 실패: ${err.message}`;
  return "공유를 보내지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} client
 * @param {string} userId
 * @param {string} fromEmail
 * @param {string} toEmail
 */
async function sendShareRequestViaClient(client, userId, fromEmail, toEmail) {
  const { data: cloudRow, error: cloudErr } = await client
    .from("sea_user_data")
    .select("points")
    .eq("user_id", userId)
    .maybeSingle();
  if (cloudErr) throw cloudErr;

  const points = Array.isArray(cloudRow?.points) ? cloudRow.points : [];
  if (!points.length) {
    const err = new Error("no_points");
    err.code = "no_points";
    throw err;
  }

  await client
    .from("sea_share_requests")
    .update({ status: "cancelled", responded_at: new Date().toISOString() })
    .eq("from_user_id", userId)
    .eq("to_email", toEmail)
    .eq("status", "pending");

  const { data: row, error: insErr } = await client
    .from("sea_share_requests")
    .insert({
      from_user_id: userId,
      from_email: fromEmail,
      to_email: toEmail,
      status: "pending",
    })
    .select("id")
    .single();
  if (insErr) throw insErr;
  return row.id;
}

function getDismissedPopupIds() {
  try {
    const raw = sessionStorage.getItem(SHARE_POPUP_DISMISSED_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch {
    return new Set();
  }
}

function markPopupDismissed(requestId) {
  const s = getDismissedPopupIds();
  s.add(String(requestId));
  try {
    sessionStorage.setItem(SHARE_POPUP_DISMISSED_KEY, JSON.stringify([...s]));
  } catch {
    /* ignore */
  }
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} client
 * @param {string} userEmail
 * @param {HTMLElement | null} listEl
 * @param {(text: string) => void} setStatus
 * @param {string} requestId
 */
async function acceptShareRequest(client, userEmail, listEl, setStatus, requestId) {
  showShareAcceptBusy("공유를 수락하는 중…", setStatus);
  await yieldToPaint();
  try {
    try {
      await authFetch("share-accept", {
        method: "POST",
        body: JSON.stringify({ requestId }),
      });
    } catch (accErr) {
      if (accErr.code === "server_not_configured") {
        throw Object.assign(new Error("server_not_configured"), accErr);
      }
      throw accErr;
    }
    showShareAcceptBusy("포인트를 가져오는 중…", setStatus);
    await yieldToPaint();
    const userId = (await client.auth.getSession()).data.session?.user?.id;
    if (userId) {
      await runFullCloudSync(client, userId);
    }
    markPopupDismissed(requestId);
    showSeaShareHint("공유받은 포인트를 내 목록에 반영했습니다.");
    await refreshIncomingShareRequests(client, userEmail, listEl, setStatus, requestId);
  } finally {
    hideShareAcceptBusy(setStatus);
  }
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} client
 * @param {string} userEmail
 * @param {HTMLElement | null} listEl
 * @param {(text: string) => void} setStatus
 * @param {string} requestId
 */
async function rejectShareRequest(client, userEmail, listEl, setStatus, requestId) {
  await authFetch("share-reject", {
    method: "POST",
    body: JSON.stringify({ requestId }),
  });
  markPopupDismissed(requestId);
  await refreshIncomingShareRequests(client, userEmail, listEl, setStatus, requestId);
}

/**
 * @param {Array<{ id: string, from_email: string }>} pendingRows
 * @param {import("@supabase/supabase-js").SupabaseClient} client
 * @param {string} userEmail
 * @param {HTMLElement | null} listEl
 * @param {(text: string) => void} setStatus
 * @param {string | null} preferRequestId
 */
function maybeShowSharePopup(pendingRows, client, userEmail, listEl, setStatus, preferRequestId) {
  const dialog = document.querySelector("#sea-share-popup");
  const bodyEl = document.querySelector("#sea-share-popup-body");
  if (!dialog || !bodyEl || !pendingRows?.length) return;

  const params = new URLSearchParams(window.location.search);
  const forceFromUrl = params.get("share") === "pending";
  const urlRequestId = params.get("requestId");
  const targetId = preferRequestId || urlRequestId;
  const dismissed = getDismissedPopupIds();

  let row = null;
  if (targetId) {
    const hit = pendingRows.find((r) => String(r.id) === String(targetId)) || null;
    if (hit && (forceFromUrl || !dismissed.has(String(hit.id)))) {
      row = hit;
    }
  }
  if (!row && forceFromUrl) {
    row = pendingRows[0];
  }
  if (!row) {
    row = pendingRows.find((r) => !dismissed.has(String(r.id))) || null;
  }
  if (!row) return;
  if (dismissed.has(String(row.id)) && !forceFromUrl) return;
  if (dialog.open && popupCurrentRequest?.id === row.id) return;

  popupCurrentRequest = { id: String(row.id), from_email: row.from_email };
  resetSharePopupBusyUi();
  bodyEl.textContent = `${row.from_email} 님이 바다 포인트·물때 정보를 공유했습니다.`;
  bindSharePopupOnce(client, userEmail, listEl, setStatus);
  bindSeaShareModalScrollLock();
  dialog.showModal();
  syncSeaShareModalScrollLock();

  const shareTeaser = document.querySelector("#sea-share-teaser");
  if (shareTeaser && !shareTeaser.hidden && !shareTeaser.open) {
    shareTeaser.open = true;
  }

  if (forceFromUrl || urlRequestId) {
    try {
      params.delete("share");
      params.delete("requestId");
      const q = params.toString();
      const path = `${window.location.pathname}${q ? `?${q}` : ""}`;
      window.history.replaceState({}, document.title, path);
    } catch {
      /* ignore */
    }
  }
}

function bindSharePopupOnce(client, userEmail, listEl, setStatus) {
  if (sharePopupBound) return;
  sharePopupBound = true;

  const dialog = document.querySelector("#sea-share-popup");
  const acceptBtn = document.querySelector("#sea-share-popup-accept");
  const rejectBtn = document.querySelector("#sea-share-popup-reject");
  const laterBtn = document.querySelector("#sea-share-popup-later");
  if (!dialog || !acceptBtn || !rejectBtn || !laterBtn) return;

  const closeDialog = () => {
    if (dialog.open) dialog.close();
    popupCurrentRequest = null;
  };

  laterBtn.addEventListener("click", () => {
    if (popupCurrentRequest?.id) markPopupDismissed(popupCurrentRequest.id);
    closeDialog();
  });

  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (popupCurrentRequest?.id) markPopupDismissed(popupCurrentRequest.id);
    closeDialog();
  });

  acceptBtn.addEventListener("click", async () => {
    if (!popupCurrentRequest?.id) return;
    const requestId = popupCurrentRequest.id;
    acceptBtn.disabled = true;
    rejectBtn.disabled = true;
    laterBtn.disabled = true;
    try {
      await acceptShareRequest(client, userEmail, listEl, setStatus, requestId);
      closeDialog();
    } catch (err) {
      console.error(err);
      setStatus?.(describeShareError(err));
    } finally {
      acceptBtn.disabled = false;
      rejectBtn.disabled = false;
      laterBtn.disabled = false;
    }
  });

  rejectBtn.addEventListener("click", async () => {
    if (!popupCurrentRequest?.id) return;
    const requestId = popupCurrentRequest.id;
    acceptBtn.disabled = true;
    rejectBtn.disabled = true;
    laterBtn.disabled = true;
    try {
      await rejectShareRequest(client, userEmail, listEl, setStatus, requestId);
      closeDialog();
    } catch (err) {
      console.error(err);
      setStatus?.("거절하지 못했습니다.");
    } finally {
      acceptBtn.disabled = false;
      rejectBtn.disabled = false;
      laterBtn.disabled = false;
    }
  });
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} client
 * @param {string} userEmail
 * @param {HTMLElement} listEl
 * @param {(text: string) => void} setStatus
 * @param {string | null} [preferRequestId]
 */
/**
 * @param {import("@supabase/supabase-js").SupabaseClient} client
 * @param {import("@supabase/supabase-js").Session | null | undefined} session
 * @param {HTMLElement | null} listEl
 * @param {(text: string) => void} setStatus
 */
export async function refreshIncomingForSession(client, session, listEl, setStatus) {
  let email = resolveSessionEmail(session?.user);
  if (!email) {
    try {
      const { data: userData } = await client.auth.getUser();
      email = resolveSessionEmail(userData.user);
    } catch {
      /* ignore */
    }
  }
  if (!email) return;
  await refreshIncomingShareRequests(client, email, listEl, setStatus);
}

export async function refreshIncomingShareRequests(
  client,
  userEmail,
  listEl,
  setStatus,
  preferRequestId = null
) {
  const email = normalizeEmail(userEmail);
  if (!email) {
    if (listEl) {
      listEl.hidden = true;
      listEl.replaceChildren();
    }
    pendingShareIncomingCount = 0;
    return;
  }

  const { data: sess } = await client.auth.getSession();
  const userId = sess.session?.user?.id || null;

  const { data: rawRows, error } = await client
    .from("sea_share_requests")
    .select("id, from_email, created_at, to_email, from_user_id")
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  const data = (rawRows || []).filter((row) => {
    if (userId && row.from_user_id === userId) return false;
    return normalizeEmail(row.to_email) === email;
  });

  if (error) {
    if (isShareTableMissingError(error)) {
      notifyShareTableMissing();
    } else {
      console.error(error);
      setStatus?.("공유 요청을 불러오지 못했습니다.");
    }
    if (listEl) {
      listEl.hidden = true;
      listEl.replaceChildren();
    }
    pendingShareIncomingCount = 0;
    syncSeaShareTeaserVisibility(sess.session?.user ? { user: sess.session.user } : null, undefined, 0);
    return;
  }

  pendingShareIncomingCount = data.length;
  syncSeaShareTeaserVisibility(
    sess.session?.user ? { user: sess.session.user } : null,
    undefined,
    pendingShareIncomingCount
  );

  if (listEl) {
    listEl.replaceChildren();
    if (!data?.length) {
      listEl.hidden = true;
      maybeShowSharePopup([], client, userEmail, listEl, setStatus, preferRequestId);
      return;
    }
    listEl.hidden = false;
  }

  if (!data?.length) {
    return;
  }

  maybeShowSharePopup(data, client, userEmail, listEl, setStatus, preferRequestId);

  if (!listEl) return;
  for (const row of data) {
    const card = document.createElement("div");
    card.className = "sea-share-incoming-card";
    card.dataset.requestId = row.id;

    const text = document.createElement("p");
    text.className = "sea-share-incoming-text";
    text.textContent = `${row.from_email} 님이 포인트를 공유했습니다.`;

    const actions = document.createElement("div");
    actions.className = "sea-share-incoming-actions";

    const acceptBtn = document.createElement("button");
    acceptBtn.type = "button";
    acceptBtn.className = "big-btn primary sea-share-accept";
    acceptBtn.textContent = "수락";

    const rejectBtn = document.createElement("button");
    rejectBtn.type = "button";
    rejectBtn.className = "big-btn ghost sea-share-reject";
    rejectBtn.textContent = "거절";

    acceptBtn.addEventListener("click", async () => {
      acceptBtn.disabled = true;
      rejectBtn.disabled = true;
      try {
        await acceptShareRequest(client, userEmail, listEl, setStatus, row.id);
      } catch (err) {
        console.error(err);
        setStatus?.(describeShareError(err));
        acceptBtn.disabled = false;
        rejectBtn.disabled = false;
      }
    });

    rejectBtn.addEventListener("click", async () => {
      acceptBtn.disabled = true;
      rejectBtn.disabled = true;
      try {
        await rejectShareRequest(client, userEmail, listEl, setStatus, row.id);
      } catch (err) {
        console.error(err);
        setStatus?.("거절하지 못했습니다.");
        acceptBtn.disabled = false;
        rejectBtn.disabled = false;
      }
    });

    actions.append(acceptBtn, rejectBtn);
    card.append(text, actions);
    listEl.append(card);
  }
}

let busShareTeaserListenerBound = false;

/**
 * @param {import("@supabase/supabase-js").Session | null | undefined} session
 * @param {number | undefined} stopCount
 */
export function syncSeaShareTeaserVisibility(session, stopCount, pendingIncoming) {
  const teaser = document.querySelector("#sea-share-teaser");
  if (!teaser) return;
  const signedIn = Boolean(session?.user);
  const count =
    typeof stopCount === "number" && Number.isFinite(stopCount)
      ? stopCount
      : getLocalPointCount();
  const pending =
    typeof pendingIncoming === "number" && Number.isFinite(pendingIncoming)
      ? pendingIncoming
      : pendingShareIncomingCount;
  const show = signedIn && (count > 0 || pending > 0);
  teaser.hidden = !show;
  if (!show) {
    teaser.open = false;
    return;
  }
  if (pending > 0) teaser.open = true;
}

function bindSeaShareTeaserStopListener() {
  if (busShareTeaserListenerBound) return;
  busShareTeaserListenerBound = true;
  window.addEventListener("sea-points-changed", (ev) => {
    const logoutBtn = document.querySelector("#cloud-sync-logout");
    const signedIn = Boolean(logoutBtn && !logoutBtn.hidden);
    const stopCount =
      typeof ev?.detail?.count === "number" ? ev.detail.count : undefined;
    syncSeaShareTeaserVisibility(signedIn ? { user: {} } : null, stopCount);
  });
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} client
 * @param {import("@supabase/supabase-js").Session} session
 * @param {(text: string) => void} setStatus
 */
export function initSeaShareUi(client, session, setStatus) {
  const teaser = document.querySelector("#sea-share-teaser");
  const sendInput = document.querySelector("#sea-share-to-email");
  const sendBtn = document.querySelector("#sea-share-send");
  const incomingEl = document.querySelector("#sea-share-incoming");

  bindSeaShareTeaserStopListener();

  if (!session?.user) {
    syncSeaShareTeaserVisibility(null);
    return;
  }

  syncSeaShareTeaserVisibility(session);
  bindSeaShareModalScrollLock();

  if (!shareUiBound) {
    shareUiBound = true;

    if (sendBtn && sendInput) {
      sendBtn.addEventListener("click", async () => {
        const raw = String(sendInput.value || "").trim();
        if (!raw) {
          showSeaShareHint("받을 사람 지메일 아이디를 입력해 주세요.");
          sendInput.focus();
          return;
        }
        const toEmail = normalizeEmail(raw);
        sendBtn.disabled = true;
        sendInput.disabled = true;
        showShareAcceptBusy("클라우드에 저장한 뒤 공유합니다…", setStatus);
        await yieldToPaint();
        try {
          const { data: sess } = await client.auth.getSession();
          const userId = sess.session?.user?.id;
          const fromEmail = resolveSessionEmail(sess.session?.user);
          if (!userId || !fromEmail) {
            const e = new Error("login_required");
            e.code = "login_required";
            throw e;
          }
          if (toEmail === fromEmail) {
            const e = new Error("self_share");
            e.code = "self_share";
            throw e;
          }
          showShareAcceptBusy("포인트를 클라우드에 올리는 중…", setStatus);
          await yieldToPaint();
          await pushLocalStateToCloud(client, userId);
          showShareAcceptBusy("공유 요청을 보내는 중…", setStatus);
          await yieldToPaint();
          await sendShareRequestViaClient(client, userId, fromEmail, toEmail);
          sendInput.value = "";
          hideShareAcceptBusy(setStatus);
          showSeaShareHint(`공유 요청을 보냈습니다.\n\n받는 사람: ${toEmail}`);
        } catch (err) {
          console.error(err);
          hideShareAcceptBusy(setStatus);
          const message = describeShareError(err);
          if (isShareTableMissingError(err)) {
            notifyShareTableMissing();
          } else {
            showSeaShareHint(message);
            setStatus?.(message);
          }
        } finally {
          sendBtn.disabled = false;
          sendInput.disabled = false;
        }
      });
    }
  }

  void refreshIncomingForSession(client, session, incomingEl, setStatus);

  const params = new URLSearchParams(window.location.search);
  if (params.get("share") === "pending" && incomingEl) {
    incomingEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}
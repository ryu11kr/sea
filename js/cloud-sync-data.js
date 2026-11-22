/** 물때첩 — 포인트 목록 클라우드 동기화 */

export const SEA_STORAGE_KEY = "sea-points-v1";
export const CLOUD_MAX_POINTS = 40;

let uploadTimer = null;
let syncInFlight = null;
/** @type {((text: string) => void) | null} */
let syncStatusCb = null;

export function setCloudSyncStatusCallback(fn) {
  syncStatusCb = fn;
}

function setSyncStatus(text) {
  syncStatusCb?.(text || "");
}

export function generatePointId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore */
  }
  return `sea-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * @param {unknown} points
 */
export function ensurePointIds(points) {
  if (!Array.isArray(points)) return [];
  /** @type {any[]} */
  const out = [];
  for (const p of points) {
    if (!p || typeof p !== "object") continue;
    out.push({
      ...p,
      id: p.id || generatePointId(),
      updatedAt: p.updatedAt || new Date(0).toISOString(),
    });
  }
  return out;
}

function mergePoints(local, remote) {
  const map = new Map();
  for (const p of remote || []) {
    if (p?.id) map.set(p.id, p);
  }
  for (const p of local || []) {
    if (!p?.id) continue;
    const prev = map.get(p.id);
    if (!prev) {
      map.set(p.id, p);
      continue;
    }
    const tLocal = new Date(p.updatedAt || 0).getTime();
    const tRemote = new Date(prev.updatedAt || 0).getTime();
    map.set(p.id, tLocal >= tRemote ? p : prev);
  }
  return [...map.values()].sort(
    (a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
  );
}

function readLocalPoints() {
  /** @type {any[]} */
  let storagePoints = [];
  try {
    const raw = localStorage.getItem(SEA_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) storagePoints = ensurePointIds(parsed);
  } catch {
    storagePoints = [];
  }

  const getter = window.seaAppGetLocalPoints;
  if (typeof getter === "function") {
    const mem = getter();
    const memPoints = ensurePointIds(mem.points);
    const merged = mergePoints(storagePoints, memPoints);
    return {
      points: merged,
      updatedAt: mem.updatedAt ?? null,
    };
  }

  return { points: storagePoints, updatedAt: null };
}

function applyLocal(points) {
  const normalized = ensurePointIds(points);
  const apply = window.seaAppApplyPoints;
  if (typeof apply === "function") {
    apply(normalized);
    return;
  }
  localStorage.setItem(SEA_STORAGE_KEY, JSON.stringify(normalized));
}

export function getLocalPointCount() {
  const state = readLocalPoints();
  return Array.isArray(state.points) ? state.points.length : 0;
}

export async function pullAndMergeCloudState(client, userId) {
  const { data, error } = await client
    .from("sea_user_data")
    .select("points, updated_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;

  const localState = readLocalPoints();
  const localPoints = ensurePointIds(localState.points || []);
  const remotePoints = ensurePointIds(Array.isArray(data?.points) ? data.points : []);
  let trimmed = mergePoints(localPoints, remotePoints).slice(0, CLOUD_MAX_POINTS);

  // 클라우드 동기화가 로컬·메모리를 빈 목록으로 덮어쓰는 사고 방지
  if (trimmed.length === 0) {
    if (localPoints.length > 0) {
      trimmed = localPoints.slice(0, CLOUD_MAX_POINTS);
    } else if (remotePoints.length > 0) {
      trimmed = remotePoints.slice(0, CLOUD_MAX_POINTS);
    }
  }

  window.__seaCloudSyncApplying = true;
  try {
    applyLocal(trimmed);
  } finally {
    window.__seaCloudSyncApplying = false;
  }

  const localAt = localPoints.reduce((m, p) => Math.max(m, new Date(p.updatedAt || 0).getTime()), 0);
  const remoteAt = data?.updated_at ? new Date(data.updated_at).getTime() : 0;
  const mergedAt = trimmed.reduce((m, p) => Math.max(m, new Date(p.updatedAt || 0).getTime()), 0);
  if ((localAt > remoteAt || mergedAt > remoteAt) && trimmed.length > 0) {
    scheduleCloudPush(client, userId, 400);
  }
}

export async function pushLocalStateToCloud(client, userId) {
  if (window.__seaCloudSyncApplying) return;
  const localState = readLocalPoints();
  let points = ensurePointIds(Array.isArray(localState.points) ? [...localState.points] : []);
  if (points.length === 0) {
    return;
  }
  if (points.length > CLOUD_MAX_POINTS) {
    points = points.slice(0, CLOUD_MAX_POINTS);
    setSyncStatus(`포인트는 클라우드에 최대 ${CLOUD_MAX_POINTS}개까지 저장됩니다.`);
  }

  const updatedAt = new Date().toISOString();
  const { error } = await client.from("sea_user_data").upsert({
    user_id: userId,
    points,
    schema_version: 1,
    updated_at: updatedAt,
  });
  if (error) throw error;
  setSyncStatus("클라우드에 저장했습니다.");
}

export function scheduleCloudPush(client, userId, delayMs = 1500) {
  if (uploadTimer) clearTimeout(uploadTimer);
  uploadTimer = window.setTimeout(() => {
    uploadTimer = null;
    if (window.__seaCloudSyncApplying) return;
    pushLocalStateToCloud(client, userId).catch((err) => {
      console.error(err);
      setSyncStatus("클라우드 저장에 실패했습니다. 이 기기에는 저장돼 있습니다.");
    });
  }, delayMs);
}

export async function runFullCloudSync(client, userId) {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    if (!navigator.onLine) {
      setSyncStatus("오프라인입니다. 이 기기 데이터만 보여 줍니다.");
      return;
    }
    setSyncStatus("클라우드에서 불러오는 중…");
    try {
      await pullAndMergeCloudState(client, userId);
      setSyncStatus("포인트를 안전하게 보관 중입니다.");
    } catch (err) {
      console.error(err);
      setSyncStatus("클라우드를 불러오지 못했습니다. Supabase SQL 설정을 확인해 주세요.");
    }
  })().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

export function bindCloudSaveListener(client, userId, enabled) {
  window.addEventListener("sea-local-state-saved", () => {
    if (!enabled || !userId) return;
    scheduleCloudPush(client, userId);
  });
}
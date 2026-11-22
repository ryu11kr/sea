/** 물때첩 — 포인트 목록 클라우드 동기화 */

export const SEA_STORAGE_KEY = "sea-points-v1";
/** 로컬에서 저장·삭제 등 마지막으로 손댄 시각 (클라우드보다 최신이면 삭제 유지) */
export const SEA_MUTATED_AT_KEY = "sea-points-mutated-at";
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

function readLocalMutatedAtMs() {
  try {
    const raw = localStorage.getItem(SEA_MUTATED_AT_KEY);
    if (!raw) return 0;
    const t = new Date(raw).getTime();
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

export function touchLocalPointsMutatedAt() {
  try {
    localStorage.setItem(SEA_MUTATED_AT_KEY, new Date().toISOString());
  } catch {
    /* ignore */
  }
}

/** 로컬 변경(삭제 포함)이 서버보다 최신일 때 — 원격에만 남은 옛 포인트는 되살리지 않음 */
function mergeWhenLocalMutationIsNewer(localPoints, remotePoints, localMutatedMs) {
  const localIds = new Set(localPoints.map((p) => p.id).filter(Boolean));
  const merged = [...localPoints];
  for (const p of remotePoints) {
    if (!p?.id || localIds.has(p.id)) continue;
    const t = new Date(p.updatedAt || 0).getTime();
    if (t > localMutatedMs) merged.push(p);
  }
  return mergePoints(merged, []).slice(0, CLOUD_MAX_POINTS);
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

function storagePointCount() {
  try {
    const raw = localStorage.getItem(SEA_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function applyLocal(points) {
  const normalized = ensurePointIds(points);
  if (normalized.length === 0 && storagePointCount() > 0 && !window.__seaCloudSyncAllowEmpty) {
    console.warn("blocked empty applyLocal over stored points");
    return;
  }
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

  // 클라우드가 비어 있는데 이 기기에 포인트가 있으면 덮어쓰지 않고 업로드만
  if (remotePoints.length === 0 && localPoints.length > 0) {
    scheduleCloudPush(client, userId, 400);
    return;
  }

  const localMutatedMs = readLocalMutatedAtMs();
  const remoteAt = data?.updated_at ? new Date(data.updated_at).getTime() : 0;

  let trimmed;
  if (localMutatedMs > remoteAt) {
    trimmed = mergeWhenLocalMutationIsNewer(localPoints, remotePoints, localMutatedMs);
  } else {
    trimmed = mergePoints(localPoints, remotePoints).slice(0, CLOUD_MAX_POINTS);
  }

  if (trimmed.length === 0 && localPoints.length > 0 && remotePoints.length === 0) {
    trimmed = localPoints.slice(0, CLOUD_MAX_POINTS);
  }

  const shouldApply = remotePoints.length > 0 || localPoints.length === 0;
  if (shouldApply) {
    window.__seaCloudSyncApplying = true;
    try {
      applyLocal(trimmed);
    } finally {
      window.__seaCloudSyncApplying = false;
    }
  }

  const localAt = localPoints.reduce((m, p) => Math.max(m, new Date(p.updatedAt || 0).getTime()), 0);
  const mergedAt = trimmed.reduce((m, p) => Math.max(m, new Date(p.updatedAt || 0).getTime()), 0);
  if (
    localMutatedMs > remoteAt ||
    (localPoints.length > 0 &&
      (localAt > remoteAt ||
        mergedAt > remoteAt ||
        trimmed.length !== remotePoints.length))
  ) {
    scheduleCloudPush(client, userId, 400);
  }
}

export async function pushLocalStateToCloud(client, userId) {
  if (window.__seaCloudSyncApplying) return;
  const localState = readLocalPoints();
  let points = ensurePointIds(Array.isArray(localState.points) ? [...localState.points] : []);
  if (points.length === 0 && !window.__seaCloudSyncAllowEmpty) {
    const localMutatedMs = readLocalMutatedAtMs();
    let remoteAtMs = 0;
    try {
      const { data } = await client
        .from("sea_user_data")
        .select("updated_at")
        .eq("user_id", userId)
        .maybeSingle();
      if (data?.updated_at) {
        const t = new Date(data.updated_at).getTime();
        if (Number.isFinite(t)) remoteAtMs = t;
      }
    } catch {
      /* ignore */
    }
    if (localMutatedMs <= remoteAtMs) return;
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

export function scheduleCloudPush(client, userId, delayMs = 400) {
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

/** 로그아웃 전 등 — 예약된 업로드를 즉시 실행 */
export async function flushCloudPush(client, userId) {
  if (uploadTimer) {
    clearTimeout(uploadTimer);
    uploadTimer = null;
  }
  if (window.__seaCloudSyncApplying) return;
  try {
    await pushLocalStateToCloud(client, userId);
  } catch (err) {
    console.error(err);
  }
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
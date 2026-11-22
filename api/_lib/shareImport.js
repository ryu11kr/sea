const CLOUD_MAX_POINTS = 40;

function mergePoints(local, added) {
  const map = new Map();
  for (const p of local || []) {
    if (p?.id) map.set(p.id, p);
  }
  for (const p of added || []) {
    if (p?.id) map.set(p.id, p);
  }
  return [...map.values()].sort(
    (a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
  );
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} admin
 * @param {string} ownerId
 * @param {string} recipientId
 */
export async function importPointsFromOwnerToRecipient(admin, ownerId, recipientId) {
  const { data: ownerRow, error: ownerErr } = await admin
    .from("sea_user_data")
    .select("points")
    .eq("user_id", ownerId)
    .maybeSingle();
  if (ownerErr) throw ownerErr;

  const ownerPoints = Array.isArray(ownerRow?.points) ? ownerRow.points : [];
  if (!ownerPoints.length) {
    throw new Error("보낸 사람의 클라우드에 포인트가 없습니다.");
  }

  const { data: recipRow } = await admin
    .from("sea_user_data")
    .select("points")
    .eq("user_id", recipientId)
    .maybeSingle();

  const existing = Array.isArray(recipRow?.points) ? recipRow.points : [];
  const now = new Date().toISOString();
  const imported = ownerPoints.map((p) => ({
    ...p,
    id: globalThis.crypto.randomUUID(),
    updatedAt: now,
  }));

  let merged = mergePoints(existing, imported);
  if (merged.length > CLOUD_MAX_POINTS) {
    merged = merged.slice(0, CLOUD_MAX_POINTS);
  }

  const { error: upsertErr } = await admin.from("sea_user_data").upsert({
    user_id: recipientId,
    points: merged,
    schema_version: 1,
    updated_at: now,
  });
  if (upsertErr) throw upsertErr;

  return { importedCount: imported.length, totalPoints: merged.length };
}
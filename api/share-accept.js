/** POST { requestId } — 포인트 공유 수락 */

import { getAuthUser, normalizeEmail } from "./_lib/auth.js";
import { getAdminClient } from "./_lib/admin.js";
import { importPointsFromOwnerToRecipient } from "./_lib/shareImport.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const user = await getAuthUser(req);
  if (!user?.id || !user.email) {
    return res.status(401).json({ error: "login_required" });
  }

  const requestId = String(req.body?.requestId || "").trim();
  if (!requestId) {
    return res.status(400).json({ error: "missing_request_id" });
  }

  const admin = await getAdminClient();
  if (!admin) {
    return res.status(503).json({ error: "server_not_configured" });
  }

  const myEmail = normalizeEmail(user.email);
  const { data: reqRow, error: fetchErr } = await admin
    .from("sea_share_requests")
    .select("id, from_user_id, from_email, to_email, status")
    .eq("id", requestId)
    .maybeSingle();
  if (fetchErr || !reqRow) {
    return res.status(404).json({ error: "not_found" });
  }
  if (normalizeEmail(reqRow.to_email) !== myEmail) {
    return res.status(403).json({ error: "forbidden" });
  }
  if (reqRow.status !== "pending") {
    return res.status(409).json({ error: "not_pending" });
  }

  try {
    const result = await importPointsFromOwnerToRecipient(admin, reqRow.from_user_id, user.id);
    const now = new Date().toISOString();
    await admin
      .from("sea_share_requests")
      .update({ status: "accepted", responded_at: now })
      .eq("id", requestId);

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "import_failed";
    return res.status(500).json({ error: "import_failed", message });
  }
}
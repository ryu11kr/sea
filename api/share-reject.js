/** POST { requestId } — 포인트 공유 거절 */

import { getAuthUser, normalizeEmail } from "./_lib/auth.js";
import { getAdminClient } from "./_lib/admin.js";

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
  const { data: reqRow } = await admin
    .from("sea_share_requests")
    .select("to_email, status")
    .eq("id", requestId)
    .maybeSingle();

  if (!reqRow || normalizeEmail(reqRow.to_email) !== myEmail) {
    return res.status(404).json({ error: "not_found" });
  }
  if (reqRow.status !== "pending") {
    return res.status(409).json({ error: "not_pending" });
  }

  await admin
    .from("sea_share_requests")
    .update({ status: "rejected", responded_at: new Date().toISOString() })
    .eq("id", requestId);

  return res.status(200).json({ ok: true });
}
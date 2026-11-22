/** POST { requestId } — 포인트 공유 거절 */

import { getAuthUser, getUserDbClient, resolveUserEmail } from "./_lib/auth.js";
import { readJsonBody, recipientOwnsShareRequest, isUuid } from "./_lib/email.js";

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
  if (!user?.id || !resolveUserEmail(user)) {
    return res.status(401).json({ error: "login_required" });
  }

  const body = readJsonBody(req);
  const requestId = String(body?.requestId || "").trim();
  if (!requestId) {
    return res.status(400).json({ error: "missing_request_id" });
  }
  if (!isUuid(requestId)) {
    return res.status(400).json({ error: "invalid_request_id" });
  }

  const userDb = await getUserDbClient(req);
  if (!userDb) {
    return res.status(401).json({ error: "login_required" });
  }

  const { data: reqRow, error: fetchErr } = await userDb
    .from("sea_share_requests")
    .select("to_email, status")
    .eq("id", requestId)
    .maybeSingle();
  if (fetchErr) {
    console.error("share-reject fetch", fetchErr);
    return res.status(500).json({ error: "fetch_failed" });
  }

  if (!reqRow) {
    return res.status(404).json({ error: "not_found" });
  }
  if (!recipientOwnsShareRequest(reqRow.to_email, user)) {
    return res.status(403).json({ error: "forbidden" });
  }
  if (reqRow.status !== "pending") {
    return res.status(409).json({ error: "not_pending" });
  }

  const now = new Date().toISOString();
  const { data: updated, error: updErr } = await userDb
    .from("sea_share_requests")
    .update({ status: "rejected", responded_at: now })
    .eq("id", requestId)
    .eq("status", "pending")
    .select("id");
  if (updErr) {
    console.error("share-reject update", updErr);
    return res.status(500).json({ error: "update_failed" });
  }
  if (!updated?.length) {
    return res.status(409).json({ error: "not_pending" });
  }

  return res.status(200).json({ ok: true });
}
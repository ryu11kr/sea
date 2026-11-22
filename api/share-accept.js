/** POST { requestId } — 포인트 공유 수락 */

import { getAuthUser, getUserDbClient, resolveUserEmail } from "./_lib/auth.js";
import { readJsonBody, recipientOwnsShareRequest, isUuid } from "./_lib/email.js";
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
    .select("id, from_user_id, from_email, to_email, status")
    .eq("id", requestId)
    .maybeSingle();
  if (fetchErr) {
    console.error("share-accept fetch", fetchErr);
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

  const admin = await getAdminClient();
  if (!admin) {
    return res.status(503).json({ error: "server_not_configured" });
  }

  try {
    const result = await importPointsFromOwnerToRecipient(admin, reqRow.from_user_id, user.id);
    const now = new Date().toISOString();
    const { error: adminUpdErr } = await admin
      .from("sea_share_requests")
      .update({ status: "accepted", responded_at: now })
      .eq("id", requestId);
    if (adminUpdErr) {
      const { data: acceptedViaUser, error: userUpdErr } = await userDb
        .from("sea_share_requests")
        .update({ status: "accepted", responded_at: now })
        .eq("id", requestId)
        .eq("status", "pending")
        .select("id");
      if (userUpdErr || !acceptedViaUser?.length) {
        console.error("share-accept status", adminUpdErr, userUpdErr);
        return res.status(500).json({ error: "status_update_failed" });
      }
    }

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "import_failed";
    return res.status(500).json({ error: "import_failed", message });
  }
}
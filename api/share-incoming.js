/** GET — 나에게 온 pending 공유 (service_role + Gmail canonical) */

import { getAuthUser, resolveUserEmail } from "./_lib/auth.js";
import { getAdminClient } from "./_lib/admin.js";
import { canonicalShareEmail, shareEmailsMatch } from "./_lib/email.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization");
    return res.status(204).end();
  }
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }

  const user = await getAuthUser(req);
  if (!user?.id) {
    return res.status(401).json({ error: "login_required" });
  }

  const myCanon = canonicalShareEmail(resolveUserEmail(user));
  if (!myCanon) {
    return res.status(401).json({ error: "email_missing" });
  }

  const admin = await getAdminClient();
  if (!admin) {
    return res.status(503).json({ error: "server_not_configured" });
  }

  const { data, error } = await admin
    .from("sea_share_requests")
    .select("id, from_email, created_at, to_email, from_user_id")
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("share-incoming", error);
    return res.status(500).json({ error: "list_failed" });
  }

  const requests = (data || [])
    .filter((row) => row.from_user_id !== user.id && shareEmailsMatch(row.to_email, myCanon))
    .map(({ id, from_email, created_at }) => ({ id, from_email, created_at }));

  return res.status(200).json({ requests });
}
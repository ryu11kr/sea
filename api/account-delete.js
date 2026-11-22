/** POST — 서비스 탈퇴: 클라우드 데이터·Auth 사용자 삭제 */

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

  const admin = await getAdminClient();
  if (!admin) {
    return res.status(503).json({ error: "server_not_configured" });
  }

  const userId = user.id;
  const myEmail = normalizeEmail(user.email);

  const { error: dataErr } = await admin.from("sea_user_data").delete().eq("user_id", userId);
  if (dataErr) {
    console.error("sea_user_data delete", dataErr);
    return res.status(500).json({ error: "data_delete_failed" });
  }

  const { error: shareFromErr } = await admin
    .from("sea_share_requests")
    .delete()
    .eq("from_user_id", userId);
  if (shareFromErr) {
    console.error("share from delete", shareFromErr);
    return res.status(500).json({ error: "share_delete_failed" });
  }

  const { error: shareToErr } = await admin
    .from("sea_share_requests")
    .delete()
    .eq("to_email", myEmail);
  if (shareToErr) {
    console.error("share to delete", shareToErr);
    return res.status(500).json({ error: "share_delete_failed" });
  }

  const { error: authErr } = await admin.auth.admin.deleteUser(userId);
  if (authErr) {
    console.error("auth delete", authErr);
    return res.status(500).json({ error: "auth_delete_failed" });
  }

  return res.status(200).json({ ok: true });
}
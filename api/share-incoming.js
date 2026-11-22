/** GET — 나에게 온 pending 공유 (service_role + Gmail canonical) */

import { getAuthUser, resolveUserEmail } from "./_lib/auth.js";
import { getAdminClient } from "./_lib/admin.js";
import { canonicalShareEmail, normalizeEmail, recipientOwnsShareRequest } from "./_lib/email.js";

function maskEmail(email) {
  const n = normalizeEmail(email);
  if (!n.includes("@")) return "***";
  const at = n.indexOf("@");
  const local = n.slice(0, at);
  const domain = n.slice(at + 1);
  const head = local.length <= 2 ? local : `${local.slice(0, 2)}***`;
  return `${head}@${domain}`;
}

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
  const myPlain = normalizeEmail(resolveUserEmail(user));
  if (!myCanon && !myPlain) {
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

  const allPending = data || [];
  const requests = allPending
    .filter((row) => row.from_user_id !== user.id && recipientOwnsShareRequest(row.to_email, user))
    .map(({ id, from_email, created_at }) => ({ id, from_email, created_at }));

  const debug = {
    pendingTotal: allPending.length,
    matched: requests.length,
    checkedPlain: myPlain || null,
    checkedCanon: myCanon || null,
    sampleRecipients: [...new Set(allPending.map((r) => maskEmail(r.to_email)))].slice(0, 5),
  };

  return res.status(200).json({
    requests,
    checkedAs: myCanon || myPlain,
    loginEmail: resolveUserEmail(user) || null,
    debug,
  });
}
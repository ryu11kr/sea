/** GET — Supabase + 공유 테이블 진단 (물때첩) */

import { getAdminClient } from "./_lib/admin.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }

  const supabaseUrl = (process.env.SUPABASE_URL || "").trim();
  const supabaseAnonKey = (process.env.SUPABASE_ANON_KEY || "").trim();
  const configured = Boolean(supabaseUrl && supabaseAnonKey);

  const hasServiceRole = Boolean((process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim());
  const admin = await getAdminClient();

  let shareTableReady = false;
  /** service_role 없으면 테이블 존재 여부를 서버에서 확인할 수 없음 */
  const shareTableCheckSkipped = !admin;
  let shareTableError = null;
  if (admin) {
    const { error } = await admin.from("sea_share_requests").select("id").limit(1);
    shareTableReady = !error;
    if (error?.code) shareTableError = error.code;
    else if (error?.message) shareTableError = "query_failed";
  }

  const hints = [];
  if (!configured) hints.push("Vercel에 SUPABASE_URL·SUPABASE_ANON_KEY를 넣고 Redeploy 하세요.");
  if (!hasServiceRole) {
    hints.push(
      "Vercel에 SUPABASE_SERVICE_ROLE_KEY(service_role)를 넣고 Redeploy — 공유 수락·탈퇴에 필요."
    );
  }
  if (shareTableCheckSkipped) {
    hints.push("shareTableReady는 service_role 설정 후에만 정확히 표시됩니다.");
  } else if (!shareTableReady) {
    hints.push("Supabase SQL Editor에서 supabase/sea-share-setup.sql 전체를 Run 하세요.");
  }

  return res.status(200).json({
    configured,
    hasUrl: Boolean(supabaseUrl),
    hasAnonKey: Boolean(supabaseAnonKey),
    hasServiceRole,
    shareTableReady,
    shareTableCheckSkipped,
    shareTableError,
    acceptNeedsServiceRole: true,
    hint: hints.length ? hints.join(" ") : "공유·클라우드 설정이 갖춰졌습니다.",
  });
}
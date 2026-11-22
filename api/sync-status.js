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
  if (admin) {
    const { error } = await admin.from("sea_share_requests").select("id").limit(1);
    shareTableReady = !error;
  }

  return res.status(200).json({
    configured,
    hasUrl: Boolean(supabaseUrl),
    hasAnonKey: Boolean(supabaseAnonKey),
    hasServiceRole,
    shareTableReady,
    acceptNeedsServiceRole: true,
    hint: "로그인 UI는 cloud-sync.runtime.json 과 Supabase Google Provider 가 필요합니다.",
  });
}
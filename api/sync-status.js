/** GET — Supabase 클라우드 연결 진단 (물때첩) */

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

  return res.status(200).json({
    configured: Boolean(supabaseUrl && supabaseAnonKey),
    hasUrl: Boolean(supabaseUrl),
    hasAnonKey: Boolean(supabaseAnonKey),
    hint: "로그인 UI는 cloud-sync.runtime.json 과 Supabase Google Provider 가 필요합니다.",
  });
}
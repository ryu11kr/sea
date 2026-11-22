/** Bearer JWT → Supabase 사용자 */

export async function getAuthUser(req) {
  const url = (process.env.SUPABASE_URL || "").trim();
  const anon = (process.env.SUPABASE_ANON_KEY || "").trim();
  const token = String(req.headers.authorization || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (!url || !anon || !token) return null;

  const { createClient } = await import("@supabase/supabase-js");
  const client = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const {
    data: { user },
    error,
  } = await client.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

export function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}
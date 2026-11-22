/** GET — 앱 배포 버전 (가벼운 폴링용) */

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }

  const sha = process.env.VERCEL_GIT_COMMIT_SHA || null;
  const build = sha ? parseInt(sha.replace(/[^a-f0-9]/gi, "").slice(0, 8), 16) || 0 : 0;

  let versionFile = null;
  try {
    const { readFileSync } = await import("node:fs");
    versionFile = JSON.parse(readFileSync("version.json", "utf8"));
  } catch {
    /* ignore */
  }

  return res.status(200).json({
    build: versionFile?.build ?? build,
    label: versionFile?.label ?? null,
    commitSha: versionFile?.commitSha ?? sha,
    updatedAt: versionFile?.updatedAt ?? null,
  });
}
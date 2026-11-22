import { readFileSync, writeFileSync } from "node:fs";

const sha = process.env.VERCEL_GIT_COMMIT_SHA || `local-${Date.now()}`;
const hex = sha.replace(/[^a-f0-9]/gi, "");
const build = hex.length >= 8 ? parseInt(hex.slice(0, 8), 16) : Math.floor(Date.now() / 1000);

let cachePrefix = "sea-tide";
try {
  const cfg = JSON.parse(readFileSync("pwa.config.json", "utf8"));
  if (cfg.cachePrefix) cachePrefix = cfg.cachePrefix;
} catch {
  /* ignore */
}

const payload = {
  build,
  cacheName: `${cachePrefix}-${build}`,
  label: `배포 ${sha.slice(0, 7)}`,
  updatedAt: new Date().toISOString(),
  commitSha: sha,
};

writeFileSync("version.json", `${JSON.stringify(payload, null, 2)}\n`);
console.log(`version.json → build ${build} (${sha.slice(0, 7)})`);
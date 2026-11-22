import { readFileSync, writeFileSync } from "node:fs";
import { writeDeployVersionJs } from "./write-deploy-version.mjs";

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
writeDeployVersionJs(payload);
console.log(`version.json → build ${build} (${sha.slice(0, 7)})`);

const supabaseUrl = (process.env.SUPABASE_URL || "").trim();
const supabaseAnonKey = (process.env.SUPABASE_ANON_KEY || "").trim();
const syncRuntime = {
  configured: Boolean(supabaseUrl && supabaseAnonKey),
  supabaseUrl: supabaseUrl || null,
  supabaseAnonKey: supabaseAnonKey || null,
  builtAt: new Date().toISOString(),
};
writeFileSync("cloud-sync.runtime.json", `${JSON.stringify(syncRuntime, null, 2)}\n`);
console.log(`cloud-sync.runtime.json → configured ${syncRuntime.configured ? "yes" : "no"}`);
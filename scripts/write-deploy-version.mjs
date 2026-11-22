import { writeFileSync } from "node:fs";

/**
 * @param {{ build: number, commitSha?: string | null, updatedAt?: string | null }} payload
 */
export function writeDeployVersionJs(payload) {
  const meta = {
    build: payload.build,
    commitSha: payload.commitSha || null,
    updatedAt: payload.updatedAt || null,
  };
  writeFileSync("deploy-version.js", `window.SEA_DEPLOY_VERSION=${JSON.stringify(meta)};\n`);
}
/** 공유용 이메일 — Gmail 점(.)·googlemail·+alias 정규화 */

export function normalizeEmail(email) {
  let raw = String(email || "")
    .trim()
    .toLowerCase();
  if (!raw) return "";
  if (!raw.includes("@")) {
    raw = `${raw}@gmail.com`;
  }
  return raw;
}

/** DB·매칭에 쓰는 canonical (Gmail만 점·플러스 제거) */
export function canonicalShareEmail(email) {
  const raw = normalizeEmail(email);
  if (!raw.includes("@")) return raw;
  const at = raw.indexOf("@");
  let local = raw.slice(0, at);
  let domain = raw.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") {
    const plus = local.indexOf("+");
    if (plus >= 0) local = local.slice(0, plus);
    local = local.replace(/\./g, "");
  }
  return `${local}@${domain}`;
}

export function shareEmailsMatch(a, b) {
  const ca = canonicalShareEmail(a);
  const cb = canonicalShareEmail(b);
  return Boolean(ca && cb && ca === cb);
}
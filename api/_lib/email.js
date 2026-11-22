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

/** @param {string} rowToEmail
 * @param {string | { email?: string, user_metadata?: object }} userOrEmail
 */
export function recipientOwnsShareRequest(rowToEmail, userOrEmail) {
  let raw =
    typeof userOrEmail === "string"
      ? userOrEmail
      : userOrEmail?.email ||
        userOrEmail?.user_metadata?.email ||
        userOrEmail?.user_metadata?.email_address ||
        "";
  if (!raw) return false;
  const candidates = [normalizeEmail(raw), canonicalShareEmail(raw)].filter(Boolean);
  const toNorm = normalizeEmail(rowToEmail);
  for (const mine of candidates) {
    if (toNorm === mine) return true;
    if (shareEmailsMatch(rowToEmail, mine)) return true;
  }
  return false;
}

/** Vercel/Node에서 POST JSON 본문 */
export function readJsonBody(req) {
  const body = req?.body;
  if (Buffer.isBuffer(body)) {
    try {
      return JSON.parse(body.toString("utf8"));
    } catch {
      return {};
    }
  }
  if (body && typeof body === "object") return body;
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  return {};
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return UUID_RE.test(String(value || "").trim());
}
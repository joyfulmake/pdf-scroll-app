// Cookie parsing/writing + token hashing helpers shared by every functions/api/auth/*.js
// endpoint — kept separate from authHandlers.js so this string-building logic isn't
// duplicated across each thin endpoint file.

const SESSION_COOKIE = "pdfscroll_session";
const STATE_COOKIE = "pdfscroll_oauth_state";

export function parseCookies(request) {
  const header = request.headers.get("Cookie");
  if (!header) return {};
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function bytesToBase64Url(bytes) {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(byteLength = 32) {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Hex(input) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cookieAttrs(maxAgeSeconds) {
  return `Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function sessionCookieHeader(token, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieAttrs(maxAgeSeconds)}`;
}
export function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; ${cookieAttrs(0)}`;
}
export function getSessionToken(request) {
  return parseCookies(request)[SESSION_COOKIE];
}

export function stateCookieHeader(state) {
  return `${STATE_COOKIE}=${encodeURIComponent(state)}; ${cookieAttrs(600)}`;
}
export function clearStateCookieHeader() {
  return `${STATE_COOKIE}=; ${cookieAttrs(0)}`;
}
export function getStateCookie(request) {
  return parseCookies(request)[STATE_COOKIE];
}

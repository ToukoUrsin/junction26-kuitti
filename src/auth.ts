import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { getDb, type User, type Workspace } from "./db";

export const SESSION_COOKIE = "kuitti_session";
export const PRE_CSRF_COOKIE = "kuitti_csrf";
const SESSION_DAYS = 14;

export interface AuthUser {
  id: number;
  workspace_id: number;
  name: string;
  email: string;
  workspace_name: string;
}

export type Env = {
  Variables: {
    user: AuthUser;
    csrf: string;
  };
};

function randomToken(bytes = 32): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

function sha256(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const secureCookies = () => process.env.COOKIE_SECURE === "1";

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash).catch(() => false);
}

// A real hash of a random string, so unknown emails take as long as wrong passwords.
let dummyHash: Promise<string> | null = null;
export function dummyVerify(password: string): Promise<boolean> {
  dummyHash ??= hashPassword(randomToken());
  return dummyHash.then((h) => verifyPassword(password, h)).then(() => false);
}

export function createSession(c: Context, userId: number): void {
  const token = randomToken();
  const csrf = randomToken();
  const expires = Date.now() + SESSION_DAYS * 86400_000;
  getDb()
    .query("INSERT INTO sessions (token_hash, user_id, csrf, expires_at) VALUES (?, ?, ?, ?)")
    .run(sha256(token), userId, csrf, expires);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: secureCookies(),
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
}

export function destroySession(c: Context): void {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) getDb().query("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

interface SessionRow {
  user_id: number;
  csrf: string;
  expires_at: number;
  workspace_id: number;
  name: string;
  email: string;
  workspace_name: string;
}

export function loadSession(c: Context): { user: AuthUser; csrf: string } | null {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || token.length > 100) return null;
  const row = getDb()
    .query<SessionRow, [string]>(
      `SELECT s.user_id, s.csrf, s.expires_at, u.workspace_id, u.name, u.email, w.name AS workspace_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN workspaces w ON w.id = u.workspace_id
       WHERE s.token_hash = ?`,
    )
    .get(sha256(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    getDb().query("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
    return null;
  }
  return {
    user: {
      id: row.user_id,
      workspace_id: row.workspace_id,
      name: row.name,
      email: row.email,
      workspace_name: row.workspace_name,
    },
    csrf: row.csrf,
  };
}

/** Pre-login CSRF token (double submit cookie) for the sign-in form. */
export function preCsrf(c: Context): string {
  let t = getCookie(c, PRE_CSRF_COOKIE);
  if (!t || t.length !== 43) {
    t = randomToken();
    setCookie(c, PRE_CSRF_COOKIE, t, { httpOnly: true, sameSite: "Lax", secure: secureCookies(), path: "/" });
  }
  return t;
}

export function checkPreCsrf(c: Context, submitted: unknown): boolean {
  const cookie = getCookie(c, PRE_CSRF_COOKIE);
  return typeof submitted === "string" && !!cookie && timingSafeEqual(cookie, submitted);
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function submittedCsrf(c: Context): Promise<string> {
  const header = c.req.header("x-csrf-token");
  if (header) return header;
  const type = c.req.header("content-type") ?? "";
  if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
    const body = await c.req.parseBody();
    const v = body["_csrf"];
    return typeof v === "string" ? v : "";
  }
  return "";
}

/** Pages: redirect to sign-in when there is no session; check CSRF on writes. */
export const requirePage: MiddlewareHandler<Env> = async (c, next) => {
  const s = loadSession(c);
  if (!s) {
    if (c.req.method === "GET" || c.req.method === "HEAD") {
      const url = new URL(c.req.url);
      const nextPath = url.pathname + url.search;
      return c.redirect(nextPath === "/" ? "/login" : `/login?next=${encodeURIComponent(nextPath)}`);
    }
    return c.text("Sign in required", 401);
  }
  c.set("user", s.user);
  c.set("csrf", s.csrf);
  if (UNSAFE.has(c.req.method) && !timingSafeEqual(await submittedCsrf(c), s.csrf)) {
    return c.text("Invalid or missing CSRF token. Reload the page and try again.", 403);
  }
  await next();
};

/** JSON API: 401 without a session; CSRF header required on writes. */
export const requireApi: MiddlewareHandler<Env> = async (c, next) => {
  const s = loadSession(c);
  if (!s) return c.json({ error: "unauthorized" }, 401);
  c.set("user", s.user);
  c.set("csrf", s.csrf);
  if (UNSAFE.has(c.req.method) && !timingSafeEqual(c.req.header("x-csrf-token") ?? "", s.csrf)) {
    return c.json({ error: "invalid_csrf" }, 403);
  }
  await next();
};

// ---- Login throttling (in memory, per process) ----

const WINDOW_MS = 15 * 60_000;
const MAX_PER_ACCOUNT = 5;
const MAX_PER_IP = 30;
const failures = new Map<string, number[]>();

function recent(key: string, now: number): number[] {
  const list = (failures.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length) failures.set(key, list);
  else failures.delete(key);
  return list;
}

/** Seconds until another attempt is allowed, or 0. */
export function throttled(ip: string, email: string, now = Date.now()): number {
  const acct = recent(`a:${ip}:${email.toLowerCase()}`, now);
  const byIp = recent(`i:${ip}`, now);
  if (acct.length >= MAX_PER_ACCOUNT) return Math.ceil((WINDOW_MS - (now - acct[0]!)) / 1000);
  if (byIp.length >= MAX_PER_IP) return Math.ceil((WINDOW_MS - (now - byIp[0]!)) / 1000);
  return 0;
}

export function recordFailure(ip: string, email: string, now = Date.now()): void {
  for (const key of [`a:${ip}:${email.toLowerCase()}`, `i:${ip}`]) {
    const list = recent(key, now);
    list.push(now);
    failures.set(key, list);
  }
}

export function clearFailures(ip: string, email: string): void {
  failures.delete(`a:${ip}:${email.toLowerCase()}`);
}

export function resetThrottle(): void {
  failures.clear();
}

export type { User, Workspace };

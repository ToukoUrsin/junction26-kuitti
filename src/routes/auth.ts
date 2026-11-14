import { Hono, type Context } from "hono";
import { getConnInfo } from "hono/bun";
import {
  checkPreCsrf,
  clearFailures,
  createSession,
  destroySession,
  dummyVerify,
  loadSession,
  preCsrf,
  recordFailure,
  throttled,
  timingSafeEqual,
  verifyPassword,
  type Env,
} from "../auth";
import { getUserByEmail } from "../db";
import { esc, str } from "../lib/util";
import { bare, logo } from "../views/layout";

export const authRoutes = new Hono<Env>();

function clientIp(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "local";
  }
}

/** Only allow redirects to local paths. */
function safeNext(next: unknown): string {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/";
  return next;
}

function loginPage(token: string, opts: { email?: string; error?: string; next?: string } = {}): string {
  return bare(
    "Sign in",
    `<main class="auth-wrap">
  <div class="auth-card">
    <div class="logo auth-logo">${logo()}</div>
    <h1>Sign in to your workspace</h1>
    <p class="muted">Invoices, clients and payments for small teams.</p>
    ${opts.error ? `<div class="alert" role="alert">${esc(opts.error)}</div>` : ""}
    <form method="post" action="/login" class="form">
      <input type="hidden" name="_csrf" value="${esc(token)}">
      <input type="hidden" name="next" value="${esc(opts.next ?? "/")}">
      <label class="field"><span>Email</span>
        <input type="email" name="email" autocomplete="username" required value="${esc(opts.email ?? "")}" autofocus>
      </label>
      <label class="field"><span>Password</span>
        <input type="password" name="password" autocomplete="current-password" required>
      </label>
      <button type="submit" class="btn btn-primary btn-block">Sign in</button>
    </form>
  </div>
  <p class="auth-foot muted">Kuitti · invoicing for small teams</p>
</main>`,
  );
}

authRoutes.get("/login", (c) => {
  if (loadSession(c)) return c.redirect("/");
  return c.html(loginPage(preCsrf(c), { next: safeNext(c.req.query("next")) }));
});

authRoutes.post("/login", async (c) => {
  const body = await c.req.parseBody();
  const email = str(body.email, 200).toLowerCase();
  const password = typeof body.password === "string" ? body.password.slice(0, 200) : "";
  const next = safeNext(body.next);
  if (!checkPreCsrf(c, body._csrf)) {
    return c.html(loginPage(preCsrf(c), { email, next, error: "Your session expired. Please try again." }), 403);
  }
  const token = preCsrf(c);
  const ip = clientIp(c);
  const wait = throttled(ip, email);
  if (wait > 0) {
    c.header("Retry-After", String(wait));
    return c.html(
      loginPage(token, { email, next, error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minutes.` }),
      429,
    );
  }
  const user = email ? getUserByEmail(email) : null;
  const ok = user ? await verifyPassword(password, user.password_hash) : await dummyVerify(password);
  if (!user || !ok) {
    recordFailure(ip, email);
    return c.html(loginPage(token, { email, next, error: "Email or password is incorrect." }), 401);
  }
  clearFailures(ip, email);
  createSession(c, user.id);
  return c.redirect(next);
});

authRoutes.post("/logout", async (c) => {
  const s = loadSession(c);
  if (s) {
    const body = await c.req.parseBody();
    const submitted = typeof body._csrf === "string" ? body._csrf : "";
    if (!timingSafeEqual(submitted, s.csrf)) return c.text("Invalid or missing CSRF token.", 403);
    destroySession(c);
  }
  return c.redirect("/login");
});

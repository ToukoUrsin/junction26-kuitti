import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { loadSession, requirePage, type Env } from "./auth";
import { getDb } from "./db";
import { apiRoutes } from "./routes/api";
import { authRoutes } from "./routes/auth";
import { clientRoutes } from "./routes/clients";
import { dashboardRoutes } from "./routes/dashboard";
import { invoiceRoutes } from "./routes/invoices";
import { settingsRoutes } from "./routes/settings";
import { errorPage } from "./views/layout";

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

export function createApp(): Hono<Env> {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    await next();
    c.header("Content-Security-Policy", CSP);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "same-origin");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    c.header("Cross-Origin-Opener-Policy", "same-origin");
    if (!c.req.path.startsWith("/static/")) c.header("Cache-Control", "no-store");
  });

  app.get("/healthz", (c) => {
    getDb().query("SELECT 1").get();
    return c.json({ ok: true });
  });

  app.use(
    "/static/*",
    serveStatic({
      root: "./public",
      rewriteRequestPath: (p) => p.replace(/^\/static/, ""),
      onFound: (_path, c) => {
        c.header("Cache-Control", "public, max-age=3600");
      },
    }),
  );

  app.route("/", authRoutes);
  app.route("/api", apiRoutes);

  app.use("/", requirePage);
  app.use("/invoices", requirePage);
  app.use("/invoices/*", requirePage);
  app.use("/clients", requirePage);
  app.use("/clients/*", requirePage);
  app.use("/settings", requirePage);
  app.use("/settings/*", requirePage);

  app.route("/", dashboardRoutes);
  app.route("/", invoiceRoutes);
  app.route("/", clientRoutes);
  app.route("/", settingsRoutes);

  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) return c.json({ error: "not_found" }, 404);
    const s = loadSession(c);
    return c.html(errorPage(404, "Page not found", "The page you are looking for does not exist.", s?.user, s?.csrf), 404);
  });

  app.onError((err, c) => {
    console.error(err);
    if (c.req.path.startsWith("/api/")) return c.json({ error: "server_error" }, 500);
    return c.html(errorPage(500, "Something went wrong", "Please try again in a moment."), 500);
  });

  return app;
}

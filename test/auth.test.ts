import { beforeEach, describe, expect, test } from "bun:test";
import { ALICE, BOB, Client, as, setup } from "./helpers";

beforeEach(setup);

describe("auth", () => {
  test("signed-out visitors are sent to the sign-in page", async () => {
    const res = await new Client().get("/invoices?status=paid");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?next=%2Finvoices%3Fstatus%3Dpaid");
  });

  test("the sign-in page renders the form the runner expects", async () => {
    const html = await (await new Client().get("/login")).text();
    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
    expect(html).toContain('type="submit"');
  });

  test("alice can sign in and lands on her dashboard", async () => {
    const c = new Client();
    const res = await c.login(ALICE);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const html = await (await c.get("/")).text();
    expect(html).toContain("Nordlys Studio");
    expect(html).toContain("Outstanding");
  });

  test("bob signs in to Harbour & Co", async () => {
    const c = await as(BOB);
    const html = await (await c.get("/")).text();
    expect(html).toContain("Harbour &amp; Co");
  });

  test("email is case-insensitive", async () => {
    const res = await new Client().login({ email: "ALICE@Nordlys.test", password: ALICE.password });
    expect(res.status).toBe(302);
  });

  test("wrong password is rejected with a generic message", async () => {
    const res = await new Client().login({ email: ALICE.email, password: "nope" });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("Email or password is incorrect.");
  });

  test("unknown email gets the same message", async () => {
    const res = await new Client().login({ email: "nobody@nordlys.test", password: "whatever" });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("Email or password is incorrect.");
  });

  test("session cookie is HttpOnly and SameSite=Lax", async () => {
    const c = new Client();
    await c.get("/login");
    const page = await (await c.get("/login")).text();
    const token = /name="_csrf" value="([^"]+)"/.exec(page)![1]!;
    const res = await c.form("/login", { _csrf: token, email: ALICE.email, password: ALICE.password });
    const cookie = res.headers.getSetCookie().find((h) => h.startsWith("kuitti_session="))!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  test("sign-in without the CSRF token is refused", async () => {
    const c = new Client();
    await c.get("/login");
    const res = await c.form("/login", { email: ALICE.email, password: ALICE.password }, false);
    expect(res.status).toBe(403);
    expect(c.cookies.has("kuitti_session")).toBe(false);
  });

  test("repeated failures are throttled", async () => {
    const c = new Client();
    for (let i = 0; i < 5; i++) expect((await c.login({ email: ALICE.email, password: `bad-${i}` })).status).toBe(401);
    const res = await c.login(ALICE);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  test("sign out ends the session", async () => {
    const c = await as(ALICE);
    const res = await c.form("/logout", {});
    expect(res.status).toBe(302);
    expect((await c.get("/")).status).toBe(302);
  });

  test("sign out needs the CSRF token", async () => {
    const c = await as(ALICE);
    const res = await c.form("/logout", { _csrf: "forged" });
    expect(res.status).toBe(403);
    expect((await c.get("/")).status).toBe(200);
  });

  test("next only redirects to local paths", async () => {
    const c = new Client();
    const page = await (await c.get("/login?next=//evil.example")).text();
    expect(page).toContain('name="next" value="/"');
  });

  test("API answers 401 without a session", async () => {
    const res = await new Client().api("/api/invoices");
    expect(res.status).toBe(401);
  });

  test("security headers are set", async () => {
    const res = await new Client().get("/login");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("healthz is public", async () => {
    const res = await new Client().get("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

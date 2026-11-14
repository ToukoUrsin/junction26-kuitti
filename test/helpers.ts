import { createApp } from "../src/app";
import { resetThrottle } from "../src/auth";
import { getDb, openDb } from "../src/db";
import { seed } from "../scripts/seed";

export const ALICE = { email: "alice@nordlys.test", password: "crashtest-alice" };
export const BOB = { email: "bob@harbour.test", password: "crashtest-bob" };

let app: ReturnType<typeof createApp>;

/** Fresh in-memory database with the small seed. */
export async function setup() {
  openDb(":memory:");
  await seed("small", "2026-11-14");
  resetThrottle();
  app = createApp();
  return app;
}

export class Client {
  cookies = new Map<string, string>();
  csrf = "";

  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  absorb(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const idx = pair!.indexOf("=");
      const name = pair!.slice(0, idx);
      const value = pair!.slice(idx + 1);
      if (/max-age=0/i.test(line) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async req(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set("cookie", this.cookieHeader());
    const res = await app.request(path, { ...init, headers, redirect: "manual" });
    this.absorb(res);
    return res;
  }

  get(path: string) {
    return this.req(path);
  }

  /** Form POST, adding the session CSRF token unless `_csrf` is given. */
  form(path: string, fields: Record<string, string | string[]>, withCsrf = true) {
    const body = new URLSearchParams();
    if (withCsrf && !("_csrf" in fields)) body.append("_csrf", this.csrf);
    for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
    return this.req(path, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
  }

  api(path: string, method = "GET", json?: unknown, withCsrf = true) {
    const headers: Record<string, string> = { accept: "application/json" };
    if (json !== undefined) headers["content-type"] = "application/json";
    if (withCsrf && method !== "GET") headers["x-csrf-token"] = this.csrf;
    return this.req(path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  }

  async login(who: { email: string; password: string }): Promise<Response> {
    const page = await this.get("/login");
    const html = await page.text();
    const token = /name="_csrf" value="([^"]+)"/.exec(html)![1]!;
    const res = await this.form("/login", { _csrf: token, email: who.email, password: who.password });
    if (res.status === 302) await this.refreshCsrf();
    return res;
  }

  async refreshCsrf() {
    const html = await (await this.get("/")).text();
    const m = /<meta name="csrf-token" content="([^"]+)">/.exec(html);
    this.csrf = m ? m[1]! : "";
  }
}

export async function as(who: { email: string; password: string }): Promise<Client> {
  const c = new Client();
  const res = await c.login(who);
  if (res.status !== 302) throw new Error(`login failed: ${res.status}`);
  return c;
}

export function idsFor(workspaceName: string) {
  const db = getDb();
  const ws = db.query<{ id: number }, [string]>("SELECT id FROM workspaces WHERE name = ?").get(workspaceName)!;
  const invoice = db
    .query<{ id: number }, [number]>("SELECT id FROM invoices WHERE workspace_id = ? AND status = 'sent' ORDER BY id LIMIT 1")
    .get(ws.id)!;
  const client = db.query<{ id: number }, [number]>("SELECT id FROM clients WHERE workspace_id = ? ORDER BY id LIMIT 1").get(ws.id)!;
  return { workspace: ws.id, invoice: invoice.id, client: client.id };
}

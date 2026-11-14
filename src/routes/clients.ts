import { Hono } from "hono";
import type { Env } from "../auth";
import { getDb, LINE_AMOUNT_SQL } from "../db";
import { esc, money, str } from "../lib/util";
import { page } from "../views/layout";

export const clientRoutes = new Hono<Env>();

interface ClientRow {
  id: number;
  name: string;
  contact_name: string;
  email: string;
  invoice_count: number;
  outstanding: number;
  billed: number;
}

export interface ClientInput {
  name: string;
  contact_name: string;
  email: string;
  address: string;
  vat_id: string;
}

export function readClient(body: Record<string, unknown>): ClientInput {
  return {
    name: str(body.name, 120),
    contact_name: str(body.contact_name, 120),
    email: str(body.email, 200),
    address: str(body.address, 400),
    vat_id: str(body.vat_id, 40),
  };
}

export function validateClient(input: ClientInput): string[] {
  const errors: string[] = [];
  if (!input.name) errors.push("Company name is required.");
  if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) errors.push("Email address does not look right.");
  return errors;
}

export function insertClient(workspaceId: number, input: ClientInput): number {
  return getDb()
    .query<{ id: number }, [number, string, string, string, string, string]>(
      "INSERT INTO clients (workspace_id, name, contact_name, email, address, vat_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .get(workspaceId, input.name, input.contact_name, input.email, input.address, input.vat_id)!.id;
}

clientRoutes.get("/clients", (c) => {
  const user = c.get("user");
  const rows = getDb()
    .query<ClientRow, [number]>(
      `SELECT c.id, c.name, c.contact_name, c.email,
              COUNT(t.id) AS invoice_count,
              COALESCE(SUM(CASE WHEN t.status = 'sent' THEN t.total END), 0) AS outstanding,
              COALESCE(SUM(CASE WHEN t.status != 'draft' THEN t.total END), 0) AS billed
       FROM clients c
       LEFT JOIN (
         SELECT i.id, i.client_id, i.status,
                (SELECT COALESCE(SUM(${LINE_AMOUNT_SQL}), 0) FROM line_items li WHERE li.invoice_id = i.id) AS total
         FROM invoices i
       ) t ON t.client_id = c.id
       WHERE c.workspace_id = ?
       GROUP BY c.id
       ORDER BY c.name COLLATE NOCASE`,
    )
    .all(user.workspace_id);

  const added = c.req.query("done") === "created";
  const list = rows.length
    ? rows
        .map(
          (r) => `<tr>
      <td><span class="strong">${esc(r.name)}</span>${r.contact_name ? `<div class="muted small">${esc(r.contact_name)}</div>` : ""}</td>
      <td class="hide-sm">${r.email ? `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : `<span class="muted">–</span>`}</td>
      <td class="num hide-sm">${r.invoice_count}</td>
      <td class="num">${esc(money(r.outstanding))}</td>
      <td class="num hide-sm">${esc(money(r.billed))}</td>
      <td class="num"><a class="small" href="/invoices/new?client=${r.id}">New invoice</a></td>
    </tr>`,
        )
        .join("")
    : `<tr><td colspan="6" class="empty-cell">No clients yet. <a href="/clients/new">Add your first client</a>.</td></tr>`;

  const body = `
  <header class="page-head">
    <div><h1>Clients</h1><p class="muted">${rows.length} ${rows.length === 1 ? "client" : "clients"}</p></div>
    <a href="/clients/new" class="btn btn-primary">Add client</a>
  </header>
  <section class="card card-flush">
    <table class="table">
      <thead><tr><th>Client</th><th class="hide-sm">Email</th><th class="num hide-sm">Invoices</th><th class="num">Outstanding</th><th class="num hide-sm">Billed</th><th class="num"><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${list}</tbody>
    </table>
  </section>`;
  return c.html(
    page({ title: "Clients", user, csrf: c.get("csrf"), section: "clients", body, flash: added ? "Client added." : undefined }),
  );
});

function clientForm(csrf: string, input: Partial<ClientInput> = {}, errors: string[] = []): string {
  return `
  <header class="page-head"><div><a href="/clients" class="back">← Clients</a><h1>Add client</h1></div></header>
  ${errors.length ? `<div class="alert" role="alert"><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : ""}
  <form method="post" action="/clients" class="form narrow">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <section class="card">
      <div class="form-grid">
        <label class="field span-2"><span>Company name</span><input name="name" required maxlength="120" value="${esc(input.name ?? "")}"></label>
        <label class="field"><span>Contact person</span><input name="contact_name" maxlength="120" value="${esc(input.contact_name ?? "")}"></label>
        <label class="field"><span>Billing email</span><input type="email" name="email" maxlength="200" value="${esc(input.email ?? "")}"></label>
        <label class="field span-2"><span>Address</span><textarea name="address" rows="3" maxlength="400">${esc(input.address ?? "")}</textarea></label>
        <label class="field"><span>VAT ID <em class="muted">optional</em></span><input name="vat_id" maxlength="40" value="${esc(input.vat_id ?? "")}"></label>
      </div>
    </section>
    <div class="form-actions">
      <a href="/clients" class="btn btn-ghost">Cancel</a>
      <button type="submit" class="btn btn-primary">Add client</button>
    </div>
  </form>`;
}

clientRoutes.get("/clients/new", (c) => {
  const user = c.get("user");
  return c.html(page({ title: "Add client", user, csrf: c.get("csrf"), section: "clients", body: clientForm(c.get("csrf")) }));
});

clientRoutes.post("/clients", async (c) => {
  const user = c.get("user");
  const input = readClient(await c.req.parseBody());
  const errors = validateClient(input);
  if (errors.length) {
    return c.html(
      page({ title: "Add client", user, csrf: c.get("csrf"), section: "clients", body: clientForm(c.get("csrf"), input, errors) }),
      422,
    );
  }
  insertClient(user.workspace_id, input);
  return c.redirect("/clients?done=created");
});

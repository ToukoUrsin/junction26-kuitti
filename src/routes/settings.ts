import { Hono } from "hono";
import type { Env } from "../auth";
import { getDb, getWorkspace, workspaceMembers, type Workspace } from "../db";
import { esc, initials, str, toInt } from "../lib/util";
import { page } from "../views/layout";

export const settingsRoutes = new Hono<Env>();

type WorkspaceInput = Pick<
  Workspace,
  "name" | "legal_name" | "address" | "vat_id" | "email" | "iban" | "invoice_prefix" | "payment_terms"
>;

function view(csrf: string, ws: WorkspaceInput, members: { id: number; name: string; email: string }[], errors: string[] = []): string {
  return `
  <header class="page-head"><div><h1>Settings</h1><p class="muted">Workspace details printed on your invoices.</p></div></header>
  ${errors.length ? `<div class="alert" role="alert"><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : ""}
  <form method="post" action="/settings" class="form narrow">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <section class="card">
      <div class="card-head"><h2>Company</h2></div>
      <div class="form-grid">
        <label class="field"><span>Workspace name</span><input name="name" required maxlength="80" value="${esc(ws.name)}"></label>
        <label class="field"><span>Legal name</span><input name="legal_name" maxlength="120" value="${esc(ws.legal_name)}"></label>
        <label class="field span-2"><span>Address</span><textarea name="address" rows="3" maxlength="400">${esc(ws.address)}</textarea></label>
        <label class="field"><span>VAT ID</span><input name="vat_id" maxlength="40" value="${esc(ws.vat_id)}"></label>
        <label class="field"><span>Billing email</span><input type="email" name="email" maxlength="200" value="${esc(ws.email)}"></label>
      </div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Invoicing</h2></div>
      <div class="form-grid">
        <label class="field span-2"><span>IBAN</span><input name="iban" maxlength="42" value="${esc(ws.iban)}"></label>
        <label class="field"><span>Invoice number prefix</span><input name="invoice_prefix" required maxlength="8" pattern="[A-Za-z0-9]{1,8}" value="${esc(ws.invoice_prefix)}"></label>
        <label class="field"><span>Payment terms (days)</span><input type="number" name="payment_terms" min="0" max="120" required value="${esc(ws.payment_terms)}"></label>
      </div>
    </section>
    <div class="form-actions"><button type="submit" class="btn btn-primary">Save settings</button></div>
  </form>
  <section class="card narrow">
    <div class="card-head"><h2>Members</h2><span class="muted small">${members.length}</span></div>
    <ul class="members">${members
      .map((m) => `<li><span class="avatar">${esc(initials(m.name))}</span><span><span class="strong">${esc(m.name)}</span><span class="muted small block">${esc(m.email)}</span></span></li>`)
      .join("")}</ul>
  </section>`;
}

settingsRoutes.get("/settings", (c) => {
  const user = c.get("user");
  const ws = getWorkspace(user.workspace_id)!;
  return c.html(
    page({
      title: "Settings",
      user,
      csrf: c.get("csrf"),
      section: "settings",
      body: view(c.get("csrf"), ws, workspaceMembers(ws.id)),
      flash: c.req.query("done") === "saved" ? "Settings saved." : undefined,
    }),
  );
});

settingsRoutes.post("/settings", async (c) => {
  const user = c.get("user");
  const b = await c.req.parseBody();
  const input: WorkspaceInput = {
    name: str(b.name, 80),
    legal_name: str(b.legal_name, 120),
    address: str(b.address, 400),
    vat_id: str(b.vat_id, 40),
    email: str(b.email, 200),
    iban: str(b.iban, 42).toUpperCase(),
    invoice_prefix: str(b.invoice_prefix, 8).toUpperCase(),
    payment_terms: toInt(str(b.payment_terms, 3)) ?? -1,
  };
  const errors: string[] = [];
  if (!input.name) errors.push("Workspace name is required.");
  if (!/^[A-Z0-9]{1,8}$/.test(input.invoice_prefix)) errors.push("Prefix can only contain letters and digits (up to 8).");
  if (input.payment_terms < 0 || input.payment_terms > 120) errors.push("Payment terms must be between 0 and 120 days.");
  if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) errors.push("Billing email does not look right.");
  if (errors.length) {
    return c.html(
      page({ title: "Settings", user, csrf: c.get("csrf"), section: "settings", body: view(c.get("csrf"), input, workspaceMembers(user.workspace_id), errors) }),
      422,
    );
  }
  getDb()
    .query(
      `UPDATE workspaces SET name = ?, legal_name = ?, address = ?, vat_id = ?, email = ?, iban = ?, invoice_prefix = ?, payment_terms = ?
       WHERE id = ?`,
    )
    .run(input.name, input.legal_name, input.address, input.vat_id, input.email, input.iban, input.invoice_prefix, input.payment_terms, user.workspace_id);
  return c.redirect("/settings?done=saved");
});

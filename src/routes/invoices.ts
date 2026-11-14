import { Hono } from "hono";
import type { Env } from "../auth";
import { getClient, getInvoice, getWorkspace, invoiceTotal, lineItems, workspaceClients } from "../db";
import {
  blankForm,
  createInvoice,
  listInvoices,
  parseStatusFilter,
  readInvoiceForm,
  STATUS_FILTERS,
  updateInvoice,
  validateInvoice,
  type InvoiceForm,
  type StatusFilter,
} from "../lib/invoices";
import { displayStatus, esc, fmtDate, money, parseMoney, parseQuantity, statusBadge, today, toInt } from "../lib/util";
import { errorPage, page } from "../views/layout";

export const invoiceRoutes = new Hono<Env>();

const FILTER_LABEL: Record<StatusFilter, string> = {
  all: "All",
  draft: "Drafts",
  sent: "Outstanding",
  overdue: "Overdue",
  paid: "Paid",
};

const FLASH: Record<string, string> = {
  created: "Invoice created.",
  saved: "Changes saved.",
  deleted: "Invoice deleted.",
};

function listHref(status: StatusFilter, pageNo: number): string {
  const q = new URLSearchParams();
  if (status !== "all") q.set("status", status);
  if (pageNo > 1) q.set("page", String(pageNo));
  const s = q.toString();
  return s ? `/invoices?${s}` : "/invoices";
}

invoiceRoutes.get("/invoices", (c) => {
  const user = c.get("user");
  const status = parseStatusFilter(c.req.query("status"));
  const pageNo = toInt(c.req.query("page")) ?? 1;
  const res = listInvoices(user.workspace_id, status, pageNo);
  const now = today();

  const tabs = STATUS_FILTERS.map(
    (s) =>
      `<a href="${listHref(s, 1)}" class="tab${s === status ? " active" : ""}"${s === status ? ' aria-current="true"' : ""}>${FILTER_LABEL[s]} <span class="tab-count">${res.counts[s]}</span></a>`,
  ).join("");

  const rows = res.rows.length
    ? res.rows
        .map(
          (r) => `<tr class="row-link" data-href="/invoices/${r.id}">
      <td class="hide-sm"><a href="/invoices/${r.id}" class="strong">${esc(r.number)}</a></td>
      <td><a href="/invoices/${r.id}" class="strong show-sm">${esc(r.client_name)}</a><span class="hide-sm">${esc(r.client_name)}</span><span class="muted small show-sm">${esc(r.number)}</span></td>
      <td>${statusBadge(displayStatus(r, now))}</td>
      <td class="hide-sm">${esc(fmtDate(r.due_date))}</td>
      <td class="num">${esc(money(r.total))}</td>
    </tr>`,
        )
        .join("")
    : `<tr><td colspan="5" class="empty-cell">No ${status === "all" ? "" : FILTER_LABEL[status].toLowerCase() + " "}invoices.</td></tr>`;

  const from = res.total === 0 ? 0 : (res.page - 1) * 25 + 1;
  const to = Math.min(res.page * 25, res.total);
  const pager = `<nav class="pager" aria-label="Pages">
    <span class="muted small">${from}–${to} of ${res.total}</span>
    <span class="pager-buttons">
      ${res.page > 1 ? `<a class="btn btn-small" href="${listHref(status, res.page - 1)}" rel="prev">Previous</a>` : `<span class="btn btn-small disabled" aria-disabled="true">Previous</span>`}
      <span class="small muted">Page ${res.page} of ${res.pages}</span>
      ${res.page < res.pages ? `<a class="btn btn-small" href="${listHref(status, res.page + 1)}" rel="next">Next</a>` : `<span class="btn btn-small disabled" aria-disabled="true">Next</span>`}
    </span>
  </nav>`;

  const flash = FLASH[c.req.query("done") ?? ""];
  const body = `
  <header class="page-head">
    <div><h1>Invoices</h1><p class="muted">${res.counts.all} invoices in ${esc(user.workspace_name)}</p></div>
    <a href="/invoices/new" class="btn btn-primary">New invoice</a>
  </header>
  <div class="tabs" role="navigation" aria-label="Filter by status">${tabs}</div>
  <section class="card card-flush">
    <table class="table" id="invoice-table">
      <thead><tr><th class="hide-sm">Number</th><th>Client</th><th>Status</th><th class="hide-sm">Due date</th><th class="num">Total</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>
  ${pager}`;

  return c.html(page({ title: "Invoices", user, csrf: c.get("csrf"), section: "invoices", body, flash }));
});

function invoiceFormView(opts: {
  action: string;
  form: InvoiceForm;
  clients: { id: number; name: string }[];
  errors?: string[];
  csrf: string;
  isNew: boolean;
  cancelHref: string;
}): string {
  const { form } = opts;
  const options = opts.clients
    .map((cl) => `<option value="${cl.id}"${String(cl.id) === form.client_id ? " selected" : ""}>${esc(cl.name)}</option>`)
    .join("");
  const items = form.items.length ? form.items : [{ description: "", quantity: "1", unit_price: "" }];
  const lineRow = (it: { description: string; quantity: string; unit_price: string }) => {
    const q = parseQuantity(it.quantity);
    const p = parseMoney(it.unit_price);
    const amount = q !== null && p !== null ? money(Math.round(q * p)) : "–";
    return `<tr class="line">
      <td><input name="description" value="${esc(it.description)}" placeholder="What did you deliver?" aria-label="Description" maxlength="300"></td>
      <td class="w-qty"><input name="quantity" value="${esc(it.quantity)}" inputmode="decimal" aria-label="Quantity" class="num"></td>
      <td class="w-price"><input name="unit_price" value="${esc(it.unit_price)}" inputmode="decimal" placeholder="0.00" aria-label="Unit price (EUR)" class="num"></td>
      <td class="num line-amount">${esc(amount)}</td>
      <td class="w-remove"><button type="button" class="icon-button remove-line" aria-label="Remove line">×</button></td>
    </tr>`;
  };
  const errors = opts.errors?.length
    ? `<div class="alert" role="alert"><strong>Please fix the following:</strong><ul>${opts.errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>`
    : "";
  const noClients = opts.clients.length === 0
    ? `<div class="alert alert-info">You have no clients yet. <a href="/clients/new">Add a client</a> first.</div>`
    : "";
  return `${errors}${noClients}
  <form method="post" action="${esc(opts.action)}" class="form invoice-form" id="invoice-form">
    <input type="hidden" name="_csrf" value="${esc(opts.csrf)}">
    <section class="card">
      <div class="form-grid">
        <label class="field span-2"><span>Client</span>
          <select name="client_id" required><option value="">Choose a client…</option>${options}</select>
        </label>
        <label class="field"><span>Issue date</span><input type="date" name="issue_date" value="${esc(form.issue_date)}" required></label>
        <label class="field"><span>Due date</span><input type="date" name="due_date" value="${esc(form.due_date)}" required></label>
        <label class="field span-2"><span>Reference <em class="muted">optional</em></span><input name="reference" value="${esc(form.reference)}" placeholder="PO number or project name" maxlength="120"></label>
      </div>
    </section>
    <section class="card card-flush">
      <div class="card-head padded"><h2>Line items</h2></div>
      <table class="table lines-table">
        <thead><tr><th>Description</th><th class="num w-qty">Qty</th><th class="num w-price">Unit price</th><th class="num">Amount</th><th class="w-remove"><span class="sr-only">Remove</span></th></tr></thead>
        <tbody id="lines">${items.map(lineRow).join("")}</tbody>
        <tfoot><tr>
          <td colspan="3"><button type="button" class="btn btn-small" id="add-line">Add line</button></td>
          <td class="num strong" id="form-total">–</td><td></td>
        </tr></tfoot>
      </table>
    </section>
    <div class="form-actions">
      <a href="${esc(opts.cancelHref)}" class="btn btn-ghost">Cancel</a>
      ${opts.isNew
        ? `<button type="submit" name="intent" value="draft" class="btn">Save as draft</button>
           <button type="submit" name="intent" value="sent" class="btn btn-primary">Create and mark sent</button>`
        : `<button type="submit" class="btn btn-primary">Save changes</button>`}
    </div>
  </form>
  <template id="line-template">
    <tr class="line">
      <td><input name="description" placeholder="What did you deliver?" aria-label="Description" maxlength="300"></td>
      <td class="w-qty"><input name="quantity" value="1" inputmode="decimal" aria-label="Quantity" class="num"></td>
      <td class="w-price"><input name="unit_price" inputmode="decimal" placeholder="0.00" aria-label="Unit price (EUR)" class="num"></td>
      <td class="num line-amount">–</td>
      <td class="w-remove"><button type="button" class="icon-button remove-line" aria-label="Remove line">×</button></td>
    </tr>
  </template>`;
}

invoiceRoutes.get("/invoices/new", (c) => {
  const user = c.get("user");
  const ws = getWorkspace(user.workspace_id)!;
  const form = blankForm(ws.payment_terms);
  const pre = toInt(c.req.query("client"));
  if (pre) {
    const cl = getClient(pre);
    if (cl && cl.workspace_id === user.workspace_id) form.client_id = String(cl.id);
  }
  const body = `<header class="page-head"><div><a href="/invoices" class="back">← Invoices</a><h1>New invoice</h1></div></header>
  ${invoiceFormView({ action: "/invoices", form, clients: workspaceClients(user.workspace_id), csrf: c.get("csrf"), isNew: true, cancelHref: "/invoices" })}`;
  return c.html(page({ title: "New invoice", user, csrf: c.get("csrf"), section: "invoices", body }));
});

invoiceRoutes.post("/invoices", async (c) => {
  const user = c.get("user");
  const raw = await c.req.parseBody({ all: true });
  const form = readInvoiceForm(raw);
  const result = validateInvoice(form, user.workspace_id);
  if (!result.ok) {
    const body = `<header class="page-head"><div><a href="/invoices" class="back">← Invoices</a><h1>New invoice</h1></div></header>
    ${invoiceFormView({ action: "/invoices", form, clients: workspaceClients(user.workspace_id), errors: result.errors, csrf: c.get("csrf"), isNew: true, cancelHref: "/invoices" })}`;
    return c.html(page({ title: "New invoice", user, csrf: c.get("csrf"), section: "invoices", body }), 422);
  }
  const ws = getWorkspace(user.workspace_id)!;
  const id = createInvoice(ws, result.value, raw.intent === "sent" ? "sent" : "draft");
  return c.redirect(`/invoices/${id}?done=created`);
});

invoiceRoutes.get("/invoices/:id", (c) => {
  const user = c.get("user");
  const id = toInt(c.req.param("id"));
  const invoice = id ? getInvoice(id) : null;
  if (!invoice) return c.html(errorPage(404, "Invoice not found", "This invoice does not exist or was deleted.", user, c.get("csrf")), 404);
  if (invoice.workspace_id !== user.workspace_id) {
    return c.html(errorPage(403, "No access", "This invoice belongs to another workspace.", user, c.get("csrf")), 403);
  }
  const client = getClient(invoice.client_id)!;
  const ws = getWorkspace(user.workspace_id)!;
  const items = lineItems(invoice.id);
  const total = invoiceTotal(invoice.id);
  const status = displayStatus(invoice);

  const lines = items
    .map(
      (li) => `<tr>
      <td>${esc(li.description)}</td>
      <td class="num">${esc(String(li.quantity))}</td>
      <td class="num hide-sm">${esc(money(li.unit_price))}</td>
      <td class="num">${esc(money(Math.round(li.quantity * li.unit_price)))}</td>
    </tr>`,
    )
    .join("");

  const actions = [
    invoice.status === "draft"
      ? `<button type="button" class="btn" data-api="/api/invoices/${invoice.id}/send" data-method="POST">Mark as sent</button>`
      : "",
    invoice.status !== "paid"
      ? `<button type="button" class="btn btn-primary" data-api="/api/invoices/${invoice.id}/pay" data-method="POST" id="mark-paid">Mark paid</button>`
      : "",
    `<a class="btn" href="/invoices/${invoice.id}/edit">Edit</a>`,
    `<button type="button" class="btn btn-danger-ghost" data-api="/api/invoices/${invoice.id}" data-method="DELETE" data-confirm="Delete invoice ${esc(invoice.number)}? This cannot be undone." data-redirect="/invoices?done=deleted" id="delete-invoice">Delete</button>`,
  ].join("");

  const flash = FLASH[c.req.query("done") ?? ""];
  const body = `
  <header class="page-head">
    <div>
      <a href="/invoices" class="back">← Invoices</a>
      <h1 class="with-badge">${esc(invoice.number)} ${statusBadge(status)}</h1>
      <p class="muted">${esc(client.name)} · ${esc(money(total))} · due ${esc(fmtDate(invoice.due_date))}</p>
    </div>
    <div class="actions">${actions}</div>
  </header>
  <p class="api-error alert" role="alert" hidden></p>

  <article class="card invoice-paper">
    <div class="paper-head">
      <div>
        <div class="paper-from strong">${esc(ws.legal_name || ws.name)}</div>
        <div class="muted small pre">${esc(ws.address)}</div>
        ${ws.vat_id ? `<div class="muted small">VAT ${esc(ws.vat_id)}</div>` : ""}
      </div>
      <div class="paper-title">
        <div class="eyebrow">Invoice</div>
        <div class="paper-number">${esc(invoice.number)}</div>
      </div>
    </div>
    <div class="paper-meta">
      <div><div class="eyebrow">Billed to</div><div class="strong">${esc(client.name)}</div>
        ${client.contact_name ? `<div class="small">${esc(client.contact_name)}</div>` : ""}
        <div class="muted small pre">${esc(client.address)}</div>
        ${client.vat_id ? `<div class="muted small">VAT ${esc(client.vat_id)}</div>` : ""}
      </div>
      <dl class="meta-list">
        <div><dt>Issued</dt><dd>${esc(fmtDate(invoice.issue_date))}</dd></div>
        <div><dt>Due</dt><dd>${esc(fmtDate(invoice.due_date))}</dd></div>
        ${invoice.paid_at ? `<div><dt>Paid</dt><dd>${esc(fmtDate(invoice.paid_at))}</dd></div>` : ""}
        ${invoice.reference ? `<div><dt>Reference</dt><dd>${esc(invoice.reference)}</dd></div>` : ""}
      </dl>
    </div>
    <table class="table paper-lines">
      <thead><tr><th>Description</th><th class="num">Qty</th><th class="num hide-sm">Unit price</th><th class="num">Amount</th></tr></thead>
      <tbody>${lines}</tbody>
      <tfoot><tr><td colspan="2" class="hide-sm"></td><td class="strong total-label">Total</td><td class="num strong total-value">${esc(money(total))}</td></tr></tfoot>
    </table>
    ${ws.iban ? `<div class="paper-foot muted small">Pay to ${esc(ws.iban)} · reference ${esc(invoice.number)}</div>` : ""}
  </article>`;

  return c.html(page({ title: invoice.number, user, csrf: c.get("csrf"), section: "invoices", body, flash }));
});

invoiceRoutes.get("/invoices/:id/edit", (c) => {
  const user = c.get("user");
  const id = toInt(c.req.param("id"));
  const invoice = id ? getInvoice(id) : null;
  if (!invoice) return c.html(errorPage(404, "Invoice not found", "This invoice does not exist or was deleted.", user, c.get("csrf")), 404);
  if (invoice.workspace_id !== user.workspace_id) {
    return c.html(errorPage(403, "No access", "This invoice belongs to another workspace.", user, c.get("csrf")), 403);
  }
  const form: InvoiceForm = {
    client_id: String(invoice.client_id),
    issue_date: invoice.issue_date,
    due_date: invoice.due_date,
    reference: invoice.reference,
    items: lineItems(invoice.id).map((li) => ({
      description: li.description,
      quantity: String(li.quantity),
      unit_price: (li.unit_price / 100).toFixed(2),
    })),
  };
  const body = `<header class="page-head"><div><a href="/invoices/${invoice.id}" class="back">← ${esc(invoice.number)}</a><h1>Edit ${esc(invoice.number)}</h1></div></header>
  ${invoiceFormView({ action: `/invoices/${invoice.id}`, form, clients: workspaceClients(user.workspace_id), csrf: c.get("csrf"), isNew: false, cancelHref: `/invoices/${invoice.id}` })}`;
  return c.html(page({ title: `Edit ${invoice.number}`, user, csrf: c.get("csrf"), section: "invoices", body }));
});

invoiceRoutes.post("/invoices/:id", async (c) => {
  const user = c.get("user");
  const id = toInt(c.req.param("id"));
  const invoice = id ? getInvoice(id) : null;
  if (!invoice) return c.html(errorPage(404, "Invoice not found", "This invoice does not exist or was deleted.", user, c.get("csrf")), 404);
  if (invoice.workspace_id !== user.workspace_id) {
    return c.html(errorPage(403, "No access", "This invoice belongs to another workspace.", user, c.get("csrf")), 403);
  }
  const form = readInvoiceForm(await c.req.parseBody({ all: true }));
  const result = validateInvoice(form, user.workspace_id);
  if (!result.ok) {
    const body = `<header class="page-head"><div><a href="/invoices/${invoice.id}" class="back">← ${esc(invoice.number)}</a><h1>Edit ${esc(invoice.number)}</h1></div></header>
    ${invoiceFormView({ action: `/invoices/${invoice.id}`, form, clients: workspaceClients(user.workspace_id), errors: result.errors, csrf: c.get("csrf"), isNew: false, cancelHref: `/invoices/${invoice.id}` })}`;
    return c.html(page({ title: `Edit ${invoice.number}`, user, csrf: c.get("csrf"), section: "invoices", body }), 422);
  }
  updateInvoice(invoice.id, result.value);
  return c.redirect(`/invoices/${invoice.id}?done=saved`);
});

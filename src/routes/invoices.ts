import { Hono, type Context } from "hono";
import type { Env } from "../auth";
import { databaseGeneration, getClient, getInvoice, getWorkspace, invoiceTotal, lineItems, workspaceClients, workspaceVersion, type Invoice } from "../db";
import { toCsv } from "../lib/csv";
import {
  blankForm,
  createInvoice,
  enableShare,
  exportInvoices,
  listInvoices,
  MAX_NOTES,
  MAX_SEARCH,
  PAGE_SIZE,
  parseSearch,
  parseStatusFilter,
  readInvoiceForm,
  revokeShare,
  STATUS_FILTERS,
  updateInvoice,
  validateInvoice,
  type InvoiceForm,
  type StatusFilter,
} from "../lib/invoices";
import { displayStatus, esc, fmtDate, money, parseMoney, parseQuantity, statusBadge, today, toInt } from "../lib/util";
import { invoicePaper } from "../views/invoice";
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
  shared: "Share link created.",
  unshared: "Share link revoked. The old link no longer works.",
};

function listQuery(status: StatusFilter, q: string, pageNo = 1): string {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  if (status !== "all") p.set("status", status);
  if (pageNo > 1) p.set("page", String(pageNo));
  return p.toString();
}

function listHref(status: StatusFilter, q: string, pageNo: number): string {
  const s = listQuery(status, q, pageNo);
  return s ? `/invoices?${s}` : "/invoices";
}

function exportHref(status: StatusFilter, q: string): string {
  const s = listQuery(status, q);
  return s ? `/invoices/export.csv?${s}` : "/invoices/export.csv";
}

invoiceRoutes.get("/invoices", (c) => {
  const user = c.get("user");
  const status = parseStatusFilter(c.req.query("status"));
  const q = parseSearch(c.req.query("q"));
  const pageNo = toInt(c.req.query("page")) ?? 1;
  const res = listInvoices(user.workspace_id, status, pageNo, q);
  const now = today();

  const tabs = STATUS_FILTERS.map(
    (s) =>
      `<a href="${esc(listHref(s, q, 1))}" class="tab${s === status ? " active" : ""}"${s === status ? ' aria-current="true"' : ""}>${FILTER_LABEL[s]} <span class="tab-count">${res.counts[s]}</span></a>`,
  ).join("");

  const what = `${status === "all" ? "" : FILTER_LABEL[status].toLowerCase() + " "}invoices`;
  const empty = q
    ? `No ${what} match “${esc(q)}”. <a href="${esc(listHref(status, "", 1))}">Clear search</a>`
    : `No ${what}.`;
  const rows = res.rows.length
    ? res.rows
        .map(
          (r) => `<tr class="row-link" data-href="/invoices/${r.id}">
      <td class="hide-sm"><a href="/invoices/${r.id}" class="strong">${esc(r.number)}</a></td>
      <td><a href="/invoices/${r.id}" class="strong show-sm">${esc(r.client_name)}</a><span class="hide-sm">${esc(r.client_name)}</span><span class="muted small show-sm">${esc(r.number)} · ${r.line_count} ${r.line_count === 1 ? "item" : "items"}</span></td>
      <td>${statusBadge(displayStatus(r, now))}</td>
      <td class="hide-sm">${esc(fmtDate(r.due_date))}</td>
      <td class="num hide-sm line-count">${r.line_count}</td>
      <td class="num">${esc(money(r.total))}</td>
    </tr>`,
        )
        .join("")
    : `<tr><td colspan="6" class="empty-cell">${empty}</td></tr>`;

  const from = res.total === 0 ? 0 : (res.page - 1) * PAGE_SIZE + 1;
  const to = Math.min(res.page * PAGE_SIZE, res.total);
  const pager = `<nav class="pager" aria-label="Pages">
    <span class="muted small">${from}–${to} of ${res.total}</span>
    <span class="pager-buttons">
      ${res.page > 1 ? `<a class="btn btn-small" href="${esc(listHref(status, q, res.page - 1))}" rel="prev">Previous</a>` : `<span class="btn btn-small disabled" aria-disabled="true">Previous</span>`}
      <span class="small muted">Page ${res.page} of ${res.pages}</span>
      ${res.page < res.pages ? `<a class="btn btn-small" href="${esc(listHref(status, q, res.page + 1))}" rel="next">Next</a>` : `<span class="btn btn-small disabled" aria-disabled="true">Next</span>`}
    </span>
  </nav>`;

  const search = `<form method="get" action="/invoices" class="list-search" role="search">
    ${status !== "all" ? `<input type="hidden" name="status" value="${esc(status)}">` : ""}
    <input type="search" name="q" value="${esc(q)}" placeholder="Search client or invoice number" aria-label="Search invoices" maxlength="${MAX_SEARCH}">
    <button type="submit" class="btn">Search</button>
    ${q ? `<a class="btn btn-ghost" href="${esc(listHref(status, "", 1))}">Clear</a>` : ""}
    <a class="btn btn-ghost export-link" href="${esc(exportHref(status, q))}" download>Export CSV</a>
  </form>`;

  const flash = FLASH[c.req.query("done") ?? ""];
  const body = `
  <header class="page-head">
    <div><h1>Invoices</h1><p class="muted">${q ? `${res.counts.all} matching “${esc(q)}”` : `${res.counts.all} invoices`} in ${esc(user.workspace_name)}</p></div>
    <a href="/invoices/new" class="btn btn-primary">New invoice</a>
  </header>
  ${search}
  <div class="tabs" role="navigation" aria-label="Filter by status">${tabs}</div>
  <section class="card card-flush">
    <table class="table" id="invoice-table">
      <thead><tr><th class="hide-sm">Number</th><th>Client</th><th>Status</th><th class="hide-sm">Due date</th><th class="num hide-sm">Items</th><th class="num">Total</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>
  ${pager}`;

  return c.html(page({ title: "Invoices", user, csrf: c.get("csrf"), section: "invoices", body, flash }));
});

/**
 * Built CSV files, keyed by workspace, filter, search and day, and tagged with
 * the workspace's change counter. Any write to the workspace's invoices, line
 * items or clients bumps the counter (database triggers), so a stale file is
 * never served; repeated downloads of unchanged data skip the query and the
 * CSV building. Bounded so many different searches cannot grow it without limit.
 */
const EXPORT_CACHE_MAX = 200;
const exportCache = new Map<string, { generation: number; version: number; body: Uint8Array }>();

function exportCsv(workspaceId: number, status: StatusFilter, q: string, now: string): Uint8Array {
  const key = JSON.stringify([workspaceId, status, q, now]);
  const generation = databaseGeneration();
  const version = workspaceVersion(workspaceId);
  const hit = exportCache.get(key);
  if (hit && hit.generation === generation && hit.version === version) {
    exportCache.delete(key); // move to the newest end (LRU order)
    exportCache.set(key, hit);
    return hit.body;
  }
  const rows = exportInvoices(workspaceId, status, q);
  const csv = toCsv([
    ["Number", "Client", "Status", "Issue date", "Due date", "Paid date", "Reference", "Line items", "Total (EUR)", "Notes"],
    ...rows.map((r) => [
      r.number,
      r.client_name,
      displayStatus(r, now),
      r.issue_date,
      r.due_date,
      r.paid_at ?? "",
      r.reference,
      r.line_count,
      (r.total / 100).toFixed(2),
      r.notes,
    ]),
  ]);
  const body = new TextEncoder().encode(csv);
  exportCache.delete(key);
  exportCache.set(key, { generation, version, body });
  while (exportCache.size > EXPORT_CACHE_MAX) exportCache.delete(exportCache.keys().next().value!);
  return body;
}

invoiceRoutes.get("/invoices/export.csv", (c) => {
  const user = c.get("user");
  const status = parseStatusFilter(c.req.query("status"));
  const q = parseSearch(c.req.query("q"));
  const now = today();
  const body = exportCsv(user.workspace_id, status, q, now);
  const name = `invoices-${status === "all" ? "" : status + "-"}${now}.csv`;
  return c.body(body, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${name}"`,
  });
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
        <label class="field span-2"><span>Notes <em class="muted">optional, shown on the invoice and its share link</em></span><textarea name="notes" rows="3" maxlength="${MAX_NOTES}" placeholder="Payment instructions, thanks, delivery details…">${esc(form.notes ?? "")}</textarea></label>
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
  const csrf = c.get("csrf");

  const shareUrl = invoice.share_token ? `${new URL(c.req.url).origin}/share/${invoice.share_token}` : "";
  const share = invoice.share_token
    ? `<section class="card share-card" id="share">
      <div class="card-head"><h2>Share link</h2><span class="badge badge-sent">Active</span></div>
      <p class="muted small">Anyone with this link can view this invoice without signing in. Revoke it to turn the link off.</p>
      <div class="share-row">
        <input type="text" readonly value="${esc(shareUrl)}" aria-label="Share link" id="share-url" class="share-url">
        <button type="button" class="btn" data-copy="#share-url">Copy</button>
        <form method="post" action="/invoices/${invoice.id}/share/revoke">
          <input type="hidden" name="_csrf" value="${esc(csrf)}">
          <button type="submit" class="btn btn-danger-ghost">Revoke link</button>
        </form>
      </div>
    </section>`
    : `<section class="card share-card" id="share">
      <div class="card-head"><h2>Share link</h2></div>
      <p class="muted small">Create a link your client can open without an account. They see a read-only copy of this invoice, including its notes.</p>
      <form method="post" action="/invoices/${invoice.id}/share">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <button type="submit" class="btn">Create share link</button>
      </form>
    </section>`;

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

  ${invoicePaper({ invoice, client, workspace: ws, items, total })}
  ${share}`;

  return c.html(page({ title: invoice.number, user, csrf, section: "invoices", body, flash }));
});

/** The signed-in user's invoice, or an error response (404 missing, 403 other workspace). */
function ownInvoice(c: Context<Env>): { invoice: Invoice } | { error: Response } {
  const user = c.get("user");
  const id = toInt(c.req.param("id"));
  const invoice = id ? getInvoice(id) : null;
  if (!invoice) return { error: c.html(errorPage(404, "Invoice not found", "This invoice does not exist or was deleted.", user, c.get("csrf")), 404) };
  if (invoice.workspace_id !== user.workspace_id) {
    return { error: c.html(errorPage(403, "No access", "This invoice belongs to another workspace.", user, c.get("csrf")), 403) };
  }
  return { invoice };
}

invoiceRoutes.post("/invoices/:id/share", (c) => {
  const r = ownInvoice(c);
  if ("error" in r) return r.error;
  enableShare(r.invoice.id);
  return c.redirect(`/invoices/${r.invoice.id}?done=shared#share`);
});

invoiceRoutes.post("/invoices/:id/share/revoke", (c) => {
  const r = ownInvoice(c);
  if ("error" in r) return r.error;
  revokeShare(r.invoice.id);
  return c.redirect(`/invoices/${r.invoice.id}?done=unshared#share`);
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
    notes: invoice.notes,
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

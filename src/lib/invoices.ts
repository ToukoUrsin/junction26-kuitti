import {
  formatInvoiceNumber,
  getClient,
  getDb,
  LINE_AMOUNT_SQL,
  nextInvoiceSeq,
  replaceLineItems,
  type Invoice,
  type LineInput,
} from "../db";
import { addDays, isDate, parseMoney, parseQuantity, str, today, toInt } from "./util";

export const PAGE_SIZE = 25;
export const MAX_LINES = 50;
export const STATUS_FILTERS = ["all", "draft", "sent", "overdue", "paid"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export function parseStatusFilter(s: string | undefined): StatusFilter {
  return (STATUS_FILTERS as readonly string[]).includes(s ?? "") ? (s as StatusFilter) : "all";
}

export const MAX_SEARCH = 100;
export const MAX_NOTES = 2000;

/** Normalise the search box value: trimmed, single spaces, bounded length. */
export function parseSearch(s: string | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_SEARCH);
}

export interface ListRow {
  id: number;
  number: string;
  status: "draft" | "sent" | "paid";
  issue_date: string;
  due_date: string;
  client_id: number;
  client_name: string;
  total: number;
  line_count: number;
}

export interface ListResult {
  rows: ListRow[];
  total: number;
  page: number;
  pages: number;
  counts: Record<StatusFilter, number>;
}

type Param = string | number;

/** Matches client name or invoice number, case-insensitively (ASCII), as a substring. */
function searchClause(q: string): { sql: string; params: Param[] } {
  if (!q) return { sql: "", params: [] };
  const pattern = likePattern(q);
  return { sql: " AND (c.name LIKE ? ESCAPE '\\' OR i.number LIKE ? ESCAPE '\\')", params: [pattern, pattern] };
}

/** WHERE clause for a workspace's invoices narrowed by status and search. Expects aliases i (invoices), c (clients). */
function filterClause(workspaceId: number, status: StatusFilter, q: string, now: string): { sql: string; params: Param[] } {
  let sql = "i.workspace_id = ?";
  const params: Param[] = [workspaceId];
  if (status === "overdue") {
    sql += " AND i.status = 'sent' AND i.due_date < ?";
    params.push(now);
  } else if (status !== "all") {
    sql += " AND i.status = ?";
    params.push(status);
  }
  const s = searchClause(q);
  return { sql: sql + s.sql, params: [...params, ...s.params] };
}

/** LIKE pattern matching `q` as a literal substring. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

const LIST_COLUMNS = `i.id, i.number, i.status, i.issue_date, i.due_date, i.client_id, c.name AS client_name,
              (SELECT COALESCE(SUM(${LINE_AMOUNT_SQL}), 0) FROM line_items li WHERE li.invoice_id = i.id) AS total,
              (SELECT COUNT(*) FROM line_items li WHERE li.invoice_id = i.id) AS line_count`;

function inStatus(r: { status: string; due_date: string }, status: StatusFilter, now: string): boolean {
  if (status === "all") return true;
  if (status === "overdue") return r.status === "sent" && r.due_date < now;
  return r.status === status;
}

/** One page of a workspace's invoices, newest first, narrowed by status and search. */
export function listInvoices(workspaceId: number, status: StatusFilter, pageNo: number, q = ""): ListResult {
  return q ? searchInvoices(workspaceId, status, pageNo, q) : browseInvoices(workspaceId, status, pageNo);
}

function pageOf(total: number, pageNo: number): { page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return { page: Math.min(Math.max(1, pageNo), pages), pages };
}

/** Unsearched list: counts from the status indexes, then one indexed page. */
function browseInvoices(workspaceId: number, status: StatusFilter, pageNo: number): ListResult {
  const db = getDb();
  const now = today();
  const { sql: where, params } = filterClause(workspaceId, status, "", now);
  const c = db
    .query<{ all_n: number; draft: number; sent: number; overdue: number; paid: number }, [string, number]>(
      `SELECT COUNT(*) AS all_n,
              COUNT(CASE WHEN status = 'draft' THEN 1 END) AS draft,
              COUNT(CASE WHEN status = 'sent' THEN 1 END) AS sent,
              COUNT(CASE WHEN status = 'sent' AND due_date < ?1 THEN 1 END) AS overdue,
              COUNT(CASE WHEN status = 'paid' THEN 1 END) AS paid
       FROM invoices WHERE workspace_id = ?2`,
    )
    .get(now, workspaceId)!;
  const counts: Record<StatusFilter, number> = { all: c.all_n, draft: c.draft, sent: c.sent, overdue: c.overdue, paid: c.paid };
  const total = counts[status];
  const { page, pages } = pageOf(total, pageNo);
  const rows = db
    .query<ListRow, Param[]>(
      `SELECT ${LIST_COLUMNS}
       FROM invoices i
       JOIN clients c ON c.id = i.client_id
       WHERE ${where}
       ORDER BY i.issue_date DESC, i.id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE);
  return { rows, total, page, pages, counts };
}

/**
 * Searched list. The workspace's few clients are matched by name first; then a
 * single pass over a covering index finds every matching invoice (by client or
 * number) in display order, from which the tab counts and the requested page
 * are taken. Only that page's rows are then loaded in full.
 */
function searchInvoices(workspaceId: number, status: StatusFilter, pageNo: number, q: string): ListResult {
  const db = getDb();
  const now = today();
  const pattern = likePattern(q);
  const clientIds = db
    .query<{ id: number }, [number, string]>(`SELECT id FROM clients WHERE workspace_id = ? AND name LIKE ? ESCAPE '\\'`)
    .all(workspaceId, pattern)
    .map((r) => r.id);
  const matches = db
    .query<{ id: number; status: string; due_date: string }, [number, string, string]>(
      `SELECT id, status, due_date FROM invoices INDEXED BY invoices_workspace_search
       WHERE workspace_id = ?
         AND (number LIKE ? ESCAPE '\\' OR client_id IN (SELECT value FROM json_each(?)))
       ORDER BY issue_date DESC, id DESC`,
    )
    .all(workspaceId, pattern, JSON.stringify(clientIds));

  const counts: Record<StatusFilter, number> = { all: matches.length, draft: 0, sent: 0, overdue: 0, paid: 0 };
  for (const m of matches) {
    if (m.status === "draft") counts.draft++;
    else if (m.status === "paid") counts.paid++;
    else if (m.status === "sent") {
      counts.sent++;
      if (m.due_date < now) counts.overdue++;
    }
  }
  const total = counts[status];
  const { page, pages } = pageOf(total, pageNo);
  const inTab = status === "all" ? matches : matches.filter((m) => inStatus(m, status, now));
  const ids = inTab.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((m) => m.id);
  const rows = ids.length
    ? db
        .query<ListRow, [string]>(
          `SELECT ${LIST_COLUMNS}
           FROM invoices i
           JOIN clients c ON c.id = i.client_id
           WHERE i.id IN (SELECT value FROM json_each(?))
           ORDER BY i.issue_date DESC, i.id DESC`,
        )
        .all(JSON.stringify(ids))
    : [];
  return { rows, total, page, pages, counts };
}

export interface ExportRow extends ListRow {
  paid_at: string | null;
  reference: string;
  notes: string;
}

/** Every invoice matching the status filter and search (all pages), newest first. */
export function exportInvoices(workspaceId: number, status: StatusFilter, q = ""): ExportRow[] {
  const { sql: where, params } = filterClause(workspaceId, status, q, today());
  return getDb()
    .query<ExportRow, Param[]>(
      `SELECT i.id, i.number, i.status, i.issue_date, i.due_date, i.paid_at, i.reference, i.notes,
              i.client_id, c.name AS client_name,
              COALESCE(t.total, 0) AS total, COALESCE(t.line_count, 0) AS line_count
       FROM invoices i
       JOIN clients c ON c.id = i.client_id
       LEFT JOIN (
         SELECT li.invoice_id, SUM(${LINE_AMOUNT_SQL}) AS total, COUNT(*) AS line_count
         FROM line_items li
         WHERE li.invoice_id IN (SELECT id FROM invoices WHERE workspace_id = ?)
         GROUP BY li.invoice_id
       ) t ON t.invoice_id = i.id
       WHERE ${where}
       ORDER BY i.issue_date DESC, i.id DESC`,
    )
    .all(workspaceId, ...params);
}

export interface InvoiceInput {
  client_id: number;
  issue_date: string;
  due_date: string;
  reference: string;
  /** null when the request did not include notes: keep what is stored. */
  notes: string | null;
  items: LineInput[];
}

export interface InvoiceForm {
  client_id: string;
  issue_date: string;
  due_date: string;
  reference: string;
  notes: string | null;
  items: { description: string; quantity: string; unit_price: string }[];
}

/** Free text from a textarea or JSON: normalised line endings, bounded length. */
export function readNotes(v: unknown): string {
  return typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim().slice(0, MAX_NOTES) : "";
}

function asList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null) return [];
  return [v];
}

/** Normalise a form body (repeated fields) or a JSON body into one shape. */
export function readInvoiceForm(body: Record<string, unknown>): InvoiceForm {
  let items: InvoiceForm["items"];
  if (Array.isArray(body.items)) {
    items = (body.items as Record<string, unknown>[]).slice(0, MAX_LINES + 1).map((it) => ({
      description: str(it?.description, 300),
      quantity: String(it?.quantity ?? "").slice(0, 20),
      unit_price: String(it?.unit_price ?? "").slice(0, 20),
    }));
  } else {
    const d = asList(body["description"] ?? body["description[]"]);
    const q = asList(body["quantity"] ?? body["quantity[]"]);
    const p = asList(body["unit_price"] ?? body["unit_price[]"]);
    const n = Math.min(Math.max(d.length, q.length, p.length), MAX_LINES + 1);
    items = [];
    for (let i = 0; i < n; i++) {
      items.push({ description: str(d[i], 300), quantity: str(q[i], 20), unit_price: str(p[i], 20) });
    }
  }
  return {
    client_id: String(body.client_id ?? ""),
    issue_date: str(body.issue_date, 10),
    due_date: str(body.due_date, 10),
    reference: str(body.reference, 120),
    notes: "notes" in body ? readNotes(body.notes) : null,
    items,
  };
}

/** Validate against the user's workspace. Returns parsed input or a list of errors. */
export function validateInvoice(
  form: InvoiceForm,
  workspaceId: number,
): { ok: true; value: InvoiceInput } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const clientId = toInt(form.client_id);
  const client = clientId ? getClient(clientId) : null;
  if (!client || client.workspace_id !== workspaceId) errors.push("Choose a client.");
  if (!isDate(form.issue_date)) errors.push("Issue date is not a valid date.");
  if (!isDate(form.due_date)) errors.push("Due date is not a valid date.");
  if (isDate(form.issue_date) && isDate(form.due_date) && form.due_date < form.issue_date) {
    errors.push("Due date cannot be before the issue date.");
  }
  const filled = form.items.filter((it) => it.description || it.quantity || it.unit_price);
  if (filled.length === 0) errors.push("Add at least one line item.");
  if (filled.length > MAX_LINES) errors.push(`An invoice can have at most ${MAX_LINES} line items.`);
  const items: LineInput[] = [];
  filled.slice(0, MAX_LINES).forEach((it, i) => {
    const quantity = parseQuantity(it.quantity);
    const unit = parseMoney(it.unit_price);
    if (!it.description) errors.push(`Line ${i + 1}: add a description.`);
    if (quantity === null) errors.push(`Line ${i + 1}: quantity must be a positive number.`);
    if (unit === null || unit < 0 || unit > 100_000_000) errors.push(`Line ${i + 1}: unit price is not a valid amount.`);
    if (it.description && quantity !== null && unit !== null) items.push({ description: it.description, quantity, unit_price: unit });
  });
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      client_id: clientId!,
      issue_date: form.issue_date,
      due_date: form.due_date,
      reference: form.reference,
      notes: form.notes,
      items,
    },
  };
}

export function blankForm(paymentTerms: number): InvoiceForm {
  const issue = today();
  return {
    client_id: "",
    issue_date: issue,
    due_date: addDays(issue, paymentTerms),
    reference: "",
    notes: "",
    items: [{ description: "", quantity: "1", unit_price: "" }],
  };
}

export function createInvoice(
  workspace: { id: number; invoice_prefix: string },
  input: InvoiceInput,
  status: "draft" | "sent",
): number {
  const db = getDb();
  return db.transaction(() => {
    const seq = nextInvoiceSeq(workspace.id);
    const row = db
      .query<{ id: number }, [number, number, string, number, string, string, string, string, string]>(
        `INSERT INTO invoices (workspace_id, client_id, number, seq, status, issue_date, due_date, reference, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        workspace.id,
        input.client_id,
        formatInvoiceNumber(workspace.invoice_prefix, seq),
        seq,
        status,
        input.issue_date,
        input.due_date,
        input.reference,
        input.notes ?? "",
      )!;
    replaceLineItems(row.id, input.items);
    return row.id;
  })();
}

export function updateInvoice(invoiceId: number, input: InvoiceInput): void {
  const db = getDb();
  db.transaction(() => {
    db.query("UPDATE invoices SET client_id = ?, issue_date = ?, due_date = ?, reference = ? WHERE id = ?").run(
      input.client_id,
      input.issue_date,
      input.due_date,
      input.reference,
      invoiceId,
    );
    if (input.notes !== null) setNotes(invoiceId, input.notes);
    replaceLineItems(invoiceId, input.items);
  })();
}

export function setNotes(invoiceId: number, notes: string): void {
  getDb().query("UPDATE invoices SET notes = ? WHERE id = ?").run(notes, invoiceId);
}

// ---- Public share links ----

const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Turn sharing on and return the token. Keeps an existing token so links already sent keep working. */
export function enableShare(invoiceId: number): string {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const db = getDb();
  db.query("UPDATE invoices SET share_token = ? WHERE id = ? AND share_token IS NULL").run(token, invoiceId);
  return db.query<{ share_token: string }, [number]>("SELECT share_token FROM invoices WHERE id = ?").get(invoiceId)!.share_token;
}

export function revokeShare(invoiceId: number): void {
  getDb().query("UPDATE invoices SET share_token = NULL WHERE id = ?").run(invoiceId);
}

export function invoiceByShareToken(token: string): Invoice | null {
  if (!SHARE_TOKEN_RE.test(token)) return null;
  return getDb().query<Invoice, [string]>("SELECT * FROM invoices WHERE share_token = ?").get(token);
}

export function setStatus(invoiceId: number, status: "draft" | "sent" | "paid"): void {
  getDb()
    .query("UPDATE invoices SET status = ?, paid_at = CASE WHEN ? = 'paid' THEN ? ELSE NULL END WHERE id = ?")
    .run(status, status, today(), invoiceId);
}

export function deleteInvoice(invoiceId: number): void {
  getDb().query("DELETE FROM invoices WHERE id = ?").run(invoiceId);
}

import { formatInvoiceNumber, getClient, getDb, LINE_AMOUNT_SQL, nextInvoiceSeq, replaceLineItems, type LineInput } from "../db";
import { addDays, isDate, parseMoney, parseQuantity, str, today, toInt } from "./util";

export const PAGE_SIZE = 25;
export const MAX_LINES = 50;
export const STATUS_FILTERS = ["all", "draft", "sent", "overdue", "paid"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export function parseStatusFilter(s: string | undefined): StatusFilter {
  return (STATUS_FILTERS as readonly string[]).includes(s ?? "") ? (s as StatusFilter) : "all";
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
}

export interface ListResult {
  rows: ListRow[];
  total: number;
  page: number;
  pages: number;
  counts: Record<StatusFilter, number>;
}

/** One page of a workspace's invoices, newest first. */
export function listInvoices(workspaceId: number, status: StatusFilter, pageNo: number): ListResult {
  const db = getDb();
  const now = today();
  let where = "i.workspace_id = ?";
  const params: (string | number)[] = [workspaceId];
  if (status === "overdue") {
    where += " AND i.status = 'sent' AND i.due_date < ?";
    params.push(now);
  } else if (status !== "all") {
    where += " AND i.status = ?";
    params.push(status);
  }

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
  const counts: Record<StatusFilter, number> = {
    all: c.all_n,
    draft: c.draft,
    sent: c.sent,
    overdue: c.overdue,
    paid: c.paid,
  };
  const total = counts[status];
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, pageNo), pages);

  const rows = db
    .query<ListRow, (string | number)[]>(
      `SELECT i.id, i.number, i.status, i.issue_date, i.due_date, i.client_id, c.name AS client_name,
              (SELECT COALESCE(SUM(${LINE_AMOUNT_SQL}), 0) FROM line_items li WHERE li.invoice_id = i.id) AS total
       FROM invoices i
       JOIN clients c ON c.id = i.client_id
       WHERE ${where}
       ORDER BY i.issue_date DESC, i.id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE);

  return { rows, total, page, pages, counts };
}

export interface InvoiceInput {
  client_id: number;
  issue_date: string;
  due_date: string;
  reference: string;
  items: LineInput[];
}

export interface InvoiceForm {
  client_id: string;
  issue_date: string;
  due_date: string;
  reference: string;
  items: { description: string; quantity: string; unit_price: string }[];
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
    value: { client_id: clientId!, issue_date: form.issue_date, due_date: form.due_date, reference: form.reference, items },
  };
}

export function blankForm(paymentTerms: number): InvoiceForm {
  const issue = today();
  return {
    client_id: "",
    issue_date: issue,
    due_date: addDays(issue, paymentTerms),
    reference: "",
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
      .query<{ id: number }, [number, number, string, number, string, string, string, string]>(
        `INSERT INTO invoices (workspace_id, client_id, number, seq, status, issue_date, due_date, reference)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
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
    replaceLineItems(invoiceId, input.items);
  })();
}

export function setStatus(invoiceId: number, status: "draft" | "sent" | "paid"): void {
  getDb()
    .query("UPDATE invoices SET status = ?, paid_at = CASE WHEN ? = 'paid' THEN ? ELSE NULL END WHERE id = ?")
    .run(status, status, today(), invoiceId);
}

export function deleteInvoice(invoiceId: number): void {
  getDb().query("DELETE FROM invoices WHERE id = ?").run(invoiceId);
}

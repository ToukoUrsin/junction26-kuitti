import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Workspace {
  id: number;
  name: string;
  legal_name: string;
  address: string;
  vat_id: string;
  email: string;
  iban: string;
  invoice_prefix: string;
  payment_terms: number;
  created_at: string;
}

export interface User {
  id: number;
  workspace_id: number;
  name: string;
  email: string;
  password_hash: string;
  created_at: string;
}

export interface Client {
  id: number;
  workspace_id: number;
  name: string;
  contact_name: string;
  email: string;
  address: string;
  vat_id: string;
  created_at: string;
}

export type InvoiceStatus = "draft" | "sent" | "paid";

export interface Invoice {
  id: number;
  workspace_id: number;
  client_id: number;
  number: string;
  seq: number;
  status: InvoiceStatus;
  issue_date: string;
  due_date: string;
  paid_at: string | null;
  reference: string;
  notes: string;
  share_token: string | null;
  created_at: string;
}

export interface LineItem {
  id: number;
  invoice_id: number;
  position: number;
  description: string;
  quantity: number;
  unit_price: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  legal_name TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  vat_id TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  iban TEXT NOT NULL DEFAULT '',
  invoice_prefix TEXT NOT NULL DEFAULT 'INV',
  payment_terms INTEGER NOT NULL DEFAULT 14,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  contact_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  vat_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  number TEXT NOT NULL,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'sent', 'paid')),
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  paid_at TEXT,
  reference TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  share_token TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workspace_id, seq)
);

CREATE TABLE IF NOT EXISTS line_items (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS users_workspace ON users (workspace_id);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS clients_workspace_name ON clients (workspace_id, name);
CREATE INDEX IF NOT EXISTS invoices_workspace_issue ON invoices (workspace_id, issue_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS invoices_workspace_status_issue ON invoices (workspace_id, status, issue_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS invoices_workspace_status_due ON invoices (workspace_id, status, due_date);
CREATE INDEX IF NOT EXISTS invoices_client ON invoices (client_id);
CREATE INDEX IF NOT EXISTS line_items_invoice ON line_items (invoice_id, position);
`;

/** Columns added after the first release. Databases created earlier get them through ALTER TABLE. */
const ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [
  { table: "invoices", column: "notes", ddl: "notes TEXT NOT NULL DEFAULT ''" },
  { table: "invoices", column: "share_token", ddl: "share_token TEXT" },
];

// Indexes on added columns; created once the columns exist.
const LATE_INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS invoices_share_token ON invoices (share_token) WHERE share_token IS NOT NULL;
`;

function applySchema(d: Database): void {
  d.exec(SCHEMA);
  for (const { table, column, ddl } of ADDED_COLUMNS) {
    const cols = d.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
  d.exec(LATE_INDEXES);
}

let db: Database | null = null;

export function openDb(path = process.env.DATABASE_PATH ?? "data/kuitti.db"): Database {
  if (db) db.close();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
  }
  applySchema(db);
  return db;
}

export function getDb(): Database {
  return db ?? openDb();
}

export function resetSchema(): void {
  const d = getDb();
  d.exec("PRAGMA foreign_keys = OFF");
  for (const t of ["line_items", "invoices", "clients", "sessions", "users", "workspaces"]) {
    d.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  d.exec("PRAGMA foreign_keys = ON");
  applySchema(d);
}

/** Amount of one line in cents. Quantities may be fractional (hours). */
export const LINE_AMOUNT_SQL = "CAST(ROUND(li.quantity * li.unit_price) AS INTEGER)";

export function getWorkspace(id: number): Workspace | null {
  return getDb().query<Workspace, [number]>("SELECT * FROM workspaces WHERE id = ?").get(id);
}

export function getUser(id: number): User | null {
  return getDb().query<User, [number]>("SELECT * FROM users WHERE id = ?").get(id);
}

export function getUserByEmail(email: string): User | null {
  return getDb().query<User, [string]>("SELECT * FROM users WHERE email = ?").get(email.trim());
}

export function getClient(id: number): Client | null {
  return getDb().query<Client, [number]>("SELECT * FROM clients WHERE id = ?").get(id);
}

export function getInvoice(id: number): Invoice | null {
  return getDb().query<Invoice, [number]>("SELECT * FROM invoices WHERE id = ?").get(id);
}

export function lineItems(invoiceId: number): LineItem[] {
  return getDb()
    .query<LineItem, [number]>("SELECT * FROM line_items WHERE invoice_id = ? ORDER BY position, id")
    .all(invoiceId);
}

export function invoiceTotal(invoiceId: number): number {
  const row = getDb()
    .query<{ total: number }, [number]>(
      `SELECT COALESCE(SUM(${LINE_AMOUNT_SQL}), 0) AS total FROM line_items li WHERE li.invoice_id = ?`,
    )
    .get(invoiceId);
  return row?.total ?? 0;
}

export function workspaceMembers(workspaceId: number): Pick<User, "id" | "name" | "email">[] {
  return getDb()
    .query<Pick<User, "id" | "name" | "email">, [number]>(
      "SELECT id, name, email FROM users WHERE workspace_id = ? ORDER BY name",
    )
    .all(workspaceId);
}

export function workspaceClients(workspaceId: number): Pick<Client, "id" | "name">[] {
  return getDb()
    .query<Pick<Client, "id" | "name">, [number]>(
      "SELECT id, name FROM clients WHERE workspace_id = ? ORDER BY name COLLATE NOCASE",
    )
    .all(workspaceId);
}

export interface LineInput {
  description: string;
  quantity: number;
  unit_price: number;
}

export function replaceLineItems(invoiceId: number, items: LineInput[]): void {
  const d = getDb();
  d.query("DELETE FROM line_items WHERE invoice_id = ?").run(invoiceId);
  const ins = d.query(
    "INSERT INTO line_items (invoice_id, position, description, quantity, unit_price) VALUES (?, ?, ?, ?, ?)",
  );
  items.forEach((it, i) => ins.run(invoiceId, i + 1, it.description, it.quantity, it.unit_price));
}

export function nextInvoiceSeq(workspaceId: number): number {
  const row = getDb()
    .query<{ seq: number }, [number]>("SELECT COALESCE(MAX(seq), 1000) + 1 AS seq FROM invoices WHERE workspace_id = ?")
    .get(workspaceId);
  return row?.seq ?? 1001;
}

export function formatInvoiceNumber(prefix: string, seq: number): string {
  return `${prefix}-${seq}`;
}

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, getInvoice, openDb } from "../src/db";
import { csvField } from "../src/lib/csv";
import { ALICE, BOB, Client, as, idsFor, setup } from "./helpers";

let alice: Client;
let bob: Client;
let nordlys: ReturnType<typeof idsFor>;
let harbour: ReturnType<typeof idsFor>;

beforeEach(async () => {
  await setup();
  alice = await as(ALICE);
  bob = await as(BOB);
  nordlys = idsFor("Nordlys Studio");
  harbour = idsFor("Harbour & Co");
});

const rowCount = (html: string) => (html.match(/class="row-link"/g) ?? []).length;

/** The client with the most invoices in Nordlys Studio, and how many invoices it has (overall and paid). */
function busiestClient() {
  return getDb()
    .query<{ name: string; n: number; paid: number }, [number]>(
      `SELECT c.name, COUNT(*) AS n, COUNT(CASE WHEN i.status = 'paid' THEN 1 END) AS paid
       FROM invoices i JOIN clients c ON c.id = i.client_id
       WHERE i.workspace_id = ? GROUP BY c.id ORDER BY n DESC LIMIT 1`,
    )
    .get(nordlys.workspace)!;
}

function shareToken(invoiceId: number): string | null {
  return getInvoice(invoiceId)!.share_token;
}

/** Parse our CSV output (quoted fields, CRLF) into rows. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") row.push(field), (field = "");
    else if (ch === "\r" && s[i + 1] === "\n") {
      row.push(field), rows.push(row), (row = []), (field = ""), i++;
    } else field += ch;
  }
  return rows;
}

describe("invoice search", () => {
  test("finds invoices by client name, case-insensitively", async () => {
    const c = busiestClient();
    const html = await (await alice.get(`/invoices?q=${encodeURIComponent(c.name.toLowerCase())}`)).text();
    expect(rowCount(html)).toBe(Math.min(c.n, 25));
    expect(html).toContain(`${c.n} matching`);
  });

  test("finds an invoice by its number", async () => {
    const inv = getInvoice(nordlys.invoice)!;
    const html = await (await alice.get(`/invoices?q=${inv.number}`)).text();
    expect(rowCount(html)).toBe(1);
    expect(html).toContain(`/invoices/${inv.id}"`);
  });

  test("combines with the status filter, and tab counts follow the search", async () => {
    const c = busiestClient();
    const q = encodeURIComponent(c.name);
    const html = await (await alice.get(`/invoices?status=paid&q=${q}`)).text();
    expect(rowCount(html)).toBe(Math.min(c.paid, 25));
    expect(html).not.toContain("badge-draft");
    // The "All" tab keeps the search, and its count is the search total.
    const allTab = /<a href="([^"]+)" class="tab"[^>]*>All <span class="tab-count">(\d+)</.exec(html)!;
    expect(new URLSearchParams(allTab[1]!.split("?")[1]!.replace(/&amp;/g, "&")).get("q")).toBe(c.name);
    expect(Number(allTab[2])).toBe(c.n);
    // The search form keeps the status.
    expect(html).toContain('<input type="hidden" name="status" value="paid">');
  });

  test("search and filter survive paging", async () => {
    // "NS-10" matches all 42 Nordlys invoices: two pages.
    const html = await (await alice.get("/invoices?q=NS-10")).text();
    expect(html).toContain("Page 1 of 2");
    expect(html).toContain('href="/invoices?q=NS-10&amp;page=2" rel="next"');
    const page2 = await (await alice.get("/invoices?q=NS-10&page=2")).text();
    expect(rowCount(page2)).toBe(17);
    expect(page2).toContain('href="/invoices?q=NS-10" rel="prev"');

    // Status and search together: every pager link carries both.
    const nPaid = getDb()
      .query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM invoices WHERE workspace_id = ? AND status = 'paid'")
      .get(nordlys.workspace)!.n;
    expect(nPaid).toBeGreaterThan(25);
    const paid = await (await alice.get("/invoices?status=paid&q=NS-10")).text();
    expect(paid).toContain('href="/invoices?q=NS-10&amp;status=paid&amp;page=2" rel="next"');
    const paid2 = await (await alice.get("/invoices?q=NS-10&status=paid&page=2")).text();
    expect(rowCount(paid2)).toBe(nPaid - 25);
    expect(paid2).not.toContain("badge-draft");
    expect(paid2).toContain('href="/invoices?q=NS-10&amp;status=paid" rel="prev"');
  });

  test("LIKE wildcards are matched literally", async () => {
    for (const q of ["%", "_", "NS_10"]) {
      const html = await (await alice.get(`/invoices?q=${encodeURIComponent(q)}`)).text();
      expect(rowCount(html)).toBe(0);
    }
  });

  test("the search term is escaped and never shows other workspaces", async () => {
    const html = await (await alice.get(`/invoices?q=${encodeURIComponent('"><script>x</script>')}`)).text();
    expect(html).not.toContain("<script>x</script>");
    const hc = await (await alice.get("/invoices?q=HC-")).text();
    expect(rowCount(hc)).toBe(0);
  });

  test("the JSON API accepts q too", async () => {
    const inv = getInvoice(nordlys.invoice)!;
    const res = (await (await alice.api(`/api/invoices?q=${inv.number}`)).json()) as { total: number; invoices: { line_items: number }[] };
    expect(res.total).toBe(1);
    expect(res.invoices[0]!.line_items).toBeGreaterThan(0);
  });
});

describe("line item count", () => {
  test("each list row shows how many line items the invoice has", async () => {
    const html = await (await alice.get("/invoices")).text();
    const rows = [...html.matchAll(/data-href="\/invoices\/(\d+)">[\s\S]*?<td class="num hide-sm line-count">(\d+)<\/td>/g)];
    expect(rows).toHaveLength(25);
    for (const [, id, n] of rows) {
      const actual = getDb().query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM line_items WHERE invoice_id = ?").get(Number(id))!.n;
      expect(Number(n)).toBe(actual);
    }
  });
});

describe("notes", () => {
  const fields = (extra: Record<string, string | string[]> = {}) => ({
    client_id: String(nordlys.client),
    issue_date: "2026-11-10",
    due_date: "2026-11-24",
    reference: "",
    description: "Design work",
    quantity: "1",
    unit_price: "100",
    ...extra,
  });

  test("can be set on create and edited, and show on the invoice page", async () => {
    const res = await alice.form("/invoices", fields({ notes: "Thanks for the work!\r\nPay within 14 days." }));
    const id = Number(/\/invoices\/(\d+)/.exec(res.headers.get("location")!)![1]);
    expect(getInvoice(id)!.notes).toBe("Thanks for the work!\nPay within 14 days.");
    expect(await (await alice.get(`/invoices/${id}`)).text()).toContain("Pay within 14 days.");

    expect(await (await alice.get(`/invoices/${id}/edit`)).text()).toContain("Pay within 14 days.</textarea>");
    await alice.form(`/invoices/${id}`, fields({ notes: "Updated <b>note</b>" }));
    const html = await (await alice.get(`/invoices/${id}`)).text();
    expect(html).toContain("Updated &lt;b&gt;note&lt;/b&gt;");
    expect(html).not.toContain("Pay within 14 days.");

    await alice.form(`/invoices/${id}`, fields({ notes: "" }));
    expect(getInvoice(id)!.notes).toBe("");
  });

  test("an API update without notes keeps them; with notes replaces them", async () => {
    getDb().query("UPDATE invoices SET notes = 'keep me' WHERE id = ?").run(nordlys.invoice);
    const body = {
      client_id: nordlys.client,
      issue_date: "2026-11-01",
      due_date: "2026-11-15",
      items: [{ description: "Work", quantity: 1, unit_price: "100" }],
    };
    expect((await alice.api(`/api/invoices/${nordlys.invoice}`, "PUT", body)).status).toBe(200);
    expect(getInvoice(nordlys.invoice)!.notes).toBe("keep me");
    await alice.api(`/api/invoices/${nordlys.invoice}`, "PUT", { ...body, notes: "new" });
    const got = (await (await alice.api(`/api/invoices/${nordlys.invoice}`)).json()) as { notes: string };
    expect(got.notes).toBe("new");
  });
});

describe("share links", () => {
  test("create, view without signing in, revoke", async () => {
    getDb().query("UPDATE invoices SET notes = 'See you next quarter' WHERE id = ?").run(nordlys.invoice);
    expect(shareToken(nordlys.invoice)).toBeNull();
    expect(await (await alice.get(`/invoices/${nordlys.invoice}`)).text()).toContain("Create share link");

    const res = await alice.form(`/invoices/${nordlys.invoice}/share`, {});
    expect(res.status).toBe(302);
    const token = shareToken(nordlys.invoice)!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ownerPage = await (await alice.get(`/invoices/${nordlys.invoice}`)).text();
    expect(ownerPage).toContain(`/share/${token}`);

    const anon = new Client();
    const pub = await anon.get(`/share/${token}`);
    expect(pub.status).toBe(200);
    expect(pub.headers.get("x-robots-tag")).toContain("noindex");
    const html = await pub.text();
    const inv = getInvoice(nordlys.invoice)!;
    const client = getDb().query<{ name: string }, [number]>("SELECT name FROM clients WHERE id = ?").get(inv.client_id)!;
    const line = getDb().query<{ description: string }, [number]>("SELECT description FROM line_items WHERE invoice_id = ?").get(inv.id)!;
    expect(html).toContain(inv.number);
    expect(html).toContain(client.name.replace(/&/g, "&amp;"));
    expect(html).toContain(line.description);
    expect(html).toContain("total-value");
    expect(html).toContain("See you next quarter");
    // Read-only: no session data, no actions.
    expect(html).not.toContain("csrf");
    expect(html).not.toContain("data-api");
    expect(html).not.toContain("/edit");
    expect(html).not.toContain("Sign out");

    expect((await alice.form(`/invoices/${nordlys.invoice}/share/revoke`, {})).status).toBe(302);
    expect(shareToken(nordlys.invoice)).toBeNull();
    const gone = await anon.get(`/share/${token}`);
    expect(gone.status).toBe(404);
    expect(await gone.text()).toContain("not found");
  });

  test("creating twice keeps the same link; revoking and re-creating makes a new one", async () => {
    await alice.form(`/invoices/${nordlys.invoice}/share`, {});
    const first = shareToken(nordlys.invoice)!;
    await alice.form(`/invoices/${nordlys.invoice}/share`, {});
    expect(shareToken(nordlys.invoice)).toBe(first);
    await alice.form(`/invoices/${nordlys.invoice}/share/revoke`, {});
    await alice.form(`/invoices/${nordlys.invoice}/share`, {});
    expect(shareToken(nordlys.invoice)).not.toBe(first);
    expect((await new Client().get(`/share/${first}`)).status).toBe(404);
  });

  test("needs the CSRF token and a session", async () => {
    expect((await alice.form(`/invoices/${nordlys.invoice}/share`, { _csrf: "nope" })).status).toBe(403);
    expect((await new Client().form(`/invoices/${nordlys.invoice}/share`, {})).status).toBe(401);
    expect(shareToken(nordlys.invoice)).toBeNull();
  });

  test("another workspace cannot share or revoke my invoice", async () => {
    expect((await bob.form(`/invoices/${nordlys.invoice}/share`, {})).status).toBe(403);
    expect(shareToken(nordlys.invoice)).toBeNull();
    await alice.form(`/invoices/${nordlys.invoice}/share`, {});
    const token = shareToken(nordlys.invoice);
    expect((await bob.form(`/invoices/${nordlys.invoice}/share/revoke`, {})).status).toBe(403);
    expect(shareToken(nordlys.invoice)).toBe(token);
  });

  test("unknown, malformed and deleted links are not found", async () => {
    const anon = new Client();
    expect((await anon.get(`/share/${"A".repeat(43)}`)).status).toBe(404);
    expect((await anon.get("/share/' OR 1=1 --")).status).toBe(404);
    expect((await anon.get("/share/")).status).toBe(404);
    await alice.form(`/invoices/${nordlys.invoice}/share`, {});
    const token = shareToken(nordlys.invoice)!;
    await alice.api(`/api/invoices/${nordlys.invoice}`, "DELETE");
    expect((await anon.get(`/share/${token}`)).status).toBe(404);
  });
});

describe("CSV export", () => {
  test("exports every invoice matching the current search and filter, across pages", async () => {
    const res = await alice.get("/invoices/export.csv?q=NS-10");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="invoices-\d{4}-\d{2}-\d{2}\.csv"$/);
    const rows = parseCsv(await res.text());
    expect(rows[0]).toEqual(["Number", "Client", "Status", "Issue date", "Due date", "Paid date", "Reference", "Line items", "Total (EUR)", "Notes"]);
    expect(rows).toHaveLength(1 + 42);
    expect(rows.slice(1).every((r) => r[0]!.startsWith("NS-"))).toBe(true);

    const c = busiestClient();
    const paid = parseCsv(await (await alice.get(`/invoices/export.csv?status=paid&q=${encodeURIComponent(c.name)}`)).text());
    expect(paid).toHaveLength(1 + c.paid);
    expect(paid.slice(1).every((r) => r[1] === c.name && r[2] === "paid")).toBe(true);
  });

  test("totals and line counts match the data", async () => {
    const inv = getInvoice(nordlys.invoice)!;
    const rows = parseCsv(await (await alice.get(`/invoices/export.csv?q=${inv.number}`)).text());
    expect(rows).toHaveLength(2);
    const lines = getDb()
      .query<{ n: number; total: number }, [number]>(
        "SELECT COUNT(*) AS n, SUM(CAST(ROUND(quantity * unit_price) AS INTEGER)) AS total FROM line_items WHERE invoice_id = ?",
      )
      .get(inv.id)!;
    expect(rows[1]![7]).toBe(String(lines.n));
    expect(rows[1]![8]).toBe((lines.total / 100).toFixed(2));
  });

  test("the list page links to the export with the current search and filter", async () => {
    const html = await (await alice.get("/invoices?status=overdue&q=fazer")).text();
    expect(html).toContain('href="/invoices/export.csv?q=fazer&amp;status=overdue"');
  });

  test("user text cannot become a spreadsheet formula", async () => {
    getDb().query("UPDATE clients SET name = '=HYPERLINK(\"http://evil.test\",\"x\")' WHERE id = ?").run(nordlys.client);
    getDb().query("UPDATE invoices SET notes = '+1, \"quoted\"\nnext line' WHERE workspace_id = ?").run(nordlys.workspace);
    const text = await (await alice.get("/invoices/export.csv")).text();
    const rows = parseCsv(text);
    const evil = rows.find((r) => r[1]!.includes("HYPERLINK"))!;
    expect(evil[1]).toBe(`'=HYPERLINK("http://evil.test","x")`);
    expect(rows[1]![9]).toBe(`'+1, "quoted"\nnext line`);
    expect(csvField("-2")).toBe("'-2");
    expect(csvField("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvField(12)).toBe("12");
  });

  test("only exports the own workspace and needs a session", async () => {
    const rows = parseCsv(await (await bob.get("/invoices/export.csv")).text());
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.slice(1).every((r) => r[0]!.startsWith("HC-"))).toBe(true);
    const anon = await new Client().get("/invoices/export.csv");
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toStartWith("/login");
  });
});

describe("schema upgrade", () => {
  test("a database from before notes and share links gets the new columns", () => {
    const dir = mkdtempSync(join(tmpdir(), "kuitti-"));
    const path = join(dir, "old.db");
    try {
      const old = new Database(path, { create: true });
      old.exec(`CREATE TABLE invoices (
        id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, client_id INTEGER NOT NULL, number TEXT NOT NULL,
        seq INTEGER NOT NULL, status TEXT NOT NULL, issue_date TEXT NOT NULL, due_date TEXT NOT NULL, paid_at TEXT,
        reference TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
      old.exec("INSERT INTO invoices (workspace_id, client_id, number, seq, status, issue_date, due_date) VALUES (1, 1, 'X-1', 1, 'draft', '2026-01-01', '2026-01-15')");
      old.close();

      const db = openDb(path);
      const cols = db.query<{ name: string }, []>("PRAGMA table_info(invoices)").all().map((c) => c.name);
      expect(cols).toContain("notes");
      expect(cols).toContain("share_token");
      expect(db.query<{ notes: string; share_token: null }, []>("SELECT notes, share_token FROM invoices").get()).toEqual({ notes: "", share_token: null });
      openDb(path); // running again is a no-op
    } finally {
      openDb(":memory:");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

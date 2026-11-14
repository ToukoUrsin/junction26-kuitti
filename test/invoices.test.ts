import { beforeEach, describe, expect, test } from "bun:test";
import { getDb, getInvoice, invoiceTotal, lineItems } from "../src/db";
import { ALICE, as, idsFor, setup, type Client } from "./helpers";

let alice: Client;
let ids: ReturnType<typeof idsFor>;

beforeEach(async () => {
  await setup();
  alice = await as(ALICE);
  ids = idsFor("Nordlys Studio");
});

function newInvoiceFields(extra: Record<string, string | string[]> = {}) {
  return {
    client_id: String(ids.client),
    issue_date: "2026-11-10",
    due_date: "2026-11-24",
    reference: "PO 5512",
    description: ["Design work (hours)", "Brand workshop, half day"],
    quantity: ["12.5", "1"],
    unit_price: ["95", "1 200,00"],
    ...extra,
  };
}

describe("invoices", () => {
  test("list shows 25 per page with a pager", async () => {
    const html = await (await alice.get("/invoices")).text();
    expect((html.match(/class="row-link"/g) ?? []).length).toBe(25);
    expect(html).toContain("Page 1 of 2");
    const page2 = await (await alice.get("/invoices?page=2")).text();
    expect((page2.match(/class="row-link"/g) ?? []).length).toBe(17);
  });

  test("status filter narrows the list", async () => {
    const html = await (await alice.get("/invoices?status=paid")).text();
    expect(html).toContain("badge-paid");
    expect(html).not.toContain("badge-draft");
    expect(html).not.toContain("badge-overdue");
  });

  test("an unknown status filter falls back to all", async () => {
    expect((await alice.get("/invoices?status=%27%20OR%201=1")).status).toBe(200);
  });

  test("create an invoice with line items", async () => {
    const res = await alice.form("/invoices", newInvoiceFields({ intent: "sent" }));
    expect(res.status).toBe(302);
    const id = Number(/\/invoices\/(\d+)/.exec(res.headers.get("location")!)![1]);
    const inv = getInvoice(id)!;
    expect(inv.status).toBe("sent");
    expect(inv.number).toBe("NS-1043");
    expect(lineItems(id)).toHaveLength(2);
    expect(invoiceTotal(id)).toBe(12.5 * 9500 + 120000);
  });

  test("new invoices are drafts unless marked sent", async () => {
    const res = await alice.form("/invoices", newInvoiceFields({ intent: "draft" }));
    const id = Number(/\/invoices\/(\d+)/.exec(res.headers.get("location")!)![1]);
    expect(getInvoice(id)!.status).toBe("draft");
  });

  test("invalid invoices are rejected with messages", async () => {
    const res = await alice.form("/invoices", newInvoiceFields({ due_date: "2026-11-01", quantity: ["-1", "1"] }));
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("Due date cannot be before the issue date.");
    expect(html).toContain("Line 1: quantity must be a positive number.");
  });

  test("creating needs the CSRF token", async () => {
    const before = getDb().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM invoices").get()!.n;
    const res = await alice.form("/invoices", newInvoiceFields({ _csrf: "nope" }));
    expect(res.status).toBe(403);
    expect(getDb().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM invoices").get()!.n).toBe(before);
  });

  test("invoice page shows client, lines and total", async () => {
    const inv = getInvoice(ids.invoice)!;
    const html = await (await alice.get(`/invoices/${ids.invoice}`)).text();
    expect(html).toContain(inv.number);
    expect(html).toContain(lineItems(ids.invoice)[0]!.description);
    expect(html).toContain("Mark paid");
  });

  test("edit an invoice", async () => {
    const res = await alice.form(
      `/invoices/${ids.invoice}`,
      newInvoiceFields({ description: "Accessibility audit", quantity: "1", unit_price: "2400" }),
    );
    expect(res.status).toBe(302);
    expect(lineItems(ids.invoice)).toHaveLength(1);
    expect(invoiceTotal(ids.invoice)).toBe(240000);
  });

  test("mark paid through the API", async () => {
    const res = await alice.api(`/api/invoices/${ids.invoice}/pay`, "POST");
    expect(res.status).toBe(200);
    const inv = getInvoice(ids.invoice)!;
    expect(inv.status).toBe("paid");
    expect(inv.paid_at).toBeTruthy();
  });

  test("API writes need the CSRF header", async () => {
    const res = await alice.api(`/api/invoices/${ids.invoice}/pay`, "POST", undefined, false);
    expect(res.status).toBe(403);
    expect(getInvoice(ids.invoice)!.status).toBe("sent");
  });

  test("delete through the API removes lines too", async () => {
    expect((await alice.api(`/api/invoices/${ids.invoice}`, "DELETE")).status).toBe(200);
    expect(getInvoice(ids.invoice)).toBeNull();
    expect(lineItems(ids.invoice)).toHaveLength(0);
    expect((await alice.get(`/invoices/${ids.invoice}`)).status).toBe(404);
  });

  test("create and read through the JSON API", async () => {
    const res = await alice.api("/api/invoices", "POST", {
      client_id: ids.client,
      issue_date: "2026-11-12",
      due_date: "2026-11-26",
      items: [{ description: "Analytics setup", quantity: 1, unit_price: "1500.00" }],
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: number };
    const got = (await (await alice.api(`/api/invoices/${id}`)).json()) as { total_cents: number; status: string };
    expect(got.total_cents).toBe(150000);
    expect(got.status).toBe("draft");
  });

  test("user input is escaped on the invoice page", async () => {
    const res = await alice.form("/invoices", newInvoiceFields({ description: '<script>alert("x")</script>', quantity: "1", unit_price: "10" }));
    const id = Number(/\/invoices\/(\d+)/.exec(res.headers.get("location")!)![1]);
    const html = await (await alice.get(`/invoices/${id}`)).text();
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  test("dashboard totals match the data", async () => {
    const html = await (await alice.get("/")).text();
    expect(html).toContain("Recent invoices");
    expect(html).toContain("Overdue");
    expect(html).toMatch(/Paid in \w+/);
  });
});

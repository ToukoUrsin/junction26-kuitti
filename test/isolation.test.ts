import { beforeEach, describe, expect, test } from "bun:test";
import { getInvoice } from "../src/db";
import { ALICE, BOB, as, idsFor, setup, type Client } from "./helpers";

let alice: Client;
let bob: Client;
let harbour: ReturnType<typeof idsFor>;
let nordlys: ReturnType<typeof idsFor>;

beforeEach(async () => {
  await setup();
  alice = await as(ALICE);
  bob = await as(BOB);
  harbour = idsFor("Harbour & Co");
  nordlys = idsFor("Nordlys Studio");
});

describe("workspace isolation", () => {
  test("alice cannot open bob's invoice page", async () => {
    const res = await alice.get(`/invoices/${harbour.invoice}`);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("HC-");
  });

  test("alice cannot open bob's invoice edit page", async () => {
    expect((await alice.get(`/invoices/${harbour.invoice}/edit`)).status).toBe(403);
  });

  test("alice cannot read bob's invoice through the API", async () => {
    const res = await alice.api(`/api/invoices/${harbour.invoice}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  test("alice cannot mark bob's invoice paid", async () => {
    const res = await alice.api(`/api/invoices/${harbour.invoice}/pay`, "POST");
    expect(res.status).toBe(403);
    expect(getInvoice(harbour.invoice)!.status).toBe("sent");
  });

  test("alice cannot delete bob's invoice", async () => {
    expect((await alice.api(`/api/invoices/${harbour.invoice}`, "DELETE")).status).toBe(403);
    expect(getInvoice(harbour.invoice)).not.toBeNull();
  });

  test("alice cannot overwrite bob's invoice with the edit form", async () => {
    const res = await alice.form(`/invoices/${harbour.invoice}`, {
      client_id: String(nordlys.client),
      issue_date: "2026-11-01",
      due_date: "2026-11-15",
      description: "Hijack",
      quantity: "1",
      unit_price: "1",
    });
    expect(res.status).toBe(403);
    expect(getInvoice(harbour.invoice)!.client_id).not.toBe(nordlys.client);
  });

  test("alice cannot bill one of bob's clients", async () => {
    const res = await alice.api("/api/invoices", "POST", {
      client_id: harbour.client,
      issue_date: "2026-11-01",
      due_date: "2026-11-15",
      items: [{ description: "Work", quantity: 1, unit_price: "100" }],
    });
    expect(res.status).toBe(422);
  });

  test("alice cannot read bob's client through the API", async () => {
    expect((await alice.api(`/api/clients/${harbour.client}`)).status).toBe(403);
  });

  test("lists only show the own workspace", async () => {
    const html = await (await alice.get("/invoices")).text();
    expect(html).toContain("NS-");
    expect(html).not.toContain("HC-");
    const api = (await (await bob.api("/api/invoices")).json()) as { invoices: { number: string }[] };
    expect(api.invoices.length).toBeGreaterThan(0);
    expect(api.invoices.every((i) => i.number.startsWith("HC-"))).toBe(true);
  });

  test("clients list only shows the own workspace", async () => {
    const a = (await (await alice.api("/api/clients")).json()) as { clients: { id: number }[] };
    const b = (await (await bob.api("/api/clients")).json()) as { clients: { id: number }[] };
    const overlap = a.clients.filter((x) => b.clients.some((y) => y.id === x.id));
    expect(overlap).toHaveLength(0);
  });

  test("missing invoices are 404, not 403", async () => {
    expect((await alice.get("/invoices/999999")).status).toBe(404);
    expect((await alice.api("/api/invoices/999999")).status).toBe(404);
  });

  test("settings change only the own workspace", async () => {
    const res = await alice.form("/settings", {
      name: "Nordlys Studio",
      legal_name: "Nordlys Studio Oy",
      address: "Bulevardi 5\n00120 Helsinki",
      vat_id: "FI12345678",
      email: "billing@nordlys.test",
      iban: "FI21 1234 5600 0007 85",
      invoice_prefix: "NS",
      payment_terms: "21",
    });
    expect(res.status).toBe(302);
    const bobSettings = await (await bob.get("/settings")).text();
    expect(bobSettings).toContain("Harbour &amp; Co");
    expect(bobSettings).not.toContain("Bulevardi 5");
  });
});

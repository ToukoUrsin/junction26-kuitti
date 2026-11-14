import { beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../src/db";
import { money, parseMoney } from "../src/lib/util";
import { seed } from "../scripts/seed";
import { ALICE, BOB, as, setup, type Client } from "./helpers";

let alice: Client;

beforeEach(async () => {
  await setup();
  alice = await as(ALICE);
});

describe("clients", () => {
  test("clients list shows the workspace's clients with totals", async () => {
    const html = await (await alice.get("/clients")).text();
    expect(html).toContain("12 clients");
    expect(html).toContain("Outstanding");
  });

  test("add a client", async () => {
    const res = await alice.form("/clients", {
      name: "Sauna Collective Oy",
      contact_name: "Pekka Virta",
      email: "pekka@saunacollective.test",
      address: "Kauppakatu 3\n40100 Jyväskylä",
      vat_id: "FI99887766",
    });
    expect(res.status).toBe(302);
    const html = await (await alice.get("/clients")).text();
    expect(html).toContain("Sauna Collective Oy");
    const bob = await as(BOB);
    expect(await (await bob.get("/clients")).text()).not.toContain("Sauna Collective Oy");
  });

  test("a client needs a name", async () => {
    const res = await alice.form("/clients", { name: "  ", email: "x@y.test" });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("Company name is required.");
  });

  test("a bad email is rejected", async () => {
    const res = await alice.form("/clients", { name: "Acme", email: "not-an-email" });
    expect(res.status).toBe(422);
  });

  test("client names are escaped", async () => {
    await alice.form("/clients", { name: '"><img src=x onerror=alert(1)>' });
    const html = await (await alice.get("/clients")).text();
    expect(html).not.toContain("<img src=x");
  });

  test("add a client through the API", async () => {
    const res = await alice.api("/api/clients", "POST", { name: "Lakeside Rowing Club" });
    expect(res.status).toBe(201);
    const list = (await (await alice.api("/api/clients")).json()) as { clients: { name: string }[] };
    expect(list.clients.some((c) => c.name === "Lakeside Rowing Club")).toBe(true);
  });

  test("new client is offered on the new invoice form", async () => {
    await alice.form("/clients", { name: "Zeta Ferries" });
    const html = await (await alice.get("/invoices/new")).text();
    expect(html).toContain("Zeta Ferries");
  });
});

describe("seed and helpers", () => {
  test("small seed has the two test accounts in two workspaces", () => {
    const rows = getDb()
      .query<{ email: string; ws: string }, []>(
        "SELECT u.email, w.name AS ws FROM users u JOIN workspaces w ON w.id = u.workspace_id WHERE u.email IN ('alice@nordlys.test', 'bob@harbour.test') ORDER BY u.email",
      )
      .all();
    expect(rows).toEqual([
      { email: "alice@nordlys.test", ws: "Nordlys Studio" },
      { email: "bob@harbour.test", ws: "Harbour & Co" },
    ]);
  });

  test("seed is deterministic", async () => {
    const snapshot = () =>
      getDb()
        .query<{ s: string }, []>(
          "SELECT group_concat(number || status || issue_date || client_id, ',') AS s FROM (SELECT * FROM invoices ORDER BY id)",
        )
        .get()!.s;
    const first = snapshot();
    await seed("small", "2026-11-14");
    expect(snapshot()).toBe(first);
  });

  test("money parsing and formatting", () => {
    expect(parseMoney("1 234,50")).toBe(123450);
    expect(parseMoney("€90")).toBe(9000);
    expect(parseMoney("12.345")).toBeNull();
    expect(parseMoney("abc")).toBeNull();
    expect(money(123450)).toBe("€1,234.50");
  });
});

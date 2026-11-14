import { Hono } from "hono";
import { requireApi, type Env } from "../auth";
import { getClient, getInvoice, getWorkspace, invoiceTotal, lineItems, workspaceClients } from "../db";
import {
  createInvoice,
  deleteInvoice,
  listInvoices,
  parseStatusFilter,
  readInvoiceForm,
  setStatus,
  updateInvoice,
  validateInvoice,
} from "../lib/invoices";
import { displayStatus, toInt } from "../lib/util";
import { insertClient, readClient, validateClient } from "./clients";

export const apiRoutes = new Hono<Env>();

apiRoutes.use("*", requireApi);

async function jsonBody(req: { json(): Promise<unknown> }): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

apiRoutes.get("/me", (c) => {
  const user = c.get("user");
  return c.json({ id: user.id, name: user.name, email: user.email, workspace: { id: user.workspace_id, name: user.workspace_name } });
});

apiRoutes.get("/invoices", (c) => {
  const user = c.get("user");
  const res = listInvoices(user.workspace_id, parseStatusFilter(c.req.query("status")), toInt(c.req.query("page")) ?? 1);
  return c.json({
    page: res.page,
    pages: res.pages,
    total: res.total,
    invoices: res.rows.map((r) => ({
      id: r.id,
      number: r.number,
      client: { id: r.client_id, name: r.client_name },
      status: displayStatus(r),
      issue_date: r.issue_date,
      due_date: r.due_date,
      total_cents: r.total,
    })),
  });
});

apiRoutes.post("/invoices", async (c) => {
  const user = c.get("user");
  const body = await jsonBody(c.req);
  if (!body) return c.json({ error: "invalid_json" }, 400);
  const result = validateInvoice(readInvoiceForm(body), user.workspace_id);
  if (!result.ok) return c.json({ error: "validation", messages: result.errors }, 422);
  const id = createInvoice(getWorkspace(user.workspace_id)!, result.value, body.status === "sent" ? "sent" : "draft");
  return c.json({ id }, 201);
});

apiRoutes.get("/invoices/:id", (c) => {
  const user = c.get("user");
  const id = toInt(c.req.param("id"));
  const invoice = id ? getInvoice(id) : null;
  if (!invoice) return c.json({ error: "not_found" }, 404);
  if (invoice.workspace_id !== user.workspace_id) return c.json({ error: "forbidden" }, 403);
  const client = getClient(invoice.client_id)!;
  return c.json({
    id: invoice.id,
    number: invoice.number,
    status: displayStatus(invoice),
    issue_date: invoice.issue_date,
    due_date: invoice.due_date,
    paid_at: invoice.paid_at,
    reference: invoice.reference,
    client: { id: client.id, name: client.name },
    items: lineItems(invoice.id).map((li) => ({
      description: li.description,
      quantity: li.quantity,
      unit_price_cents: li.unit_price,
    })),
    total_cents: invoiceTotal(invoice.id),
  });
});

apiRoutes.put("/invoices/:id", async (c) => {
  const user = c.get("user");
  const id = toInt(c.req.param("id"));
  const invoice = id ? getInvoice(id) : null;
  if (!invoice) return c.json({ error: "not_found" }, 404);
  if (invoice.workspace_id !== user.workspace_id) return c.json({ error: "forbidden" }, 403);
  const body = await jsonBody(c.req);
  if (!body) return c.json({ error: "invalid_json" }, 400);
  const result = validateInvoice(readInvoiceForm(body), user.workspace_id);
  if (!result.ok) return c.json({ error: "validation", messages: result.errors }, 422);
  updateInvoice(invoice.id, result.value);
  return c.json({ ok: true });
});

apiRoutes.post("/invoices/:id/pay", (c) => {
  const user = c.get("user");
  const id = toInt(c.req.param("id"));
  const invoice = id ? getInvoice(id) : null;
  if (!invoice) return c.json({ error: "not_found" }, 404);
  if (invoice.workspace_id !== user.workspace_id) return c.json({ error: "forbidden" }, 403);
  if (invoice.status !== "paid") setStatus(invoice.id, "paid");
  return c.json({ ok: true, status: "paid" });
});

apiRoutes.post("/invoices/:id/send", (c) => {
  const user = c.get("user");
  const id = toInt(c.req.param("id"));
  const invoice = id ? getInvoice(id) : null;
  if (!invoice) return c.json({ error: "not_found" }, 404);
  if (invoice.workspace_id !== user.workspace_id) return c.json({ error: "forbidden" }, 403);
  if (invoice.status === "paid") return c.json({ error: "already_paid" }, 409);
  setStatus(invoice.id, "sent");
  return c.json({ ok: true, status: "sent" });
});

apiRoutes.delete("/invoices/:id", (c) => {
  const user = c.get("user");
  const id = toInt(c.req.param("id"));
  const invoice = id ? getInvoice(id) : null;
  if (!invoice) return c.json({ error: "not_found" }, 404);
  if (invoice.workspace_id !== user.workspace_id) return c.json({ error: "forbidden" }, 403);
  deleteInvoice(invoice.id);
  return c.json({ ok: true });
});

apiRoutes.get("/clients", (c) => {
  return c.json({ clients: workspaceClients(c.get("user").workspace_id) });
});

apiRoutes.get("/clients/:id", (c) => {
  const user = c.get("user");
  const id = toInt(c.req.param("id"));
  const client = id ? getClient(id) : null;
  if (!client) return c.json({ error: "not_found" }, 404);
  if (client.workspace_id !== user.workspace_id) return c.json({ error: "forbidden" }, 403);
  const { workspace_id: _ws, ...rest } = client;
  return c.json(rest);
});

apiRoutes.post("/clients", async (c) => {
  const user = c.get("user");
  const body = await jsonBody(c.req);
  if (!body) return c.json({ error: "invalid_json" }, 400);
  const input = readClient(body);
  const errors = validateClient(input);
  if (errors.length) return c.json({ error: "validation", messages: errors }, 422);
  return c.json({ id: insertClient(user.workspace_id, input) }, 201);
});

apiRoutes.notFound((c) => c.json({ error: "not_found" }, 404));

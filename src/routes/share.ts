import { Hono } from "hono";
import { getClient, getWorkspace, invoiceTotal, lineItems } from "../db";
import { invoiceByShareToken } from "../lib/invoices";
import { esc } from "../lib/util";
import { invoicePaper } from "../views/invoice";
import { bare, errorPage, logo } from "../views/layout";

/** Public, read-only invoice pages reached through a share link. No session needed. */
export const shareRoutes = new Hono();

shareRoutes.get("/share/:token", (c) => {
  // Shared links are private to whoever holds them: keep them out of search engines.
  c.header("X-Robots-Tag", "noindex, nofollow");
  const invoice = invoiceByShareToken(c.req.param("token"));
  if (!invoice) {
    return c.html(errorPage(404, "Invoice not found", "This link does not work. It may have been revoked or mistyped."), 404);
  }
  const client = getClient(invoice.client_id)!;
  const ws = getWorkspace(invoice.workspace_id)!;
  const body = `<main class="share-wrap">
    <header class="share-head">
      <span class="logo">${logo()}</span>
      <span class="muted small">Invoice from ${esc(ws.legal_name || ws.name)}${ws.email ? ` · <a href="mailto:${esc(ws.email)}">${esc(ws.email)}</a>` : ""}</span>
    </header>
    ${invoicePaper({ invoice, client, workspace: ws, items: lineItems(invoice.id), total: invoiceTotal(invoice.id) })}
  </main>`;
  return c.html(bare(`Invoice ${invoice.number}`, body));
});

import type { Client, Invoice, LineItem, Workspace } from "../db";
import { esc, fmtDate, money } from "../lib/util";

/** The printable invoice document. Used on the invoice page and on the public share page. */
export function invoicePaper(o: { invoice: Invoice; client: Client; workspace: Workspace; items: LineItem[]; total: number }): string {
  const { invoice, client, workspace: ws, items, total } = o;
  const lines = items
    .map(
      (li) => `<tr>
      <td>${esc(li.description)}</td>
      <td class="num">${esc(String(li.quantity))}</td>
      <td class="num hide-sm">${esc(money(li.unit_price))}</td>
      <td class="num">${esc(money(Math.round(li.quantity * li.unit_price)))}</td>
    </tr>`,
    )
    .join("");

  return `<article class="card invoice-paper">
    <div class="paper-head">
      <div>
        <div class="paper-from strong">${esc(ws.legal_name || ws.name)}</div>
        <div class="muted small pre">${esc(ws.address)}</div>
        ${ws.vat_id ? `<div class="muted small">VAT ${esc(ws.vat_id)}</div>` : ""}
      </div>
      <div class="paper-title">
        <div class="eyebrow">Invoice</div>
        <div class="paper-number">${esc(invoice.number)}</div>
      </div>
    </div>
    <div class="paper-meta">
      <div><div class="eyebrow">Billed to</div><div class="strong">${esc(client.name)}</div>
        ${client.contact_name ? `<div class="small">${esc(client.contact_name)}</div>` : ""}
        <div class="muted small pre">${esc(client.address)}</div>
        ${client.vat_id ? `<div class="muted small">VAT ${esc(client.vat_id)}</div>` : ""}
      </div>
      <dl class="meta-list">
        <div><dt>Issued</dt><dd>${esc(fmtDate(invoice.issue_date))}</dd></div>
        <div><dt>Due</dt><dd>${esc(fmtDate(invoice.due_date))}</dd></div>
        ${invoice.paid_at ? `<div><dt>Paid</dt><dd>${esc(fmtDate(invoice.paid_at))}</dd></div>` : ""}
        ${invoice.reference ? `<div><dt>Reference</dt><dd>${esc(invoice.reference)}</dd></div>` : ""}
      </dl>
    </div>
    <table class="table paper-lines">
      <thead><tr><th>Description</th><th class="num">Qty</th><th class="num hide-sm">Unit price</th><th class="num">Amount</th></tr></thead>
      <tbody>${lines}</tbody>
      <tfoot><tr><td colspan="2" class="hide-sm"></td><td class="strong total-label">Total</td><td class="num strong total-value">${esc(money(total))}</td></tr></tfoot>
    </table>
    ${invoice.notes ? `<div class="paper-notes"><div class="eyebrow">Notes</div><div class="pre-wrap">${esc(invoice.notes)}</div></div>` : ""}
    ${ws.iban ? `<div class="paper-foot muted small">Pay to ${esc(ws.iban)} · reference ${esc(invoice.number)}</div>` : ""}
  </article>`;
}

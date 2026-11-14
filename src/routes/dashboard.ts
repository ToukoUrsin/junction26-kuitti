import { Hono } from "hono";
import type { Env } from "../auth";
import { getDb, LINE_AMOUNT_SQL } from "../db";
import { displayStatus, esc, fmtDate, money, statusBadge, today } from "../lib/util";
import { page } from "../views/layout";

export const dashboardRoutes = new Hono<Env>();

interface Totals {
  outstanding: number;
  outstanding_count: number;
  overdue: number;
  overdue_count: number;
  paid_month: number;
  paid_month_count: number;
  draft_count: number;
}

interface RecentRow {
  id: number;
  number: string;
  status: "draft" | "sent" | "paid";
  issue_date: string;
  due_date: string;
  client_name: string;
  total: number;
}

dashboardRoutes.get("/", (c) => {
  const user = c.get("user");
  const now = today();
  const monthStart = `${now.slice(0, 7)}-01`;
  const db = getDb();

  const totals = db
    .query<Totals, [string, string, string, string, number]>(
      `WITH t AS (
         SELECT i.status, i.due_date, i.paid_at,
                (SELECT COALESCE(SUM(${LINE_AMOUNT_SQL}), 0) FROM line_items li WHERE li.invoice_id = i.id) AS total
         FROM invoices i
         WHERE i.workspace_id = ?5
       )
       SELECT
         COALESCE(SUM(CASE WHEN status = 'sent' THEN total END), 0) AS outstanding,
         COUNT(CASE WHEN status = 'sent' THEN 1 END) AS outstanding_count,
         COALESCE(SUM(CASE WHEN status = 'sent' AND due_date < ?1 THEN total END), 0) AS overdue,
         COUNT(CASE WHEN status = 'sent' AND due_date < ?2 THEN 1 END) AS overdue_count,
         COALESCE(SUM(CASE WHEN status = 'paid' AND paid_at >= ?3 THEN total END), 0) AS paid_month,
         COUNT(CASE WHEN status = 'paid' AND paid_at >= ?4 THEN 1 END) AS paid_month_count,
         COUNT(CASE WHEN status = 'draft' THEN 1 END) AS draft_count
       FROM t`,
    )
    .get(now, now, monthStart, monthStart, user.workspace_id)!;

  const recent = db
    .query<RecentRow, [number]>(
      `SELECT i.id, i.number, i.status, i.issue_date, i.due_date, c.name AS client_name,
              (SELECT COALESCE(SUM(${LINE_AMOUNT_SQL}), 0) FROM line_items li WHERE li.invoice_id = i.id) AS total
       FROM invoices i
       JOIN clients c ON c.id = i.client_id
       WHERE i.workspace_id = ?
       ORDER BY i.issue_date DESC, i.id DESC
       LIMIT 8`,
    )
    .all(user.workspace_id);

  const overdueList = db
    .query<RecentRow, [number, string]>(
      `SELECT i.id, i.number, i.status, i.issue_date, i.due_date, c.name AS client_name,
              (SELECT COALESCE(SUM(${LINE_AMOUNT_SQL}), 0) FROM line_items li WHERE li.invoice_id = i.id) AS total
       FROM invoices i
       JOIN clients c ON c.id = i.client_id
       WHERE i.workspace_id = ? AND i.status = 'sent' AND i.due_date < ?
       ORDER BY i.due_date ASC
       LIMIT 5`,
    )
    .all(user.workspace_id, now);

  const firstName = user.name.split(" ")[0];
  const monthName = new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" }).format(new Date(`${now}T00:00:00Z`));

  const recentRows = recent.length
    ? recent
        .map(
          (r) => `<tr class="row-link" data-href="/invoices/${r.id}">
        <td class="hide-sm"><a href="/invoices/${r.id}" class="strong">${esc(r.number)}</a></td>
        <td><a href="/invoices/${r.id}" class="strong show-sm">${esc(r.client_name)}</a><span class="hide-sm">${esc(r.client_name)}</span><span class="muted small show-sm">${esc(r.number)}</span></td>
        <td>${statusBadge(displayStatus(r, now))}</td>
        <td class="hide-sm">${esc(fmtDate(r.due_date))}</td>
        <td class="num">${esc(money(r.total))}</td>
      </tr>`,
        )
        .join("")
    : `<tr><td colspan="5" class="empty-cell">No invoices yet. <a href="/invoices/new">Create your first invoice</a>.</td></tr>`;

  const overdueRows = overdueList.length
    ? overdueList
        .map((r) => {
          const days = Math.round((Date.parse(now) - Date.parse(r.due_date)) / 86400_000);
          return `<li><a href="/invoices/${r.id}">
          <span class="ol-main"><span class="strong">${esc(r.client_name)}</span><span class="muted small">${esc(r.number)} · ${days} ${days === 1 ? "day" : "days"} late</span></span>
          <span class="num">${esc(money(r.total))}</span></a></li>`;
        })
        .join("")
    : `<li class="muted small ol-empty">Nothing overdue. Nice.</li>`;

  const body = `
  <header class="page-head">
    <div>
      <h1>Good to see you, ${esc(firstName)}</h1>
      <p class="muted">Here is where ${esc(user.workspace_name)} stands today, ${esc(fmtDate(now))}.</p>
    </div>
    <a href="/invoices/new" class="btn btn-primary">New invoice</a>
  </header>

  <section class="stats">
    <a class="stat" href="/invoices?status=sent">
      <span class="stat-label">Outstanding</span>
      <span class="stat-value">${esc(money(totals.outstanding))}</span>
      <span class="stat-sub">${totals.outstanding_count} open ${totals.outstanding_count === 1 ? "invoice" : "invoices"}</span>
    </a>
    <a class="stat stat-alert" href="/invoices?status=overdue">
      <span class="stat-label">Overdue</span>
      <span class="stat-value">${esc(money(totals.overdue))}</span>
      <span class="stat-sub">${totals.overdue_count} past due date</span>
    </a>
    <a class="stat" href="/invoices?status=paid">
      <span class="stat-label">Paid in ${esc(monthName)}</span>
      <span class="stat-value">${esc(money(totals.paid_month))}</span>
      <span class="stat-sub">${totals.paid_month_count} ${totals.paid_month_count === 1 ? "payment" : "payments"} received</span>
    </a>
  </section>

  <div class="grid-2">
    <section class="card">
      <div class="card-head">
        <h2>Recent invoices</h2>
        <a href="/invoices" class="small">View all</a>
      </div>
      <table class="table">
        <thead><tr><th class="hide-sm">Number</th><th>Client</th><th>Status</th><th class="hide-sm">Due</th><th class="num">Total</th></tr></thead>
        <tbody>${recentRows}</tbody>
      </table>
    </section>
    <section class="card">
      <div class="card-head">
        <h2>Needs a nudge</h2>
        <span class="muted small">${totals.draft_count} ${totals.draft_count === 1 ? "draft" : "drafts"}</span>
      </div>
      <ul class="overdue-list">${overdueRows}</ul>
    </section>
  </div>`;

  return c.html(page({ title: "Dashboard", user, csrf: c.get("csrf"), section: "dashboard", body }));
});

import type { AuthUser } from "../auth";
import { esc, initials } from "../lib/util";

export type Section = "dashboard" | "invoices" | "clients" | "settings";

const ICONS: Record<Section, string> = {
  dashboard:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>',
  invoices:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h9l3.5 3.5v13.5H6z"/><path d="M9 11h6M9 14.5h6M9 18h3.5"/></svg>',
  clients:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8.5" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 5.2a3.5 3.5 0 0 1 0 6.6M18 14.5c1.8.9 3 2.9 3 5.5"/></svg>',
  settings:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/></svg>',
};

const NAV: [Section, string, string][] = [
  ["dashboard", "Dashboard", "/"],
  ["invoices", "Invoices", "/invoices"],
  ["clients", "Clients", "/clients"],
  ["settings", "Settings", "/settings"],
];

function head(title: string, csrf?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Kuitti</title>
${csrf ? `<meta name="csrf-token" content="${esc(csrf)}">` : ""}
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/static/fonts/inter.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/static/app.css">
<script src="/static/app.js" defer></script>
</head>`;
}

export function logo(): string {
  return `<span class="logo-mark" aria-hidden="true">K</span><span class="logo-word">Kuitti</span>`;
}

export interface PageOpts {
  title: string;
  user: AuthUser;
  csrf: string;
  section: Section;
  body: string;
  flash?: string;
}

export function page(o: PageOpts): string {
  const nav = NAV.map(
    ([key, label, href]) =>
      `<a href="${href}" class="nav-link${key === o.section ? " active" : ""}"${key === o.section ? ' aria-current="page"' : ""}>${ICONS[key]}<span>${label}</span></a>`,
  ).join("");
  return `${head(o.title, o.csrf)}
<body>
<div class="shell">
  <aside class="sidebar">
    <a href="/" class="logo">${logo()}</a>
    <div class="workspace-name" title="Workspace">${esc(o.user.workspace_name)}</div>
    <nav class="nav">${nav}</nav>
    <div class="sidebar-foot">
      <div class="me">
        <span class="avatar">${esc(initials(o.user.name))}</span>
        <span class="me-text"><span class="me-name">${esc(o.user.name)}</span><span class="me-email">${esc(o.user.email)}</span></span>
      </div>
      <form method="post" action="/logout">
        <input type="hidden" name="_csrf" value="${esc(o.csrf)}">
        <button type="submit" class="link-button">Sign out</button>
      </form>
    </div>
  </aside>
  <main class="main">
    ${o.flash ? `<div class="flash" role="status">${esc(o.flash)}</div>` : ""}
    ${o.body}
  </main>
</div>
</body>
</html>`;
}

export function bare(title: string, body: string): string {
  return `${head(title)}
<body class="bare">
${body}
</body>
</html>`;
}

export function errorPage(status: number, title: string, message: string, user?: AuthUser, csrf?: string): string {
  const body = `<div class="empty-state error-state">
    <div class="error-code">${status}</div>
    <h1>${esc(title)}</h1>
    <p>${esc(message)}</p>
    <a class="btn" href="/">Back to dashboard</a>
  </div>`;
  if (user && csrf) return page({ title, user, csrf, section: "dashboard", body });
  return bare(title, `<main class="auth-wrap">${body}</main>`);
}

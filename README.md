# Kuitti

Kuitti is a small invoicing app for small teams. Each company has its own workspace with clients, invoices and line items. You can see what is outstanding, overdue and paid, create and edit invoices, mark them paid, and keep client and company details in one place. Invoices can be searched by client or number, exported to CSV, carry free-text notes, and be shared with a client through a revocable read-only link (`/share/<token>`, no sign-in).

Built with [Bun](https://bun.sh), [Hono](https://hono.dev) and `bun:sqlite`. Pages are rendered on the server; a small JSON API under `/api/` backs a few actions on the pages (mark paid, mark sent, delete). There is no build step.

## Run it

```sh
bun install
bun run seed      # demo data (SEED=small by default)
bun run start     # http://localhost:3000
```

Sign in as `alice@nordlys.test` / `crashtest-alice` (Nordlys Studio) or `bob@harbour.test` / `crashtest-bob` (Harbour & Co).

### Environment

| Variable | Default | Used by |
| --- | --- | --- |
| `PORT` | `3000` | `start` |
| `HOST` | `0.0.0.0` | `start` |
| `DATABASE_PATH` | `data/kuitti.db` | `start`, `seed` |
| `SEED` | `small` | `seed`: `small` is 2 workspaces with about 40 invoices each; `large` is 40 workspaces and 5,000 invoices (2,000 in Nordlys Studio) |
| `SEED_DATE` | today (UTC) | `seed`: the date the demo data is laid out around |
| `COOKIE_SECURE` | unset | set to `1` behind HTTPS to mark cookies `Secure` |

Seeding wipes and recreates the database at `DATABASE_PATH`. The same `SEED` and `SEED_DATE` always produce the same data.

## Tests

```sh
bun test
```

The suite runs against an in-memory database with the small seed and covers sign-in, sessions and CSRF, workspace isolation, invoices and clients, search, notes, share links, CSV export and the schema upgrade.

## Layout

```
src/index.ts         server entry
src/app.ts           routes, security headers, error pages
src/auth.ts          sessions, CSRF, password hashing, sign-in throttling
src/db.ts            schema and row helpers
src/lib/             formatting, validation, invoice queries
src/routes/          dashboard, invoices, clients, settings, sign-in, JSON API, public share pages
src/views/layout.ts  page shell
src/views/invoice.ts invoice document (invoice page and share page)
public/              app.css, app.js, font
scripts/seed.ts      demo data
test/                bun test suite
crashtest.yml        how automated test runs install, seed and start the app
```

## JSON API

All endpoints need a signed-in session cookie. Writes need the `X-CSRF-Token` header (the token is in the page's `csrf-token` meta tag). Amounts are in cents.

| Method | Path | |
| --- | --- | --- |
| GET | `/api/me` | current user and workspace |
| GET | `/api/invoices?status=&page=` | one page (25) of invoices |
| POST | `/api/invoices` | create: `{ client_id, issue_date, due_date, reference?, status?, items: [{ description, quantity, unit_price }] }` |
| GET | `/api/invoices/:id` | invoice with line items and total |
| PUT | `/api/invoices/:id` | replace fields and line items |
| POST | `/api/invoices/:id/send` | mark sent |
| POST | `/api/invoices/:id/pay` | mark paid |
| DELETE | `/api/invoices/:id` | delete |
| GET | `/api/clients` | clients in the workspace |
| GET | `/api/clients/:id` | one client |
| POST | `/api/clients` | create: `{ name, contact_name?, email?, address?, vat_id? }` |

`GET /healthz` answers `{"ok":true}` when the server and database are up.

Inter font: SIL Open Font License, see `public/fonts/LICENSE-inter.txt`.

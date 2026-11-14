import { createApp } from "./app";
import { openDb } from "./db";

openDb();
const app = createApp();
const port = Number(process.env.PORT ?? 3000);

const server = Bun.serve({
  port,
  hostname: process.env.HOST ?? "0.0.0.0",
  fetch: app.fetch,
});

console.log(`Kuitti listening on http://localhost:${server.port}`);

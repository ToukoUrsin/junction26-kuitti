/**
 * One CSV field (RFC 4180). Text that a spreadsheet would read as a formula
 * (starting with = + - @ or a tab/CR) gets a leading apostrophe so that user
 * data such as a client name cannot run as a formula when the file is opened.
 * Numbers are written as they are.
 */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  let s = value;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows to CSV text with CRLF line ends and a UTF-8 BOM so spreadsheet apps detect the encoding. */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return "﻿" + rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

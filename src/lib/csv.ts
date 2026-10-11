import { csvCell } from "./meridian/exports/csv.ts";

export function downloadCsv<T>(filename: string, columns: { key: keyof T; label: string }[], rows: readonly T[]) {
  downloadCsvText(filename, serializeCsv(columns, rows));
}

/** Saves CSV text that was already built as a file on this device. Nothing is uploaded or sent. */
export function downloadCsvText(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Every CSV writer in the app goes through the guarded cell rule in meridian/exports/csv.ts: text that starts with = + - @,
 * a tab or a carriage return is prefixed so a spreadsheet shows it as text, null is an empty cell, and a number is written
 * as a number. Nothing is written as 0 because a value is missing.
 */
export function serializeCsv<T>(columns: { key: keyof T; label: string }[], rows: readonly T[]) {
  return [
    columns.map((column) => csvCell(column.label)).join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column.key])).join(",")),
  ].join("\r\n");
}

export function downloadCsv<T>(filename: string, columns: { key: keyof T; label: string }[], rows: readonly T[]) {
  const content = serializeCsv(columns, rows);
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function serializeCsv<T>(columns: { key: keyof T; label: string }[], rows: readonly T[]) {
  const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return [columns.map((column) => escape(column.label)).join(","), ...rows.map((row) => columns.map((column) => escape(row[column.key])).join(","))].join("\r\n");
}

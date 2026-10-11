import assert from "node:assert/strict";
import test from "node:test";
import { csvCell, libraryCsv, performanceCsv, type PerformanceExportRow } from "./csv.ts";
import { serializeCsv } from "../../csv.ts";

test("text that starts with = + - @ is prefixed, so a spreadsheet shows it as text and does not run it", () => {
  assert.equal(csvCell("=HYPERLINK(\"http://x\")"), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(csvCell("+1 800 555"), `"'+1 800 555"`);
  assert.equal(csvCell("-2+3"), `"'-2+3"`);
  assert.equal(csvCell("@SUM(A1)"), `"'@SUM(A1)"`);
});

test("a leading tab or carriage return is prefixed too, since a spreadsheet can start a formula after either", () => {
  assert.equal(csvCell("\t=1+1"), `"'\t=1+1"`);
  assert.equal(csvCell("\r=1+1"), `"'\r=1+1"`);
});

test("ordinary text is quoted and only the quotes inside it are doubled", () => {
  assert.equal(csvCell("Spring sale"), `"Spring sale"`);
  assert.equal(csvCell('say "hi"'), `"say ""hi"""`);
  assert.equal(csvCell("a=b in the middle"), `"a=b in the middle"`, "a formula character after the first character is not a formula");
});

test("null, undefined and non-finite numbers are empty cells, never 0", () => {
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell(Number.NaN), "");
  assert.equal(csvCell(Number.POSITIVE_INFINITY), "");
});

test("a finite number is written as a number, and a negative number is not treated as a formula", () => {
  assert.equal(csvCell(0), "0", "a real zero is still written");
  assert.equal(csvCell(42), "42");
  assert.equal(csvCell(-7.5), "-7.5");
});

test("a date is written as its ISO time, and an invalid date is empty", () => {
  assert.equal(csvCell(new Date("2026-10-11T00:00:00.000Z")), `"2026-10-11T00:00:00.000Z"`);
  assert.equal(csvCell(new Date("not a date")), '""', "an invalid date is an empty cell");
});

test("the performance export writes an unrecorded spend, impression or revenue value as an empty cell, not 0", () => {
  const rows: PerformanceExportRow[] = [{
    id: "obs-1", creativeId: "cr-1", experimentId: "", platform: "meta", impressions: null, reach: null, clicks: 4,
    conversions: null, spendCents: null, revenueCents: 900, observedOn: "2026-10-10", source: "manual", createdAt: "2026-10-10T12:00:00Z",
  }];
  const [header, line] = performanceCsv(rows).split("\r\n");
  const columns = header!.split(",");
  const cells = line!.split(",");
  const cell = (label: string) => cells[columns.indexOf(`"${label}"`)];
  assert.equal(cell("Impressions"), "", "impressions not recorded is empty");
  assert.equal(cell("Spend cents"), "", "spend not recorded is empty");
  assert.equal(cell("Conversions"), "", "conversions not recorded is empty");
  assert.equal(cell("Revenue cents"), "900");
  assert.equal(cell("Clicks"), "4");
});

test("the library export guards a title that starts with a formula character", () => {
  const csv = libraryCsv([{ id: "c1", title: "=cmd", hook: "Hook", angle: "A", status: "ready", origin: "studio", createdAt: "2026-10-11" }]);
  assert.match(csv, /"'=cmd"/);
});

test("the shared CSV writer uses the same cell rule, so the library, learning and opportunities exports are guarded", () => {
  const csv = serializeCsv([{ key: "name", label: "Name" }, { key: "spend", label: "Spend" }], [
    { name: "+SUM(1,1)", spend: null },
    { name: "Acme, Inc.", spend: 0 },
  ]);
  assert.equal(csv, '"Name","Spend"\r\n"\'+SUM(1,1)",\r\n"Acme, Inc.",0');
});

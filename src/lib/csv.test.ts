import assert from "node:assert/strict";
import test from "node:test";
import { serializeCsv } from "./csv.ts";

test("CSV serialization escapes commas, quotes, and line breaks", () => {
  const result = serializeCsv([{ key: "name", label: "Name" }, { key: "note", label: "Note" }], [
    { name: "Acme, Inc.", note: 'He said "go"\nnow' },
  ]);
  assert.equal(result, '"Name","Note"\r\n"Acme, Inc.","He said ""go""\nnow"');
});

import assert from "node:assert/strict";
import test from "node:test";
import { cn } from "./cn.ts";

test("cn combines conditional classes and resolves Tailwind conflicts", () => {
  assert.equal(cn("px-2 text-sm", { hidden: false }, "px-4"), "text-sm px-4");
  assert.equal(cn(["grid", { hidden: false, flex: true }]), "flex");
});

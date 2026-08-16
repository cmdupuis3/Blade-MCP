"use strict";

// nav.js: blade_symbols reshapes references[] merged with bindings[] into a
// name-keyed table. Driven directly with a fake ctx (same shape checks.js's
// runCheck needs, since bladeSymbols calls checks.runCheck internally).

const { test } = require("node:test");
const assert = require("node:assert/strict");

const nav = require("../../src/nav");
const checkError = require("../fixtures/check-error.json");
const checkClean = require("../fixtures/check-clean.json");

function makeCtx(payload) {
  return {
    config: { cwd: process.cwd() },
    getClient: () => ({ check: async () => payload }),
    diagRegistry: () => new Map(),
    surface: () => ({ compilerVersion: "0.19.2" }),
    log: () => {},
  };
}

test("bladeSymbols: merges references[] with bindings[] by (name, def position)", async () => {
  const ctx = makeCtx(checkError);
  const result = await nav.bladeSymbols({ source: "x" }, ctx);
  const s = result.structuredContent;
  // check-error.json has 4 references (f, a, r, Idx) and 3 bindings (f, a, r).
  assert.equal(s.totalSymbols, 4);
  const f = s.symbols.find((sym) => sym.name === "f");
  assert.equal(f.kind, "function");
  assert.equal(f.type, "(Array<Float64 like Idx<4>>) -> Float64");
  assert.equal(f.useCount, 1);
  assert.deepEqual(f.def, { line: 1, col: 10, endLine: 1, endCol: 11 });
});

test("bladeSymbols: a reference with no matching binding still appears (kind 'type', def:null)", async () => {
  const ctx = makeCtx(checkError);
  const result = await nav.bladeSymbols({ source: "x" }, ctx);
  const idx = result.structuredContent.symbols.find((sym) => sym.name === "Idx");
  assert.ok(idx, "Idx must appear even though it has no bindings[] entry");
  assert.equal(idx.kind, "type");
  assert.equal(idx.def, null);
  assert.equal(idx.useCount, 2);
  assert.equal(idx.type, undefined); // no binding to source a type from
});

test("bladeSymbols: name filter is exact-first, falls back to case-insensitive substring", async () => {
  const ctx = makeCtx(checkError);
  const exact = await nav.bladeSymbols({ source: "x", name: "f" }, ctx);
  assert.equal(exact.structuredContent.nameMatch, "exact");
  assert.equal(exact.structuredContent.symbolCount, 1);
  assert.equal(exact.structuredContent.symbols[0].name, "f");

  const substr = await nav.bladeSymbols({ source: "x", name: "ID" }, ctx);
  assert.equal(substr.structuredContent.nameMatch, "substring");
  assert.ok(substr.structuredContent.symbols.some((sym) => sym.name === "Idx"));

  const none = await nav.bladeSymbols({ source: "x", name: "zzz-nope" }, ctx);
  assert.equal(none.structuredContent.nameMatch, "none");
  assert.equal(none.structuredContent.symbolCount, 0);
});

test("bladeSymbols: kind filter is a plain case-insensitive string match", async () => {
  const ctx = makeCtx(checkError);
  const result = await nav.bladeSymbols({ source: "x", kind: "TYPE" }, ctx);
  assert.equal(result.structuredContent.symbols.length, 1);
  assert.equal(result.structuredContent.symbols[0].name, "Idx");
});

test("bladeSymbols: includeUses:false drops the uses array but keeps useCount", async () => {
  const ctx = makeCtx(checkError);
  const result = await nav.bladeSymbols({ source: "x", includeUses: false }, ctx);
  for (const sym of result.structuredContent.symbols) {
    assert.equal(sym.uses, undefined);
    assert.equal(typeof sym.useCount, "number");
  }
});

test("bladeSymbols: a binding with zero references still appears (useCount 0)", async () => {
  const ctx = makeCtx(checkClean);
  const result = await nav.bladeSymbols({ source: "x" }, ctx);
  const y = result.structuredContent.symbols.find((sym) => sym.name === "y");
  assert.ok(y);
  assert.equal(y.useCount, 0);
  assert.deepEqual(y.uses, []);
});

test("bladeSymbols: errors in the payload add a partial-resolution note", async () => {
  const ctx = makeCtx(checkError);
  const result = await nav.bladeSymbols({ source: "x" }, ctx);
  assert.match(result.structuredContent.note, /may be partial/);
});

test("bladeSymbols: default tier is 'fast' (cheaper than blade_check's 'full')", async () => {
  let seenTier;
  const ctx = {
    config: { cwd: process.cwd() },
    getClient: () => ({
      check: async (file, source, tier) => {
        seenTier = tier;
        return checkClean;
      },
    }),
    diagRegistry: () => new Map(),
    surface: () => ({ compilerVersion: "0.19.2" }),
    log: () => {},
  };
  await nav.bladeSymbols({ source: "x" }, ctx);
  assert.equal(seenTier, "fast");
});

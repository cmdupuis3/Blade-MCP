"use strict";

// nav.js: blade_symbols reshapes references[] merged with bindings[] into a
// name-keyed table. Driven directly with a fake ctx (same shape checks.js's
// runCheck needs, since bladeSymbols calls checks.runCheck internally).
//
// The fixtures are real compiler payloads. check-rich.json is the one that
// matters most here: it binds `a` four ways —
//
//   8:14   parameter of `dot`     (binding: param, the function's span)
//   10:16  parameter of `scale`   (binding: param, the function's span)
//   11:20  parameter of a lambda inside `scale`   (NO binding)
//   16:5   top-level `let a`      (binding: let)
//
// — which is exactly the shape that same-name pairing gets wrong.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const nav = require("../../src/nav");
const checkError = require("../fixtures/check-error.json");
const checkClean = require("../fixtures/check-clean.json");
const checkRich = require("../fixtures/check-rich.json");

function makeCtx(payload) {
  return {
    config: { cwd: process.cwd() },
    getClient: () => ({ check: async () => payload }),
    diagRegistry: () => new Map(),
    surface: () => ({ compilerVersion: "0.20.0" }),
    log: () => {},
  };
}

test("bladeSymbols: merges references[] with bindings[] — def is the NAME token, type comes from the binding", async () => {
  const ctx = makeCtx(checkError);
  const result = await nav.bladeSymbols({ source: "x" }, ctx);
  const s = result.structuredContent;
  // check-error.json has 4 references (f, w, a, Idx) and 3 bindings (f, w, a).
  assert.equal(s.totalSymbols, 4);
  const f = s.symbols.find((sym) => sym.name === "f");
  assert.equal(f.kind, "function");
  assert.equal(f.type, "(w: Array<Float64 like Idx<4>>) -> Float64");
  assert.deepEqual(f.def, { line: 1, col: 10, endLine: 1, endCol: 11 }, "the name token, not the declaration's 1:1 start");
  const w = s.symbols.find((sym) => sym.name === "w");
  assert.equal(w.kind, "param");
  assert.equal(w.type, "Array<Float64 like Idx<4>>");
  assert.equal(w.useCount, 4);
});

test("bladeSymbols: shadowed names pair by declaration span, each with its OWN type", async () => {
  const ctx = makeCtx(checkRich);
  const result = await nav.bladeSymbols({ source: "x", name: "a" }, ctx);
  const s = result.structuredContent;
  assert.equal(s.nameMatch, "exact");
  assert.equal(s.symbolCount, 4);
  const at = (line, col) => s.symbols.find((sym) => sym.def.line === line && sym.def.col === col);

  const dotA = at(8, 14);
  assert.equal(dotA.kind, "param");
  assert.equal(dotA.type, "Array<T like Idx<_>>");

  const scaleA = at(10, 16);
  assert.equal(scaleA.kind, "param");
  assert.equal(scaleA.type, "Float64");

  // The lambda parameter sits INSIDE scale's declaration span and shares its
  // parameter's name, but scale's own `a` (earlier in the source) claimed that
  // binding. The compiler recorded no type for the lambda's, so none is shown
  // — in particular it must not borrow the top-level `let a`'s.
  const lambdaA = at(11, 20);
  assert.equal(lambdaA.kind, "param");
  assert.equal(lambdaA.type, undefined);
  assert.equal(lambdaA.useCount, 1);

  const letA = at(16, 5);
  assert.equal(letA.kind, "value");
  assert.equal(letA.bindingKind, "let");
  assert.equal(letA.type, "Float64");
});

test("mergeSymbols: every binding is reported exactly once", () => {
  const symbols = nav.mergeSymbols(checkRich);
  // 18 references; all 17 bindings pair with one of them.
  assert.equal(symbols.length, checkRich.references.length);
  assert.equal(symbols.filter((sym) => sym.bindingKind !== undefined).length, checkRich.bindings.length);
});

test("mergeSymbols: pairing does not depend on the order references arrive in", () => {
  const shuffled = Object.assign({}, checkRich, { references: checkRich.references.slice().reverse() });
  const a = nav.mergeSymbols(checkRich).map((s) => [s.name, s.def && s.def.line, s.def && s.def.col, s.type]);
  const b = nav.mergeSymbols(shuffled).map((s) => [s.name, s.def && s.def.line, s.def && s.def.col, s.type]);
  assert.deepEqual(b, a);
});

test("declContains: endCol is exclusive, and a binding without an end corner matches by line", () => {
  const b = { line: 4, col: 1, endLine: 5, endCol: 40 };
  assert.equal(nav.declContains(b, { line: 4, col: 21 }), true);
  assert.equal(nav.declContains(b, { line: 5, col: 39 }), true);
  assert.equal(nav.declContains(b, { line: 5, col: 40 }), false);
  assert.equal(nav.declContains(b, { line: 3, col: 21 }), false);
  assert.equal(nav.declContains(b, null), false);
  // a compiler predating the endLine/endCol pair
  assert.equal(nav.declContains({ line: 2, col: 1 }, { line: 2, col: 5 }), true);
  assert.equal(nav.declContains({ line: 2, col: 1 }, { line: 3, col: 5 }), false);
});

test("kindsCompatible: the two tables' vocabularies line up", () => {
  assert.equal(nav.kindsCompatible("value", "let"), true);
  assert.equal(nav.kindsCompatible("value", "let mut"), true);
  assert.equal(nav.kindsCompatible("value", "static"), true);
  assert.equal(nav.kindsCompatible("local", "let"), true);
  assert.equal(nav.kindsCompatible("function", "static function"), true);
  assert.equal(nav.kindsCompatible("param", "param"), true);
  assert.equal(nav.kindsCompatible("param", "let"), false);
  assert.equal(nav.kindsCompatible("value", "param"), false);
  assert.equal(nav.kindsCompatible("value", "function"), false);
});

test("bladeSymbols: function facts and provider provenance come along", async () => {
  const ctx = makeCtx(checkRich);
  const s = (await nav.bladeSymbols({ source: "x" }, ctx)).structuredContent;
  const dot = s.symbols.find((sym) => sym.name === "dot");
  assert.equal(dot.type, "(a: Array<T like Idx<_>>, b: Array<T like Idx<_>>) -> T");
  assert.deepEqual(dot.where, ["comm(a, b)"]);
  assert.deepEqual(dot.deducedComm, ["comm(a, b)"]);
  assert.deepEqual(s.symbols.find((sym) => sym.name === "obs").providerRead, { store: "store", member: "vars.data" });
  assert.deepEqual(s.symbols.find((sym) => sym.name === "saved").providerWrite, { store: "store", member: "vars.data" });
});

test("bladeSymbols: a function-body local is kind 'local' with its binding's type", async () => {
  const ctx = makeCtx(checkRich);
  const s = (await nav.bladeSymbols({ source: "x", name: "k" }, ctx)).structuredContent;
  assert.equal(s.symbols.length, 1);
  assert.equal(s.symbols[0].kind, "local");
  assert.equal(s.symbols[0].bindingKind, "let");
  assert.equal(s.symbols[0].type, "(Float64) -> Float64");
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

test("bladeSymbols: a binding with no references[] entry is reported from its own span", async () => {
  const payload = Object.assign({}, checkClean, { references: checkClean.references.filter((r) => r.name !== "y") });
  const s = (await nav.bladeSymbols({ source: "x" }, makeCtx(payload))).structuredContent;
  const y = s.symbols.find((sym) => sym.name === "y");
  assert.ok(y);
  assert.equal(y.kind, "value", "reported in the reference vocabulary, like every other symbol");
  assert.equal(y.bindingKind, "let");
  assert.equal(y.type, "Int64");
  assert.deepEqual(y.def, { line: 2, col: 1, endLine: 2, endCol: 14 });
  assert.equal(y.useCount, 0);
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

test("bladeSymbols: kind filter is case-insensitive over the reference class", async () => {
  const ctx = makeCtx(checkError);
  const result = await nav.bladeSymbols({ source: "x", kind: "TYPE" }, ctx);
  assert.equal(result.structuredContent.symbols.length, 1);
  assert.equal(result.structuredContent.symbols[0].name, "Idx");
});

test("bladeSymbols: kind filter also accepts a binding's source spelling", async () => {
  const ctx = makeCtx(checkRich);
  const mut = (await nav.bladeSymbols({ source: "x", kind: "let mut" }, ctx)).structuredContent;
  assert.deepEqual(mut.symbols.map((sym) => sym.name), ["total"]);
  assert.equal(mut.symbols[0].kind, "value");
  assert.equal(mut.symbols[0].bindingKind, "let mut");

  const fns = (await nav.bladeSymbols({ source: "x", kind: "function" }, ctx)).structuredContent;
  assert.deepEqual(fns.symbols.map((sym) => sym.name), ["cross", "dot", "scale"]);
  // `bindingKind` is only shown when it adds something to `kind`
  for (const sym of fns.symbols) assert.equal(sym.bindingKind, undefined);
});

test("bladeSymbols: includeUses:false drops the uses array but keeps useCount", async () => {
  const ctx = makeCtx(checkError);
  const result = await nav.bladeSymbols({ source: "x", includeUses: false }, ctx);
  for (const sym of result.structuredContent.symbols) {
    assert.equal(sym.uses, undefined);
    assert.equal(typeof sym.useCount, "number");
  }
});

test("bladeSymbols: a binding with zero uses still appears (useCount 0)", async () => {
  const ctx = makeCtx(checkClean);
  const result = await nav.bladeSymbols({ source: "x" }, ctx);
  const y = result.structuredContent.symbols.find((sym) => sym.name === "y");
  assert.ok(y);
  assert.equal(y.useCount, 0);
  assert.deepEqual(y.uses, []);
  assert.deepEqual(y.def, { line: 2, col: 5, endLine: 2, endCol: 6 });
});

test("bladeSymbols: errors in the payload add a partial-resolution note", async () => {
  const ctx = makeCtx(checkError);
  const result = await nav.bladeSymbols({ source: "x" }, ctx);
  assert.match(result.structuredContent.note, /may be partial/);
});

test("bladeSymbols: a huge listing is capped, with exact counts and a note saying how to narrow it", async () => {
  const references = [];
  const bindings = [];
  const n = nav.MAX_SYMBOLS + 25;
  for (let i = 0; i < n; i++) {
    const name = `v${String(i).padStart(4, "0")}`;
    bindings.push({ name, kind: "let", line: i + 1, col: 1, type: "Int64", endLine: i + 1, endCol: 20 });
    references.push({ name, kind: "value", def: { line: i + 1, col: 5, endLine: i + 1, endCol: 10 }, uses: [] });
  }
  const s = (await nav.bladeSymbols({ source: "x" }, makeCtx({ version: 1, diagnostics: [], bindings, references }))).structuredContent;
  assert.equal(s.symbolCount, n, "symbolCount is what matched, not what was listed");
  assert.equal(s.totalSymbols, n);
  assert.equal(s.symbols.length, nav.MAX_SYMBOLS);
  assert.equal(s.truncated, true);
  assert.match(s.note, /narrow with `name` or `kind`/);

  // a name filter is the way through the cap
  const one = (await nav.bladeSymbols({ source: "x", name: `v${String(n - 1).padStart(4, "0")}` }, makeCtx({ version: 1, diagnostics: [], bindings, references }))).structuredContent;
  assert.equal(one.symbols.length, 1);
  assert.equal(one.truncated, undefined);
});

test("bladeSymbols: a symbol used hundreds of times lists a capped run of uses; useCount stays exact", async () => {
  const uses = [];
  const n = nav.MAX_USES_PER_SYMBOL + 30;
  for (let i = 0; i < n; i++) uses.push({ line: i + 2, col: 1, endLine: i + 2, endCol: 2 });
  const payload = {
    version: 1,
    diagnostics: [],
    bindings: [{ name: "x", kind: "let", line: 1, col: 1, type: "Int64", endLine: 1, endCol: 10 }],
    references: [{ name: "x", kind: "value", def: { line: 1, col: 5, endLine: 1, endCol: 6 }, uses }],
  };
  const s = (await nav.bladeSymbols({ source: "x" }, makeCtx(payload))).structuredContent;
  assert.equal(s.symbols[0].useCount, n);
  assert.equal(s.symbols[0].uses.length, nav.MAX_USES_PER_SYMBOL);
  assert.equal(s.symbols[0].usesTruncated, true);
  assert.match(s.note, /useCount is exact/);
});

test("bladeSymbols: use spans share one response-wide budget, spent in listing order", async () => {
  // 20 symbols with 40 uses each = 800 spans; the response may carry 300.
  const bindings = [];
  const references = [];
  for (let i = 0; i < 20; i++) {
    const name = `s${String(i).padStart(2, "0")}`;
    const uses = [];
    for (let u = 0; u < 40; u++) uses.push({ line: 100 + u, col: i + 1, endLine: 100 + u, endCol: i + 2 });
    bindings.push({ name, kind: "let", line: i + 1, col: 1, type: "Int64", endLine: i + 1, endCol: 20 });
    references.push({ name, kind: "value", def: { line: i + 1, col: 5, endLine: i + 1, endCol: 8 }, uses });
  }
  const payload = { version: 1, diagnostics: [], bindings, references };
  const s = (await nav.bladeSymbols({ source: "x" }, makeCtx(payload))).structuredContent;
  const listed = s.symbols.reduce((n, sym) => n + sym.uses.length, 0);
  assert.equal(listed, nav.MAX_USES_TOTAL);
  assert.equal(s.symbols[0].uses.length, 40, "early symbols are whole");
  assert.equal(s.symbols[0].usesTruncated, undefined);
  assert.equal(s.symbols[19].uses.length, 0, "late symbols list none once the budget is spent");
  assert.equal(s.symbols[19].usesTruncated, true);
  for (const sym of s.symbols) assert.equal(sym.useCount, 40);

  // looking one of the late ones up by name gets all of its uses
  const one = (await nav.bladeSymbols({ source: "x", name: "s19" }, makeCtx(payload))).structuredContent;
  assert.equal(one.symbols[0].uses.length, 40);
  assert.equal(one.symbols[0].usesTruncated, undefined);
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
    surface: () => ({ compilerVersion: "0.20.0" }),
    log: () => {},
  };
  await nav.bladeSymbols({ source: "x" }, ctx);
  assert.equal(seenTier, "fast");
});

test("bladeSymbols: a binding's doc comment comes along on a lookup, capped", async () => {
  const s = (await nav.bladeSymbols({ source: "x", name: "dot" }, makeCtx(checkRich))).structuredContent;
  assert.equal(s.symbols[0].doc, "Sum of products of two rows.");
  // bindings without one carry no key
  const k = (await nav.bladeSymbols({ source: "x", name: "k" }, makeCtx(checkRich))).structuredContent;
  assert.equal("doc" in k.symbols[0], false);

  const banner = "=".repeat(1000);
  const payload = {
    version: 1,
    diagnostics: [],
    bindings: [{ name: "x", kind: "let", line: 1, col: 1, type: "Int64", doc: banner, endLine: 1, endCol: 10 }],
    references: [{ name: "x", kind: "value", def: { line: 1, col: 5, endLine: 1, endCol: 6 }, uses: [] }],
  };
  const long = (await nav.bladeSymbols({ source: "x" }, makeCtx(payload))).structuredContent;
  assert.ok(long.symbols[0].doc.length < 320, "a section banner attached as a doc must not be relayed whole");
  assert.match(long.symbols[0].doc, /…$/);
});

test("bladeSymbols: `static function` and `static` are visible as bindingKind and usable as a kind filter", async () => {
  const payload = {
    version: 1,
    diagnostics: [],
    bindings: [
      { name: "n", kind: "static", line: 1, col: 1, type: "Int64", endLine: 1, endCol: 17 },
      { name: "sq", kind: "static function", line: 2, col: 1, type: "(\n    k: Int64\n) -> Int64", params: [{ name: "k", type: "Int64" }], ret: "Int64", deducedComm: [], endLine: 2, endCol: 45 },
      { name: "k", kind: "param", line: 2, col: 1, type: "Int64", endLine: 2, endCol: 45 },
    ],
    references: [
      { name: "n", kind: "value", def: { line: 1, col: 12, endLine: 1, endCol: 13 }, uses: [] },
      { name: "sq", kind: "function", def: { line: 2, col: 17, endLine: 2, endCol: 19 }, uses: [] },
      { name: "k", kind: "param", def: { line: 2, col: 20, endLine: 2, endCol: 21 }, uses: [] },
    ],
  };
  const all = (await nav.bladeSymbols({ source: "x" }, makeCtx(payload))).structuredContent;
  const sq = all.symbols.find((sym) => sym.name === "sq");
  assert.equal(sq.kind, "function");
  assert.equal(sq.bindingKind, "static function");
  assert.equal(sq.type, "(k: Int64) -> Int64");
  assert.equal(all.symbols.find((sym) => sym.name === "n").bindingKind, "static");

  const statics = (await nav.bladeSymbols({ source: "x", kind: "static function" }, makeCtx(payload))).structuredContent;
  assert.deepEqual(statics.symbols.map((sym) => sym.name), ["sq"]);
  // "let" reaches the top-level value bindings spelled that way — none here
  assert.equal((await nav.bladeSymbols({ source: "x", kind: "let" }, makeCtx(payload))).structuredContent.symbolCount, 0);
  assert.equal((await nav.bladeSymbols({ source: "x", kind: "let" }, makeCtx(checkRich))).structuredContent.symbolCount > 0, true);
});

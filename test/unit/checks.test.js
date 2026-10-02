"use strict";

// checks.js: blade_check trimming, raw passthrough, synthetic naming, cwd
// validation. Driven directly with an injected fake ctx — no process, no
// fake-serve — per the plan's "handlers driven directly with an injected
// fake client/ctx" strategy.
//
// The fixtures are the real compiler's own tier-full payloads (see
// test/fake-serve.js for what each one holds), so what is trimmed here is the
// shape the compiler actually sends.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const checks = require("../../src/checks");
const checkClean = require("../fixtures/check-clean.json");
const checkError = require("../fixtures/check-error.json");
const checkRich = require("../fixtures/check-rich.json");

const REGISTRY = new Map([
  ["BL3016", { code: "BL3016", title: "argument extent mismatch", phase: "types" }],
  ["BL3020", { code: "BL3020", title: "implicit numeric conversion", phase: "types" }],
]);

/** Build a minimal ctx exposing only what checks.js reads. */
function makeCtx(opts) {
  const o = opts || {};
  const calls = [];
  return {
    config: { cwd: o.cwd || process.cwd() },
    calls,
    getClient: () => ({
      check: async (file, source, tier, timeoutMs) => {
        calls.push({ file, source, tier, timeoutMs });
        return o.payload !== undefined ? o.payload : checkClean;
      },
    }),
    diagRegistry: () => o.registry || REGISTRY,
    surface: () => (o.surface !== undefined ? o.surface : { compilerVersion: "0.20.0" }),
    liveVersion: o.liveVersion,
    log: () => {},
  };
}

test("bladeCheck: trims diagnostics with registry title/phase, and code:null when absent", async () => {
  const ctx = makeCtx({ payload: checkError });
  const result = await checks.bladeCheck({ source: "let r = f(a)\n" }, ctx);
  const s = result.structuredContent;
  assert.equal(s.ok, false); // one error-severity diagnostic present
  assert.equal(s.diagnostics.length, 2);
  const coded = s.diagnostics.find((d) => d.code === "BL3016");
  assert.equal(coded.title, "argument extent mismatch");
  assert.equal(coded.phase, "types");
  assert.equal(coded.severity, "error");
  assert.deepEqual(coded.span, { line: 3, col: 11, endLine: 3, endCol: 12 });
  const uncoded = s.diagnostics.find((d) => d.code === null);
  assert.ok(uncoded, "a diagnostic with no code in the payload must trim to code: null, not absent");
  assert.equal(uncoded.title, undefined);
});

test("bladeCheck: a warning-only payload is ok:true, and the warning keeps its title", async () => {
  const ctx = makeCtx({ payload: checkRich });
  const s = (await checks.bladeCheck({ source: "x" }, ctx)).structuredContent;
  assert.equal(s.ok, true, "warnings do not fail a check");
  assert.equal(s.stats.errors, 0);
  assert.equal(s.stats.warnings, 1);
  assert.equal(s.diagnostics[0].severity, "warning");
  assert.equal(s.diagnostics[0].code, "BL3020");
  assert.equal(s.diagnostics[0].title, "implicit numeric conversion");
});

test("bladeCheck: a plain binding trims to {name, kind, line, type} — kind as the source spells it", async () => {
  const ctx = makeCtx({ payload: checkClean });
  const result = await checks.bladeCheck({ source: "let x = 1\nlet y = x + 1\n" }, ctx);
  const s = result.structuredContent;
  assert.equal(s.bindings.length, 2);
  assert.deepEqual(s.bindings[0], { name: "x", kind: "let", line: 1, type: "Int64" });
  assert.deepEqual(s.bindings[1], { name: "y", kind: "let", line: 2, type: "Int64" });
  // the declaration span's other three corners are editor data, not agent data
  for (const b of s.bindings) for (const k of ["col", "endLine", "endCol", "doc", "params", "ret"]) assert.equal(b[k], undefined);
});

test("bladeCheck: binding kinds pass through verbatim (let mut, param, function)", async () => {
  const ctx = makeCtx({ payload: checkRich });
  const s = (await checks.bladeCheck({ source: "x" }, ctx)).structuredContent;
  const kinds = new Set(s.bindings.map((b) => b.kind));
  for (const k of ["let", "let mut", "function", "param"]) assert.ok(kinds.has(k), `expected a '${k}' binding`);
  assert.equal(s.bindings.find((b) => b.name === "total").kind, "let mut");
});

test("bladeCheck: concreteType is kept when the full tier resolved one", async () => {
  const ctx = makeCtx({ payload: checkRich });
  const s = (await checks.bladeCheck({ source: "x" }, ctx)).structuredContent;
  const store = s.bindings.find((b) => b.name === "store");
  assert.equal(store.concreteType, "Void");
  assert.equal(s.bindings.find((b) => b.name === "obs").concreteType, undefined);
});

test("bladeCheck: a function's hover-formatted type is flattened to one line", async () => {
  const ctx = makeCtx({ payload: checkRich });
  const s = (await checks.bladeCheck({ source: "x" }, ctx)).structuredContent;
  const scale = s.bindings.find((b) => b.name === "scale");
  assert.equal(scale.type, "(a: Float64, s: Float64 = 2.0) -> Float64");
  for (const b of s.bindings) assert.ok(!/\n/.test(b.type), `${b.name}'s type must not carry newlines`);
});

test("flattenType: only multi-line renderings change", () => {
  assert.equal(checks.flattenType("(\n    a: T^1,\n    b: T^1\n) -> T"), "(a: T^1, b: T^1) -> T");
  assert.equal(checks.flattenType("Array<Float64 like Idx<4>>"), "Array<Float64 like Idx<4>>");
  assert.equal(checks.flattenType("(Int64) -> Int64"), "(Int64) -> Int64");
  assert.equal(checks.flattenType(undefined), undefined);
});

test("bladeCheck: declared where-clauses and DEDUCED symmetry ride the function binding", async () => {
  const ctx = makeCtx({ payload: checkRich });
  const s = (await checks.bladeCheck({ source: "x" }, ctx)).structuredContent;
  const dot = s.bindings.find((b) => b.name === "dot");
  assert.deepEqual(dot.where, ["comm(a, b)"]);
  assert.deepEqual(dot.deducedComm, ["comm(a, b)"]);
  // deduced without being declared: no `where`, but the proof is reported
  const cross = s.bindings.find((b) => b.name === "cross");
  assert.equal(cross.where, undefined);
  assert.deepEqual(cross.deducedComm, ["comm(x, y)"]);
  // "deduction ran and proved nothing" ([] on the wire) is omitted, not sent empty
  const scale = s.bindings.find((b) => b.name === "scale");
  assert.equal(scale.deducedComm, undefined);
  assert.equal(scale.where, undefined);
});

test("bladeCheck: providerRead and providerWrite are surfaced, and never on the same binding", async () => {
  const ctx = makeCtx({ payload: checkRich });
  const s = (await checks.bladeCheck({ source: "x" }, ctx)).structuredContent;
  const obs = s.bindings.find((b) => b.name === "obs");
  assert.deepEqual(obs.providerRead, { store: "store", member: "vars.data" });
  assert.equal(obs.providerWrite, undefined);
  const saved = s.bindings.find((b) => b.name === "saved");
  assert.deepEqual(saved.providerWrite, { store: "store", member: "vars.data" });
  assert.equal(saved.providerRead, undefined, "a write binding reads nothing");
});

test("bladeCheck: loaded provider stores are listed with their structure", async () => {
  const ctx = makeCtx({ payload: checkRich });
  const s = (await checks.bladeCheck({ source: "x" }, ctx)).structuredContent;
  assert.deepEqual(s.providers, [
    {
      store: "store",
      alias: "c",
      provider: "csv",
      path: "obs.csv",
      line: 3,
      indexTypes: [],
      dims: [],
      vars: [{ name: "data", type: "Array<Int64 like Idx<2>, Idx<2>>" }],
    },
  ]);
  assert.equal(s.stats.providers, 1);
});

test("bladeCheck: a program that loads nothing has no `providers` key at all", async () => {
  const ctx = makeCtx({ payload: checkClean });
  const s = (await checks.bladeCheck({ source: "x" }, ctx)).structuredContent;
  assert.equal("providers" in s, false);
  assert.equal(s.stats.providers, 0);
});

test("trimProvider: a store with hundreds of variables is capped, and says how many were cut", () => {
  const vars = [];
  for (let i = 0; i < checks.MAX_PROVIDER_MEMBERS + 7; i++) vars.push({ name: `v${i}`, type: "Array<Float64 like Idx<t>>" });
  const out = checks.trimProvider({
    store: "s",
    alias: "nc",
    provider: "netcdf",
    path: "big.nc",
    line: 2,
    col: 1,
    indexTypes: [{ name: "t", extent: 12 }, { name: "z" }],
    dims: [{ name: "t", type: "Array<Int64 like Idx<t>>" }],
    vars,
  });
  assert.equal(out.vars.length, checks.MAX_PROVIDER_MEMBERS);
  assert.deepEqual(out.omitted, { vars: 7 });
  assert.deepEqual(out.indexTypes, [{ name: "t", extent: 12 }, { name: "z" }], "a missing extent stays missing");
  assert.equal(out.col, undefined);
});

test("bladeCheck: deduced facts pass through verbatim", async () => {
  const ctx = makeCtx({ payload: checkRich });
  const s = (await checks.bladeCheck({ source: "x" }, ctx)).structuredContent;
  assert.deepEqual(s.deduced, checkRich.deduced);
  assert.equal(s.deduced[0].kind, "comm");
  assert.equal(s.deduced[0].owner, "cross");
});

test("bladeCheck: stats counts every table, not just diagnostics", async () => {
  const ctx = makeCtx({ payload: checkError });
  const result = await checks.bladeCheck({ source: "x" }, ctx);
  const stats = result.structuredContent.stats;
  assert.deepEqual(stats, {
    diagnostics: 2,
    errors: 1,
    warnings: 1,
    bindings: 3,
    references: 4,
    calls: 0,
    kernels: 0,
    providers: 0,
    deduced: 0,
  });
});

test("bladeCheck: the span tables are counted, never included", async () => {
  const ctx = makeCtx({ payload: checkRich });
  const s = (await checks.bladeCheck({ source: "x" }, ctx)).structuredContent;
  for (const k of ["references", "calls", "kernels"]) assert.equal(k in s, false, `${k} must not be in the trimmed output`);
  assert.equal(s.stats.references, checkRich.references.length);
  assert.equal(s.stats.calls, checkRich.calls.length);
  // the trimmed result is a fraction of the payload it came from
  assert.ok(JSON.stringify(s).length < JSON.stringify(checkRich).length);
});

test("bladeCheck: raw:true returns the untrimmed payload verbatim", async () => {
  const ctx = makeCtx({ payload: checkError });
  const result = await checks.bladeCheck({ source: "x", raw: true }, ctx);
  const s = result.structuredContent;
  assert.equal(s.raw, true);
  assert.deepEqual(s.payload, checkError);
  // raw mode does not trim: the untrimmed diagnostics still lack a title field.
  assert.equal(s.payload.diagnostics[0].title, undefined);
});

test("bladeCheck: bare `source` checks at a synthetic path, writes nothing, notes it", async () => {
  const cwd = os.tmpdir();
  const ctx = makeCtx({ cwd, payload: checkClean });
  const result = await checks.bladeCheck({ source: "let x = 1" }, ctx);
  const s = result.structuredContent;
  assert.equal(s.synthetic, true);
  assert.equal(path.basename(s.file), "__blade_mcp_snippet__.blade");
  assert.equal(path.dirname(s.file), path.resolve(cwd));
  assert.match(s.note, /no file was written/);
  // and the client was actually called with that synthetic path + the source text
  assert.equal(ctx.calls[0].file, s.file);
  assert.equal(ctx.calls[0].source, "let x = 1");
});

/** Write `text` to a throwaway .blade file; returns {file, dispose}. */
function tempBlade(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blade-mcp-check-"));
  const file = path.join(dir, "probe.blade");
  fs.writeFileSync(file, text);
  return { file, dir, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("bladeCheck: `file` alone reads the file from disk", async () => {
  const ctx = makeCtx({ payload: checkClean });
  const tmp = tempBlade("let x = 1\nlet y = x + 1\n");
  try {
    const result = await checks.bladeCheck({ file: tmp.file }, ctx);
    const s = result.structuredContent;
    assert.equal(s.synthetic, false);
    assert.equal(path.resolve(s.file), path.resolve(tmp.file));
    assert.equal(ctx.calls[0].source, "let x = 1\nlet y = x + 1\n");
    assert.equal(s.note, undefined, "a real file needs no 'nothing was written' note");
  } finally {
    tmp.dispose();
  }
});

test("bladeCheck: a UTF-8 byte-order mark is stripped — from a file, and from bare source", async () => {
  // `blade check` accepts a BOM-prefixed file (its reader is BOM-aware); sent
  // verbatim over `ide serve` the U+FEFF reaches the lexer and the whole file
  // is rejected at 1:1.
  const tmp = tempBlade("\uFEFFlet x = 1\nlet y = x + 1\n");
  try {
    assert.equal(fs.readFileSync(tmp.file)[0], 0xef, "the fixture really starts with EF BB BF");
    const ctx = makeCtx({ payload: checkClean });
    await checks.bladeCheck({ file: tmp.file }, ctx);
    assert.equal(ctx.calls[0].source, "let x = 1\nlet y = x + 1\n");
    assert.notEqual(ctx.calls[0].source.charCodeAt(0), 0xfeff);

    await checks.bladeCheck({ source: "\uFEFFlet x = 1\n" }, ctx);
    assert.equal(ctx.calls[1].source, "let x = 1\n");

    // unsaved-buffer text at a path gets the same treatment
    await checks.bladeCheck({ file: tmp.file, source: "\uFEFFlet z = 2\n" }, ctx);
    assert.equal(ctx.calls[2].source, "let z = 2\n");
  } finally {
    tmp.dispose();
  }
});

test("normalizeSource: only a LEADING mark is removed; text without one is returned as it was", () => {
  assert.equal(checks.normalizeSource("\uFEFFlet x = 1"), "let x = 1");
  assert.equal(checks.normalizeSource("let s = \"a\uFEFFb\""), "let s = \"a\uFEFFb\"");
  assert.equal(checks.normalizeSource("let x = 1\n"), "let x = 1\n");
  assert.equal(checks.normalizeSource(""), "");
});

test("bladeCheck: a lone surrogate is refused up front, naming the line — nothing is sent", async () => {
  // Sent on, the compiler cannot parse the request line and answers with an
  // error that carries no id: the call would hang to its timeout and the serve
  // process (with every session) would be killed for it.
  const ctx = makeCtx({ payload: checkClean });
  await assert.rejects(
    () => checks.bladeCheck({ source: 'let a = 1\nlet s = "\uD83D"\n' }, ctx),
    (e) => e.userFacing === true && /lone UTF-16 surrogate \(line 2\)/.test(e.message) && e.details.line === 2
  );
  await assert.rejects(() => checks.bladeCheck({ source: "let s = \uDE00" }, ctx), /lone UTF-16 surrogate/);
  assert.equal(ctx.calls.length, 0);
  // a proper pair is ordinary text
  await checks.bladeCheck({ source: 'let s = "\uD83D\uDE00"' }, ctx);
  assert.equal(ctx.calls.length, 1);
});

test("bladeCheck: `timeoutMs` reaches the client; omitted, the client's own tier default applies", async () => {
  const ctx = makeCtx({ payload: checkClean });
  await checks.bladeCheck({ source: "x", timeoutMs: 90000 }, ctx);
  assert.equal(ctx.calls[0].timeoutMs, 90000);
  await checks.bladeCheck({ source: "x" }, ctx);
  assert.equal(ctx.calls[1].timeoutMs, undefined);
});

test("bladeCheck: a restart backoff is waited out and the check retried once", async () => {
  let calls = 0;
  const ctx = makeCtx({});
  ctx.getClient = () => ({
    check: async () => {
      calls++;
      if (calls === 1) throw new Error("blade ide serve: backing off for 20ms");
      return checkClean;
    },
    available: () => "yes",
  });
  ctx.resolved = () => ({ exe: "Blade.exe", origin: "env" });
  const result = await checks.bladeCheck({ source: "let x = 1" }, ctx);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(calls, 2);
});

test("bladeCheck: compilerVersion is the BINARY's version, not the packaged surface's — and null when unknown", async () => {
  const live = makeCtx({ payload: checkClean, surface: { compilerVersion: "0.19.2" }, liveVersion: async () => "0.20.0" });
  assert.equal((await checks.bladeCheck({ source: "x" }, live)).structuredContent.compilerVersion, "0.20.0");

  const unknown = makeCtx({ payload: checkClean, surface: { compilerVersion: "0.19.2" }, liveVersion: async () => "unknown" });
  assert.equal((await checks.bladeCheck({ source: "x" }, unknown)).structuredContent.compilerVersion, null);

  const none = makeCtx({ payload: checkClean, surface: { compilerVersion: "0.19.2" } });
  assert.equal((await checks.bladeCheck({ source: "x" }, none)).structuredContent.compilerVersion, null);
});

test("bladeCheck: a function's type is its signature with parameter defaults", async () => {
  const ctx = makeCtx({ payload: checkRich });
  const s = (await checks.bladeCheck({ source: "x" }, ctx)).structuredContent;
  // the compiler's own `type` rendering has no default; params[] carries it
  const raw = checkRich.bindings.find((b) => b.name === "scale");
  assert.ok(!/2\.0/.test(raw.type));
  assert.equal(raw.params[1].default, "2.0");
  assert.equal(s.bindings.find((b) => b.name === "scale").type, "(a: Float64, s: Float64 = 2.0) -> Float64");
});

test("signatureOf: non-function bindings just get their flattened type", () => {
  assert.equal(checks.signatureOf({ type: "Int64" }), "Int64");
  assert.equal(checks.signatureOf({ type: "(Float64) -> Float64" }), "(Float64) -> Float64");
  assert.equal(checks.signatureOf({ type: "(\n    w: T^1\n) -> T", params: [{ name: "w", type: "T^1" }], ret: "T" }), "(w: T^1) -> T");
});

test("bladeCheck: a program with thousands of bindings lists the first MAX_BINDINGS and says so; stats stay exact", async () => {
  const bindings = [];
  const n = checks.MAX_BINDINGS + 50;
  for (let i = 0; i < n; i++) bindings.push({ name: `v${i}`, kind: "let", line: i + 1, col: 1, type: "Int64", endLine: i + 1, endCol: 12 });
  const payload = { version: 1, diagnostics: [], bindings, providers: [], deduced: [], calls: [], kernels: [], references: [] };
  const s = (await checks.bladeCheck({ source: "x" }, makeCtx({ payload }))).structuredContent;
  assert.equal(s.bindings.length, checks.MAX_BINDINGS);
  assert.equal(s.bindingsOmitted, 50);
  assert.equal(s.stats.bindings, n);
  assert.match(s.note, /only the first 300 are listed/);
  assert.match(s.note, /blade_symbols/);
  // an ordinary program carries neither the count nor the note
  const small = (await checks.bladeCheck({ file: __filename, source: "x" }, makeCtx({ payload: checkClean }))).structuredContent;
  assert.equal(small.bindingsOmitted, undefined);
  assert.equal(small.note, undefined);
});

test("bladeCheck: cwd must exist", async () => {
  const ctx = makeCtx({});
  await assert.rejects(
    () => checks.bladeCheck({ source: "x", cwd: path.join(os.tmpdir(), "definitely-does-not-exist-blade-mcp") }, ctx),
    /cwd does not exist/
  );
});

test("bladeCheck: neither `file` nor `source` is a UserError", async () => {
  const ctx = makeCtx({});
  await assert.rejects(() => checks.bladeCheck({}, ctx), /provide `file`/);
});

test("pickTier: fast/full pass through, anything else falls back", () => {
  assert.equal(checks.pickTier("fast", "full"), "fast");
  assert.equal(checks.pickTier("full", "fast"), "full");
  assert.equal(checks.pickTier(undefined, "full"), "full");
  assert.equal(checks.pickTier("bogus", "fast"), "fast");
});

test("trimDiagnostic: severity/message/span pass through unchanged", () => {
  const d = { severity: "error", message: "boom", line: 1, col: 2, endLine: 1, endCol: 5, code: "BL9999" };
  const out = checks.trimDiagnostic(d, new Map());
  assert.equal(out.code, "BL9999");
  assert.equal(out.title, undefined); // not in the registry
  assert.deepEqual(out.span, { line: 1, col: 2, endLine: 1, endCol: 5 });
});

test("trimDiagnostic: an eval's `note` severity survives, and a missing registry is tolerated", () => {
  const d = { severity: "note", message: "fyi", line: 2, col: 1, endLine: 2, endCol: 1, code: "BL3020" };
  const out = checks.trimDiagnostic(d, undefined);
  assert.equal(out.severity, "note");
  assert.equal(out.code, "BL3020");
  assert.equal(out.title, undefined);
});

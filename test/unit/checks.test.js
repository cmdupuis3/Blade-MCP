"use strict";

// checks.js: blade_check trimming, raw passthrough, synthetic naming, cwd
// validation. Driven directly with an injected fake ctx — no process, no
// fake-serve — per the plan's "handlers driven directly with an injected
// fake client/ctx" strategy.

const path = require("path");
const os = require("os");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const checks = require("../../src/checks");
const checkClean = require("../fixtures/check-clean.json");
const checkError = require("../fixtures/check-error.json");

const REGISTRY = new Map([["BL3016", { code: "BL3016", title: "argument extent mismatch", phase: "types" }]]);

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
    surface: () => (o.surface !== undefined ? o.surface : { compilerVersion: "0.19.2" }),
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
  const uncoded = s.diagnostics.find((d) => d.code === null);
  assert.ok(uncoded, "a diagnostic with no code in the payload must trim to code: null, not absent");
  assert.equal(uncoded.title, undefined);
});

test("bladeCheck: bindings trim to {name, kind, type, concreteType?}", async () => {
  const ctx = makeCtx({ payload: checkClean });
  const result = await checks.bladeCheck({ source: "let x = 1\nlet y = x + 1\n" }, ctx);
  const s = result.structuredContent;
  assert.equal(s.bindings.length, 2);
  assert.deepEqual(Object.keys(s.bindings[0]).sort(), ["kind", "name", "type"]);
  assert.deepEqual(s.bindings[1], { name: "y", kind: "value", type: "Int64", concreteType: "Int64" });
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

test("bladeCheck: `file` alone reads the file from disk", async () => {
  const ctx = makeCtx({ payload: checkClean });
  const target = path.join(__dirname, "..", "fixtures", "corpus-mini", "basic", "001_add_one.blade");
  const result = await checks.bladeCheck({ file: target }, ctx);
  const s = result.structuredContent;
  assert.equal(s.synthetic, false);
  assert.equal(path.resolve(s.file), path.resolve(target));
  assert.match(ctx.calls[0].source, /let x = 1/);
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

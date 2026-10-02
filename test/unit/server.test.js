"use strict";

// server.js + schemas.js: the tool table as a client sees it (annotations,
// descriptions that match behavior), argument validation at the dispatcher,
// and the dispatch wrapper's error shapes. No transport — test/e2e-stdio.test.js
// covers the SDK plumbing.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const server = require("../../src/server");
const schemas = require("../../src/schemas");

/** A context no handler should reach when its arguments are invalid. */
function untouchableCtx() {
  const boom = () => {
    throw new Error("the handler must not run on invalid arguments");
  };
  return { config: { cwd: process.cwd() }, getClient: boom, resolved: boom, log: () => {} };
}

// --- schemas.validate ------------------------------------------------------------

test("validate: a typo'd argument is named, with the argument it probably meant", () => {
  const problems = schemas.validate(schemas.bladeCheck, { sorce: "let x = 1" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /unknown argument `sorce`/);
  assert.match(problems[0], /did you mean `source`\?/);
  assert.match(problems[0], /accepted: file, source, tier, cwd, timeoutMs, raw/);
});

test("validate: enum, type, range and pattern violations each say what was expected and what arrived", () => {
  assert.deepEqual(schemas.validate(schemas.bladeCheck, { source: "x", tier: "bogus" }), ['`tier` must be one of "fast", "full", got "bogus"']);
  assert.deepEqual(schemas.validate(schemas.bladeCheck, { source: "x", raw: "yes" }), ['`raw` must be a boolean, got string ("yes")']);
  assert.deepEqual(schemas.validate(schemas.bladeEval, { source: "x", timeoutMs: 1 }), ["`timeoutMs` must be at least 1000, got 1"]);
  assert.deepEqual(schemas.validate(schemas.bladeEval, { source: "x", plotWidth: 10 }), ["`plotWidth` must be at least 64, got 10"]);
  assert.deepEqual(schemas.validate(schemas.bladeEval, { source: "x", plotHeight: 99999 }), ["`plotHeight` must be at most 4096, got 99999"]);
  assert.deepEqual(schemas.validate(schemas.bladeCorpusFind, { maxResults: "ten" }), ['`maxResults` must be an integer, got string ("ten")']);
  assert.deepEqual(schemas.validate(schemas.bladeEval, { source: "x", timeoutMs: 1500.5 }), ["`timeoutMs` must be an integer, got number (1500.5)"]);
  assert.match(schemas.validate(schemas.bladeExplain, { code: "extent" })[0], /`code` must match/);
  // a diagnostic code is accepted in either case, with or without its prefix
  for (const code of ["BL3016", "bl3016", "Bl3016", "3016"]) {
    assert.deepEqual(schemas.validate(schemas.bladeExplain, { code }), [], code);
    assert.deepEqual(schemas.validate(schemas.bladeCorpusFind, { code }), [], code);
  }
  assert.match(schemas.validate(schemas.bladeExplain, { code: "BL316" })[0], /`code` must match/);
});

test("validate: nothing is coerced, required arguments are required, and several problems are all reported", () => {
  assert.deepEqual(schemas.validate(schemas.bladeEval, {}), ["missing required argument `source`"]);
  assert.deepEqual(schemas.validate(schemas.bladeEval, { source: 5 }), ["`source` must be a string, got integer (5)"]);
  const many = schemas.validate(schemas.bladeEval, { sourse: "x", session: 3 });
  assert.equal(many.length, 3, JSON.stringify(many));
});

test("validate: valid arguments — including none at all — produce no problems", () => {
  assert.deepEqual(schemas.validate(schemas.bladeCheck, { source: "let x = 1", tier: "fast", raw: false, timeoutMs: 60000 }), []);
  assert.deepEqual(schemas.validate(schemas.bladeEval, { source: "1 + 1", session: "s", plotWidth: 1200, plotHeight: 900, timeoutMs: 1000 }), []);
  assert.deepEqual(schemas.validate(schemas.bladeSymbols, { file: "a.blade", name: "x", kind: "let mut", includeUses: false }), []);
  assert.deepEqual(schemas.validate(schemas.bladeExplain, { code: "BL3016" }), []);
  assert.deepEqual(schemas.validate(schemas.bladeExplain, { code: "3016", maxExamples: 0 }), []);
  assert.deepEqual(schemas.validate(schemas.bladeDoctor, {}), []);
  assert.deepEqual(schemas.validate(schemas.bladeDoctor, undefined), []);
  assert.deepEqual(schemas.validate(schemas.bladeCorpusFind, {}), []);
});

test("validate: arguments that are not an object at all are refused", () => {
  assert.deepEqual(schemas.validate(schemas.bladeDoctor, [1, 2]), ["arguments must be an object, got array"]);
  assert.deepEqual(schemas.validate(schemas.bladeDoctor, "x"), ["arguments must be an object, got string"]);
});

test("every tool's schema is one validate() fully implements (no keyword it would silently skip)", () => {
  const understood = new Set(["type", "description", "default", "enum", "minimum", "maximum", "pattern"]);
  for (const tool of server.TOOLS) {
    const schema = tool.inputSchema;
    assert.equal(schema.type, "object", tool.name);
    assert.equal(schema.additionalProperties, false, `${tool.name} must reject unknown arguments`);
    for (const [name, spec] of Object.entries(schema.properties)) {
      assert.ok(["string", "integer", "number", "boolean"].includes(spec.type), `${tool.name}.${name}: type ${spec.type}`);
      for (const key of Object.keys(spec)) assert.ok(understood.has(key), `${tool.name}.${name} uses '${key}', which validate() does not check`);
      if (spec.default !== undefined) {
        assert.deepEqual(schemas.validate(schema, Object.assign(requiredStub(schema), { [name]: spec.default })), [], `${tool.name}.${name}: its own default must validate`);
      }
    }
  }
});

function requiredStub(schema) {
  const out = {};
  for (const name of schema.required || []) out[name] = schema.properties[name].pattern ? "BL3016" : "x";
  return out;
}

// --- dispatchTool ----------------------------------------------------------------

test("dispatchTool: invalid arguments are an isError naming every problem — the handler never runs", async () => {
  const ctx = untouchableCtx();
  for (const [tool, args, expect] of [
    ["blade_check", { sorce: "typo" }, /unknown argument `sorce`/],
    ["blade_check", { source: "x", tier: "bogus" }, /`tier` must be one of/],
    ["blade_check", { source: "x", raw: "yes" }, /`raw` must be a boolean/],
    ["blade_eval", { source: "x", timeoutMs: 1 }, /`timeoutMs` must be at least 1000/],
    ["blade_eval", { source: "x", plotWidth: 10 }, /`plotWidth` must be at least 64/],
    ["blade_corpus_find", { maxResults: "ten" }, /`maxResults` must be an integer/],
    ["blade_eval", {}, /missing required argument `source`/],
    ["blade_doctor", { verbose: true }, /unknown argument `verbose`/],
  ]) {
    const result = await server.dispatchTool(tool, args, ctx);
    assert.equal(result.isError, true, `${tool} ${JSON.stringify(args)}`);
    assert.match(result.structuredContent.error, new RegExp(`^${tool}: invalid arguments`));
    assert.match(result.structuredContent.error, expect);
    assert.ok(Array.isArray(result.structuredContent.invalidArguments) && result.structuredContent.invalidArguments.length > 0);
    assert.ok(Array.isArray(result.structuredContent.accepted));
  }
});

test("dispatchTool: an unknown tool lists the real ones", async () => {
  const result = await server.dispatchTool("blade_nope", {}, untouchableCtx());
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent.availableTools, server.TOOLS.map((t) => t.name));
});

test("dispatchTool: a UserError becomes a clean isError carrying its details; an unexpected throw is reported, not rethrown", async () => {
  const logs = [];
  const ctx = { config: { cwd: process.cwd() }, log: (l) => logs.push(l) };
  // blade_check with neither file nor source throws a UserError inside the handler.
  const user = await server.dispatchTool("blade_check", {}, ctx);
  assert.equal(user.isError, true);
  assert.match(user.structuredContent.error, /provide `file`/);
  assert.equal(logs.length, 0, "a user-facing error is not a server fault and is not logged as one");

  // a lone surrogate is refused before anything is sent to the compiler
  const surrogate = await server.dispatchTool("blade_check", { source: 'let s = "\uD83D"\n' }, ctx);
  assert.equal(surrogate.isError, true);
  assert.match(surrogate.structuredContent.error, /lone UTF-16 surrogate \(line 1\)/);

  // a context with no client at all: the handler blows up, the dispatcher contains it
  const broken = await server.dispatchTool("blade_check", { source: "let x = 1" }, ctx);
  assert.equal(broken.isError, true);
  assert.match(broken.structuredContent.error, /^blade_check/);
});

// --- the tool table --------------------------------------------------------------

test("publicTool: every tool exposes name, description, inputSchema and annotations — and never its handler", () => {
  for (const tool of server.TOOLS) {
    const pub = server.publicTool(tool);
    assert.deepEqual(Object.keys(pub).sort(), ["annotations", "description", "inputSchema", "name"]);
    assert.equal(typeof pub.annotations.title, "string");
    assert.equal(typeof pub.annotations.readOnlyHint, "boolean");
    assert.equal(pub.annotations.openWorldHint, false, "every tool works on local sources and a local compiler");
  }
});

test("annotations: only blade_eval and blade_reset_session change anything", () => {
  const byName = Object.fromEntries(server.TOOLS.map((t) => [t.name, t.annotations]));
  for (const name of ["blade_check", "blade_symbols", "blade_doctor", "blade_explain", "blade_corpus_find"]) {
    assert.equal(byName[name].readOnlyHint, true, name);
    assert.equal(byName[name].idempotentHint, true, name);
  }
  assert.equal(byName.blade_eval.readOnlyHint, false);
  assert.equal(byName.blade_eval.destructiveHint, true, "a program can write files through a provider");
  assert.equal(byName.blade_eval.idempotentHint, false);
  assert.equal(byName.blade_reset_session.readOnlyHint, false);
  assert.equal(byName.blade_reset_session.idempotentHint, true);
});

test("descriptions say what the tools actually do", () => {
  const d = Object.fromEntries(server.TOOLS.map((t) => [t.name, t.description]));
  // the eval display rule: not "bindings with values"
  assert.ok(!/bindings with values/.test(d.blade_eval));
  assert.match(d.blade_eval, /at most one entry/);
  assert.match(d.blade_eval, /END THE SOURCE WITH AN EXPRESSION/);
  // a check is not the whole pipeline
  assert.match(d.blade_check, /does NOT run code generation/);
  assert.match(schemas.bladeCheck.properties.tier.description, /Neither runs code generation/);
  assert.ok(!/complete pipeline/.test(schemas.bladeCheck.properties.tier.description));
  // the kinds blade_symbols really reports
  assert.match(schemas.bladeSymbols.properties.kind.description, /value, function, param, local, type/);
  assert.match(d.blade_symbols, /Not covered/);
  // nothing stale about target frameworks
  for (const text of Object.values(d)) assert.ok(!/net7\.0/.test(text));
});

test("INSTRUCTIONS: present, short, and naming every tool", () => {
  assert.equal(typeof server.INSTRUCTIONS, "string");
  assert.ok(server.INSTRUCTIONS.length > 200 && server.INSTRUCTIONS.length < 2500, `length ${server.INSTRUCTIONS.length}`);
  for (const name of ["blade_check", "blade_explain", "blade_corpus_find", "blade_eval", "blade_symbols", "blade_doctor"]) {
    assert.ok(server.INSTRUCTIONS.includes(name), `instructions should mention ${name}`);
  }
});

"use strict";

// knowledge.js: blade_explain merges the compiler's registry, the curated KB,
// and a live scan of the corpus. Tested against the REAL vendored
// @blade-lang/ide-protocol surface/KB (so BL3016's registry title is
// authentic) but the mini corpus (so example resolution is hermetic).

const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const knowledge = require("../../src/knowledge");
const corpus = require("../../src/corpus");
const pkg = require("@blade-lang/ide-protocol");

const MINI_ROOT = path.join(__dirname, "..", "fixtures", "corpus-mini");

function makeCtx(overrides) {
  const o = overrides || {};
  const diagRegistryCache = new Map();
  for (const entry of (pkg.surface && pkg.surface.diagnostics) || []) diagRegistryCache.set(entry.code, entry);
  return {
    diagRegistry: () => (o.diagRegistry !== undefined ? o.diagRegistry : diagRegistryCache),
    kb: () => (o.kb !== undefined ? o.kb : pkg.diagnosticsKb || null),
    corpusRoot: () => (o.corpusRoot !== undefined ? o.corpusRoot : MINI_ROOT),
    repoRoot: () => (o.repoRoot !== undefined ? o.repoRoot : null),
    surface: () => (o.surface !== undefined ? o.surface : pkg.surface || null),
    log: () => {},
  };
}

test.beforeEach(() => corpus.resetCache());

test("bladeExplain: a known code returns registry title/phase plus KB explanation/fix", async () => {
  const ctx = makeCtx();
  const result = await knowledge.bladeExplain({ code: "BL3016" }, ctx);
  const s = result.structuredContent;
  assert.equal(s.known, true);
  assert.equal(s.code, "BL3016");
  assert.equal(s.title, "argument extent mismatch");
  assert.equal(s.phase, "types");
  assert.ok(typeof s.explanation === "string" && s.explanation.length > 0);
});

test("bladeExplain: examples are drawn from the mini corpus via BLADE_CORPUS_DIR-equivalent ctx.corpusRoot()", async () => {
  const ctx = makeCtx();
  const result = await knowledge.bladeExplain({ code: "BL3016" }, ctx);
  const s = result.structuredContent;
  assert.ok(s.corpusMatches >= 1);
  assert.ok(s.examples.length >= 1);
  const hit = s.examples.find((e) => e.path && e.path.endsWith("069_extent_mismatch_direct_rejects.blade"));
  assert.ok(hit, "the mini corpus's BL3016-pinning file should surface as an example");
  assert.equal(hit.origin, "corpus-pin");
});

test("bladeExplain: includeSource:true inlines the example's text (truncated marker when huge)", async () => {
  const ctx = makeCtx();
  const result = await knowledge.bladeExplain({ code: "BL3016", includeSource: true }, ctx);
  const hit = result.structuredContent.examples.find((e) => e.path.endsWith("069_extent_mismatch_direct_rejects.blade"));
  assert.match(hit.source, /ERROR: BL3016/);
});

test("bladeExplain: includeSource:false omits source text", async () => {
  const ctx = makeCtx();
  const result = await knowledge.bladeExplain({ code: "BL3016", includeSource: false }, ctx);
  const hit = result.structuredContent.examples.find((e) => e.path.endsWith("069_extent_mismatch_direct_rejects.blade"));
  assert.equal(hit.source, undefined);
});

test("bladeExplain: maxExamples caps the returned example count", async () => {
  const ctx = makeCtx();
  const result = await knowledge.bladeExplain({ code: "BL3016", maxExamples: 0 }, ctx);
  assert.equal(result.structuredContent.examples.length, 0);
});

test("bladeExplain: an unknown/unregistered code degrades gracefully instead of erroring", async () => {
  const ctx = makeCtx();
  const result = await knowledge.bladeExplain({ code: "BL0000" }, ctx);
  const s = result.structuredContent;
  assert.equal(s.ok, true);
  assert.equal(s.known, false);
  assert.equal(s.title, undefined);
  assert.match(s.registryNote, /not registered in this surface|no diagnostics registry/);
});

test("bladeExplain: a registered code with no corpus pin in the mini corpus returns zero examples, not an error", async () => {
  const ctx = makeCtx();
  // BL0001 is a real registry code (lex phase) that the mini corpus never pins.
  const result = await knowledge.bladeExplain({ code: "BL0001" }, ctx);
  const s = result.structuredContent;
  assert.equal(s.examples.length, 0);
});

test("bladeExplain: bad code shape is a UserError, not a silent pass-through", async () => {
  const ctx = makeCtx();
  await assert.rejects(() => knowledge.bladeExplain({ code: "not-a-code" }, ctx), /not a diagnostic code/);
});

test("bladeExplain: accepts a bare 4-digit code (no BL prefix)", async () => {
  const ctx = makeCtx();
  const result = await knowledge.bladeExplain({ code: "3016" }, ctx);
  assert.equal(result.structuredContent.code, "BL3016");
});

test("bladeExplain: no corpus root -> corpusNote instead of a crash", async () => {
  const ctx = makeCtx({ corpusRoot: null });
  const result = await knowledge.bladeExplain({ code: "BL3016" }, ctx);
  const s = result.structuredContent;
  assert.match(s.corpusNote, /no test corpus found/);
  assert.equal(s.examples.length, 0);
});

test("docUriFor: maps docs/*.md to blade-docs://, and the two special cases", () => {
  assert.equal(knowledge.docUriFor("docs/formalism.md"), "blade-docs://formalism");
  assert.equal(knowledge.docUriFor("README.md"), "blade-docs://readme");
  assert.equal(knowledge.docUriFor("llms.txt"), "blade-docs://llms");
  assert.equal(knowledge.docUriFor("not-a-doc.txt"), undefined);
});

test("resolveDocs: without a repo root, docs are reported unavailable with a remedy", () => {
  const ctx = makeCtx({ repoRoot: null });
  const docs = knowledge.resolveDocs(ctx, ["docs/formalism.md"]);
  assert.equal(docs[0].available, false);
  assert.match(docs[0].reason, /BLADE_REPO/);
});

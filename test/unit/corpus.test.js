"use strict";

// corpus.js: category listing, intent scoring, code mode, content search —
// against test/fixtures/corpus-mini (3 real .blade files with real pin
// comments), so this runs hermetically without a Blade checkout.

const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const corpus = require("../../src/corpus");

const MINI_ROOT = path.join(__dirname, "..", "fixtures", "corpus-mini");

function makeCtx(overrides) {
  const o = overrides || {};
  return {
    corpusRoot: () => (o.corpusRoot !== undefined ? o.corpusRoot : MINI_ROOT),
    repoRoot: () => (o.repoRoot !== undefined ? o.repoRoot : null),
    log: () => {},
  };
}

test.beforeEach(() => corpus.resetCache());

test("categoryListing: three categories, live counts from disk, curated notes attached", () => {
  const ctx = makeCtx();
  const cats = corpus.categoryListing(ctx);
  const byName = new Map(cats.map((c) => [c.category, c]));
  assert.equal(byName.get("basic").count, 1);
  assert.equal(byName.get("diagnostics").count, 1);
  assert.equal(byName.get("recursive-arrays").count, 1);
  assert.equal(byName.get("basic").note, corpus.CATEGORY_NOTES.basic);
});

test("bladeCorpusFind: no args lists categories with counts and a hint", async () => {
  const ctx = makeCtx();
  const result = await corpus.bladeCorpusFind({}, ctx);
  const s = result.structuredContent;
  assert.equal(s.mode, "categories");
  assert.equal(s.totalFiles, 3);
  assert.equal(s.categoryCount, 3);
  assert.match(s.hint, /intent/);
});

test("bladeCorpusFind: code mode finds the file pinning BL3016", async () => {
  const ctx = makeCtx();
  const result = await corpus.bladeCorpusFind({ code: "BL3016" }, ctx);
  const s = result.structuredContent;
  assert.equal(s.mode, "code");
  assert.equal(s.code, "BL3016");
  assert.equal(s.resultCount, 1);
  assert.equal(s.results[0].category, "diagnostics");
  assert.deepEqual(s.results[0].codes, ["BL3016"]);
});

test("bladeCorpusFind: code mode accepts a bare 4-digit code", async () => {
  const ctx = makeCtx();
  const result = await corpus.bladeCorpusFind({ code: "3016" }, ctx);
  assert.equal(result.structuredContent.code, "BL3016");
  assert.equal(result.structuredContent.resultCount, 1);
});

test("bladeCorpusFind: code mode with no pinning file returns a note, not an error", async () => {
  const ctx = makeCtx();
  const result = await corpus.bladeCorpusFind({ code: "BL9999" }, ctx);
  const s = result.structuredContent;
  assert.equal(s.resultCount, 0);
  assert.match(s.note, /no corpus file pins BL9999/);
});

test("bladeCorpusFind: category mode lists files in that category only", async () => {
  const ctx = makeCtx();
  const result = await corpus.bladeCorpusFind({ category: "basic" }, ctx);
  const s = result.structuredContent;
  assert.equal(s.mode, "category");
  assert.equal(s.total, 1);
  assert.equal(s.results[0].testName, "Add One");
});

test("bladeCorpusFind: unknown category reports ok:false with the known category list", async () => {
  const ctx = makeCtx();
  const result = await corpus.bladeCorpusFind({ category: "not-a-real-category" }, ctx);
  const s = result.structuredContent;
  assert.equal(s.ok, false);
  assert.ok(s.categories.includes("basic"));
});

test("bladeCorpusFind: intent mode scores the curated idiom index and locates the corpus hit", async () => {
  const ctx = makeCtx();
  const result = await corpus.bladeCorpusFind({ intent: "running state / recurrence" }, ctx);
  const s = result.structuredContent;
  assert.equal(s.mode, "intent");
  assert.ok(s.resultCount > 0);
  const top = s.results[0];
  assert.match(top.intent, /running state|recurrence/);
  // idioms.json's real corpus path 002_running_reduce.blade exists in the mini corpus too.
  const located = top.corpus.find((c) => c.path && c.path.endsWith("002_running_reduce.blade"));
  assert.ok(located, "the curated idiom path should resolve against the mini corpus");
  assert.equal(located.missing, undefined);
});

test("bladeCorpusFind: intent mode falls through to content search when nothing scores", async () => {
  const ctx = makeCtx();
  const result = await corpus.bladeCorpusFind({ intent: "xyzzy-no-such-idiom-keyword-at-all" }, ctx);
  const s = result.structuredContent;
  assert.equal(s.mode, "intent-fallback");
  assert.match(s.note, /fell through to a content search/);
});

test("bladeCorpusFind: query mode is a case-insensitive content grep with snippets", async () => {
  const ctx = makeCtx();
  const result = await corpus.bladeCorpusFind({ query: "recurrence", includeSnippets: true }, ctx);
  const s = result.structuredContent;
  assert.equal(s.mode, "query");
  assert.ok(s.resultCount >= 1);
  const hit = s.results.find((r) => r.path.endsWith("002_running_reduce.blade"));
  assert.ok(hit);
  assert.ok(hit.snippet && hit.snippet.length > 0);
});

test("bladeCorpusFind: no corpus root -> isError with remediation, not a throw", async () => {
  const ctx = makeCtx({ corpusRoot: null });
  const result = await corpus.bladeCorpusFind({}, ctx);
  assert.equal(result.isError, true);
  assert.match(result.structuredContent.error, /no test corpus found/);
});

test("normalizeCode: accepts BLxxxx and bare xxxx, rejects garbage and lowercase", () => {
  assert.equal(corpus.normalizeCode("BL3016"), "BL3016");
  assert.equal(corpus.normalizeCode("3016"), "BL3016");
  assert.equal(corpus.normalizeCode("  BL3016  "), "BL3016");
  assert.equal(corpus.normalizeCode("bl3016"), null); // case-sensitive, matches schemas.js's pattern
  assert.equal(corpus.normalizeCode("not-a-code"), null);
  assert.equal(corpus.normalizeCode(""), null);
});

"use strict";

// corpus.js: pin parsing, category discovery, code mode, intent scoring,
// content search — against test/fixtures/corpus-mini, so this runs
// hermetically without a Blade checkout.
//
// The mini corpus is NOT synthetic: every file except basic/001_add_one is a
// byte-for-byte (LF-normalized) copy of the same path under the real
// tests/corpus, chosen so each pin kind and each classification rule appears
// exactly as the real corpus spells it:
//
//   basic/067_int_div_by_zero_aborts          `// ABORT: error[BL8013]...`, an (aborts) probe
//   casts/009_int_gate_rejects                `// ERROR:` + `// ERROR-CONTAINS:`, a (rejects) probe
//   casts/014_implicit_warning                `// WARN: BL3020` on a VALUE test
//   diagnostics/045_for_in_removed            `// ERROR: BL1003 @ 13:5` (a span) in a reject-only category
//   diagnostics/069_extent_arg_direct         `// ERROR: BL3016` after a long rationale comment
//   interfaces/001_interface_declaration      `// NOPINS: <reason>`
//   loops/190_pipeline_three_stage_decline... `// REJECT-AT:`, `// WARN-CODEGEN:`, and PROSE that mentions `// ERROR: BL7004`
//   multifile/017_qualified_call_extent/      two `// MODULE:` files; the pin lives in the second
//   recursive-arrays/013_while_guard_budget.. `// ABORT: error[BL8010]`
//   ad-jvp-comb/101_reverse_map_...           `// WARN: BL4003` at line 93, PAST the first 4 KB of the file

const fs = require("fs");
const os = require("os");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const corpus = require("../../src/corpus");
const idioms = require("../../src/idioms.json");

const MINI_ROOT = path.join(__dirname, "..", "fixtures", "corpus-mini");

function makeCtx(overrides) {
  const o = overrides || {};
  const ctx = {
    corpusRoot: () => (o.corpusRoot !== undefined ? o.corpusRoot : MINI_ROOT),
    repoRoot: () => (o.repoRoot !== undefined ? o.repoRoot : null),
    log: () => {},
  };
  if (o.env) ctx.config = { env: o.env };
  return ctx;
}

function fileOf(ctx, rel) {
  return corpus.corpusIndex(ctx).files.find((f) => f.rel === rel);
}

test.beforeEach(() => corpus.resetCache());

// --- discovery -----------------------------------------------------------------

test("categoryListing: categories and counts come from disk, sorted, with curated notes attached", () => {
  const cats = corpus.categoryListing(makeCtx());
  assert.deepEqual(
    cats.map((c) => [c.category, c.count]),
    [
      ["ad-jvp-comb", 1],
      ["basic", 2],
      ["casts", 2],
      ["diagnostics", 2],
      ["interfaces", 1],
      ["loops", 1],
      ["multifile", 2],
      ["recursive-arrays", 2],
    ]
  );
  const byName = new Map(cats.map((c) => [c.category, c]));
  assert.equal(byName.get("basic").note, corpus.CATEGORY_NOTES.basic);
  assert.equal(byName.get("casts").note, corpus.CATEGORY_NOTES.casts);
});

test("categoryListing: a multi-file category reports TESTS as well as files; reject-only categories are flagged", () => {
  const byName = new Map(corpus.categoryListing(makeCtx()).map((c) => [c.category, c]));
  const multi = byName.get("multifile");
  assert.equal(multi.multiFile, true);
  assert.equal(multi.count, 2); // two module files...
  assert.equal(multi.tests, 1); // ...that are ONE test
  assert.equal(byName.get("diagnostics").rejectOnly, true);
  assert.equal(byName.get("basic").rejectOnly, undefined);
  assert.equal(byName.get("basic").multiFile, undefined);
});

test("REJECT_ONLY_CATEGORIES mirrors Corpus.rejectOnlyCategories, and every one has a note", () => {
  assert.deepEqual(Array.from(corpus.REJECT_ONLY_CATEGORIES).sort(), ["diagnostics", "display-errors", "mutability-errors", "unit-errors"]);
  for (const c of corpus.REJECT_ONLY_CATEGORIES) assert.match(corpus.CATEGORY_NOTES[c], /reject-only/);
});

test("the index is deterministic: files in ordinal path order, identical across cold builds", () => {
  const ctx = makeCtx();
  const first = corpus.corpusIndex(ctx).files.map((f) => f.rel);
  const sorted = first.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.deepEqual(first, sorted);
  corpus.resetCache();
  assert.deepEqual(
    corpus.corpusIndex(ctx).files.map((f) => f.rel),
    first
  );
});

test("the index is rebuilt after resetCache, so a file added to the corpus is seen", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blade-mcp-corpus-"));
  try {
    fs.mkdirSync(path.join(tmp, "basic"));
    fs.writeFileSync(path.join(tmp, "basic", "001_a.blade"), "// TEST: A\n// EXPECT: x = 1\nlet x = 1\n");
    const ctx = makeCtx({ corpusRoot: tmp });
    assert.equal(corpus.corpusIndex(ctx).files.length, 1);
    fs.mkdirSync(path.join(tmp, "casts"));
    fs.writeFileSync(path.join(tmp, "casts", "001_b.blade"), "// TEST: B (rejects)\n// ERROR: BL3019\nlet b = Int64(2.5)\n");
    corpus.resetCache();
    assert.deepEqual(
      corpus.categoryListing(ctx).map((c) => c.category),
      ["basic", "casts"]
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- which corpus --------------------------------------------------------------

test("corpusLocation: BLADE_CORPUS_DIR > a checkout's live tests/corpus > the deployed copy", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blade-mcp-roots-"));
  try {
    const repo = path.join(tmp, "repo");
    const live = path.join(repo, "tests", "corpus");
    const deployed = path.join(tmp, "bin", "tests", "corpus");
    const override = path.join(tmp, "override");
    for (const d of [live, deployed, override]) fs.mkdirSync(d, { recursive: true });

    // A stale deployed copy must not shadow the checkout's live tree.
    assert.deepEqual(corpus.corpusLocation(makeCtx({ corpusRoot: deployed, repoRoot: repo })), { root: live, origin: "checkout" });
    // No checkout: the deployed copy is what there is.
    assert.deepEqual(corpus.corpusLocation(makeCtx({ corpusRoot: deployed })), { root: deployed, origin: "deployed" });
    // A checkout without a corpus directory falls through to the deployed copy.
    assert.deepEqual(corpus.corpusLocation(makeCtx({ corpusRoot: deployed, repoRoot: tmp })), { root: deployed, origin: "deployed" });
    // The explicit override beats both.
    assert.deepEqual(
      corpus.corpusLocation(makeCtx({ corpusRoot: deployed, repoRoot: repo, env: { BLADE_CORPUS_DIR: override } })),
      { root: override, origin: "env" }
    );
    // An override that is not a directory is ignored rather than trusted.
    assert.deepEqual(
      corpus.corpusLocation(makeCtx({ corpusRoot: deployed, repoRoot: repo, env: { BLADE_CORPUS_DIR: path.join(tmp, "nope") } })),
      { root: live, origin: "checkout" }
    );
    assert.deepEqual(corpus.corpusLocation(makeCtx({ corpusRoot: null })), { root: null, origin: null });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- pin parsing ---------------------------------------------------------------

test("parsePins: every pin form of tests/corpus/README.md", () => {
  const p = corpus.parsePins(
    [
      "// TEST: Everything (rejects)",
      "// MODULE: Main",
      "// ERROR: BL3016",
      "// ERROR: BL2001 @ 4:12",
      "// ERROR: BL3006 @ 4:12-4:20",
      "// ERROR-CONTAINS: spell the rounding at the cast site",
      "// WARN: BL4010  (storage suggestion)",
      "// WARN-CODEGEN: staged emission supports two stages",
      "// ABORT: error[BL8013]: integer division by zero",
      "// ABORT: Constraint violation in Balanced",
      "// REJECT-AT: codegen",
      "// NOPINS: declaration-only",
      "let x = 1",
      "// EXPECT: x = 1",
      "// EXPECT: prose with no equals sign",
    ].join("\n")
  );
  assert.equal(p.testName, "Everything (rejects)");
  assert.equal(p.module, "Main");
  assert.deepEqual(p.pins, [
    { pin: "ERROR", code: "BL3016", line: 3 },
    { pin: "ERROR", code: "BL2001", line: 4, at: "4:12" },
    { pin: "ERROR", code: "BL3006", line: 5, at: "4:12-4:20" },
    { pin: "WARN", code: "BL4010", line: 7 }, // prose after the code is ignored
    { pin: "ABORT", code: "BL8013", line: 9 }, // an abort message that names a code
  ]);
  assert.deepEqual(p.messages, ["spell the rounding at the cast site"]);
  assert.equal(p.rejectAt, "codegen");
  assert.equal(p.nopins, true);
  assert.equal(p.expects, 1); // only the `=`-bearing EXPECT is a value pin
});

test("parsePins: a pin is a line that STARTS with the directive — prose mentioning one is not a pin", () => {
  const p = corpus.parsePins(
    [
      "// TEST: Prose",
      "// (No `// ERROR: BL7004` pin: the harness emits and compiles directly.)",
      "let x = 1 // ERROR: BL3001",
      "//ERROR: BL3002",
      "    // WARN: BL4003",
    ].join("\n")
  );
  // Only the indented, line-leading WARN is a pin (the harness trims the line).
  assert.deepEqual(p.pins, [{ pin: "WARN", code: "BL4003", line: 5 }]);
});

test("parsePins: CRLF line endings and a leading BOM (how the checkout stores many corpus files)", () => {
  const p = corpus.parsePins("\uFEFF// TEST: Windows File (rejects)\r\n// ERROR: BL3019 @ 7:17\r\nlet bad = Int64(2.9)\r\n");
  assert.equal(p.testName, "Windows File (rejects)");
  assert.deepEqual(p.pins, [{ pin: "ERROR", code: "BL3019", line: 2, at: "7:17" }]);
});

test("parsePins: a malformed code is not indexed, and a malformed span keeps the code without a span", () => {
  const p = corpus.parsePins(["// TEST: T", "// ERROR: BL30", "// ERROR: BL3006 @ 4;12", "// WARN:", "// WARN: storage"].join("\n"));
  assert.deepEqual(p.pins, [{ pin: "ERROR", code: "BL3006", line: 3 }]);
});

test("kindOf: (rejects)/(aborts) name suffixes, and reject-only categories with unmarked names", () => {
  assert.equal(corpus.kindOf("Extent Mismatch (rejects)", "functions"), "rejects");
  assert.equal(corpus.kindOf("Int Div By Zero Aborts (aborts)", "basic"), "aborts");
  assert.equal(corpus.kindOf("Diag Extent Arg Direct (diag)", "diagnostics"), "rejects");
  assert.equal(corpus.kindOf("Unit Mismatch Add", "unit-errors"), "rejects");
  assert.equal(corpus.kindOf("Add One", "basic"), "value");
  assert.equal(corpus.kindOf("a (rejects) test that passes", "basic"), "value"); // suffix, not substring
  assert.equal(corpus.kindOf(null, "basic"), "value");
});

test("index: the real files classify as the harness classifies them", () => {
  const ctx = makeCtx();
  assert.equal(fileOf(ctx, "basic/001_add_one.blade").kind, "value");
  assert.equal(fileOf(ctx, "casts/014_implicit_warning.blade").kind, "value"); // a WARN pin does not make a probe
  assert.equal(fileOf(ctx, "casts/009_int_gate_rejects.blade").kind, "rejects");
  assert.equal(fileOf(ctx, "diagnostics/069_extent_arg_direct.blade").kind, "rejects"); // "(diag)", reject-only dir
  assert.equal(fileOf(ctx, "basic/067_int_div_by_zero_aborts.blade").kind, "aborts");
  assert.equal(fileOf(ctx, "interfaces/001_interface_declaration.blade").nopins, true);
  assert.equal(fileOf(ctx, "loops/190_pipeline_three_stage_decline_rejects.blade").rejectAt, "codegen");
});

test("index: multi-file tests carry their module and test directory", () => {
  const ctx = makeCtx();
  const main = fileOf(ctx, "multifile/017_qualified_call_extent/02_Main.blade");
  assert.equal(main.category, "multifile");
  assert.equal(main.module, "Main");
  assert.equal(main.test, "multifile/017_qualified_call_extent");
  assert.equal(main.kind, "rejects");
  assert.deepEqual(main.codes, ["BL3016"]);
  const phys = fileOf(ctx, "multifile/017_qualified_call_extent/01_Phys.blade");
  assert.equal(phys.module, "Phys");
  assert.deepEqual(phys.codes, []); // the pin lives in the other member
  const described = corpus.describe(main);
  assert.equal(described.module, "Main");
  assert.equal(described.test, "multifile/017_qualified_call_extent");
});

// --- the tool: categories ------------------------------------------------------

test("bladeCorpusFind: no args lists categories with counts, the corpus origin, and a hint", async () => {
  const result = await corpus.bladeCorpusFind({}, makeCtx());
  const s = result.structuredContent;
  assert.equal(s.mode, "categories");
  assert.equal(s.totalFiles, 13);
  assert.equal(s.categoryCount, 8);
  assert.equal(s.corpusOrigin, "deployed");
  assert.match(s.corpusOriginNote, /as old as that build/);
  assert.match(s.hint, /intent/);
});

// --- the tool: code mode -------------------------------------------------------

test("bladeCorpusFind: code mode finds the files pinning BL3016, the dedicated diagnostics probe first", async () => {
  const result = await corpus.bladeCorpusFind({ code: "BL3016" }, makeCtx());
  const s = result.structuredContent;
  assert.equal(s.mode, "code");
  assert.equal(s.code, "BL3016");
  assert.equal(s.total, 2);
  assert.equal(s.resultCount, 2);
  assert.deepEqual(
    s.results.map((r) => r.path),
    ["tests/corpus/diagnostics/069_extent_arg_direct.blade", "tests/corpus/multifile/017_qualified_call_extent/02_Main.blade"]
  );
  assert.equal(s.results[0].category, "diagnostics");
  assert.equal(s.results[0].kind, "rejects");
  assert.deepEqual(s.results[0].codes, ["BL3016"]);
  assert.deepEqual(s.results[0].pinned, [{ pin: "ERROR", line: 9 }]);
});

test("bladeCorpusFind: code mode is bounded by maxResults but still reports the total", async () => {
  const result = await corpus.bladeCorpusFind({ code: "BL3016", maxResults: 1 }, makeCtx());
  const s = result.structuredContent;
  assert.equal(s.total, 2);
  assert.equal(s.resultCount, 1);
  assert.equal(s.results.length, 1);
});

test("bladeCorpusFind: code mode finds a `// WARN:` pin, on a value test", async () => {
  const s = (await corpus.bladeCorpusFind({ code: "BL3020" }, makeCtx())).structuredContent;
  assert.equal(s.resultCount, 1);
  assert.equal(s.results[0].path, "tests/corpus/casts/014_implicit_warning.blade");
  assert.equal(s.results[0].kind, undefined); // a value test: no probe marker
  assert.deepEqual(s.results[0].pinned, [{ pin: "WARN", line: 14 }]);
});

test("bladeCorpusFind: code mode finds a pin past the first 4 KB of a file (whole files are scanned)", async () => {
  const late = path.join(MINI_ROOT, "ad-jvp-comb", "101_reverse_map_moment_former_shape.blade");
  const text = fs.readFileSync(late, "utf8");
  assert.ok(text.indexOf("// WARN: BL4003") > 4096, "fixture precondition: the pin sits beyond a 4 KB head window");
  const s = (await corpus.bladeCorpusFind({ code: "BL4003" }, makeCtx())).structuredContent;
  assert.equal(s.resultCount, 1);
  assert.equal(s.results[0].pinned[0].pin, "WARN");
});

test("bladeCorpusFind: code mode finds runtime codes through `// ABORT:` pins", async () => {
  const ctx = makeCtx();
  const div = (await corpus.bladeCorpusFind({ code: "BL8013" }, ctx)).structuredContent;
  assert.equal(div.results[0].path, "tests/corpus/basic/067_int_div_by_zero_aborts.blade");
  assert.equal(div.results[0].kind, "aborts");
  assert.equal(div.results[0].pinned[0].pin, "ABORT");
  const budget = (await corpus.bladeCorpusFind({ code: "8010" }, ctx)).structuredContent;
  assert.equal(budget.results[0].path, "tests/corpus/recursive-arrays/013_while_guard_budget_aborts.blade");
});

test("bladeCorpusFind: code mode reports an `@ l:c` span and the file's ERROR-CONTAINS substrings", async () => {
  const s = (await corpus.bladeCorpusFind({ code: "BL1003" }, makeCtx())).structuredContent;
  assert.equal(s.resultCount, 1);
  // The pin says 13:5; the harness compiles the file WITHOUT its `// TEST:`
  // line, so in the file as an agent reads it the offending `for` is on line 14.
  assert.deepEqual(s.results[0].pinned, [{ pin: "ERROR", line: 2, at: "13:5", atInFile: "14:5" }]);
  const lines = fs.readFileSync(path.join(MINI_ROOT, "diagnostics", "045_for_in_removed.blade"), "utf8").split("\n");
  assert.match(lines[14 - 1], /^ {4}for k in 0\.\.3 \{/);
  assert.match(s.spanNote, /WITHOUT its `\/\/ TEST:` line/);
  assert.match(s.results[0].messages[0], /statement has been removed/);
});

test("describeForCode: a span in a multi-file member shifts past both the TEST and the MODULE line", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blade-mcp-span-"));
  try {
    const dir = path.join(tmp, "multifile", "001_two_modules");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "01_Main.blade"), "// TEST: Two Modules (rejects)\n// MODULE: Main\n// ERROR: BL3016 @ 3:9-3:20\nmodule Main\nlet x = f(a)\n");
    const ctx = makeCtx({ corpusRoot: tmp });
    const described = corpus.describeForCode(fileOf(ctx, "multifile/001_two_modules/01_Main.blade"), "BL3016");
    assert.deepEqual(described.pinned, [{ pin: "ERROR", line: 3, at: "3:9-3:20", atInFile: "5:9-5:20" }]);
    assert.ok(corpus.spanNoteFor([described]));
    assert.equal(corpus.spanNoteFor([{ pinned: [{ pin: "WARN", line: 4 }] }]), undefined); // nothing to caveat
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("bladeCorpusFind: prose that mentions `// ERROR: BL7004` is not a pin", async () => {
  const s = (await corpus.bladeCorpusFind({ code: "BL7004" }, makeCtx())).structuredContent;
  assert.equal(s.resultCount, 0);
  assert.match(s.note, /no corpus file pins BL7004/);
});

test("bladeCorpusFind: code mode accepts a bare 4-digit code", async () => {
  const result = await corpus.bladeCorpusFind({ code: "3016" }, makeCtx());
  assert.equal(result.structuredContent.code, "BL3016");
  assert.equal(result.structuredContent.resultCount, 2);
});

test("bladeCorpusFind: code mode with no pinning file returns a note, not an error", async () => {
  const s = (await corpus.bladeCorpusFind({ code: "BL9999" }, makeCtx())).structuredContent;
  assert.equal(s.resultCount, 0);
  assert.match(s.note, /no corpus file pins BL9999/);
});

test("bladeCorpusFind: includeSnippets in code mode quotes the pin line", async () => {
  const s = (await corpus.bladeCorpusFind({ code: "BL3019", includeSnippets: true }, makeCtx())).structuredContent;
  assert.deepEqual(s.results[0].snippet, [{ line: 4, text: "// ERROR: BL3019" }]);
});

// --- the tool: category mode ---------------------------------------------------

test("bladeCorpusFind: category mode lists files in that category only, in file order", async () => {
  const s = (await corpus.bladeCorpusFind({ category: "basic" }, makeCtx())).structuredContent;
  assert.equal(s.mode, "category");
  assert.equal(s.total, 2);
  assert.deepEqual(
    s.results.map((r) => r.testName),
    ["Add One", "Int Div By Zero Aborts (aborts)"]
  );
  assert.equal(s.rejectOnly, undefined);
});

test("bladeCorpusFind: a reject-only category says its unmarked files are reject probes", async () => {
  const s = (await corpus.bladeCorpusFind({ category: "diagnostics" }, makeCtx())).structuredContent;
  assert.equal(s.rejectOnly, true);
  assert.match(s.kindNote, /reject probe/);
  assert.ok(s.results.every((r) => r.kind === "rejects"));
});

test("bladeCorpusFind: unknown category reports ok:false with the known category list", async () => {
  const s = (await corpus.bladeCorpusFind({ category: "not-a-real-category" }, makeCtx())).structuredContent;
  assert.equal(s.ok, false);
  assert.ok(s.categories.includes("basic"));
});

// --- the tool: intent and query ------------------------------------------------

test("bladeCorpusFind: intent mode scores the curated idiom index and locates the corpus hit", async () => {
  const s = (await corpus.bladeCorpusFind({ intent: "running state / recurrence" }, makeCtx())).structuredContent;
  assert.equal(s.mode, "intent");
  assert.ok(s.resultCount > 0);
  const top = s.results[0];
  assert.match(top.intent, /running state/);
  // idioms.json's real corpus path 002_running_reduce.blade exists in the mini corpus too.
  const located = top.corpus.find((c) => c.path && c.path.endsWith("002_running_reduce.blade"));
  assert.ok(located, "the curated idiom path should resolve against the mini corpus");
  assert.equal(located.missing, undefined);
  // ...and a curated path the mini corpus lacks is reported missing rather than dropped.
  assert.ok(top.corpus.some((c) => c.missing === true));
});

test("bladeCorpusFind: intent mode falls through to content search when nothing scores", async () => {
  const s = (await corpus.bladeCorpusFind({ intent: "xyzzy plugh frobnicate" }, makeCtx())).structuredContent;
  assert.equal(s.mode, "intent-fallback");
  assert.match(s.note, /fell through to a content search/);
});

test("bladeCorpusFind: query mode is a case-insensitive content grep with snippets", async () => {
  const s = (await corpus.bladeCorpusFind({ query: "RECURRENCE", includeSnippets: true }, makeCtx())).structuredContent;
  assert.equal(s.mode, "query");
  assert.ok(s.resultCount >= 1);
  const hit = s.results.find((r) => r.path.endsWith("002_running_reduce.blade"));
  assert.ok(hit);
  assert.ok(hit.snippet && hit.snippet.length > 0);
});

test("contentSearch: results are bounded, and ordered by score then path", () => {
  const ctx = makeCtx();
  const all = corpus.contentSearch(ctx, "TEST:", 50, false);
  assert.equal(all.length, 13);
  const capped = corpus.contentSearch(ctx, "TEST:", 3, false);
  assert.deepEqual(
    capped.map((r) => r.path),
    all.slice(0, 3).map((r) => r.path)
  );
  assert.deepEqual(corpus.contentSearch(ctx, "   ", 5, false), []);
});

test("bladeCorpusFind: a whitespace-only query or intent returns at once instead of hanging the server", async () => {
  // Regression: a trimmed-empty needle made the match loop spin forever on the
  // event loop (indexOf("", i) === i), and every later request timed out.
  const ctx = makeCtx();
  for (const args of [{ query: " " }, { query: "\t\n" }, { intent: "   " }, { intent: " ", query: "  " }, { query: "", intent: " " }]) {
    const s = (await corpus.bladeCorpusFind(args, ctx)).structuredContent;
    assert.equal(s.ok, true, JSON.stringify(args));
    assert.equal(s.resultCount, 0, JSON.stringify(args));
    assert.deepEqual(s.results, [], JSON.stringify(args));
    assert.match(s.note, /search text is empty/, JSON.stringify(args));
  }
  // The scan itself terminates on an empty needle too, whoever calls it.
  assert.deepEqual(corpus.contentSearch(ctx, "", 5, true), []);
  // A blank intent beside a real query defers to the query.
  const q = (await corpus.bladeCorpusFind({ intent: " ", query: "recurrence" }, ctx)).structuredContent;
  assert.equal(q.mode, "query");
  assert.ok(q.resultCount >= 1);
});

test("bladeCorpusFind: a phrase that only brushes one keyword falls through honestly instead of claiming an idiom", async () => {
  // "squares" is one word of one multi-word keyword ("sum and sum of squares"):
  // not evidence that the caller wants that idiom.
  const best = Math.max(...idioms.map((e) => corpus.scoreIdiom(e, "squares")));
  assert.ok(best > 0 && best < corpus.MIN_INTENT_SCORE, `precondition: a weak, non-zero score (got ${best})`);
  const s = (await corpus.bladeCorpusFind({ intent: "squares" }, makeCtx())).structuredContent;
  assert.equal(s.mode, "intent-fallback");
  assert.match(s.note, /fell through to a content search/);
});

test("bladeCorpusFind: the worked examples answer to the pseudo-category 'examples'", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blade-mcp-examples-"));
  try {
    fs.mkdirSync(path.join(tmp, "examples", "physics"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "examples", "01_weather_stations.blade"), "// TEST: Weather Stations\n// EXPECT: n = 3\nlet n = 3\n");
    fs.writeFileSync(path.join(tmp, "examples", "lsdft.blade"), "// TEST: LSDFT\n// EXPECT: n = 1\nlet n = 1\n");
    fs.writeFileSync(path.join(tmp, "examples", "physics", "01_projectile_range.blade"), "// TEST: Projectile Range\n// EXPECT: r = 2\nlet r = 2\n");
    const ctx = makeCtx({ repoRoot: tmp }); // no tests/corpus in this "checkout": the mini corpus stays the corpus
    const all = (await corpus.bladeCorpusFind({ category: "examples" }, ctx)).structuredContent;
    assert.equal(all.ok, true);
    assert.equal(all.category, "examples");
    assert.equal(all.total, 3);
    assert.deepEqual(
      all.results.map((r) => r.path),
      // the top-level tour first, then the sub-corpora
      ["examples/01_weather_stations.blade", "examples/lsdft.blade", "examples/physics/01_projectile_range.blade"]
    );
    const physics = (await corpus.bladeCorpusFind({ category: "examples/physics" }, ctx)).structuredContent;
    assert.deepEqual(
      physics.results.map((r) => r.path),
      ["examples/physics/01_projectile_range.blade"]
    );
    const listing = (await corpus.bladeCorpusFind({}, ctx)).structuredContent;
    assert.equal(listing.examplesAvailable, true);
    assert.equal(listing.examples.count, 3);
    assert.equal(listing.categoryCount, 8); // examples are not counted as a corpus category
    const none = (await corpus.bladeCorpusFind({ category: "examples/nope" }, ctx)).structuredContent;
    assert.equal(none.ok, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // Without a checkout there are no examples, and the answer says how to get them.
  const bare = (await corpus.bladeCorpusFind({ category: "examples" }, makeCtx())).structuredContent;
  assert.equal(bare.ok, false);
  assert.match(bare.error, /BLADE_REPO/);
  assert.equal((await corpus.bladeCorpusFind({}, makeCtx())).structuredContent.examples, undefined);
});

test("bladeCorpusFind: no corpus root -> isError with remediation, not a throw", async () => {
  const result = await corpus.bladeCorpusFind({}, makeCtx({ corpusRoot: null }));
  assert.equal(result.isError, true);
  assert.match(result.structuredContent.error, /no test corpus found/);
});

test("normalizeCode: accepts BLxxxx in either case and bare xxxx, rejects garbage", () => {
  assert.equal(corpus.normalizeCode("BL3016"), "BL3016");
  assert.equal(corpus.normalizeCode("3016"), "BL3016");
  assert.equal(corpus.normalizeCode("  BL3016  "), "BL3016");
  assert.equal(corpus.normalizeCode("bl3016"), "BL3016"); // people type it lower-case
  assert.equal(corpus.normalizeCode("Bl3016"), "BL3016");
  assert.equal(corpus.normalizeCode("BL301"), null);
  assert.equal(corpus.normalizeCode("BL30160"), null);
  assert.equal(corpus.normalizeCode(3016), null);
  assert.equal(corpus.normalizeCode("not-a-code"), null);
  assert.equal(corpus.normalizeCode(""), null);
});

// --- the idiom index itself ----------------------------------------------------

test("idioms.json: every entry has the schema's five fields, well-formed, with a unique intent", () => {
  const seen = new Set();
  for (const e of idioms) {
    assert.deepEqual(Object.keys(e).sort(), ["corpus", "examples", "intent", "keywords", "note"], e.intent);
    assert.ok(typeof e.intent === "string" && e.intent.length > 0);
    assert.ok(!seen.has(e.intent), `duplicate intent: ${e.intent}`);
    seen.add(e.intent);
    assert.ok(Array.isArray(e.keywords) && e.keywords.length >= 3, `${e.intent}: keywords`);
    // Providers (netcdf/zarr/csv) have no corpus directory, so an entry may rest on examples alone.
    assert.ok(Array.isArray(e.corpus) && Array.isArray(e.examples), `${e.intent}: corpus/examples arrays`);
    assert.ok(e.corpus.length + e.examples.length >= 1, `${e.intent}: at least one demonstrating file`);
    assert.ok(e.corpus.every((p) => /^tests\/corpus\/[a-z0-9-]+\/.+\.blade$/.test(p)), `${e.intent}: corpus paths`);
    assert.ok(Array.isArray(e.examples) && e.examples.every((p) => /^examples\/.+\.blade$/.test(p)), `${e.intent}: example paths`);
    assert.ok(typeof e.note === "string" && e.note.length > 40, `${e.intent}: note`);
    assert.equal((e.note.match(/`/g) || []).length % 2, 0, `${e.intent}: unbalanced backticks in the note`);
  }
});

test("idioms.json: no entry teaches removed or wrong Blade", () => {
  for (const e of idioms) {
    // reduce is a LEFT fold (formalism 6.4); the index once said the opposite.
    assert.doesNotMatch(e.note, /right-to-left/i, e.intent);
  }
  const loops = idioms.find((e) => /for loop/.test(e.intent));
  assert.match(loops.note, /REMOVED/);
  assert.match(loops.note, /BL1003/);
});

test("idioms.json: every entry is the top hit for its own intent", () => {
  for (const e of idioms) {
    const ranked = idioms
      .map((x, order) => ({ x, order, score: corpus.scoreIdiom(x, e.intent) }))
      .sort((a, b) => b.score - a.score || a.order - b.order);
    assert.equal(ranked[0].x.intent, e.intent);
  }
});

test("scoreIdiom: every row of the style guide's 'You want / Write / Not' table is findable by a natural phrase", () => {
  // [what an agent would say, a fragment of the entry that must come back in the top three]
  const cases = [
    ["add two arrays element by element", "elementwise"],
    ["all pairs of two arrays", "outer product"],
    ["sum all the elements of a matrix to a scalar", "reduce / fold"],
    ["row sums of a 2d array", "reduce / fold"],
    ["compute sum and count at the same time", "several statistics in one pass"],
    ["keep only the rows where the quality flag is zero", "filter rows"],
    ["loop over a banded matrix", "constrained index domain"],
    ["finite difference derivative", "stencil"],
    ["array of integers from 0 to n", "generate an index range"],
    ["linspace", "coordinate axis"],
    ["sum of integers from 1 to n", "sum or product of an index range"],
    ["convert an integer to a float", "numeric casts"],
    ["chain several processing stages without temporaries", "pipeline of stages"],
    ["cumulative sum", "running state"],
    ["newton iteration until convergence", "iterate to convergence"],
    ["covariance matrix", "symmetric pairwise statistics"],
    ["solve the same linear system for many right-hand sides", "several solves against one matrix"],
    ["jacobian vector product", "Jacobian-vector"],
    ["reproducible monte carlo samples across chunks", "random draws that survive chunking"],
    ["multiply a gram matrix by a vector", "Gram operator"],
    ["process an array chunk by chunk", "per-chunk"],
    ["softmax attention weights", "normalized / weighted pairwise sums"],
    ["for loop", "for loop / while loop"],
    ["while loop", "for loop / while loop"],
  ];
  for (const [phrase, expected] of cases) {
    const top = idioms
      .map((e, order) => ({ e, order, score: corpus.scoreIdiom(e, phrase) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, 3)
      .map((s) => s.e.intent);
    assert.ok(
      top.some((intent) => intent.indexOf(expected) !== -1),
      `"${phrase}" should surface the [${expected}] idiom, got: ${JSON.stringify(top)}`
    );
  }
});

test("intent lookup: the phrases that used to return confidently wrong idioms now return the right one FIRST", async () => {
  // Each of these came back wrong (or empty) from the substring scorer: "si"
  // matched "sides" and "conversion", "cast" matched "broadcast", "sum" matched
  // "sum type". [phrase, a fragment of the idiom that must be the top result]
  const cases = [
    ["cast int to float", "numeric casts"], // was: outer product
    ["jacobian vector product", "Jacobian-vector"], // was: outer product
    ["LU solve multiple right-hand sides", "several solves against one matrix"], // was: units of measure
    ["numeric width conversion", "numeric casts"], // was: units of measure
    ["per-file work chunked axis", "per-chunk / per-file"], // was: stack/join, which the style guide says NOT to use
    ["coordinate axis", "coordinate axis"], // was: stack/join
    ["kernel smoothing softmax rows", "normalized / weighted pairwise sums"], // was: filter rows
    ["matrix solve", "linear algebra"], // was: comm/reynolds
    ["match on sum type", "structs, sum types"], // was: reduce
    ["sparse array", "named index types"], // was: elementwise
    ["mutable array parameter", "mutable state"], // was: elementwise
    ["struct", "structs, sum types"], // was: tuples
    ["iterate to convergence", "iterate to convergence"],
    ["while loop until converged", "iterate to convergence"],
    ["sum of an index range", "sum or product of an index range"],
    ["index generation", "generate an index range"],
    ["random draws reproducible chunks", "random draws that survive chunking"], // was: zero results
    ["automatic differentiation gradient", "gradient of a scalar loss"], // was: zero results
    ["read netcdf file", "NetCDF"], // was: zero results
    ["linspace", "coordinate axis"], // was: content-search fallback only
    ["band domain", "constrained index domain"], // was: content-search fallback only
  ];
  const ctx = makeCtx();
  for (const [phrase, expected] of cases) {
    const s = (await corpus.bladeCorpusFind({ intent: phrase, maxResults: 3 }, ctx)).structuredContent;
    assert.equal(s.mode, "intent", `"${phrase}" should match a curated idiom`);
    assert.ok(
      s.results[0].intent.indexOf(expected) !== -1,
      `"${phrase}" should return the [${expected}] idiom first, got: ${JSON.stringify(s.results.map((r) => `${r.intent} (${r.score})`))}`
    );
  }
});

test("idioms.json: the on-topic entries say what the style guide says", () => {
  const find = (fragment) => idioms.find((e) => e.intent.indexOf(fragment) !== -1);
  // Convergence is the `while` guard over a budget extent, aborting BL8010 when it runs out.
  assert.match(find("iterate to convergence").note, /`while` guard/);
  assert.match(find("iterate to convergence").note, /BL8010/);
  assert.match(find("for loop / while loop").note, /`while` guard/);
  // A range is folded / lifted directly; mapping an identity kernel over it is the "Not" column.
  assert.match(find("sum or product of an index range").note, /reduce\(0\.\.5, \(\+\)\)/);
  assert.doesNotMatch(find("sum or product of an index range").note, /method_for\(range/);
  assert.match(find("generate an index range").note, /`let idx = 0\.\.8`/);
  assert.match(find("coordinate axis").note, /Do NOT write `method_for\(range<I>\)/);
  // Every row the language gained since the index was first written has an entry.
  for (const fragment of [
    "constrained index domain",
    "coordinate axis",
    "numeric casts",
    "iterate to convergence",
    "several solves against one matrix",
    "Jacobian-vector",
    "random draws that survive chunking",
    "Gram operator",
    "per-chunk / per-file",
    "normalized / weighted pairwise sums",
  ]) {
    assert.ok(find(fragment), `missing idiom: ${fragment}`);
  }
});

test("scoreIdiom: a keyword matches as a phrase, not as an accident of spelling", () => {
  const lu = { intent: "several solves against one matrix", keywords: ["lu", "factor once"] };
  assert.equal(corpus.scoreIdiom(lu, "eigenvalues"), 0); // "lu" is inside "eigenvaLUes"
  assert.equal(corpus.scoreIdiom(lu, "distinct values"), 0);
  assert.ok(corpus.scoreIdiom(lu, "lu decomposition") >= 3);
  // Symbolic keywords still match in place.
  const fuse = { intent: "one pass", keywords: ["<&!>"] };
  assert.ok(corpus.scoreIdiom(fuse, "what does (a)<&!>(b) do") >= 3);
});

test("scoreIdiom: a query word counts once, however many keywords contain it", () => {
  const many = { intent: "gram action", keywords: ["matrix-free", "kernel matrix vector product", "implicit matrix"] };
  const one = { intent: "linear algebra", keywords: ["matrix multiply"] };
  assert.equal(corpus.scoreIdiom(many, "matrix"), corpus.scoreIdiom(one, "matrix"));
});

test(
  "idioms.json: every corpus/example path exists in the real checkout (set BLADE_REPO to run)",
  { skip: process.env.BLADE_REPO ? false : "BLADE_REPO is not set; the hermetic suite cannot see a Blade checkout" },
  () => {
    const repo = process.env.BLADE_REPO;
    const missing = [];
    for (const e of idioms) {
      for (const p of e.corpus.concat(e.examples)) {
        if (!fs.existsSync(path.join(repo, p))) missing.push(`${e.intent}: ${p}`);
      }
    }
    assert.deepEqual(missing, []);
  }
);

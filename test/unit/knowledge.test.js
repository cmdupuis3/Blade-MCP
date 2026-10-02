"use strict";

// knowledge.js: blade_explain merges the compiler's registry, the curated KB
// and a live scan of the corpus. Tested against the REAL vendored @blade-lang/ide-protocol surface/KB
// (so registry titles are authentic) but the mini corpus (so example
// resolution is hermetic).
//
// resources.js is covered here too (the second half of this file): the two
// modules share one fact — which repo-relative doc path is served by which
// blade-docs:// URI — and blade_explain must never advertise a URI the
// resource handler cannot read.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const knowledge = require("../../src/knowledge");
const corpus = require("../../src/corpus");
const resources = require("../../src/resources");
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

async function explain(args, ctx) {
  return (await knowledge.bladeExplain(args, ctx || makeCtx())).structuredContent;
}

/** A throwaway directory shaped like a Blade checkout's docs. */
function makeFakeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blade-mcp-repo-"));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return { root, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test.beforeEach(() => corpus.resetCache());

// --- the vendored data this module merges ---------------------------------------

test("the vendored surface registry and KB have the shapes blade_explain reads", () => {
  const diagnostics = pkg.surface.diagnostics;
  assert.ok(Array.isArray(diagnostics) && diagnostics.length >= 90, "the registry should carry the current compiler's codes");
  for (const d of diagnostics) {
    assert.match(d.code, /^BL\d{4}$/);
    assert.ok(typeof d.title === "string" && d.title.length > 0, d.code);
    assert.ok(typeof d.phase === "string" && d.phase.length > 0, d.code);
  }
  const kb = pkg.diagnosticsKb;
  for (const [code, entry] of Object.entries(kb.codes)) {
    assert.match(code, /^BL\d{4}$/);
    assert.ok(typeof entry.explanation === "string" && entry.explanation.length > 0, code);
    assert.ok(typeof entry.fix === "string" && entry.fix.length > 0, code);
    assert.ok(Array.isArray(entry.examples) && Array.isArray(entry.docs), code);
  }
  // Every registered code has curated prose (the KB is checked against the registry upstream).
  const uncovered = diagnostics.map((d) => d.code).filter((c) => !kb.codes[c]);
  assert.deepEqual(uncovered, []);
});

test("bladeExplain: a spread of old and new codes all come back known, registered and titled", async () => {
  const ctx = makeCtx();
  const expected = {
    BL1001: "parse",
    BL2009: "resolve",
    BL3016: "types",
    BL3019: "types",
    BL3020: "types",
    BL3021: "types",
    BL4005: "constraints",
    BL4016: "constraints",
    BL7004: "backend",
    BL8006: "runtime",
    BL8010: "runtime",
    BL8013: "runtime",
    BL8014: "runtime",
    BL9002: "internal",
  };
  for (const [code, phase] of Object.entries(expected)) {
    const s = await explain({ code, includeSource: false }, ctx);
    assert.equal(s.known, true, code);
    assert.equal(s.registered, true, code);
    assert.equal(s.phase, phase, code);
    assert.ok(typeof s.title === "string" && s.title.length > 0, code);
    assert.ok(typeof s.explanation === "string" && s.explanation.length > 0, code);
    assert.ok(typeof s.fix === "string" && s.fix.length > 0, code);
    assert.equal(s.registryNote, undefined, code);
    assert.equal(s.kbNote, undefined, code);
  }
});

test("bladeExplain: a known code returns registry title/phase plus KB explanation/fix", async () => {
  const s = await explain({ code: "BL3016" });
  assert.equal(s.known, true);
  assert.equal(s.code, "BL3016");
  assert.equal(s.title, "argument extent mismatch");
  assert.equal(s.phase, "types");
  assert.ok(typeof s.explanation === "string" && s.explanation.length > 0);
});

// --- corpus examples -------------------------------------------------------------

test("bladeExplain: examples come from the corpus root, KB-curated paths first", async () => {
  const s = await explain({ code: "BL3016" });
  assert.equal(s.corpusMatches, 2);
  assert.deepEqual(s.pinnedAs, { ERROR: 2 });
  assert.deepEqual(
    s.examples.map((e) => [e.path, e.origin]),
    [
      // named by the KB entry, and present in the mini corpus
      ["tests/corpus/diagnostics/069_extent_arg_direct.blade", "curated"],
      // not in the KB list: found because the file PINS the code
      ["tests/corpus/multifile/017_qualified_call_extent/02_Main.blade", "corpus-pin"],
    ]
  );
  assert.equal(s.examples[0].kind, "rejects");
  assert.deepEqual(s.examples[0].pinned, [{ pin: "ERROR", line: 9 }]);
  assert.equal(s.examples[1].module, "Main");
});

test("bladeExplain: a warning code's examples come from `// WARN:` pins", async () => {
  const s = await explain({ code: "BL3020" });
  assert.deepEqual(s.pinnedAs, { WARN: 1 });
  assert.equal(s.examples.length, 1);
  assert.equal(s.examples[0].path, "tests/corpus/casts/014_implicit_warning.blade");
  assert.equal(s.examples[0].pinned[0].pin, "WARN");
  assert.match(s.examples[0].source, /\/\/ WARN: BL3020/);
});

test("bladeExplain: a runtime code's examples come from `// ABORT:` pins", async () => {
  const div = await explain({ code: "BL8013" });
  assert.deepEqual(div.pinnedAs, { ABORT: 1 });
  assert.equal(div.examples[0].path, "tests/corpus/basic/067_int_div_by_zero_aborts.blade");
  assert.equal(div.examples[0].kind, "aborts");
  const budget = await explain({ code: "BL8010" });
  assert.equal(budget.examples[0].path, "tests/corpus/recursive-arrays/013_while_guard_budget_aborts.blade");
});

test("bladeExplain: a pin past the first 4 KB of a file still yields the example", async () => {
  const s = await explain({ code: "BL4003", includeSource: false });
  assert.equal(s.corpusMatches, 1);
  assert.equal(s.examples[0].path, "tests/corpus/ad-jvp-comb/101_reverse_map_moment_former_shape.blade");
});

test("bladeExplain: includeSource:true inlines the example's text, truncating a long file", async () => {
  const short = await explain({ code: "BL3016", includeSource: true });
  const hit = short.examples.find((e) => e.path.endsWith("069_extent_arg_direct.blade"));
  assert.match(hit.source, /ERROR: BL3016/);
  assert.equal(hit.truncated, undefined);
  const long = await explain({ code: "BL4003", includeSource: true });
  assert.equal(long.examples[0].truncated, true);
  assert.equal(long.examples[0].source.length, 6144);
  assert.ok(long.examples[0].totalChars > 6144);
});

test("bladeExplain: includeSource:false omits source text", async () => {
  const s = await explain({ code: "BL3016", includeSource: false });
  assert.ok(s.examples.length > 0);
  for (const e of s.examples) assert.equal(e.source, undefined);
});

test("bladeExplain: maxExamples caps the returned example count but not corpusMatches", async () => {
  const none = await explain({ code: "BL3016", maxExamples: 0 });
  assert.equal(none.examples.length, 0);
  assert.equal(none.corpusMatches, 2);
  const one = await explain({ code: "BL3016", maxExamples: 1 });
  assert.equal(one.examples.length, 1);
});

test("bladeExplain: a KB example that is not a corpus program is reported as a reference", async () => {
  // BL8012's curated pointer is an F# test file, which cannot be inlined as a Blade example.
  const s = await explain({ code: "BL8012" });
  assert.deepEqual(s.references, ["tests/NetcdfTests.fs"]);
  assert.equal(s.examples.length, 0);
});

test("bladeExplain: a registered code with no corpus pin in the mini corpus returns zero examples, not an error", async () => {
  // BL0001 is a real registry code (lex phase) that the mini corpus never pins.
  const s = await explain({ code: "BL0001" });
  assert.equal(s.known, true);
  assert.equal(s.examples.length, 0);
  assert.equal(s.corpusMatches, 0);
  assert.equal(s.pinnedAs, undefined);
});

test("bladeExplain: no corpus root -> corpusNote instead of a crash", async () => {
  const s = await explain({ code: "BL3016" }, makeCtx({ corpusRoot: null }));
  assert.match(s.corpusNote, /no test corpus found/);
  assert.equal(s.examples.length, 0);
});

// --- the removed-loop steer ------------------------------------------------------

test("bladeExplain: BL1003 (the removed-loop steer) is registered, explained, and its span pin is shown both ways", async () => {
  const s = await explain({ code: "BL1003" });
  assert.equal(s.known, true);
  assert.equal(s.registered, true);
  assert.equal(s.phase, "parse");
  assert.equal(s.title, "removed loop or malformed recursive array");
  assert.match(s.explanation, /for x in a\.\.b/);
  assert.match(s.fix, /let rec/);
  assert.equal(s.registryNote, undefined);
  assert.equal(s.kbNote, undefined);
  assert.equal(s.examples[0].path, "tests/corpus/diagnostics/045_for_in_removed.blade");
  assert.deepEqual(s.examples[0].pinned, [{ pin: "ERROR", line: 2, at: "13:5", atInFile: "14:5" }]);
  // The inlined source is the whole file, so the pinned 13:5 is its line 14.
  assert.match(s.examples[0].source.split("\n")[14 - 1], /for k in 0\.\.3/);
  assert.match(s.spanNote, /`atInFile` is the same span in the file as shown/);
});

test("the parser steer codes BL1003 and BL1004 are in the packaged registry and knowledge base", () => {
  // They were emitted and corpus-pinned for months while the compiler's registry
  // omitted them; a re-vendor from a compiler that lost them again should fail here.
  const registered = new Map(pkg.surface.diagnostics.map((d) => [d.code, d]));
  for (const code of ["BL1003", "BL1004"]) {
    assert.equal(registered.get(code) && registered.get(code).phase, "parse", code);
    const kbEntry = pkg.diagnosticsKb.codes[code];
    assert.ok(kbEntry && kbEntry.explanation && kbEntry.fix, `${code} has curated prose`);
    assert.equal(kbEntry.title, registered.get(code).title, code);
  }
});

test("bladeExplain: examples without a span pin carry no span caveat", async () => {
  const s = await explain({ code: "BL3016", includeSource: false });
  assert.equal(s.spanNote, undefined);
});

test("bladeExplain: an unknown/unregistered code degrades gracefully instead of erroring", async () => {
  const s = await explain({ code: "BL0000" });
  assert.equal(s.ok, true);
  assert.equal(s.known, false);
  assert.equal(s.registered, false);
  assert.equal(s.title, undefined);
  assert.match(s.registryNote, /not registered in this surface/);
  assert.match(s.kbNote, /no curated explanation/);
});

test("bladeExplain: an unregistered code the corpus pins says the compiler emits it", async () => {
  const ctx = makeCtx({ diagRegistry: new Map([["BL0001", { code: "BL0001", title: "t", phase: "lex" }]]), kb: { version: 1, codes: {} } });
  const s = await explain({ code: "BL3016" }, ctx);
  assert.equal(s.known, false);
  assert.match(s.registryNote, /2 corpus file\(s\) pin it/);
  assert.equal(s.examples.length, 2); // the corpus examples survive a missing registry entry
});

test("bladeExplain: with no surface at all, the note blames the surface and the examples still arrive", async () => {
  const s = await explain({ code: "BL3016" }, makeCtx({ diagRegistry: new Map(), kb: null, surface: null }));
  assert.match(s.registryNote, /no diagnostics registry/);
  assert.equal(s.examples.length, 2);
});

test("bladeExplain: bad code shape is a UserError, not a silent pass-through", async () => {
  await assert.rejects(() => knowledge.bladeExplain({ code: "not-a-code" }, makeCtx()), /not a diagnostic code/);
});

test("bladeExplain: accepts a bare 4-digit code (no BL prefix) and a lower-case prefix", async () => {
  assert.equal((await explain({ code: "3016" })).code, "BL3016");
  const lower = await explain({ code: "bl3016" });
  assert.equal(lower.code, "BL3016");
  assert.equal(lower.title, "argument extent mismatch");
});

// --- docs: which path is served by which resource --------------------------------

test("docUriFor: curated docs, the agent guide, and discovered design docs map to blade-docs:// URIs", () => {
  assert.equal(knowledge.docUriFor("docs/formalism.md"), "blade-docs://formalism");
  assert.equal(knowledge.docUriFor("docs\\features\\sql.md"), "blade-docs://features/sql");
  assert.equal(knowledge.docUriFor("README.md"), "blade-docs://readme");
  assert.equal(knowledge.docUriFor("CLAUDE.md"), "blade-docs://agent-guide");
  assert.equal(knowledge.docUriFor("tests/corpus/README.md"), "blade-docs://corpus-readme");
  assert.equal(knowledge.docUriFor("docs/plans/README.md"), "blade-docs://plans");
  assert.equal(knowledge.docUriFor("docs/plans/plan-forward-mode-ad.md"), "blade-docs://plans/plan-forward-mode-ad");
  assert.equal(knowledge.docUriFor("docs/plans/structural/06-enumerable-domains.md"), "blade-docs://plans/structural/06-enumerable-domains");
  assert.equal(knowledge.docUriFor("stdlib/stats.blade"), "blade-docs://stdlib/stats");
});

test("docUriFor: a path no resource serves gets no URI (never a guessed one)", () => {
  assert.equal(knowledge.docUriFor("not-a-doc.txt"), undefined);
  assert.equal(knowledge.docUriFor("llms.txt"), undefined); // a stub pointer file; the agent guide replaced it
  assert.equal(knowledge.docUriFor("docs/plan-forward-mode-ad.md"), undefined); // the pre-move path
  assert.equal(knowledge.docUriFor("docs/research/exact-recurrence-reduction-proofs.md"), undefined);
  assert.equal(knowledge.docUriFor("docs/plans/../../secret.md"), undefined);
  assert.equal(knowledge.docUriFor("docs/plans/deeper/still/plan.md"), undefined);
});

test("every doc path the vendored KB cites is served by a resource", () => {
  const unserved = new Set();
  for (const entry of Object.values(pkg.diagnosticsKb.codes)) {
    for (const doc of entry.docs || []) if (!resources.uriForRel(doc)) unserved.add(doc);
  }
  assert.deepEqual(Array.from(unserved), []);
});

test("resolveDocs: without a repo root, docs are reported unavailable with a remedy", () => {
  const docs = knowledge.resolveDocs(makeCtx({ repoRoot: null }), ["docs/formalism.md"]);
  assert.equal(docs[0].available, false);
  assert.match(docs[0].reason, /BLADE_REPO/);
});

test("resolveDocs: with a checkout, an existing doc gets a URI the resource handler can read", () => {
  const repo = makeFakeRepo({
    "docs/formalism.md": "# Formalism\n",
    "docs/plans/plan-match-statements.md": "# Match statements\n\nStatus: LANDED\n",
  });
  try {
    const ctx = makeCtx({ repoRoot: repo.root });
    const docs = knowledge.resolveDocs(ctx, ["docs/formalism.md", "docs/plans/plan-match-statements.md", "docs/quickstart-1.md"]);
    assert.deepEqual(
      docs.map((d) => [d.path, d.available, d.uri]),
      [
        ["docs/formalism.md", true, "blade-docs://formalism"],
        ["docs/plans/plan-match-statements.md", true, "blade-docs://plans/plan-match-statements"],
        ["docs/quickstart-1.md", false, undefined], // absent from this checkout: no URI advertised
      ]
    );
    for (const d of docs.filter((x) => x.uri)) {
      assert.ok(resources.read(d.uri, ctx).contents[0].text.length > 0);
    }
  } finally {
    repo.dispose();
  }
});

// --- resources.js ----------------------------------------------------------------

test("resources.list: no checkout and no corpus README -> nothing, and nothing throws", () => {
  // The mini corpus has no README.md, exactly like the corpus deployed beside a binary.
  assert.deepEqual(resources.list(makeCtx({ repoRoot: null })), []);
  assert.deepEqual(resources.list(makeCtx({ repoRoot: null, corpusRoot: null })), []);
});

test("resources.list: only files that exist are listed; curated entries first, discovered design docs after", () => {
  const repo = makeFakeRepo({
    "CLAUDE.md": "# CLAUDE.md\n",
    "docs/formalism.md": "# Formalism\n",
    "docs/features/sql.md": "# SQL\n",
    "docs/features/new-feature.md": "# A feature page added after this server was written\n",
    "docs/plans/README.md": "# Living design docs\n",
    "docs/plans/plan-b.md": "# Plan B: `subset`\n",
    "docs/plans/plan-a.md": "no heading here\n",
    "docs/plans/notes.txt": "not markdown\n",
    "docs/plans/structural/06-enumerable-domains.md": "# 06 — Enumerable constrained domains\n",
    "stdlib/stats.blade": "function mean(row: T^1) = Float64(reduce(row, (+))) / Float64(extents(row))\n",
    "tests/corpus/README.md": "# Blade test corpus\n",
  });
  try {
    const ctx = makeCtx({ repoRoot: repo.root });
    const list = resources.list(ctx);
    assert.deepEqual(
      list.map((r) => r.uri),
      [
        "blade-docs://corpus-readme",
        "blade-docs://agent-guide",
        "blade-docs://formalism",
        "blade-docs://features/sql",
        "blade-docs://plans",
        "blade-docs://stdlib/stats",
        "blade-docs://features/new-feature",
        "blade-docs://plans/plan-a",
        "blade-docs://plans/plan-b",
        "blade-docs://plans/structural/06-enumerable-domains",
      ]
    );
    const byUri = new Map(list.map((r) => [r.uri, r]));
    assert.equal(byUri.get("blade-docs://stdlib/stats").mimeType, "text/plain");
    assert.equal(byUri.get("blade-docs://formalism").mimeType, "text/markdown");
    assert.equal(byUri.get("blade-docs://plans/plan-b").name, "Design doc: Plan B: subset"); // from the file's heading
    assert.equal(byUri.get("blade-docs://plans/plan-a").name, "Design doc: plan-a"); // no heading: the basename
    assert.match(byUri.get("blade-docs://plans/plan-b").description, /Status header is the source of truth/);
    // Everything listed is readable.
    for (const r of list) assert.ok(resources.read(r.uri, ctx).contents[0].text.length > 0, r.uri);
    assert.equal(resources.read("blade-docs://stdlib/stats", ctx).contents[0].mimeType, "text/plain");
  } finally {
    repo.dispose();
  }
});

test("resources.read: corpus-readme resolves from the live checkout corpus", () => {
  const repo = makeFakeRepo({ "tests/corpus/README.md": "# Blade test corpus\n\n## Pin forms\n" });
  try {
    const out = resources.read("blade-docs://corpus-readme", makeCtx({ repoRoot: repo.root }));
    assert.match(out.contents[0].text, /Pin forms/);
  } finally {
    repo.dispose();
  }
});

test("resources.read: unknown, repo-less, missing and malformed URIs fail with a useful message", () => {
  const bare = makeCtx({ repoRoot: null });
  assert.throws(() => resources.read("blade-docs://formalism", bare), /needs a Blade checkout/);
  assert.throws(() => resources.read("blade-docs://plans/plan-forward-mode-ad", bare), /needs a Blade checkout/);
  assert.throws(() => resources.read("blade-docs://corpus-readme", bare), /no test corpus README found/);
  assert.throws(() => resources.read("blade-docs://llms", bare), /unknown resource/);
  assert.throws(() => resources.read("file:///etc/passwd", bare), /unsupported resource URI/);
  const repo = makeFakeRepo({ "docs/formalism.md": "# Formalism\n", "secret.md": "# not a doc\n" });
  try {
    const ctx = makeCtx({ repoRoot: repo.root });
    assert.throws(() => resources.read("blade-docs://quickstart-1", ctx), /missing from the checkout/);
    // A URI is looked up, never turned into a path: traversal spellings are simply unknown.
    assert.throws(() => resources.read("blade-docs://plans/../../secret", ctx), /unknown resource/);
    assert.throws(() => resources.read("blade-docs://../secret", ctx), /unknown resource/);
  } finally {
    repo.dispose();
  }
});

test("resources.DOC_ENTRIES: ids are unique and none collides with a discovered-directory prefix's files", () => {
  const ids = resources.DOC_ENTRIES.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  const rels = resources.DOC_ENTRIES.map((e) => e.rel);
  assert.equal(new Set(rels).size, rels.length);
  for (const e of resources.DOC_ENTRIES) assert.equal(resources.uriForRel(e.rel), resources.uriOf(e.id));
});

test(
  "resources: every curated entry exists in the real checkout, and everything listed reads (set BLADE_REPO to run)",
  { skip: process.env.BLADE_REPO ? false : "BLADE_REPO is not set; the hermetic suite cannot see a Blade checkout" },
  () => {
    const repo = process.env.BLADE_REPO;
    const ctx = makeCtx({ repoRoot: repo, corpusRoot: path.join(repo, "tests", "corpus") });
    const missing = resources.DOC_ENTRIES.filter((e) => !fs.existsSync(path.join(repo, e.rel))).map((e) => e.rel);
    assert.deepEqual(missing, []);
    const list = resources.list(ctx);
    assert.ok(list.length > resources.DOC_ENTRIES.length, "discovered design docs should be listed too");
    for (const r of list) assert.ok(resources.read(r.uri, ctx).contents[0].text.length > 0, r.uri);
  }
);

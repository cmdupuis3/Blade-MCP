"use strict";

// blade_explain — everything known about one BLxxxx diagnostic code.
//
// Three sources, each optional, merged in this order:
//   1. the compiler's own registry (surface.json: title + phase),
//   2. the hand-authored knowledge base (explanation, fix, curated examples, docs),
//   3. a live scan of the test corpus for files that PIN this code
//      (`// ERROR: BLxxxx` / `// WARN: BLxxxx`) — ground-truth examples of the
//      exact refusal, which exist whether or not anyone wrote KB prose.
//
// Every source degrades independently: with a stub/absent surface you still get
// corpus examples, and an unknown code is reported as unregistered rather than
// as an error, because a code the binary emits but the surface lacks is real
// evidence of surface-vs-binary skew.

const fs = require("fs");
const path = require("path");
const compiler = require("./compiler");
const corpus = require("./corpus");

const MAX_SOURCE_CHARS = 6144;

function readSource(abs) {
  try {
    const text = fs.readFileSync(abs, "utf8");
    if (text.length <= MAX_SOURCE_CHARS) return { source: text };
    return { source: text.slice(0, MAX_SOURCE_CHARS), truncated: true, totalChars: text.length };
  } catch (e) {
    return { sourceError: e.message };
  }
}

function exampleEntry(file, includeSource) {
  const out = corpus.describe(file);
  out.origin = file.origin || "corpus";
  if (includeSource) Object.assign(out, readSource(file.abs));
  return out;
}

function resolveDocs(ctx, docs) {
  const repo = ctx.repoRoot();
  return (docs || []).map((rel) => {
    if (!repo) return { path: rel, available: false, reason: "no Blade checkout found (set BLADE_REPO)" };
    const abs = path.join(repo, rel);
    const exists = fs.existsSync(abs);
    return { path: rel, available: exists, uri: exists ? docUriFor(rel) : undefined };
  });
}

/** Map a repo-relative docs path onto a blade-docs:// URI when one exists. */
function docUriFor(rel) {
  const normalized = rel.replace(/\\/g, "/");
  if (normalized === "llms.txt") return "blade-docs://llms";
  if (normalized === "README.md") return "blade-docs://readme";
  const m = /^docs\/(.+)\.md$/.exec(normalized);
  return m ? `blade-docs://${m[1]}` : undefined;
}

async function bladeExplain(args, ctx) {
  const code = corpus.normalizeCode(args.code);
  if (!code) {
    throw new compiler.UserError(`not a diagnostic code: ${args.code} (expected BLxxxx or xxxx, e.g. BL3016 or 3016)`);
  }
  const maxExamples = typeof args.maxExamples === "number" ? Math.max(0, Math.min(10, args.maxExamples)) : 3;
  const includeSource = args.includeSource !== false;

  const registry = ctx.diagRegistry();
  const entry = registry.get(code);
  const kb = ctx.kb();
  const kbEntry = kb && kb.codes ? kb.codes[code] : undefined;

  const structured = {
    ok: true,
    code,
    known: !!(entry || kbEntry),
  };
  if (entry) {
    structured.title = entry.title;
    structured.phase = entry.phase;
  }
  if (kbEntry) {
    if (!structured.title && kbEntry.title) structured.title = kbEntry.title;
    if (kbEntry.explanation) structured.explanation = kbEntry.explanation;
    if (kbEntry.fix) structured.fix = kbEntry.fix;
    const docs = resolveDocs(ctx, kbEntry.docs);
    if (docs.length) structured.docs = docs;
  }

  // Examples: KB-curated first (they were chosen), then whatever the corpus pins.
  const examples = [];
  const seen = new Set();
  const index = ctx.corpusRoot() ? corpus.corpusIndex(ctx) : null;

  if (index) {
    for (const rel of (kbEntry && kbEntry.examples) || []) {
      if (examples.length >= maxExamples) break;
      const relInCorpus = rel.startsWith("tests/corpus/") ? rel.slice("tests/corpus/".length) : rel;
      const hit = index.files.find((f) => f.rel === relInCorpus);
      if (!hit || seen.has(hit.rel)) continue;
      seen.add(hit.rel);
      examples.push(exampleEntry(Object.assign({}, hit, { origin: "curated" }), includeSource));
    }
    for (const hit of index.byCode.get(code) || []) {
      if (examples.length >= maxExamples) break;
      if (seen.has(hit.rel)) continue;
      seen.add(hit.rel);
      examples.push(exampleEntry(Object.assign({}, hit, { origin: "corpus-pin" }), includeSource));
    }
    structured.corpusMatches = (index.byCode.get(code) || []).length;
  } else {
    structured.corpusNote =
      "no test corpus found (set BLADE_CORPUS_DIR, or point BLADE_EXE at a compiler with tests/corpus beside it)";
  }
  structured.examples = examples;

  if (!entry) {
    const surface = ctx.surface();
    const empty = !surface || !Array.isArray(surface.diagnostics) || surface.diagnostics.length === 0;
    structured.registryNote = empty
      ? "this server's language surface carries no diagnostics registry (surface.json unavailable or stubbed), so titles and phases are missing — the corpus examples below are still authoritative"
      : `${code} is not registered in this surface; it may come from a newer compiler than the surface.json this server was built against (run blade_doctor to check for skew)`;
  }
  if (!kbEntry) {
    structured.kbNote = "no curated explanation for this code yet; the corpus examples show the refusal in context";
  }
  return compiler.toolResult(structured);
}

module.exports = { bladeExplain, docUriFor, resolveDocs };

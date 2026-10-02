"use strict";

// blade_explain — everything known about one BLxxxx diagnostic code.
//
// Sources, each optional, merged in this order:
//   1. the compiler's own registry (surface.json `diagnostics`: code, title,
//      phase — generated from src/Diagnostics.fs by `blade ide surface`),
//   2. the hand-authored knowledge base (data/diagnostics.json: title,
//      explanation, fix, curated example paths, docs),
//   3. a small local supplement for codes the compiler EMITS but its registry
//      does not list (see UNREGISTERED below) — consulted only when 1 and 2
//      both miss, so an upstream fix supersedes it automatically,
//   4. a live scan of the test corpus for files that PIN this code
//      (`// ERROR: BLxxxx`, `// WARN: BLxxxx`, or an `// ABORT:` naming it) —
//      ground-truth examples of the exact diagnosis, which exist whether or
//      not anyone wrote KB prose.
//
// Every source degrades independently: with a stub/absent surface you still get
// corpus examples, and an unknown code is reported as unregistered rather than
// as an error, because a code the binary emits but the surface lacks is real
// evidence of surface-vs-binary skew.

const fs = require("fs");
const path = require("path");
const compiler = require("./compiler");
const corpus = require("./corpus");
const resources = require("./resources");

const MAX_SOURCE_CHARS = 6144;

/**
 * Codes the compiler raises that `src/Diagnostics.fs` (and therefore
 * surface.json and the KB) does not register. Verified against the emitting
 * sites in the compiler source (Parser.fs / ParserGrammar.fs / ParserTypes.fs)
 * and against the corpus files that pin them. This table is a stop-gap for an
 * upstream registry gap, NOT a second knowledge base: an entry is used only
 * when neither the registry nor the KB knows the code.
 */
const UNREGISTERED = {
  BL1003: {
    title: "imperative loop removed / malformed recursive-array form",
    phase: "parse",
    explanation:
      "A steering diagnostic for iteration syntax the language does not have. It fires for the REMOVED imperative `for x in a..b { ... }` statement (at top level and inside blocks), for an imperative `while cond { ... }` / `do { ... }` (neither is a keyword), for a guard on the wrong kind of arm (`while` on an ordinary match arm, whose guard is `if`; `if` on a recursive-array arm, which takes `while`; `while` on a `let rec` seed arm), and for a `let rec` array whose definition is not the required shape (a type annotation, `match <itself> with`, a `| zero -> zero` base arm, at most one `zero :: n` seed arm, and a `prefix :: n -> prefix :: <slice>` inductive arm). It is a hard parse error: no other production could still succeed once the construct has been recognized.",
    fix: "Do not look for a loop workaround — iteration is declarative. A fold is `reduce(...)`; a parallel map is array arithmetic or `method_for(range<...>) <@> lambda(...)`; a recurrence / running state is a recursive array (`let rec q: Array<T like Step> = match q with | zero -> zero | prefix :: n -> prefix :: <slice>`); iterate-until-converged is that array's inductive arm with a `while` guard over a budget extent (`| prefix :: n while <cond> -> prefix :: <step>`). Use `if` to guard an ordinary match arm.",
    docs: ["CLAUDE.md", "docs/formalism.md"],
  },
  BL1004: {
    title: "malformed type spelling",
    phase: "parse",
    explanation:
      "A type was spelled in a form the grammar recognizes but cannot give a meaning. Two families raise it. `Tuple<...>`: a width that is not an integer literal >= 2 (`Tuple<1>`, `Tuple<0>`, a negative width), an empty `Tuple<>`, a single component type (`Tuple<T>` — there is no 1-tuple; `(e)` is grouping), or a mix of the width spelling and the component-type spelling. Caret array types: a concrete element type with a non-literal rank (`Float64^r` — a variable rank belongs to a type variable, `T^r`), a caret on a built-in that is not an array element type, or a caret on a declared type that is itself an array type.",
    fix: "For tuples write either an integer width >= 2 (`Tuple<2>`, element types inferred) or at least two component types (`Tuple<Float64, Float64>`), never a mixture. For caret types give a concrete element a literal rank (`Float64^1`, `Int64^2`) or use a type variable when the rank or element is generic (`T^1`, `T^r`).",
    docs: ["docs/formalism.md", "docs/features.md"],
  },
};

function readSource(abs) {
  try {
    const text = fs.readFileSync(abs, "utf8");
    if (text.length <= MAX_SOURCE_CHARS) return { source: text };
    return { source: text.slice(0, MAX_SOURCE_CHARS), truncated: true, totalChars: text.length };
  } catch (e) {
    return { sourceError: e.message };
  }
}

function exampleEntry(file, code, origin, includeSource) {
  const out = corpus.describeForCode(file, code);
  out.origin = origin;
  if (includeSource) Object.assign(out, readSource(file.abs));
  return out;
}

/**
 * Resolve the KB's repo-relative doc paths. `uri` is advertised only when a
 * blade-docs:// resource really serves that file (resources.js is the single
 * source of truth) AND the file exists — an unreadable URI is worse than none.
 */
function resolveDocs(ctx, docs) {
  const repo = ctx.repoRoot();
  return (docs || []).map((rel) => {
    if (!repo) return { path: rel, available: false, reason: "no Blade checkout found (set BLADE_REPO)" };
    const abs = path.join(repo, rel);
    const exists = fs.existsSync(abs);
    return { path: rel, available: exists, uri: exists ? docUriFor(rel) : undefined };
  });
}

/** Map a repo-relative path onto the blade-docs:// URI that serves it, if any. */
function docUriFor(rel) {
  return resources.uriForRel(rel);
}

/** How many files pin the code through each pin kind: {ERROR, WARN, ABORT}. */
function pinKindCounts(files, code) {
  const counts = {};
  for (const f of files) {
    const kinds = new Set(f.pins.filter((p) => p.code === code).map((p) => p.pin));
    for (const k of kinds) counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

async function bladeExplain(args, ctx) {
  const code = corpus.normalizeCode(args.code);
  if (!code) {
    throw new compiler.UserError(`not a diagnostic code: ${args.code} (expected BLxxxx or xxxx, e.g. BL3016, bl3016 or 3016)`);
  }
  const maxExamples = typeof args.maxExamples === "number" ? Math.max(0, Math.min(10, args.maxExamples)) : 3;
  const includeSource = args.includeSource !== false;

  const registry = ctx.diagRegistry();
  const entry = registry.get(code);
  const kb = ctx.kb();
  const kbEntry = kb && kb.codes ? kb.codes[code] : undefined;
  const supplement = !entry && !kbEntry ? UNREGISTERED[code] : undefined;
  const prose = kbEntry || supplement;

  const structured = {
    ok: true,
    code,
    known: !!(entry || kbEntry || supplement),
    registered: !!entry,
  };
  if (entry) {
    structured.title = entry.title;
    structured.phase = entry.phase;
  }
  if (prose) {
    if (!structured.title && prose.title) structured.title = prose.title;
    if (!structured.phase && prose.phase) structured.phase = prose.phase;
    if (prose.explanation) structured.explanation = prose.explanation;
    if (prose.fix) structured.fix = prose.fix;
    const docs = resolveDocs(ctx, prose.docs);
    if (docs.length) structured.docs = docs;
  }

  // Examples: KB-curated first (they were chosen), then whatever the corpus
  // pins, best-first (corpus.js ranks dedicated diagnostics/ probes and
  // single-code files ahead of incidental ones).
  const examples = [];
  const seen = new Set();
  const index = corpus.corpusRootFor(ctx) ? corpus.corpusIndex(ctx) : null;

  if (index) {
    const pinning = index.byCode.get(code) || [];
    const references = [];
    for (const rel of (kbEntry && kbEntry.examples) || []) {
      const normalized = String(rel).replace(/\\/g, "/");
      if (!normalized.startsWith("tests/corpus/")) {
        // A curated pointer that is not a corpus program (an F# test file):
        // nothing to inline, but still where the behavior is pinned.
        references.push(normalized);
        continue;
      }
      const relInCorpus = normalized.slice("tests/corpus/".length);
      const hit = index.files.find((f) => f.rel === relInCorpus);
      // A curated corpus path this corpus root lacks (a stale deployed copy,
      // or a trimmed fixture corpus) is skipped; the pin scan below still runs.
      if (!hit) continue;
      if (seen.has(hit.rel) || examples.length >= maxExamples) continue;
      seen.add(hit.rel);
      examples.push(exampleEntry(hit, code, "curated", includeSource));
    }
    for (const hit of pinning) {
      if (examples.length >= maxExamples) break;
      if (seen.has(hit.rel)) continue;
      seen.add(hit.rel);
      examples.push(exampleEntry(hit, code, "corpus-pin", includeSource));
    }
    structured.corpusMatches = pinning.length;
    const kinds = pinKindCounts(pinning, code);
    if (Object.keys(kinds).length) structured.pinnedAs = kinds;
    if (references.length) structured.references = references;
  } else {
    structured.corpusNote =
      "no test corpus found (set BLADE_CORPUS_DIR or BLADE_REPO, or point BLADE_EXE at a compiler with tests/corpus beside it)";
  }
  structured.examples = examples;
  const spanNote = corpus.spanNoteFor(examples);
  if (spanNote) structured.spanNote = spanNote;

  if (!entry) {
    const surface = ctx.surface();
    const empty = !surface || !Array.isArray(surface.diagnostics) || surface.diagnostics.length === 0;
    if (empty) {
      structured.registryNote =
        "this server's language surface carries no diagnostics registry (surface.json unavailable or stubbed), so titles and phases are missing — the corpus examples below are still authoritative";
    } else if (supplement) {
      structured.registryNote = `${code} is emitted by the compiler and pinned by its corpus, but the compiler's registry (src/Diagnostics.fs, hence surface.json) does not list it; the title, explanation and fix here come from this server's supplement, written against the emitting sites in the compiler source`;
    } else if (structured.corpusMatches) {
      structured.registryNote = `${code} is not registered in this surface, yet ${structured.corpusMatches} corpus file(s) pin it — the compiler emits it; either its registry omits it or it comes from a newer compiler than the surface.json this server was built against (run blade_doctor to check for skew)`;
    } else {
      structured.registryNote = `${code} is not registered in this surface; it may come from a newer compiler than the surface.json this server was built against (run blade_doctor to check for skew)`;
    }
  }
  if (!prose) {
    structured.kbNote = "no curated explanation for this code yet; the corpus examples show the refusal in context";
  }
  return compiler.toolResult(structured);
}

module.exports = { bladeExplain, docUriFor, resolveDocs, UNREGISTERED };

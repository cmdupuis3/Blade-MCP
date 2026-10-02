"use strict";

// blade-docs:// resources — the language's prose, read straight from a Blade
// checkout.
//
// docs/, examples/ and the agent guide are repo-only, so those entries are
// registered ONLY when resolveRepoRoot() finds a checkout (BLADE_REPO, or a
// walk up from the resolved compiler). tests/corpus/README.md is different:
// it resolves from whichever corpus root has it, so blade-docs://corpus-readme
// can work with no checkout at all.
//
// Two kinds of entry:
//   - DOC_ENTRIES: a fixed, curated allow-list (id -> repo-relative path).
//   - DISCOVERED_DIRS: directories whose *.md files are listed FROM DISK
//     (design docs under docs/plans, feature pages under docs/features), so a
//     page added to the repo is served without touching this file — the same
//     reason the corpus is discovered rather than listed.
// Either way a URI is resolved by LOOKING IT UP in that list, never by turning
// caller input into a path, so there is no traversal surface.

const fs = require("fs");
const path = require("path");
const corpus = require("./corpus");

const SCHEME = "blade-docs://";

const DOC_ENTRIES = [
  {
    id: "agent-guide",
    rel: "CLAUDE.md",
    name: "Agent guide (CLAUDE.md)",
    description:
      "START HERE to write Blade: language essentials, the style-guide idiom table (You want / Write / Not), rules that prevent real bugs, corpus test conventions, CLI verbs and environment variables.",
  },
  { id: "formalism", rel: "docs/formalism.md", name: "Blade formalism", description: "Canonical semantics: types, index types, loop objects, combinators, symmetry, arithmetic contract (2.4), subscripts (3.10), recursive arrays (7.5), concrete syntax (15)." },
  { id: "quickstart-1", rel: "docs/quickstart-1.md", name: "Quickstart 1", description: "Tutorial: structure-first programming — loop reification, dimensional currying, arity polymorphism, units." },
  { id: "quickstart-2", rel: "docs/quickstart-2.md", name: "Quickstart 2", description: "Tutorial, part two: the advanced features." },
  { id: "features", rel: "docs/features.md", name: "Feature census", description: "Every language feature with one-paragraph semantics and a Status column (trust formalism.md and the corpus when they disagree)." },
  { id: "features/ppl", rel: "docs/features/ppl.md", name: "Feature: probabilistic surface", description: "Moment formers, the Dist algebra, pushforwards, streaming monoids, sampling and exact inference." },
  { id: "features/sql", rel: "docs/features/sql.md", name: "Feature: relational surface", description: "Masks, semijoins, group_by, sort/unique, set operations, reduce, and segmented axes (segments / files / ungroup)." },
  { id: "features/equivariant-nn", rel: "docs/features/equivariant-nn.md", name: "Feature: equivariant neural networks", description: "Irreps index types, CG tensor products, spherical harmonics, equivariance certificates." },
  { id: "features/graphs-trees", rel: "docs/features/graphs-trees.md", name: "Feature: graphs and trees", description: "Static trees (TreeIdx<shape>, leaves) and graphs as adjacency data with let rec walks." },
  { id: "examples", rel: "docs/examples.md", name: "Examples cookbook", description: "Worked end-to-end examples; every block is compiled and run by `blade test docs`." },
  { id: "examples-readme", rel: "examples/README.md", name: "Worked programs index", description: "Index of the numbered programs under examples/: the problem each solves and the idioms on display." },
  { id: "examples/physics", rel: "examples/physics/README.md", name: "Physics examples index", description: "Guide to the 47-program examples/physics corpus: physics with moment jets (the ppl Dist tower)." },
  { id: "proofs", rel: "docs/proofs.md", name: "Proofs map", description: "Which guarantees are machine-checked in Coq (proofs/) versus implemented and corpus-pinned." },
  { id: "plans", rel: "docs/plans/README.md", name: "Design docs index", description: "Index of the living design docs under docs/plans with each one's status (built / in progress / proposed / refuted)." },
  { id: "docs-index", rel: "docs/README.md", name: "Documentation hub", description: "What each document is canonical for." },
  { id: "readme", rel: "README.md", name: "Blade README", description: "Repository overview." },
  { id: "stdlib/stats", rel: "stdlib/stats.blade", name: "stdlib: stats", description: "Blade source of the stats module (mean, variance, stddev) — `from stats import mean`.", mimeType: "text/plain" },
  { id: "stdlib/plot", rel: "stdlib/plot.blade", name: "stdlib: plot", description: "Blade source of the plot module (line, scatter, contour, contourf, heatmap, stream) and its option slots.", mimeType: "text/plain" },
  { id: "stdlib/units/SI", rel: "stdlib/units/SI.blade", name: "stdlib: SI units", description: "Blade source of the SI unit declarations.", mimeType: "text/plain" },
];

/**
 * Directories whose Markdown files are served by discovery. `idPrefix` + the
 * file's basename (without .md) is the resource id, so docs/plans/foo.md is
 * blade-docs://plans/foo. Not recursive: each directory is named explicitly.
 */
const DISCOVERED_DIRS = [
  {
    dir: "docs/features",
    idPrefix: "features/",
    namePrefix: "Feature: ",
    description: "Feature module page.",
  },
  {
    dir: "docs/plans",
    idPrefix: "plans/",
    namePrefix: "Design doc: ",
    description:
      "Living design doc. Its own Status header is the source of truth — a plan may describe work that is unbuilt, partial, or refuted, so do not read it as a description of the language.",
  },
  {
    dir: "docs/plans/structural",
    idPrefix: "plans/structural/",
    namePrefix: "Design doc: ",
    description:
      "Living design doc (structural performance series). Its own Status header is the source of truth — it may describe work that is unbuilt or partial.",
  },
];

function uriOf(id) {
  return `${SCHEME}${id}`;
}

function normalizeRel(rel) {
  return String(rel).replace(/\\/g, "/");
}

/** First `# heading` of a Markdown file, or null. Reads only the file's head. */
function headingOf(abs) {
  let fd;
  try {
    fd = fs.openSync(abs, "r");
    const buf = Buffer.alloc(512);
    const read = fs.readSync(fd, buf, 0, 512, 0);
    const m = /^#\s+(.+?)\s*$/m.exec(buf.slice(0, read).toString("utf8"));
    return m ? m[1].replace(/`/g, "") : null;
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        /* ignore */
      }
    }
  }
}

/** The discovered entries of one checkout, in a stable (ordinal) order. */
function discover(repo) {
  const out = [];
  if (!repo) return out;
  const curated = new Set(DOC_ENTRIES.map((e) => e.rel));
  for (const spec of DISCOVERED_DIRS) {
    let names;
    try {
      names = fs
        .readdirSync(path.join(repo, spec.dir), { withFileTypes: true })
        .filter((e) => e.isFile() && /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(e.name))
        .map((e) => e.name);
    } catch (_) {
      continue; // an absent directory just contributes nothing
    }
    names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) {
      const rel = `${spec.dir}/${name}`;
      if (curated.has(rel)) continue; // the curated entry (and its description) wins
      const base = name.slice(0, -3);
      out.push({
        id: `${spec.idPrefix}${base}`,
        rel,
        name: `${spec.namePrefix}${headingOf(path.join(repo, rel)) || base}`,
        description: spec.description,
        discovered: true,
      });
    }
  }
  return out;
}

/** Every entry that could exist for this context's checkout (curated first). */
function entriesFor(ctx) {
  const repo = ctx.repoRoot();
  return DOC_ENTRIES.concat(discover(repo));
}

/**
 * The blade-docs:// URI serving a repo-relative path, or undefined when no
 * resource serves it. Pure path mapping (no disk access): curated entries by
 * exact path, discovered directories by their pattern. Callers that advertise
 * the URI should also check the file exists.
 */
function uriForRel(rel) {
  const normalized = normalizeRel(rel);
  const curated = DOC_ENTRIES.find((e) => e.rel === normalized);
  if (curated) return uriOf(curated.id);
  if (normalized === "tests/corpus/README.md") return uriOf("corpus-readme");
  for (const spec of DISCOVERED_DIRS) {
    const prefix = `${spec.dir}/`;
    if (!normalized.startsWith(prefix)) continue;
    const name = normalized.slice(prefix.length);
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(name)) return uriOf(`${spec.idPrefix}${name.slice(0, -3)}`);
  }
  return undefined;
}

function absFor(ctx, entry) {
  const repo = ctx.repoRoot();
  return repo ? path.join(repo, entry.rel) : null;
}

/**
 * The corpus README, from whichever root actually has it. The corpus deployed
 * beside the binary carries the category directories but NOT the README (the
 * fsproj copies only .blade files), so a checkout is the second place to look
 * — hence two candidates rather than one.
 */
function corpusReadme(ctx) {
  const candidates = [];
  const root = corpus.corpusRootFor(ctx);
  if (root) candidates.push(path.join(root, "README.md"));
  const repo = ctx.repoRoot();
  if (repo) candidates.push(path.join(repo, "tests", "corpus", "README.md"));
  for (const abs of candidates) {
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

/** Resources this server can actually serve right now. */
function list(ctx) {
  const out = [];
  const readme = corpusReadme(ctx);
  if (readme) {
    out.push({
      uri: uriOf("corpus-readme"),
      name: "Test corpus README",
      description: "How the Blade test corpus is organized and the pin grammar its .blade files use (EXPECT / ERROR / WARN / ABORT / REJECT-AT / NOPINS / MODULE).",
      mimeType: "text/markdown",
    });
  }
  if (ctx.repoRoot()) {
    for (const entry of entriesFor(ctx)) {
      const abs = absFor(ctx, entry);
      if (!abs || !fs.existsSync(abs)) continue;
      out.push({
        uri: uriOf(entry.id),
        name: entry.name,
        description: entry.description,
        mimeType: entry.mimeType || "text/markdown",
      });
    }
  }
  return out;
}

function read(uri, ctx) {
  if (typeof uri !== "string" || !uri.startsWith(SCHEME)) {
    throw new Error(`unsupported resource URI: ${uri}`);
  }
  const id = uri.slice(SCHEME.length);

  if (id === "corpus-readme") {
    const abs = corpusReadme(ctx);
    if (!abs) throw new Error("no test corpus README found (set BLADE_CORPUS_DIR or BLADE_REPO)");
    return { contents: [{ uri, mimeType: "text/markdown", text: fs.readFileSync(abs, "utf8") }] };
  }

  const entry = entriesFor(ctx).find((e) => e.id === id);
  if (!entry) {
    if (!ctx.repoRoot() && DISCOVERED_DIRS.some((spec) => id.startsWith(spec.idPrefix))) {
      throw new Error(`${uri} needs a Blade checkout: set BLADE_REPO, or point BLADE_EXE at a compiler inside one (docs/ is repo-only)`);
    }
    throw new Error(`unknown resource: ${uri}`);
  }
  const abs = absFor(ctx, entry);
  if (!abs) {
    throw new Error(
      `${uri} needs a Blade checkout: set BLADE_REPO, or point BLADE_EXE at a compiler inside one (docs/, examples/ and stdlib/ sources are repo-only)`
    );
  }
  if (!fs.existsSync(abs)) throw new Error(`${uri} maps to ${entry.rel}, which is missing from the checkout at ${ctx.repoRoot()}`);
  return { contents: [{ uri, mimeType: entry.mimeType || "text/markdown", text: fs.readFileSync(abs, "utf8") }] };
}

module.exports = { SCHEME, DOC_ENTRIES, DISCOVERED_DIRS, uriOf, uriForRel, list, read };

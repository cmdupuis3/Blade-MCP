"use strict";

// blade-docs:// resources — the language's prose, read straight from a Blade
// checkout.
//
// docs/ and examples/ are repo-only, so those entries are registered ONLY when
// resolveRepoRoot() finds a checkout (BLADE_REPO, or a walk up from the
// resolved compiler). tests/corpus/README.md is different: the corpus is
// deployed beside the binary, so blade-docs://corpus-readme works with no
// checkout at all.
//
// Paths come from this fixed allow-list and are never built from caller input,
// so there is no traversal surface.

const fs = require("fs");
const path = require("path");

const SCHEME = "blade-docs://";

const DOC_ENTRIES = [
  { id: "formalism", rel: "docs/formalism.md", name: "Blade formalism", description: "Canonical semantics: types, index types, loop objects, combinators, symmetry, concrete syntax." },
  { id: "quickstart-1", rel: "docs/quickstart-1.md", name: "Quickstart 1", description: "Tutorial: structure-first programming — loop reification, dimensional currying, arity polymorphism." },
  { id: "quickstart-2", rel: "docs/quickstart-2.md", name: "Quickstart 2", description: "Tutorial, part two." },
  { id: "features", rel: "docs/features.md", name: "Feature census", description: "Feature-by-feature status table (its Status column can lag the implementation)." },
  { id: "features/ppl", rel: "docs/features/ppl.md", name: "Feature: probabilistic surface", description: "Moments, comoments, distributions." },
  { id: "features/sql", rel: "docs/features/sql.md", name: "Feature: relational surface", description: "Masks, joins, group-by, set operations." },
  { id: "features/equivariant-nn", rel: "docs/features/equivariant-nn.md", name: "Feature: equivariant neural networks", description: "Irreps index types and equivariance certificates." },
  { id: "features/graphs-trees", rel: "docs/features/graphs-trees.md", name: "Feature: graphs and trees", description: "Graph and tree structures." },
  { id: "examples", rel: "docs/examples.md", name: "Examples guide", description: "Guide to the worked example programs." },
  { id: "proofs", rel: "docs/proofs.md", name: "Proofs map", description: "Which guarantees are machine-checked in Coq versus corpus-pinned." },
  { id: "readme", rel: "README.md", name: "Blade README", description: "Repository overview." },
  { id: "llms", rel: "llms.txt", name: "Blade for LLMs", description: "Condensed language reference written for language models.", mimeType: "text/plain" },
];

function uriOf(id) {
  return `${SCHEME}${id}`;
}

function absFor(ctx, entry) {
  const repo = ctx.repoRoot();
  return repo ? path.join(repo, entry.rel) : null;
}

/**
 * The corpus README, from whichever root actually has it. The corpus deployed
 * beside the binary carries the category directories but NOT the README (the
 * fsproj copies .blade files), so a checkout is the second place to look —
 * hence two candidates rather than one.
 */
function corpusReadme(ctx) {
  const candidates = [];
  const root = ctx.corpusRoot();
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
      description: "How the Blade test corpus is organized and the pin grammar its .blade files use.",
      mimeType: "text/markdown",
    });
  }
  if (ctx.repoRoot()) {
    for (const entry of DOC_ENTRIES) {
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

  const entry = DOC_ENTRIES.find((e) => e.id === id);
  if (!entry) throw new Error(`unknown resource: ${uri}`);
  const abs = absFor(ctx, entry);
  if (!abs) {
    throw new Error(
      `${uri} needs a Blade checkout: set BLADE_REPO, or point BLADE_EXE at a compiler inside one (docs/ is repo-only)`
    );
  }
  if (!fs.existsSync(abs)) throw new Error(`${uri} maps to ${entry.rel}, which is missing from the checkout at ${ctx.repoRoot()}`);
  return { contents: [{ uri, mimeType: entry.mimeType || "text/markdown", text: fs.readFileSync(abs, "utf8") }] };
}

module.exports = { SCHEME, DOC_ENTRIES, uriOf, list, read };

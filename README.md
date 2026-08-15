# blade-mcp

An [MCP](https://modelcontextprotocol.io) stdio server for the
[Blade](https://github.com/cdupuis3/Blade) array-functional programming language.

It gives an agent two things it otherwise has to fake: **adapters** onto the compiler's
own IDE protocol (typecheck, evaluate, navigate, diagnose), and a **knowledge layer**
(diagnostic explanations, idiom lookup) sourced from the compiler's generated language
surface and its test corpus rather than from prompt context.

All compiler work rides one persistent `blade ide serve` child process, spawned lazily on
the first tool call that needs it.

## Tools

| Tool | What it does |
| --- | --- |
| `blade_check` | Typecheck a file or snippet: diagnostics (with registry titles), bindings, deduced facts, counts. |
| `blade_eval` | Evaluate source in a persistent REPL session; returns output, bindings with values, and plots as image content. |
| `blade_reset_session` | Discard a session's accumulated bindings (Restart Kernel). |
| `blade_symbols` | Look up symbols **by name**: definition span, type, use count, use spans. |
| `blade_doctor` | Toolchain health (`doctor --json`) plus resolved compiler, serve availability, and version skew. |
| `blade_explain` | Everything known about a `BLxxxx` code: title, phase, explanation, fix, corpus examples. |
| `blade_corpus_find` | Find idiomatic Blade by intent, query, category, or diagnostic code. |

### `blade_check`

`{file?, source?, tier?: "fast"|"full" = "full", cwd?, raw?: false}`

- `file` alone reads that path; `source` alone is checked at a synthetic path
  `<cwd>/__blade_mcp_snippet__.blade` — **the text travels inline and no scratch file is
  ever written**; passing both gives unsaved-buffer semantics (this text, at that path).
- Spans are **1-based**, and `endCol` is **exclusive**.
- Output is trimmed by default. The compiler's payload carries four dense span tables
  (`references`, `calls`, `kernels`, `providers`) built for an editor's navigation
  features; they would dominate an agent's context, so they are omitted unless you pass
  `raw: true`. What you get instead: `ok`, `tier`, `diagnostics` (each with its registry
  `title` and `phase` when the language surface is available), `bindings`
  (`{name, kind, type, concreteType?}`), `deduced` (verbatim), and `stats` counts.

### `blade_eval`

`{source!, session? = "default", cwd?, timeoutMs? = 120000}`

Bindings accumulate across calls sharing a `session` key — append, or rebind-in-place by
top-level name, exactly like one `blade repl` submission. The default timeout is generous
because a fallback lane invokes g++. Display frames (plots) come back as MCP image content
when they are raster images under 1 MB, and as text otherwise.

### `blade_symbols`

`{file?, source?, name?, kind?, includeUses? = true, tier? = "fast", cwd?}`

One name-keyed tool rather than the editor's definition/references pair, because an agent
asks "where is `station_means`?", not "what is at line 12, column 4?". `name` matches
exactly first, then case-insensitively as a substring; the response says which happened.

### `blade_explain`

`{code!, maxExamples? = 3, includeSource? = true}`

`code` accepts `BL3016` or `3016`. Merges the compiler's registry (title, phase), the
hand-authored knowledge base (explanation, fix, docs), and a live scan of the corpus for
files that **pin** this code (`// ERROR: BLxxxx`). Each source degrades independently: an
unknown code still returns corpus examples and reports itself as unregistered, which is
itself evidence of surface-vs-binary skew.

### `blade_corpus_find`

`{query?, intent?, category?, code?, maxResults? = 8, includeSnippets? = false}`

Modes resolve in the order `code` → `category` → `intent` → `query`; **no arguments lists
every corpus category with live file counts**. `intent` is the idiom lookup: it scores a
curated index (`src/idioms.json`) that maps what you are trying to write onto the construct
that expresses it, and falls through to a content search when nothing matches.

## Resources

`blade-docs://` (text/markdown unless noted):

`formalism`, `quickstart-1`, `quickstart-2`, `features`, `features/ppl`, `features/sql`,
`features/equivariant-nn`, `features/graphs-trees`, `examples`, `proofs`, `readme`,
`llms` (text/plain) — all of which require a Blade checkout — plus `corpus-readme`, which
resolves from whichever corpus root has it (the copy deployed beside the binary, or a
checkout), so it can work without a repo.

## Configuration

Copy `.mcp.json.example`, or add this to your MCP client config:

```json
{
  "mcpServers": {
    "blade": {
      "command": "node",
      "args": ["C:/path/to/Blade-MCP/src/index.js"],
      "env": {
        "BLADE_EXE": "C:/path/to/Blade/bin/Release/net7.0/Blade.exe"
      }
    }
  }
}
```

| Variable | Effect |
| --- | --- |
| `BLADE_EXE` | Compiler binary to use (when `--compiler` is not passed). |
| `BLADE_REPO` | Blade checkout root. Enables `blade-docs://` doc resources and `examples/` paths. |
| `BLADE_CORPUS_DIR` | Override the `tests/corpus` root. |
| `BLADE_MCP_TEST_SERVE` | **Test only.** `"<exe> <args...>"` spawned instead of a compiler, for driving the server against a fake. |

### Compiler discovery

`--compiler <path>` → `BLADE_EXE` → newest-mtime of the built-in candidate paths → `Blade`
on `PATH`. Discovery is a *function*, re-run on every respawn, so the newest-build rule
keeps holding across a rebuild mid-session. `blade_doctor` reports which one was chosen and
by which rule.

If the compiler cannot be reached, the compiler-backed tools return an actionable error
naming the resolved path, its origin, and how to fix it — while `blade_doctor`,
`blade_explain`, `blade_corpus_find`, and the resources keep working.

## Development

```bash
npm install
node --check src/*.js          # syntax
npm test                       # unit + e2e (hermetic)
BLADE_EXE=/path/to/Blade.exe npm run test:integration
```

Requires Node >= 18. CommonJS throughout. `@modelcontextprotocol/sdk` is the only real
dependency; tool input schemas are hand-authored JSON Schema (`src/schemas.js`) rather
than zod.

**Logging is stderr-only.** stdout belongs to the MCP transport — one `console.log`
corrupts the JSON-RPC stream.

### `stub/ide-protocol` is temporary

`@blade-lang/ide-protocol` is the shared NDJSON client + generated language surface, which
lives in the Blade repo under `protocol/`. Until it is packed and vendored, this repo
depends on a local stub. To swap it in:

```bash
rm -rf stub/
npm pack ../Blade/protocol --pack-destination vendor
# package.json: "@blade-lang/ide-protocol": "file:vendor/blade-lang-ide-protocol-<v>.tgz"
npm install
```

No file under `src/` changes — every module consumes only the package's documented API.
While the stub is installed, `surface.json` is empty, so diagnostics arrive without titles
and `blade_explain` reports `known: false`; that is the intended graceful-degradation path,
not a bug.

## Reserved for a later phase

`blade_route` and `blade_test` are **reserved names** for wrappers over the compiler's
routing report and test runner. They are not implemented yet; nothing should claim them.

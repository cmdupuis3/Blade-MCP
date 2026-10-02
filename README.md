# blade-mcp

An [MCP](https://modelcontextprotocol.io) stdio server for the
[Blade](https://github.com/cmdupuis3/Blade) array-functional programming language.

It gives an agent two things it otherwise has to fake: **adapters** onto the compiler's
own IDE protocol (typecheck, evaluate, navigate, diagnose), and a **knowledge layer**
(diagnostic explanations, idiom lookup) sourced from the compiler's generated language
surface and its test corpus rather than from prompt context.

All compiler work rides one persistent `blade ide serve` child process, spawned lazily on
the first tool call that needs it.

## Tools

| Tool | What it does |
| --- | --- |
| `blade_check` | Typecheck a file or snippet: diagnostics (with registry titles), bindings, provider stores, deduced facts, counts. |
| `blade_eval` | Evaluate source in a persistent REPL session; returns output, the value of the final bare expression, and plots as **PNG image content** (rendered through GR). |
| `blade_reset_session` | Discard a session's accumulated bindings (Restart Kernel). |
| `blade_symbols` | Look up symbols **by name**: definition span, type, use count, use spans. |
| `blade_doctor` | Toolchain health (`doctor --json`) plus resolved compiler, serve availability, GR availability, version skew, and surface drift. |
| `blade_explain` | Everything known about a `BLxxxx` code: title, phase, explanation, fix, corpus examples. |
| `blade_corpus_find` | Find idiomatic Blade by intent, query, category, or diagnostic code. |

Arguments are validated against each tool's schema before anything runs: an unknown name
(with a "did you mean"), a wrong type, or an out-of-range value returns `isError` with
`invalidArguments`. Nothing is coerced.

### `blade_check`

`{file?, source?, tier?: "fast"|"full" = "full", cwd?, timeoutMs?, raw?: false}`

- `file` alone reads that path; `source` alone is checked at a synthetic path
  `<cwd>/__blade_mcp_snippet__.blade` — **the text travels inline and no scratch file is
  ever written**; passing both gives unsaved-buffer semantics (this text, at that path).
- A leading UTF-8 BOM is stripped, and text containing a lone surrogate is refused up front.
- Spans are **1-based**, and `endCol` is **exclusive**.
- **Neither tier runs code generation.** `fast` is parse + typecheck + deduction; `full`
  adds lowering and monomorphization. A construct only the C++ backend refuses (BL7xxx)
  checks clean, and `blade_eval`'s interpreter lane runs it too — only `blade emit` /
  `blade run` on the command line reports it.
- Output is trimmed by default. The compiler's payload carries three dense span tables
  (`references`, `calls`, `kernels`) built for an editor's navigation features; they would
  dominate an agent's context, so they are omitted unless you pass `raw: true`. What you
  get instead:
  - `ok`, `tier`, and `compilerVersion` (the live binary's);
  - `diagnostics`, each with its registry `title` and `phase` when the language surface
    is available;
  - `bindings` — `{name, kind, line, type, concreteType?, where?, deducedComm?,
    providerRead?, providerWrite?}`, capped at 300 (`bindingsOmitted` counts the rest);
  - `providers` — each store's alias, provider, path, index types, dims and vars — when
    the program has any;
  - `deduced` (verbatim) and `stats` counts.

### `blade_eval`

`{source!, session? = "default", cwd?, timeoutMs? = 120000, plotWidth? = 800, plotHeight? = 600}`

Bindings accumulate across calls sharing a `session` key — append, or rebind-in-place by
top-level name, exactly like one `blade repl` submission. The default timeout is generous
because a fallback lane invokes g++.

- **Only a trailing bare expression is echoed back.** Declarations are silent, so end with
  the expression or name whose value you want; `bindings` holds at most that one entry.
- `diagnostics` have the same shape as `blade_check`'s, including runtime panics
  (BL8006, BL8013, BL8014).
- **A timeout kills the compiler process, which discards every session's definitions.**
  The error carries `cause: "timeout"` and `sessionsLost: true`; a session's first eval
  after a restart reports `sessionRestarted` with a `sessionNote`.
- A plot bound in an earlier submission is not re-sent: only new or changed display frames
  are delivered (`displayFramesUnchanged` counts the rest), at most 24 per eval
  (`displayFramesOmitted`).

**Plots come back as pictures.** A raster display frame (`image/*`, base64) is passed
through as MCP image content. A *plotly* frame is a figure **spec** — JSON an agent cannot
see — so when a [GR runtime](#gr-runtime-plots-as-images) is available this server re-renders
it through the compiler's `renderPlot` verb and sends the PNG instead, preceded by a one-line
`[plot: <title> — GR render, WxH]` label so the figure can be referred to by name. Nothing
re-runs: the render is a post-hoc transformation of the spec the program already emitted.
`plotWidth`/`plotHeight` (64–4096) set the render size; at the 800x600 default a typical
line plot is under 30 KB.

Every failure on that path degrades to the previous behavior — the figure's JSON as text —
and **never** fails the eval:

| Situation | What you get |
| --- | --- |
| No GR runtime found | JSON text + `plotRenderNote` naming the reason and how to fix it |
| The compiler predates `renderPlot`, or its GR worker cannot start | JSON text + `plotRenderNote`; rendering is then skipped for the rest of that eval rather than re-timing-out per figure |
| The render exceeds the 1 MB inline cap | The same `[display frame omitted: …]` placeholder any oversized image gets |
| More than 8 figures in one eval | The first 8 are rendered; the rest are JSON text, with one note |

`plotsRendered` counts the images; `plotRenderNote` appears at most once per call.

### `blade_symbols`

`{file?, source?, name?, kind?, includeUses? = true, tier? = "fast", cwd?, timeoutMs?}`

One name-keyed tool rather than the editor's definition/references pair, because an agent
asks "where is `station_means`?", not "what is at line 12, column 4?". `name` matches
exactly first, then case-insensitively as a substring; the response says which happened.

- `kind` is the reference class (`value`, `function`, `param`, `local`, `type`);
  `bindingKind` is the source spelling (`let`, `let mut`, `static`, `static function`, …).
  The `kind` filter accepts either, case-insensitively.
- Caps: 100 symbols, 50 uses per symbol, 300 uses per response. `useCount` stays exact.
- Not covered, because the compiler's tables do not carry them: uses of named types, and
  units, import aliases, imported names and block-local `let`s as symbols.

### `blade_explain`

`{code!, maxExamples? = 3, includeSource? = true}`

`code` accepts `BL3016`, `bl3016` or `3016`. Merges the compiler's registry (title, phase),
the hand-authored knowledge base (explanation, fix, docs), and a live scan of the corpus for
files that **pin** this code — `// ERROR: BLxxxx [@ l:c]`, `// WARN: BLxxxx`, or an
`// ABORT:` line naming it — best example first. `pinnedAs` counts files per pin kind. A
pinned span (`at`) counts lines without the file's `// TEST:` line, so each also carries
`atInFile`. `docs[].uri` appears only when a `blade-docs://` resource serves that file.

Each source degrades independently: a code this server's surface does not register still
returns its corpus examples, with `registered: false` and a note saying whether the
corpus pins it (the compiler emits it) or it is simply unknown.

### `blade_corpus_find`

`{query?, intent?, category?, code?, maxResults? = 8, includeSnippets? = false}`

Modes resolve in the order `code` → `category` → `intent` → `query`; **no arguments lists
every corpus category with live file counts**. `intent` is the idiom lookup: it scores a
curated index (`src/idioms.json`) that maps what you are trying to write onto the construct
that expresses it. It matches whole words and keyword phrases, and falls through to a
content search when nothing scores well enough to recommend.

- Categories are discovered from disk. A multi-file category also reports `tests`; the
  wholly-negative ones are marked `rejectOnly`.
- `code` finds `// ERROR:`, `// WARN:` and `// ABORT:` pins.
- `category: "examples"` (or `"examples/physics"`) lists the worked programs.
- Results mark probes with `kind: "rejects" | "aborts"` — those are not code to imitate.
- Corpus root: `BLADE_CORPUS_DIR`, else a checkout's live `tests/corpus`, else the copy
  deployed beside the binary. `corpusOrigin` says which one answered.

## Resources

`blade-docs://` (text/markdown unless noted):

`agent-guide` (the Blade repo's CLAUDE.md — start here), `formalism`, `quickstart-1`,
`quickstart-2`, `features`, `features/<page>`, `examples`, `examples-readme`,
`examples/physics`, `proofs`, `plans`, `plans/<doc>`, `plans/structural/<doc>`,
`docs-index`, `readme`, and `stdlib/stats`, `stdlib/plot`, `stdlib/units/SI` (text/plain).
All of these need a Blade checkout; feature pages and design docs are discovered from disk.
`corpus-readme` resolves from whichever corpus root has it, so it can work without a repo.

## Configuration

Copy `.mcp.json.example`, or add this to your MCP client config:

```json
{
  "mcpServers": {
    "blade": {
      "command": "node",
      "args": ["C:/path/to/Blade-MCP/src/index.js"],
      "env": {
        "BLADE_EXE": "C:/path/to/Blade/bin/Release/net10.0/Blade.exe",
        "BLADE_REPO": "C:/path/to/Blade"
      }
    }
  }
}
```

For Claude Code, the same registration at user scope is one command:

```bash
claude mcp add --scope user blade -e BLADE_EXE=C:/path/to/Blade/bin/Release/net10.0/Blade.exe -e BLADE_REPO=C:/path/to/Blade -- node C:/path/to/Blade-MCP/src/index.js
```

Anything that evaluates through the compiled fallback lane also needs g++ on the server's
`PATH` (MSYS2 ucrt64 on Windows), exactly as `blade run` does.

| Variable | Effect |
| --- | --- |
| `BLADE_EXE` | Compiler binary to use (when `--compiler` is not passed). |
| `BLADE_REPO` | Blade checkout root. Enables `blade-docs://` doc resources and `examples/` paths, and is the first place compiler discovery looks for a build. |
| `BLADE_CORPUS_DIR` | Override the `tests/corpus` root (default: a checkout's live tree, then the copy deployed beside the binary). |
| `BLADE_GR_PATH` | GR installation root used to render plots as images. Explicit: if it is set but not a usable GR tree, that is reported (naming the missing files) rather than silently falling through to another one. |
| `GRDIR` | Honoured as the next candidate after `BLADE_GR_PATH`, so a shell that can already run GR needs no extra configuration. |
| `BLADE_MCP_TEST_SERVE` | **Test only.** `<exe> <args...>` spawned instead of a compiler, for driving the server against a fake. An exe path containing spaces works either quoted (`"C:\Program Files\nodejs\node.exe" fake-serve.js`) or bare; argument paths must not contain spaces. |

### Compiler discovery

`--compiler <path>` → `BLADE_EXE` → the newest-mtime build among
`<BLADE_REPO>/bin/{Release,Debug}/<tfm>/Blade.exe` and the same paths under a sibling
`../Blade` checkout → `Blade` on `PATH`. The framework directory is read off the protocol
package, not hardcoded here. Discovery is a *function*, re-run on every respawn, so the
newest-build rule keeps holding across a rebuild mid-session. `blade_doctor` reports which
one was chosen and by which rule.

If the compiler cannot be reached, the compiler-backed tools return an error with a `cause`
(`timeout`, `crash`, `backoff`, `protocol`, `unavailable`) and the remediation for that
cause — while `blade_doctor`, `blade_explain`, `blade_corpus_find`, and the resources keep
working. A client that failed to start is rebuilt when the binary's path or mtime changes,
and `blade_doctor` always re-probes.

**The version string does not detect a stale binary** — it has been `0.20.0` across months
of language changes. `blade_doctor` therefore also reports `surfaceDrift`: the live
binary's `ide surface` (diagnostic codes, builtins) compared with the packaged surface. A
non-empty drift means the binary and this server's vendored package are from different
compiler states; rebuild the compiler or re-vendor the package. `toolchainIssues` lifts
doctor's warn/error rows, and `ok` requires both a healthy toolchain and a reachable
`ide serve`.

### GR runtime (plots as images)

Rendering a figure spec to a PNG needs a **GR installation** (<https://gr-framework.org>) —
a directory containing `bin/` and `fonts/`. It is optional: without one, plots degrade to
JSON text and everything else is unaffected. `blade_doctor` reports what was found under
`grRuntime`.

Resolution order: `BLADE_GR_PATH` → `GRDIR` → `<this repo>/vendor/gr` → `<sibling>/Blade-REPL/vendor/gr`
(the VS Code extension checkout's `npm run fetch-vendor` tree, when the two repos are cloned
side by side). A root is validated file-by-file before it is used, because **every way of
misconfiguring GR fails silently**: no `GRDIR` is an access violation with no output, and
missing DLLs are a spawn failure with no error text. For the same reason the `ide serve`
child is told where GR is explicitly — `GRDIR` set, `GKS_WSTYPE=100` (the null
workstation, so no stray Qt process spawns), and `GR_DISPLAY` removed.

`PATH` is deliberately **not** modified. A GR distribution bundles its own
`libstdc++-6.dll`, `libgcc_s_seh-1.dll` and `libwinpthread-1.dll`; ahead of the toolchain's
on `PATH` they are what g++ loads, and g++ then exits 1 with no output — which broke every
eval that needed the compiled lane on exactly the hosts where plots worked. The compiler
puts `<GRDIR>/bin` on its GR worker's `PATH` itself.

## Development

```bash
npm install
node --check src/*.js          # syntax
npm test                       # unit + e2e (hermetic)
BLADE_EXE=/path/to/Blade.exe npm run test:integration
```

`BLADE_REPO=<checkout> npm test` also runs two checkout-gated tests that are otherwise
skipped. The integration suite re-derives the `test/fixtures/check-*.json` payloads from
the real compiler and fails on drift, so the hermetic fake cannot quietly fall behind the
wire format.

Requires Node >= 24. CommonJS throughout. `@modelcontextprotocol/sdk` is the only real
dependency; tool input schemas are hand-authored JSON Schema (`src/schemas.js`) rather
than zod.

**Logging is stderr-only.** stdout belongs to the MCP transport — one `console.log`
corrupts the JSON-RPC stream.

### The vendored `@blade-lang/ide-protocol`

`@blade-lang/ide-protocol` is the shared NDJSON client + generated language surface, which
lives in the Blade repo under `protocol/`. It is vendored here as a tarball under `vendor/`
(currently **0.20.0** — the plot upgrade needs its `renderPlot` verb and its `env` spawn
dependency). To refresh it after a compiler change:

```bash
npm run vendor:protocol          # npm pack ../Blade/protocol --pack-destination vendor
# package.json: "@blade-lang/ide-protocol": "file:vendor/blade-lang-ide-protocol-<v>.tgz"
npm install ./vendor/blade-lang-ide-protocol-<v>.tgz
git rm --cached vendor/blade-lang-ide-protocol-<old>.tgz && rm vendor/blade-lang-ide-protocol-<old>.tgz
```

Install the tarball **by path**. The package's version tracks the compiler's and often does
not change between re-packs, and a plain `npm install` then does nothing: `node_modules`
keeps the old copy and `package-lock.json` keeps the old integrity hash (so `npm ci` fails
later). `blade_doctor`'s `surfaceDrift` and the integration suite's packaged-surface
subtest both catch a stale copy.

Against an older package `surface.json` may be empty, so diagnostics arrive without titles
and `blade_explain` reports `known: false`; that is the intended graceful-degradation path,
not a bug.

## Reserved for a later phase

`blade_route` and `blade_test` are **reserved names** for wrappers over the compiler's
routing report and test runner. They are not implemented yet; nothing should claim them.

# `@blade-lang/ide-protocol` — STUB

**This directory is temporary scaffolding and is deleted at integration.**

The real package is generated in the Blade repo under `protocol/`, co-located with its
source of truth (`src/IdeServe.fs` / `src/Ide.fs`), and ships here as a vendored
`npm pack` tarball. This stub exists only so `src/**` can be written, loaded, and
smoke-tested before that tarball exists.

## Swapping in the real package

```bash
rm -rf stub/
npm pack ../Blade/protocol --pack-destination vendor
# package.json:
#   "@blade-lang/ide-protocol": "file:vendor/blade-lang-ide-protocol-<version>.tgz"
npm install
```

**No file under `src/` changes.** Every consumer touches only the documented API:
`createClient`, `resolveCompiler`, `resolveRepoRoot`, `DEFAULT_CANDIDATES`, `display`,
`serveProto`, `replProto`, and the lazy `surface` / `diagnosticsKb` getters.

## What this stub simplifies

Faithful: the NDJSON wire protocol — id correlation, `\r\n` tolerance, `event` lines never
settling a pending id, `{"error": ...}` responses rejecting with `err.protocolError = true`
without tearing the process down, the tri-state availability latch, and `dispose()` writing
`{"cmd":"shutdown"}` before killing.

Simplified (documented deviations):

- restart backoff is a single retry gate instead of the real `[500, 2000, 8000]` ladder;
- `surface` returns an empty-but-well-shaped registry (`compilerVersion: "stub"`) and
  `diagnosticsKb` returns `{version: 1, codes: {}}`, so consumers exercise their
  graceful-degradation paths (diagnostics render with no `title`, `blade_explain` reports
  `known: false`) for as long as the stub is installed;
- display frame validation checks mime/encoding/data presence only.

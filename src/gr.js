"use strict";

// GR runtime resolution for the compiler's `renderPlot` verb.
//
// `renderPlot` makes the compiler spawn a native GR worker that resolves its
// shared libraries and fonts off GRDIR/PATH. Every way of getting that wrong
// fails SILENTLY and catastrophically: no GRDIR is an access violation with
// zero output, DLLs missing from PATH is a spawn failure with no error text.
// So nothing here invokes GR on faith — a root is validated file-by-file
// before this server will claim GR is available, and the serve child is told
// where it is (GRDIR) explicitly rather than left with "whatever the shell
// had". The compiler composes the WORKER's environment from that; this module
// must not do it for the serve process itself (see grEnv for why).
//
// This module is pure data-in/data-out (no process spawning, no I/O beyond
// fs.existsSync, and every seam injectable), so it unit-tests without a GR
// installation.
//
// Resolution precedence — explicit first, then conventional locations:
//
//   1. BLADE_GR_PATH — explicit wins, and an explicitly configured-but-broken
//      path is an ERROR, not a fall-through: someone who pointed this server
//      at a tree wants to hear that it is missing cairoplugin.dll, not have
//      a different GR quietly used instead.
//   2. GRDIR — the variable GR itself reads, so honouring it means a shell
//      that can already run GR needs no blade-mcp-specific configuration.
//   3. `<blade-mcp>/vendor/gr` — this repo's own vendor tree, if one is ever
//      fetched here.
//   4. `<sibling>/Blade-REPL/vendor/gr` — the VS Code extension checkout beside
//      this one populates `vendor/gr` with `npm run fetch-vendor`, and the two
//      repos are conventionally cloned side by side. Reusing that download is
//      worth one existsSync; it is the last candidate precisely because it is
//      a guess about the developer's layout.
//
// Nothing found is not an error. GR is optional: blade_eval degrades to the
// JSON-text rendering of a figure exactly as it did before this module.

const path = require("path");
const fs = require("fs");

// Per-platform relative paths that must exist under a GR root for the
// headless render path to work. win32 is the verified set (it mirrors the
// files the Blade extension's vendor fetch keeps); the other platforms are
// best-effort until exercised — the shared library plus fonts is the minimum
// any GR tree needs.
const REQUIRED = {
  win32: ["bin/libGR.dll", "bin/libGKS.dll", "bin/cairoplugin.dll", "fonts"],
  linux: ["lib/libGR.so", "fonts"],
  darwin: ["lib/libGR.dylib", "fonts"],
};

/** Which files a GR root must contain on `platform` (defaults to this one). */
function requiredFiles(platform) {
  return REQUIRED[platform || process.platform] || ["fonts"];
}

/** `{ok: true}` or `{ok: false, missing: [relPath, ...]}`. */
function validateRoot(root, opts) {
  const o = opts || {};
  const exists = o.exists || fs.existsSync;
  if (!root || !exists(root)) return { ok: false, missing: ["<root>"] };
  const missing = requiredFiles(o.platform).filter((rel) => !exists(path.join(root, rel)));
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/**
 * Resolve a usable GR installation root.
 *
 * opts: {
 *   env,           // environment to read BLADE_GR_PATH / GRDIR from
 *   repoRoot,      // this checkout's root (for <repoRoot>/vendor/gr and its siblings)
 *   platform, exists,  // test seams
 * }
 *
 * Returns `{ok: true, grdir, source}` with source ∈ "BLADE_GR_PATH" | "GRDIR" |
 * "vendor" | "sibling", or `{ok: false, reason}` with a message ready to hand
 * an agent verbatim.
 */
function resolveGr(opts) {
  const o = opts || {};
  const env = o.env || process.env;

  const configured = String(env.BLADE_GR_PATH || "").trim();
  if (configured) {
    const v = validateRoot(configured, o);
    if (v.ok) return { ok: true, grdir: configured, source: "BLADE_GR_PATH" };
    return {
      ok: false,
      reason: `BLADE_GR_PATH is set to "${configured}" but it is not a usable GR installation (missing: ${v.missing.join(", ")})`,
    };
  }

  const candidates = [];
  const grdirEnv = String(env.GRDIR || "").trim();
  if (grdirEnv) candidates.push({ root: grdirEnv, source: "GRDIR" });
  if (o.repoRoot) {
    candidates.push({ root: path.join(o.repoRoot, "vendor", "gr"), source: "vendor" });
    candidates.push({ root: path.join(path.dirname(o.repoRoot), "Blade-REPL", "vendor", "gr"), source: "sibling" });
  }
  for (const c of candidates) {
    if (validateRoot(c.root, o).ok) return { ok: true, grdir: c.root, source: c.source };
  }
  return {
    ok: false,
    reason:
      "no GR installation found — set BLADE_GR_PATH (or GRDIR) to a GR root " +
      "(a directory containing bin/ and fonts/), or run `npm run fetch-vendor` " +
      "in a Blade-REPL checkout beside this one",
  };
}

/**
 * Compose the environment of the `ide serve` child so the compiler can find
 * GR, layered over `baseEnv` (normally process.env, never mutated):
 *
 *   GRDIR       — the install root. This is the ONE thing the compiler needs
 *                 from us: `renderPlot` reads it, validates `<GRDIR>/bin`, and
 *                 composes its GR worker's environment itself (GRDIR, the bin
 *                 dir on the WORKER's PATH, the null workstation),
 *   GKS_WSTYPE  — "100" (the null workstation): without it GR's Windows
 *                 default is gksqt, and a stray Qt process can spawn,
 *   GR_DISPLAY  — removed, same reason.
 *
 * PATH IS DELIBERATELY LEFT ALONE. `<grdir>/bin` must NOT be put on the serve
 * process's PATH: a GR distribution bundles its own libstdc++-6.dll,
 * libgcc_s_seh-1.dll and libwinpthread-1.dll, and ahead of the toolchain's
 * they are what g++'s own executables load. g++ then exits 1 with no output —
 * so every eval that needed the compiled fallback lane failed, on exactly the
 * hosts where plots worked. The worker gets GR's bin dir from the compiler;
 * the serve process (which never loads GR) keeps the PATH it was given.
 *
 * The result is a COMPLETE environment (the parent's plus these), because the
 * protocol client hands it to cp.spawn, where an `env` object replaces rather
 * than extends.
 */
function grEnv(grdir, baseEnv) {
  const base = baseEnv || process.env;
  const env = Object.assign({}, base);
  env.GRDIR = grdir;
  env.GKS_WSTYPE = "100";
  delete env.GR_DISPLAY;
  return env;
}

module.exports = { resolveGr, validateRoot, requiredFiles, grEnv };

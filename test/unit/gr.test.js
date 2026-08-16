"use strict";

// gr.js: GR root resolution precedence, root validation, and the composed
// child environment. Every filesystem probe is injected (`exists`), so these
// run identically on a machine with no GR installed.

const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const gr = require("../../src/gr");

/** An `exists` double: true for exactly the paths under `roots`. */
function existsUnder(roots) {
  const list = Array.isArray(roots) ? roots : [roots];
  return (p) => list.some((r) => path.resolve(p) === path.resolve(r) || path.resolve(p).startsWith(path.resolve(r) + path.sep));
}

const WIN = { platform: "win32" };

test("validateRoot: a tree with every required entry is ok", () => {
  const v = gr.validateRoot("C:/gr", Object.assign({ exists: existsUnder("C:/gr") }, WIN));
  assert.deepEqual(v, { ok: true });
});

test("validateRoot: a missing root reports <root>, not a per-file list", () => {
  const v = gr.validateRoot("C:/nope", Object.assign({ exists: () => false }, WIN));
  assert.equal(v.ok, false);
  assert.deepEqual(v.missing, ["<root>"]);
});

test("validateRoot: a partial tree names exactly what is missing", () => {
  const exists = (p) => {
    const s = String(p).replace(/\\/g, "/");
    return s === "C:/gr" || s.endsWith("bin/libGR.dll") || s.endsWith("fonts");
  };
  const v = gr.validateRoot("C:/gr", Object.assign({ exists }, WIN));
  assert.equal(v.ok, false);
  assert.deepEqual(v.missing.sort(), ["bin/cairoplugin.dll", "bin/libGKS.dll"]);
});

test("resolveGr: BLADE_GR_PATH wins and reports source 'BLADE_GR_PATH'", () => {
  const r = gr.resolveGr(
    Object.assign(
      {
        env: { BLADE_GR_PATH: "C:/explicit-gr", GRDIR: "C:/env-gr" },
        repoRoot: "C:/repo",
        exists: existsUnder(["C:/explicit-gr", "C:/env-gr"]),
      },
      WIN
    )
  );
  assert.deepEqual(r, { ok: true, grdir: "C:/explicit-gr", source: "BLADE_GR_PATH" });
});

test("resolveGr: a broken BLADE_GR_PATH is an ERROR naming the missing files, never a fall-through", () => {
  const r = gr.resolveGr(
    Object.assign(
      {
        env: { BLADE_GR_PATH: "C:/broken-gr", GRDIR: "C:/env-gr" },
        exists: existsUnder(["C:/broken-gr", "C:/env-gr"].filter((p) => p !== "C:/broken-gr")),
      },
      WIN
    )
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /BLADE_GR_PATH is set to "C:\/broken-gr"/);
  assert.match(r.reason, /missing/);
});

test("resolveGr: GRDIR is the next candidate", () => {
  const r = gr.resolveGr(
    Object.assign({ env: { GRDIR: "C:/env-gr" }, repoRoot: "C:/repo", exists: existsUnder("C:/env-gr") }, WIN)
  );
  assert.deepEqual(r, { ok: true, grdir: "C:/env-gr", source: "GRDIR" });
});

test("resolveGr: falls back to <repoRoot>/vendor/gr, then a sibling Blade-REPL checkout", () => {
  const vendor = path.join("C:/gh/Blade-MCP", "vendor", "gr");
  const own = gr.resolveGr(Object.assign({ env: {}, repoRoot: "C:/gh/Blade-MCP", exists: existsUnder(vendor) }, WIN));
  assert.deepEqual(own, { ok: true, grdir: vendor, source: "vendor" });

  const sibling = path.join("C:/gh", "Blade-REPL", "vendor", "gr");
  const next = gr.resolveGr(Object.assign({ env: {}, repoRoot: "C:/gh/Blade-MCP", exists: existsUnder(sibling) }, WIN));
  assert.deepEqual(next, { ok: true, grdir: sibling, source: "sibling" });
});

test("resolveGr: nothing found is a non-fatal {ok:false} with an actionable reason", () => {
  const r = gr.resolveGr(Object.assign({ env: {}, repoRoot: "C:/gh/Blade-MCP", exists: () => false }, WIN));
  assert.equal(r.ok, false);
  assert.match(r.reason, /BLADE_GR_PATH/);
});

test("grEnv: sets GRDIR/GKS_WSTYPE, prepends <grdir>/bin to PATH, drops GR_DISPLAY", () => {
  const out = gr.grEnv("C:/gr", { PATH: "C:/windows", GR_DISPLAY: "gksqt", KEEP: "me" });
  assert.equal(out.GRDIR, "C:/gr");
  assert.equal(out.GKS_WSTYPE, "100");
  assert.equal(out.GR_DISPLAY, undefined);
  assert.equal(out.KEEP, "me");
  assert.equal(out.PATH, path.join("C:/gr", "bin") + path.delimiter + "C:/windows");
});

test("grEnv: preserves the existing PATH key's CASE — a second 'PATH' would be ignored by Windows", () => {
  const out = gr.grEnv("C:/gr", { Path: "C:/windows" });
  assert.equal(out.PATH, undefined);
  assert.match(out.Path, /^C:[\\/]gr[\\/]bin/);
});

test("grEnv: does not mutate the base environment", () => {
  const base = { PATH: "C:/windows" };
  gr.grEnv("C:/gr", base);
  assert.deepEqual(base, { PATH: "C:/windows" });
});

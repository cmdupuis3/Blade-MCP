"use strict";

// compiler.js: BLADE_MCP_TEST_SERVE parsing, discovery precedence
// (explicit/env/candidate/path — delegated to an injectable pkg.resolveCompiler
// so a fake pkg can pin it), and the shared tool-result/error shapes.

const path = require("path");
const os = require("os");
const fs = require("fs");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const compiler = require("../../src/compiler");
const { makeFakeGrRoot, NO_SUCH_GR } = require("../helpers");

function fakePkg(overrides) {
  const o = overrides || {};
  return Object.assign(
    {
      resolveCompiler: (opts) => ({ exe: "Blade", origin: "path", __opts: opts }),
      resolveRepoRoot: () => undefined,
      DEFAULT_CANDIDATES: ["/fake/bin/Release/net7.0/Blade.exe"],
      createClient: () => ({ available: () => "unknown" }),
      display: { subscribe: () => ({ dispose() {} }), setLogger: () => {} },
    },
    o
  );
}

// --- splitTestServe -----------------------------------------------------------

test("splitTestServe: undefined/empty -> undefined", () => {
  assert.equal(compiler.splitTestServe(undefined), undefined);
  assert.equal(compiler.splitTestServe(""), undefined);
  assert.equal(compiler.splitTestServe("   "), undefined);
});

test("splitTestServe: a quoted exe with args", () => {
  const out = compiler.splitTestServe('"C:\\fake path\\node.exe" fake-serve.js --flag');
  assert.equal(out.exe, "C:\\fake path\\node.exe");
  assert.deepEqual(out.args, ["fake-serve.js", "--flag"]);
});

test("splitTestServe: a quoted exe with no args", () => {
  const out = compiler.splitTestServe('"C:\\fake path\\node.exe"');
  assert.equal(out.exe, "C:\\fake path\\node.exe");
  assert.deepEqual(out.args, []);
});

test("splitTestServe: unquoted, single-token exe (e.g. 'node')", () => {
  const out = compiler.splitTestServe("node fake-serve.js");
  assert.equal(out.exe, "node");
  assert.deepEqual(out.args, ["fake-serve.js"]);
});

test("splitTestServe: unquoted exe path containing spaces grows until a real file matches", () => {
  // Build a real file at a space-containing path so existsSync can find it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blade-mcp-spaced "));
  const exe = path.join(dir, "node fake.exe");
  fs.writeFileSync(exe, "");
  try {
    const out = compiler.splitTestServe(`${exe} arg1 arg2`);
    assert.equal(out.exe, exe);
    assert.deepEqual(out.args, ["arg1", "arg2"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("splitTestServe: unquoted exe with spaces but no args, and no file matches -> falls back to first token", () => {
  const out = compiler.splitTestServe("this file does not exist anywhere.exe");
  assert.equal(out.exe, "this");
  assert.deepEqual(out.args, ["file", "does", "not", "exist", "anywhere.exe"]);
});

// --- discovery precedence (via createContext) ----------------------------------

test("resolved(): BLADE_MCP_TEST_SERVE wins over everything, origin 'test-serve'", () => {
  const ctx = compiler.createContext({
    compilerPath: "/explicit/Blade.exe",
    env: { BLADE_MCP_TEST_SERVE: "node fake-serve.js", BLADE_EXE: "/env/Blade.exe" },
    pkg: fakePkg(),
  });
  const r = ctx.resolved();
  assert.equal(r.exe, "node");
  assert.equal(r.origin, "test-serve");
});

test("resolved(): without TEST_SERVE, delegates to pkg.resolveCompiler with {explicitPath, env}", () => {
  let seenOpts;
  const ctx = compiler.createContext({
    compilerPath: "/explicit/Blade.exe",
    env: { BLADE_EXE: "/env/Blade.exe" },
    pkg: fakePkg({
      resolveCompiler: (opts) => {
        seenOpts = opts;
        return { exe: "/explicit/Blade.exe", origin: "explicit" };
      },
    }),
  });
  const r = ctx.resolved();
  assert.equal(r.origin, "explicit");
  assert.equal(seenOpts.explicitPath, "/explicit/Blade.exe");
  assert.equal(seenOpts.env.BLADE_EXE, "/env/Blade.exe");
});

test("resolved(): is re-evaluated on every call (a respawn can pick up a rebuild)", () => {
  let calls = 0;
  const ctx = compiler.createContext({
    env: {},
    pkg: fakePkg({
      resolveCompiler: () => {
        calls++;
        return { exe: `/build-${calls}/Blade.exe`, origin: "candidate" };
      },
    }),
  });
  const first = ctx.resolved();
  const second = ctx.resolved();
  assert.notEqual(first.exe, second.exe);
  assert.equal(calls, 2);
});

test("getClient(): deps.args is set from TEST_SERVE's parsed args, and findCompiler re-resolves per spawn", () => {
  let seenDeps;
  const ctx = compiler.createContext({
    env: { BLADE_MCP_TEST_SERVE: '"C:\\node.exe" fake-serve.js' },
    pkg: fakePkg({
      createClient: (deps) => {
        seenDeps = deps;
        return { available: () => "unknown" };
      },
    }),
  });
  ctx.getClient();
  assert.deepEqual(seenDeps.args, ["fake-serve.js"]);
  assert.equal(typeof seenDeps.findCompiler, "function");
  assert.equal(seenDeps.findCompiler(), "C:\\node.exe");
});

test("getClient(): without TEST_SERVE, deps.args is left unset so the package's default ['ide','serve'] applies", () => {
  let seenDeps;
  const ctx = compiler.createContext({
    env: {},
    pkg: fakePkg({
      createClient: (deps) => {
        seenDeps = deps;
        return { available: () => "unknown" };
      },
    }),
  });
  ctx.getClient();
  assert.equal(seenDeps.args, undefined);
});

test("getClient(): a lazy singleton — only constructed once per context", () => {
  let constructCount = 0;
  const ctx = compiler.createContext({
    env: {},
    pkg: fakePkg({
      createClient: () => {
        constructCount++;
        return { available: () => "unknown" };
      },
    }),
  });
  const a = ctx.getClient();
  const b = ctx.getClient();
  assert.equal(a, b);
  assert.equal(constructCount, 1);
});

// --- GR plumbing ----------------------------------------------------------------

test("grRuntime(): BLADE_GR_PATH at a valid tree resolves, and getClient passes a GR env FUNCTION", () => {
  const gr = makeFakeGrRoot();
  let seenDeps;
  try {
    const ctx = compiler.createContext({
      env: { BLADE_GR_PATH: gr.root, PATH: "C:/windows", GR_DISPLAY: "gksqt" },
      pkg: fakePkg({
        createClient: (deps) => {
          seenDeps = deps;
          return { available: () => "unknown" };
        },
      }),
    });
    assert.equal(ctx.grRuntime().ok, true);
    assert.equal(ctx.grRuntime().grdir, gr.root);

    ctx.getClient();
    // A function, not an object: the protocol client re-reads it per spawn.
    assert.equal(typeof seenDeps.env, "function");
    const childEnv = seenDeps.env();
    assert.equal(childEnv.GRDIR, gr.root);
    assert.equal(childEnv.GKS_WSTYPE, "100");
    assert.equal(childEnv.GR_DISPLAY, undefined, "GR_DISPLAY must be removed or a stray Qt process can spawn");
    assert.ok(childEnv.PATH.startsWith(path.join(gr.root, "bin") + path.delimiter), "the GR bin dir must come FIRST on PATH");
    assert.match(childEnv.PATH, /C:\/windows$/, "the inherited PATH must survive");
  } finally {
    gr.dispose();
  }
});

test("grRuntime(): with no GR anywhere, deps.env returns undefined — plain inheritance, the pre-GR behavior", () => {
  let seenDeps;
  const ctx = compiler.createContext({
    env: { BLADE_GR_PATH: NO_SUCH_GR },
    pkg: fakePkg({
      createClient: (deps) => {
        seenDeps = deps;
        return { available: () => "unknown" };
      },
    }),
  });
  const g = ctx.grRuntime();
  assert.equal(g.ok, false);
  assert.match(g.reason, /BLADE_GR_PATH/);
  ctx.getClient();
  assert.equal(seenDeps.env(), undefined);
});

test("grRuntime(): resolved once and cached (an existsSync sweep per spawn would be waste)", () => {
  const ctx = compiler.createContext({ env: { BLADE_GR_PATH: NO_SUCH_GR }, pkg: fakePkg() });
  assert.equal(ctx.grRuntime(), ctx.grRuntime());
});

// --- tool result / error shapes -------------------------------------------------

test("toolResult: content is pretty-printed JSON text plus structuredContent", () => {
  const r = compiler.toolResult({ ok: true, n: 1 });
  assert.equal(r.structuredContent.ok, true);
  assert.equal(r.content[0].type, "text");
  assert.deepEqual(JSON.parse(r.content[0].text), { ok: true, n: 1 });
  assert.equal(r.isError, undefined);
});

test("toolError: sets isError:true and ok:false", () => {
  const r = compiler.toolError("boom", { extra: 1 });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.ok, false);
  assert.equal(r.structuredContent.error, "boom");
  assert.equal(r.structuredContent.extra, 1);
});

test("UserError: carries userFacing:true and details", () => {
  const e = new compiler.UserError("nope", { foo: 1 });
  assert.equal(e.userFacing, true);
  assert.deepEqual(e.details, { foo: 1 });
  assert.equal(e.message, "nope");
});

test("remediationFor: origin 'path' prepends a 'no local build found' line naming candidates", () => {
  const ctx = { pkg: { DEFAULT_CANDIDATES: ["/a/Blade.exe", "/b/Blade.exe"] } };
  const lines = compiler.remediationFor(ctx, { exe: "Blade", origin: "path" });
  assert.match(lines[0], /No local build was found/);
  assert.match(lines[0], /\/a\/Blade\.exe, \/b\/Blade\.exe/);
});

test("remediationFor: any other origin skips the 'no local build' line", () => {
  const ctx = { pkg: {} };
  const lines = compiler.remediationFor(ctx, { exe: "/env/Blade.exe", origin: "env" });
  assert.ok(!lines.some((l) => /No local build was found/.test(l)));
});

test("serveErrorResult: protocolError responses get a rebuild remediation, not the generic list", async () => {
  const ctx = {
    resolved: () => ({ exe: "Blade.exe", origin: "path" }),
    getClient: () => ({ available: () => "yes" }),
    pkg: {},
  };
  const err = new Error("unknown cmd 'surface'");
  err.protocolError = true;
  const r = compiler.serveErrorResult(ctx, err, "blade_check");
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.protocolError, true);
  assert.equal(r.structuredContent.remediation.length, 1);
  assert.match(r.structuredContent.remediation[0], /rebuild from a newer Blade checkout/);
});

"use strict";

// compiler.js: BLADE_MCP_TEST_SERVE parsing, discovery precedence
// (explicit/env/candidate/path — delegated to an injectable pkg.resolveCompiler
// so a fake pkg can pin it), the candidate list this server supplies, the
// shared tool-result/error shapes (including WHY a serve request failed), and
// blade_doctor's toolchain / surface-drift reporting.

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
      DEFAULT_CANDIDATES: ["/fake/bin/Release/net10.0/Blade.exe"],
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

test("resolved(): hands pkg.resolveCompiler this server's OWN candidate list", () => {
  let seenOpts;
  const ctx = compiler.createContext({
    env: { BLADE_REPO: path.join(os.tmpdir(), "some-blade-checkout") },
    pkg: fakePkg({
      resolveCompiler: (opts) => {
        seenOpts = opts;
        return { exe: "Blade", origin: "path" };
      },
    }),
  });
  ctx.resolved();
  assert.ok(Array.isArray(seenOpts.candidates) && seenOpts.candidates.length >= 4);
  assert.deepEqual(seenOpts.candidates, ctx.candidates());
});

test("compilerCandidates: BLADE_REPO first, then a sibling Blade checkout, each Release then Debug", () => {
  const repo = path.join(os.tmpdir(), "my-blade");
  const out = compiler.compilerCandidates({ BLADE_REPO: repo }, fakePkg());
  assert.equal(out[0], path.join(repo, "bin", "Release", "net10.0", "Blade.exe"));
  assert.equal(out[1], path.join(repo, "bin", "Debug", "net10.0", "Blade.exe"));
  const sibling = path.resolve(__dirname, "..", "..", "..", "Blade");
  assert.equal(path.resolve(out[2]), path.join(sibling, "bin", "Release", "net10.0", "Blade.exe"));
  assert.equal(path.resolve(out[3]), path.join(sibling, "bin", "Debug", "net10.0", "Blade.exe"));
  // the package's own entries stay, last
  assert.equal(out[out.length - 1], "/fake/bin/Release/net10.0/Blade.exe");
});

test("compilerCandidates: the framework directory and exe name are READ from the package, not hardcoded", () => {
  const next = compiler.compilerCandidates({}, fakePkg({ DEFAULT_CANDIDATES: ["/x/bin/Release/net12.0/Blade"] }));
  assert.match(next[0].replace(/\\/g, "/"), /\/bin\/Release\/net12\.0\/Blade$/);
  // a package naming no candidates at all still yields a usable list
  const bare = compiler.compilerCandidates({}, fakePkg({ DEFAULT_CANDIDATES: undefined }));
  assert.match(bare[0].replace(/\\/g, "/"), /\/bin\/Release\/net10\.0\/Blade\.exe$/);
});

test("compilerCandidates: with the REAL package, nothing points at a removed target framework", () => {
  const pkg = require("@blade-lang/ide-protocol");
  const out = compiler.compilerCandidates({}, pkg);
  const tfm = /[\\/](net\d+\.\d+)[\\/]/.exec(pkg.DEFAULT_CANDIDATES[0])[1];
  for (const c of out) assert.ok(c.indexOf(tfm) !== -1, `${c} should target ${tfm}`);
  // the vendored package's own candidates resolve inside node_modules, where no
  // build can ever land — they must not be searched, or listed in an error
  assert.ok(pkg.DEFAULT_CANDIDATES.every((c) => /node_modules/.test(c)), "this assertion assumes the package is vendored");
  assert.ok(!out.some((c) => /node_modules/.test(c)), out.join(", "));
  assert.equal(out.length, 2, "with no BLADE_REPO: the sibling checkout's Release and Debug builds");
  assert.ok(!out.some((c) => /net7\.0/.test(c)), "net7.0 build outputs are stale binaries");
});

test("resolved(): a real file among the candidates wins over PATH, newest first (real package)", () => {
  const pkg = require("@blade-lang/ide-protocol");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "blade-mcp-repo-"));
  try {
    const tfm = /[\\/](net\d+\.\d+)[\\/]/.exec(pkg.DEFAULT_CANDIDATES[0])[1];
    const release = path.join(repo, "bin", "Release", tfm, "Blade.exe");
    const debug = path.join(repo, "bin", "Debug", tfm, "Blade.exe");
    for (const f of [release, debug]) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, "");
    }
    // Far in the future, so this build is newer than any real sibling checkout's.
    const future = new Date(Date.now() + 365 * 24 * 3600 * 1000);
    fs.utimesSync(debug, future, future);
    const ctx = compiler.createContext({ env: { BLADE_REPO: repo }, pkg, log: () => {} });
    const r = ctx.resolved();
    assert.equal(r.origin, "candidate");
    assert.equal(r.exe, debug, "the NEWEST build wins, whichever configuration it is");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
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

test("resetClient(): the next getClient() builds a fresh client (clears a latched 'no')", () => {
  let constructCount = 0;
  let disposed = 0;
  const ctx = compiler.createContext({
    env: {},
    pkg: fakePkg({
      createClient: () => {
        constructCount++;
        return { available: () => "no", dispose: () => disposed++ };
      },
    }),
  });
  const a = ctx.getClient();
  ctx.resetClient();
  const b = ctx.getClient();
  assert.notEqual(a, b);
  assert.equal(constructCount, 2);
  assert.equal(disposed, 1, "the old client's process must be released");
});

test("corpusRoot(): BLADE_CORPUS_DIR, then the CHECKOUT's tests/corpus, then the copy deployed beside the binary", () => {
  const pkg = require("@blade-lang/ide-protocol");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "blade-mcp-corpus-"));
  try {
    const binDir = path.join(repo, "bin", "Release", "net10.0");
    const exe = path.join(binDir, "Blade.exe");
    const checkoutCorpus = path.join(repo, "tests", "corpus");
    const deployedCorpus = path.join(binDir, "tests", "corpus");
    for (const d of [checkoutCorpus, deployedCorpus, path.join(repo, "docs")]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(exe, "");
    fs.writeFileSync(path.join(repo, "Blade.fsproj"), "");
    fs.writeFileSync(path.join(repo, "docs", "formalism.md"), "");

    // a checkout: its sources beat the build artifact
    const inCheckout = compiler.createContext({ env: { BLADE_EXE: exe }, pkg, log: () => {} });
    assert.equal(inCheckout.corpusRoot(), checkoutCorpus);

    // a deployed tree with no checkout around it: the copy beside the binary
    fs.rmSync(path.join(repo, "Blade.fsproj"));
    const deployed = compiler.createContext({ env: { BLADE_EXE: exe }, pkg, log: () => {} });
    assert.equal(deployed.corpusRoot(), deployedCorpus);

    // the explicit override beats both
    const override = fs.mkdtempSync(path.join(os.tmpdir(), "blade-mcp-corpus-override-"));
    try {
      const pinned = compiler.createContext({ env: { BLADE_EXE: exe, BLADE_CORPUS_DIR: override }, pkg, log: () => {} });
      assert.equal(pinned.corpusRoot(), override);
    } finally {
      fs.rmSync(override, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
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
    assert.equal(childEnv.PATH, "C:/windows", "PATH is inherited untouched: GR's bin dir must not shadow the g++ toolchain");
  } finally {
    gr.dispose();
  }
});

test("grRuntime(): with no GR anywhere, the serve child gets the context's environment unchanged", () => {
  let seenDeps;
  const env = { BLADE_GR_PATH: NO_SUCH_GR, PATH: "C:/windows" };
  const ctx = compiler.createContext({
    env,
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
  // The context's env IS the child's env — the same object blade_doctor's
  // probes run under (serveEnv), so the two can never disagree about PATH.
  assert.equal(seenDeps.env(), env);
  assert.equal(ctx.serveEnv(), env);
});

test("serve child env: a context running under process.env hands the client `undefined` (plain inheritance)", () => {
  const saved = process.env.BLADE_GR_PATH;
  process.env.BLADE_GR_PATH = NO_SUCH_GR;
  try {
    let seenDeps;
    const ctx = compiler.createContext({
      pkg: fakePkg({
        createClient: (deps) => {
          seenDeps = deps;
          return { available: () => "unknown" };
        },
      }),
      log: () => {},
    });
    ctx.getClient();
    assert.equal(seenDeps.env(), undefined);
    assert.equal(ctx.serveEnv(), process.env);
  } finally {
    if (saved === undefined) delete process.env.BLADE_GR_PATH;
    else process.env.BLADE_GR_PATH = saved;
  }
});

test("serveEnv(): with GR, it is the composed environment — and PATH is the context's own", () => {
  const gr = makeFakeGrRoot();
  try {
    const ctx = compiler.createContext({ env: { BLADE_GR_PATH: gr.root, PATH: "C:/msys64/ucrt64/bin" }, pkg: fakePkg(), log: () => {} });
    const e = ctx.serveEnv();
    assert.equal(e.GRDIR, gr.root);
    assert.equal(e.PATH, "C:/msys64/ucrt64/bin");
  } finally {
    gr.dispose();
  }
});

test("serveGeneration(): counts every spawn the protocol client makes (it calls findCompiler per spawn)", () => {
  let seenDeps;
  const ctx = compiler.createContext({
    env: {},
    pkg: fakePkg({
      createClient: (deps) => {
        seenDeps = deps;
        return { available: () => "unknown" };
      },
    }),
    log: () => {},
  });
  assert.equal(ctx.serveGeneration(), 0);
  ctx.getClient();
  assert.equal(ctx.serveGeneration(), 0, "building the client spawns nothing");
  seenDeps.findCompiler();
  assert.equal(ctx.serveGeneration(), 1);
  seenDeps.findCompiler(); // a respawn after a timeout or crash
  assert.equal(ctx.serveGeneration(), 2);
});

test("getClient(): a client latched 'no' is rebuilt once the BINARY has changed — and left alone while it has not", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blade-mcp-latch-"));
  const exe = path.join(dir, "Blade.exe");
  let built = 0;
  try {
    const ctx = compiler.createContext({
      env: {},
      pkg: fakePkg({
        resolveCompiler: () => ({ exe, origin: "env" }),
        // every client this fake builds has already failed its probe
        createClient: () => (built++, { available: () => "no", dispose() {} }),
      }),
      log: () => {},
    });
    ctx.getClient();
    ctx.getClient();
    assert.equal(built, 1, "nothing changed: the latch stands, and the compiler is not re-probed per call");

    fs.writeFileSync(exe, ""); // the build lands
    ctx.getClient();
    assert.equal(built, 2, "the binary appeared: the old verdict was about a compiler that did not exist");
    ctx.getClient();
    assert.equal(built, 2);

    const later = new Date(Date.now() + 60000);
    fs.utimesSync(exe, later, later); // a rebuild
    ctx.getClient();
    assert.equal(built, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("liveVersion(): 'unknown' for a binary that does not exist, and for one whose --help carries no Blade banner", async () => {
  const missing = compiler.createContext({
    env: process.env,
    pkg: fakePkg({ resolveCompiler: () => ({ exe: path.join(os.tmpdir(), "blade-mcp-not-built-yet.exe"), origin: "env" }) }),
    log: () => {},
  });
  assert.equal(await missing.liveVersion(), "unknown");

  const notBlade = compiler.createContext({
    env: process.env,
    pkg: fakePkg({ resolveCompiler: () => ({ exe: process.execPath, origin: "env" }) }),
    log: () => {},
  });
  assert.equal(await notBlade.liveVersion(), "unknown");
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
  assert.match(r.content[0].text, /\n  "ok": true/, "a small result is indented for reading");
  assert.equal(r.isError, undefined);
});

test("toolResult: a LARGE result's text block is the compact encoding of the same JSON", () => {
  const big = { ok: true, rows: [] };
  for (let i = 0; i < 2000; i++) big.rows.push({ line: i, col: 1, endLine: i, endCol: 9 });
  const r = compiler.toolResult(big);
  const text = r.content[0].text;
  assert.deepEqual(JSON.parse(text), big);
  assert.equal(text, JSON.stringify(big), "no indentation once it would only add bulk");
  assert.ok(text.length < JSON.stringify(big, null, 2).length * 0.7, "the indentation was a third of the bytes");
  // errors follow the same rule
  const e = compiler.toolError("boom", { rows: big.rows });
  assert.equal(e.content[0].text, JSON.stringify(e.structuredContent));
});

test("callServe: waits out a restart backoff and retries ONCE; anything else is thrown as it is", async () => {
  let calls = 0;
  const value = await compiler.callServe(async () => {
    calls++;
    if (calls === 1) throw new Error("blade ide serve: backing off for 15ms");
    return "ok";
  });
  assert.equal(value, "ok");
  assert.equal(calls, 2);

  // a second backoff is not waited out again
  let again = 0;
  await assert.rejects(
    () =>
      compiler.callServe(async () => {
        again++;
        throw new Error("blade ide serve: backing off for 10ms");
      }),
    /backing off/
  );
  assert.equal(again, 2);

  // a timeout is not retried: re-sending the request would just time out again
  let timeouts = 0;
  await assert.rejects(
    () =>
      compiler.callServe(async () => {
        timeouts++;
        throw new Error("blade ide serve: request 3 timed out after 1000ms");
      }),
    /timed out/
  );
  assert.equal(timeouts, 1);
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

test("remediationFor: prefers the context's own candidate list (what was actually searched)", () => {
  const ctx = { pkg: { DEFAULT_CANDIDATES: ["/inside/node_modules/Blade.exe"] }, candidates: () => ["/repo/bin/Release/net10.0/Blade.exe"] };
  const lines = compiler.remediationFor(ctx, { exe: "Blade", origin: "path" });
  assert.match(lines[0], /\/repo\/bin\/Release\/net10\.0\/Blade\.exe/);
  assert.ok(!/node_modules/.test(lines[0]));
});

test("remediationFor: says blade_doctor re-probes, since nothing else clears a failed probe", () => {
  const lines = compiler.remediationFor({ pkg: {} }, { exe: "/env/Blade.exe", origin: "env" });
  assert.ok(lines.some((l) => /blade_doctor/.test(l) && /RE-PROBES/.test(l)));
});

test("remediationFor: blade_doctor does not tell its caller to run blade_doctor", () => {
  const normal = compiler.remediationFor({ pkg: {} }, { exe: "/env/Blade.exe", origin: "env" });
  const fromDoctor = compiler.remediationFor({ pkg: {} }, { exe: "/env/Blade.exe", origin: "env" }, { fromDoctor: true });
  assert.ok(normal.some((l) => /Run blade_doctor/.test(l)));
  assert.ok(!fromDoctor.some((l) => /Run blade_doctor/.test(l)));
  assert.equal(fromDoctor.length, normal.length - 1);
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

// --- why a serve request failed ----------------------------------------------------

function errCtx(latch) {
  return {
    resolved: () => ({ exe: "C:/b/Blade.exe", origin: "env" }),
    getClient: () => ({ available: () => latch || "yes" }),
    pkg: {},
  };
}

test("classifyServeError: reads the protocol client's rejection messages", () => {
  const protocol = new Error("unknown cmd 'eval'");
  protocol.protocolError = true;
  assert.equal(compiler.classifyServeError(protocol), "protocol");
  assert.equal(compiler.classifyServeError(new Error("blade ide serve: request 12 timed out after 30000ms")), "timeout");
  assert.equal(compiler.classifyServeError(new Error("blade ide serve: backing off for 412ms")), "backoff");
  assert.equal(compiler.classifyServeError(new Error("blade ide serve: blade ide serve exited (code=3)")), "crash");
  assert.equal(compiler.classifyServeError(new Error("blade ide serve unavailable")), "unavailable");
  assert.equal(compiler.classifyServeError(undefined), "unavailable");
});

test("serveErrorResult: a timeout says the process was killed and the sessions are gone — and offers timeoutMs only to blade_eval", () => {
  const err = new Error("blade ide serve: request 12 timed out after 30000ms");
  const evalResult = compiler.serveErrorResult(errCtx(), err, "blade_eval").structuredContent;
  assert.equal(evalResult.cause, "timeout");
  assert.equal(evalResult.sessionsLost, true);
  assert.equal(evalResult.protocolError, false);
  assert.ok(evalResult.remediation.some((l) => /timeoutMs/.test(l)));
  assert.ok(!evalResult.remediation.some((l) => /dotnet build/.test(l)));

  const checkResult = compiler.serveErrorResult(errCtx(), err, "blade_check").structuredContent;
  assert.equal(checkResult.cause, "timeout");
  assert.ok(!checkResult.remediation.some((l) => /timeoutMs/.test(l)), "blade_check has no timeoutMs argument to raise");
});

test("serveErrorResult: a crash mid-request and a restart backoff each get their own advice", () => {
  const crash = compiler.serveErrorResult(errCtx(), new Error("blade ide serve: blade ide serve exited (code=3)"), "blade_eval").structuredContent;
  assert.equal(crash.cause, "crash");
  assert.equal(crash.sessionsLost, true);
  assert.ok(crash.remediation.some((l) => /reduce it to a small reproduction/.test(l)));

  const backoff = compiler.serveErrorResult(errCtx(), new Error("blade ide serve: backing off for 412ms"), "blade_check").structuredContent;
  assert.equal(backoff.cause, "backoff");
  assert.equal(backoff.sessionsLost, undefined);
  assert.equal(backoff.remediation.length, 1);
  assert.match(backoff.remediation[0], /retry this call shortly/);
});

test("serveErrorResult: 'unavailable' keeps the build/point/doctor remediation list", () => {
  const r = compiler.serveErrorResult(errCtx("no"), new Error("blade ide serve unavailable"), "blade_check").structuredContent;
  assert.equal(r.cause, "unavailable");
  assert.equal(r.serveAvailable, false);
  assert.equal(r.availability, "no");
  assert.ok(r.remediation.some((l) => /dotnet build/.test(l)));
});

// --- blade_doctor -------------------------------------------------------------------

/** The `blade doctor --json` line a current compiler prints (rows abridged):
 *  note the `stdlib` and `llvm` rows, and that only `gpp` decides `healthy`. */
const DOCTOR_REPORT = {
  os: "windows",
  arch: "x64",
  healthy: true,
  checks: [
    { key: "dotnet", title: ".NET", status: "ok", detail: ".NET 10.0.11 on Microsoft Windows 10.0.26300", origin: "" },
    { key: "stdlib", title: "stdlib", status: "warn", detail: "C:\\b\\stdlib answers, but C:\\b\\bin\\stdlib has a DIFFERENT stats.blade -- rebuild to refresh the deployed copy", origin: "" },
    { key: "gpp", title: "g++ / OpenMP", status: "ok", detail: "g++ 16.2.0 -- compiles and runs (OpenMP max threads 16)", origin: "" },
    { key: "blas", title: "BLAS", status: "error", detail: "gate on but does not link: cannot find -lopenblas", origin: "OPENBLAS_DIR [env]" },
    { key: "cuda", title: "CUDA", status: "missing", detail: "optional -- nvcc not on PATH", origin: "" },
    { key: "llvm", title: "clang / LLVM", status: "ok", detail: "clang version 22.1.8 -- compiles and runs textual LLVM IR; off by default (set BLADE_LLVM=1)", origin: "" },
  ],
};

test("toolchainIssues: lifts the warn/error rows; ok and (optional) missing rows are not issues", () => {
  const issues = compiler.toolchainIssues(DOCTOR_REPORT);
  assert.deepEqual(issues.map((i) => [i.key, i.status]), [["stdlib", "warn"], ["blas", "error"]]);
  assert.match(issues[0].detail, /DIFFERENT stats\.blade/);
  assert.deepEqual(compiler.toolchainIssues(null), []);
  assert.deepEqual(compiler.toolchainIssues({ checks: "nope" }), []);
});

test("lastJsonLine: takes the JSON object line, whatever preceded it", () => {
  assert.equal(compiler.lastJsonLine('warning: something\r\n{"healthy":true}\r\n'), '{"healthy":true}');
  assert.equal(compiler.lastJsonLine("no json here"), undefined);
  assert.equal(compiler.lastJsonLine(""), undefined);
});

const SURFACE = {
  version: 1,
  compilerVersion: "0.20.0",
  keywords: [{ word: "let", token: "KwLet" }, { word: "gram", token: "KwGram" }],
  operators: ["<@>", "+"],
  mathIntrinsics: { unary: ["sin"], binary: ["atan2"], ternary: ["fma"], complex: ["sin"] },
  builtins: ["abs", "fma"],
  staticOnlyBuiltins: ["length"],
  scalarTypes: ["Int64"],
  builtinCalls: ["reduce", "gram_apply"],
  diagnostics: [
    { code: "BL3016", title: "argument extent mismatch", phase: "types" },
    { code: "BL8013", title: "integer arithmetic fault", phase: "runtime" },
  ],
};

test("surfaceDrift: identical name sets are 'false'; an unavailable side is 'null'", () => {
  assert.equal(compiler.surfaceDrift(SURFACE, JSON.parse(JSON.stringify(SURFACE))), false);
  assert.equal(compiler.surfaceDrift(null, SURFACE), null);
  assert.equal(compiler.surfaceDrift(SURFACE, null), null);
});

test("surfaceDrift: a stale packaged surface under the SAME version string is caught by its names", () => {
  // What the pre-refresh vendored surface looked like against a current binary:
  // same compilerVersion, fewer diagnostics, no staticOnlyBuiltins, no ternary intrinsics.
  const stale = JSON.parse(JSON.stringify(SURFACE));
  stale.diagnostics = [{ code: "BL3016", title: "argument extent mismatch", phase: "types" }];
  delete stale.staticOnlyBuiltins;
  delete stale.mathIntrinsics.ternary;
  stale.builtinCalls = ["reduce"];
  const drift = compiler.surfaceDrift(SURFACE, stale);
  assert.deepEqual(drift.diagnostics, { onlyInBinary: ["BL8013 integer arithmetic fault"], onlyInSurface: [] });
  assert.deepEqual(drift.staticOnlyBuiltins, { onlyInBinary: ["length"], onlyInSurface: [] });
  assert.deepEqual(drift.mathIntrinsics, { onlyInBinary: ["ternary:fma"], onlyInSurface: [] });
  assert.deepEqual(drift.builtinCalls, { onlyInBinary: ["gram_apply"], onlyInSurface: [] });
  assert.equal(drift.keywords, undefined, "sets that agree are not listed");
});

test("surfaceDrift: a retitled diagnostic is drift, and long lists are cut with a count", () => {
  const retitled = JSON.parse(JSON.stringify(SURFACE));
  retitled.diagnostics[0].title = "extent mismatch";
  const drift = compiler.surfaceDrift(SURFACE, retitled);
  assert.deepEqual(drift.diagnostics.onlyInBinary, ["BL3016 argument extent mismatch"]);
  assert.deepEqual(drift.diagnostics.onlyInSurface, ["BL3016 extent mismatch"]);

  const many = JSON.parse(JSON.stringify(SURFACE));
  for (let i = 0; i < 30; i++) many.builtins.push(`new_builtin_${i}`);
  const big = compiler.surfaceDrift(many, SURFACE);
  assert.equal(big.builtins.onlyInBinary.length, 13);
  assert.match(big.builtins.onlyInBinary[12], /\+18 more/);
});

/**
 * A stand-in "compiler" for the one-shot verbs: `node doctor --json`,
 * `node ide surface` and `node --help` resolve the first two against the
 * context's cwd, so two small scripts there are the whole double. (Node's own
 * --help carries no Blade banner, which is the "version unknown" path.)
 */
function makeDoctorDouble(report, surface) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blade-mcp-doctor-"));
  // The double reports the environment it was run under in a `probe-env` row,
  // which is how a test can see WHICH environment doctor's probes get.
  fs.writeFileSync(
    path.join(dir, "doctor"),
    `const report = ${JSON.stringify(report)};
report.checks = report.checks.concat([{ key: "probe-env", title: "probe env", status: "ok", detail: JSON.stringify({ GRDIR: process.env.GRDIR || null, MARK: process.env.BLADE_MCP_TEST_MARK || null }), origin: "" }]);
console.log("a warning line first");
console.log(JSON.stringify(report));
`
  );
  if (surface) fs.writeFileSync(path.join(dir, "ide"), `console.log(${JSON.stringify(JSON.stringify(surface))});\n`);
  return { dir, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function doctorCtx(double, packagedSurface, clientImpl) {
  const ctx = compiler.createContext({
    cwd: double.dir,
    env: Object.assign({}, process.env, { BLADE_GR_PATH: NO_SUCH_GR }),
    log: () => {},
    pkg: fakePkg({
      resolveCompiler: () => ({ exe: process.execPath, origin: "env" }),
      createClient: clientImpl || (() => ({ available: () => "yes", check: async () => ({ version: 1 }), dispose() {} })),
      surface: packagedSurface,
    }),
  });
  return ctx;
}

test("bladeDoctor: passes every toolchain row through (stdlib and llvm included) and lifts the ones needing attention", async () => {
  const double = makeDoctorDouble(DOCTOR_REPORT, SURFACE);
  try {
    const result = await compiler.bladeDoctor({}, doctorCtx(double, SURFACE));
    assert.equal(result.isError, undefined);
    const s = result.structuredContent;
    assert.equal(s.ok, true, "ok mirrors the compiler's 'healthy' (the g++ core)");
    assert.deepEqual(s.toolchain.checks.slice(0, DOCTOR_REPORT.checks.length), DOCTOR_REPORT.checks, "the rows are passed through verbatim");
    assert.deepEqual(s.toolchain.checks.map((c) => c.key), ["dotnet", "stdlib", "gpp", "blas", "cuda", "llvm", "probe-env"], "a row this server has never heard of is kept too");
    assert.deepEqual(s.toolchainIssues.map((i) => i.key), ["stdlib", "blas"]);
    assert.equal(s.serveAvailable, true);
    assert.equal(s.protocolVersion, 1);
    assert.equal(s.surfaceDrift, false);
    assert.equal(s.skewNote, undefined);
    assert.equal(s.compilerVersion, "unknown", "node --help carries no 'Blade Compiler v…' banner");
    assert.equal(s.versionSkew, null, "an unknown binary version cannot be compared");
  } finally {
    double.dispose();
  }
});

test("bladeDoctor: a packaged surface that lags the binary is reported even though the versions agree", async () => {
  const stale = JSON.parse(JSON.stringify(SURFACE));
  stale.diagnostics = stale.diagnostics.slice(0, 1);
  const double = makeDoctorDouble(DOCTOR_REPORT, SURFACE);
  try {
    const s = (await compiler.bladeDoctor({}, doctorCtx(double, stale))).structuredContent;
    assert.deepEqual(s.surfaceDrift.diagnostics.onlyInBinary, ["BL8013 integer arithmetic fault"]);
    assert.match(s.skewNote, /same version string, different names/);
    assert.match(s.skewNote, /re-vendor the protocol package/);
  } finally {
    double.dispose();
  }
});

test("bladeDoctor: a compiler with no `ide surface` verb leaves surfaceDrift null, not an error", async () => {
  const double = makeDoctorDouble(DOCTOR_REPORT, null);
  try {
    const s = (await compiler.bladeDoctor({}, doctorCtx(double, SURFACE))).structuredContent;
    assert.equal(s.surfaceDrift, null);
    assert.equal(s.ok, true);
    assert.equal(s.skewNote, undefined);
  } finally {
    double.dispose();
  }
});

test("bladeDoctor: re-probes a client whose availability latched to 'no'", async () => {
  const double = makeDoctorDouble(DOCTOR_REPORT, SURFACE);
  let built = 0;
  try {
    const ctx = doctorCtx(double, SURFACE, () => {
      built++;
      // the first client is the one that failed its probe; the one built after
      // the reset finds the compiler
      const latched = built === 1;
      return { available: () => (latched ? "no" : "unknown"), check: async () => ({ version: 1 }), dispose() {} };
    });
    ctx.getClient();
    const s = (await compiler.bladeDoctor({}, ctx)).structuredContent;
    assert.equal(built, 2, "the latched client is replaced, not consulted");
    assert.equal(s.serveAvailable, true);
    assert.equal(s.serveError, undefined);
  } finally {
    double.dispose();
  }
});

test("bladeDoctor: an unusable compiler is DATA — doctorError plus remediation, never isError", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blade-mcp-nodoctor-"));
  try {
    const ctx = compiler.createContext({
      cwd: dir,
      env: Object.assign({}, process.env, { BLADE_GR_PATH: NO_SUCH_GR }),
      log: () => {},
      pkg: fakePkg({
        resolveCompiler: () => ({ exe: path.join(dir, "no-such-Blade.exe"), origin: "env" }),
        createClient: () => ({ available: () => "no", check: async () => Promise.reject(new Error("blade ide serve unavailable")), dispose() {} }),
        surface: SURFACE,
      }),
    });
    const result = await compiler.bladeDoctor({}, ctx);
    assert.equal(result.isError, undefined);
    const s = result.structuredContent;
    assert.equal(s.ok, false);
    assert.equal(s.toolchain, null);
    assert.match(s.doctorError, /doctor --json/);
    assert.equal(s.serveAvailable, false);
    assert.equal(s.surfaceDrift, null);
    assert.ok(Array.isArray(s.remediation) && s.remediation.length > 0);
    assert.equal(s.toolchainIssues, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bladeDoctor: its probes run in the SAME environment the serve child gets (GRDIR included)", async () => {
  const double = makeDoctorDouble(DOCTOR_REPORT, SURFACE);
  const gr = makeFakeGrRoot();
  try {
    const ctx = compiler.createContext({
      cwd: double.dir,
      env: Object.assign({}, process.env, { BLADE_GR_PATH: gr.root, BLADE_MCP_TEST_MARK: "from-ctx-env" }),
      log: () => {},
      pkg: fakePkg({
        resolveCompiler: () => ({ exe: process.execPath, origin: "env" }),
        createClient: () => ({ available: () => "yes", check: async () => ({ version: 1 }), dispose() {} }),
        surface: SURFACE,
      }),
    });
    const s = (await compiler.bladeDoctor({}, ctx)).structuredContent;
    const probe = JSON.parse(s.toolchain.checks.find((c) => c.key === "probe-env").detail);
    assert.equal(probe.GRDIR, gr.root, "doctor must see the GR wiring an eval's g++ lane will run under");
    assert.equal(probe.MARK, "from-ctx-env", "and the context's environment, not merely this process's");
    assert.equal(ctx.serveEnv().GRDIR, gr.root);
  } finally {
    double.dispose();
    gr.dispose();
  }
});

test("bladeDoctor: a healthy toolchain whose `ide serve` does not answer is NOT ok, and gets remediation that does not point back at doctor", async () => {
  const double = makeDoctorDouble(DOCTOR_REPORT, SURFACE);
  try {
    const ctx = doctorCtx(double, SURFACE, () => ({
      available: () => "unknown",
      check: async () => Promise.reject(new Error("blade ide serve unavailable")),
      dispose() {},
    }));
    const s = (await compiler.bladeDoctor({}, ctx)).structuredContent;
    assert.equal(s.toolchain.healthy, true);
    assert.equal(s.serveAvailable, false);
    assert.equal(s.ok, false, "no compiler-backed tool works without `ide serve`, however healthy g++ is");
    assert.equal(s.serveError, "blade ide serve unavailable");
    assert.ok(Array.isArray(s.remediation) && s.remediation.length > 0);
    assert.ok(!s.remediation.some((l) => /Run blade_doctor/.test(l)));
  } finally {
    double.dispose();
  }
});

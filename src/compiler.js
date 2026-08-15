"use strict";

// Compiler discovery, the lazy `ide serve` client singleton, shared tool-result
// helpers, and blade_doctor.
//
// Everything a handler needs arrives through a context object built by
// createContext() — no module-level mutable state escapes a context, so a unit
// test can build one, override ctx.getClient with a fake, and drive handlers
// directly.
//
// Two hard rules encoded here:
//   1. STDERR ONLY. The MCP transport owns stdout; one stray console.log
//      corrupts the JSON-RPC stream.
//   2. NEVER spawn the compiler with an empty argv. `blade` with no arguments
//      runs the ENTIRE test suite (src/Cli.fs: `| [||] -> runFullSuite`), which
//      would look like a hang. Every execFile below passes explicit args.

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

/** Synthetic path used when a caller supplies bare `source`. Never written to disk. */
const SNIPPET_BASENAME = "__blade_mcp_snippet__.blade";

/** Test-only override: "<exe> <arg> <arg>..." — spawn this instead of a compiler. */
const TEST_SERVE_ENV = "BLADE_MCP_TEST_SERVE";

/** The compiler has no --version verb; the usage banner is the only version source. */
const VERSION_BANNER = /^Blade Compiler v(\S+)/m;

const DOCTOR_TIMEOUT_MS = 60000;
const VERSION_TIMEOUT_MS = 5000;
const SERVE_PROBE_TIMEOUT_MS = 8000;

/** An error whose message is safe (and useful) to show the caller verbatim. */
class UserError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "UserError";
    this.userFacing = true;
    this.details = details || {};
  }
}

/** `BLADE_MCP_TEST_SERVE` -> {exe, args}. Honors one leading "quoted path". */
function splitTestServe(raw) {
  if (!raw || typeof raw !== "string" || raw.trim() === "") return undefined;
  const text = raw.trim();
  const quoted = /^"([^"]+)"\s*(.*)$/.exec(text);
  if (quoted) {
    const rest = quoted[2].trim();
    return { exe: quoted[1], args: rest === "" ? [] : rest.split(/\s+/) };
  }
  const parts = text.split(/\s+/);
  return { exe: parts[0], args: parts.slice(1) };
}

// --- tool results ------------------------------------------------------------

function toolResult(structured, extraContent) {
  const content = [{ type: "text", text: JSON.stringify(structured, null, 2) }];
  return {
    content: extraContent && extraContent.length ? content.concat(extraContent) : content,
    structuredContent: structured,
  };
}

function toolError(message, extra) {
  const structured = Object.assign({ ok: false, error: message }, extra || {});
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
    isError: true,
  };
}

/** Remediation lines for "the compiler isn't answering" — actionable, not generic. */
function remediationFor(ctx, resolved) {
  const candidates = (ctx.pkg && ctx.pkg.DEFAULT_CANDIDATES) || [];
  const lines = [
    "Build the compiler: `dotnet build Blade.fsproj -c Release` in your Blade checkout.",
    "Point this server at a binary: set BLADE_EXE=<path to Blade.exe>, or start blade-mcp with --compiler <path>.",
    "Confirm the binary supports the IDE protocol: `<exe> ide serve` should read NDJSON on stdin (older builds predate it).",
    "Run blade_doctor for a full toolchain report (it works even when `ide serve` does not).",
  ];
  if (resolved && resolved.origin === "path") {
    lines.unshift(`No local build was found; fell through to \"Blade\" on PATH. Candidates searched: ${candidates.length ? candidates.join(", ") : "(none)"}.`);
  }
  return lines;
}

/** The isError body every serve-backed tool returns when the client rejects. */
function serveErrorResult(ctx, err, what) {
  const resolved = safeResolved(ctx);
  let latch = "unknown";
  try {
    latch = ctx.getClient().available();
  } catch (_) {
    /* client construction itself failed */
  }
  const protocolError = !!(err && err.protocolError);
  return toolError(`${what}: ${err && err.message ? err.message : String(err)}`, {
    resolvedCompiler: resolved,
    serveAvailable: latch === "yes",
    availability: latch,
    protocolError,
    remediation: protocolError
      ? ["This compiler answered but does not know that command — rebuild from a newer Blade checkout."]
      : remediationFor(ctx, resolved),
  });
}

function safeResolved(ctx) {
  try {
    return ctx.resolved();
  } catch (e) {
    return { exe: "(unresolved)", origin: "error", error: e.message };
  }
}

// --- context -----------------------------------------------------------------

/**
 * Build the handler context.
 * options: { compilerPath?, cwd?, env?, pkg?, log? }
 */
function createContext(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const cwd = opts.cwd || process.cwd();
  const pkg = opts.pkg || require("@blade-lang/ide-protocol");
  const config = { compilerPath: opts.compilerPath, cwd, env };

  const log =
    opts.log ||
    function (line) {
      process.stderr.write(`[blade-mcp] ${line}\n`);
    };

  let client;
  let framesSubscribed = false;
  let frameQueue = [];
  let versionCache;
  let surfaceCache;
  let kbCache;
  let diagRegistryCache;
  let repoRootCache;
  let corpusRootCache;

  const testServe = splitTestServe(env[TEST_SERVE_ENV]);

  /** Re-resolved on every call so a respawn picks up a newer build. */
  function resolved() {
    if (testServe) return { exe: testServe.exe, origin: "test-serve" };
    return pkg.resolveCompiler({ explicitPath: config.compilerPath, env });
  }

  function subscribeFrames() {
    if (framesSubscribed || !pkg.display || typeof pkg.display.subscribe !== "function") return;
    framesSubscribed = true;
    try {
      pkg.display.subscribe((frame) => {
        frameQueue.push(frame);
      });
      if (typeof pkg.display.setLogger === "function") pkg.display.setLogger((line) => log(line));
    } catch (e) {
      log(`display hub unavailable: ${e.message}`);
    }
  }

  /** Lazy singleton — created on the first serve-backed tool call, not at boot. */
  function getClient() {
    if (!client) {
      subscribeFrames();
      const deps = {
        findCompiler: () => resolved().exe,
        output: { appendLine: (line) => log(line) },
        cwd: config.cwd,
      };
      if (testServe) deps.args = testServe.args;
      client = pkg.createClient(deps, "blade-mcp");
      log(`serve client created (exe=${resolved().exe}, origin=${resolved().origin})`);
    }
    return client;
  }

  /** Out-of-band display frames since the last drain. Serve is strictly serial,
   *  so whatever is queued when an eval returns belongs to that eval. */
  function drainFrames() {
    const frames = frameQueue;
    frameQueue = [];
    return frames;
  }

  function surface() {
    if (surfaceCache === undefined) {
      try {
        surfaceCache = pkg.surface || null;
      } catch (e) {
        log(`surface.json unavailable: ${e.message}`);
        surfaceCache = null;
      }
    }
    return surfaceCache;
  }

  function kb() {
    if (kbCache === undefined) {
      try {
        kbCache = pkg.diagnosticsKb || null;
      } catch (e) {
        log(`diagnostics KB unavailable: ${e.message}`);
        kbCache = null;
      }
    }
    return kbCache;
  }

  /** code -> {code, title, phase} from surface.json's diagnostics array. */
  function diagRegistry() {
    if (!diagRegistryCache) {
      diagRegistryCache = new Map();
      const s = surface();
      const list = s && Array.isArray(s.diagnostics) ? s.diagnostics : [];
      for (const entry of list) {
        if (entry && typeof entry.code === "string") diagRegistryCache.set(entry.code, entry);
      }
    }
    return diagRegistryCache;
  }

  function repoRoot() {
    if (repoRootCache === undefined) {
      try {
        repoRootCache = pkg.resolveRepoRoot({ exe: resolved().exe, env }) || null;
      } catch (e) {
        log(`repo root lookup failed: ${e.message}`);
        repoRootCache = null;
      }
    }
    return repoRootCache;
  }

  /** BLADE_CORPUS_DIR -> dirname(exe)/tests/corpus -> repoRoot()/tests/corpus. */
  function corpusRoot() {
    if (corpusRootCache === undefined) {
      corpusRootCache = null;
      const candidates = [];
      if (env.BLADE_CORPUS_DIR) candidates.push(env.BLADE_CORPUS_DIR);
      try {
        const exe = resolved().exe;
        if (exe && exe !== "Blade") candidates.push(path.join(path.dirname(path.resolve(exe)), "tests", "corpus"));
      } catch (_) {
        /* unresolvable exe */
      }
      const root = repoRoot();
      if (root) candidates.push(path.join(root, "tests", "corpus"));
      for (const c of candidates) {
        try {
          if (fs.statSync(c).isDirectory()) {
            corpusRootCache = c;
            break;
          }
        } catch (_) {
          /* not this one */
        }
      }
    }
    return corpusRootCache;
  }

  /** Live binary version from the `--help` banner; "unknown" on any failure. */
  function liveVersion() {
    if (versionCache !== undefined) return Promise.resolve(versionCache);
    let exe;
    try {
      exe = resolved().exe;
    } catch (_) {
      versionCache = "unknown";
      return Promise.resolve(versionCache);
    }
    return new Promise((resolve) => {
      // Explicit args: a zero-arg spawn would run the whole test suite.
      execFile(exe, ["--help"], { timeout: VERSION_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        const m = stdout ? VERSION_BANNER.exec(String(stdout)) : null;
        versionCache = m ? m[1] : "unknown";
        resolve(versionCache);
      });
    });
  }

  function dispose() {
    if (client) {
      try {
        client.dispose();
      } catch (e) {
        log(`dispose failed: ${e.message}`);
      }
      client = undefined;
    }
  }

  return {
    config,
    pkg,
    log,
    resolved,
    getClient,
    drainFrames,
    surface,
    kb,
    diagRegistry,
    repoRoot,
    corpusRoot,
    liveVersion,
    dispose,
  };
}

// --- blade_doctor -------------------------------------------------------------

function runDoctorJson(ctx) {
  return new Promise((resolve) => {
    let exe;
    try {
      exe = ctx.resolved().exe;
    } catch (e) {
      resolve({ ok: false, error: e.message });
      return;
    }
    execFile(
      exe,
      ["doctor", "--json"],
      { timeout: DOCTOR_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024, cwd: ctx.config.cwd },
      (err, stdout, stderr) => {
        const text = String(stdout || "");
        // Take the last JSON object line: doctor may print warnings first.
        const line = text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.startsWith("{") && l.endsWith("}"))
          .pop();
        if (!line) {
          resolve({
            ok: false,
            error: err ? `doctor --json failed: ${err.message}` : "doctor --json produced no JSON",
            stderr: String(stderr || "").slice(0, 2000),
          });
          return;
        }
        try {
          resolve({ ok: true, json: JSON.parse(line) });
        } catch (e) {
          resolve({ ok: false, error: `could not parse doctor --json output: ${e.message}` });
        }
      }
    );
  });
}

/** Availability + payload schema version, via one tiny real check. */
async function probeServe(ctx) {
  let client;
  try {
    client = ctx.getClient();
  } catch (e) {
    return { available: false, protocolVersion: null, reason: e.message };
  }
  if (client.available() === "no") {
    return { available: false, protocolVersion: null, reason: "availability latched to 'no' earlier this session" };
  }
  try {
    const payload = await client.check(
      path.join(ctx.config.cwd, SNIPPET_BASENAME),
      "let __blade_mcp_probe = 1\n",
      "fast",
      SERVE_PROBE_TIMEOUT_MS
    );
    return {
      available: true,
      protocolVersion: payload && typeof payload.version === "number" ? payload.version : null,
    };
  } catch (e) {
    return { available: false, protocolVersion: null, reason: e && e.message };
  }
}

/**
 * blade_doctor — NEVER returns isError. Diagnosing a broken/absent compiler is
 * precisely this tool's job, so a failure is reported as data.
 */
async function bladeDoctor(args, ctx) {
  const resolved = safeResolved(ctx);
  const [doctor, compilerVersion, serve] = await Promise.all([runDoctorJson(ctx), ctx.liveVersion(), probeServe(ctx)]);
  const surface = ctx.surface();
  const surfaceCompilerVersion = surface && surface.compilerVersion ? surface.compilerVersion : null;

  const structured = {
    ok: !!(doctor.ok && doctor.json && doctor.json.healthy),
    resolvedCompiler: resolved,
    compilerVersion,
    surfaceCompilerVersion,
    versionSkew:
      compilerVersion === "unknown" || !surfaceCompilerVersion || surfaceCompilerVersion === "stub"
        ? null
        : compilerVersion !== surfaceCompilerVersion,
    serveAvailable: serve.available,
    protocolVersion: serve.protocolVersion,
    toolchain: doctor.ok ? doctor.json : null,
  };
  if (!doctor.ok) {
    structured.doctorError = doctor.error;
    if (doctor.stderr) structured.doctorStderr = doctor.stderr;
    structured.remediation = remediationFor(ctx, resolved);
  }
  if (!serve.available && serve.reason) structured.serveError = serve.reason;
  if (structured.versionSkew) {
    structured.skewNote =
      "surface.json was generated by a different compiler build than the one resolved here; " +
      "diagnostic titles and name registries may be stale. Regenerate protocol/surface.json.";
  }
  return toolResult(structured);
}

module.exports = {
  SNIPPET_BASENAME,
  TEST_SERVE_ENV,
  UserError,
  splitTestServe,
  toolResult,
  toolError,
  serveErrorResult,
  remediationFor,
  createContext,
  bladeDoctor,
  probeServe,
  runDoctorJson,
};

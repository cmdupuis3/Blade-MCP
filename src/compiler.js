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
//   2. NEVER spawn the compiler with an empty argv. A current compiler prints
//      its usage for a bare `blade`, but builds before that change ran the
//      ENTIRE test suite instead (`| [||] -> runFullSuite`), which looks like
//      a hang — and this server cannot know which one it was pointed at.
//      Every execFile below passes explicit args.

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const gr = require("./gr");

/** Synthetic path used when a caller supplies bare `source`. Never written to disk. */
const SNIPPET_BASENAME = "__blade_mcp_snippet__.blade";

/** Test-only override: "<exe> <arg> <arg>..." — spawn this instead of a compiler. */
const TEST_SERVE_ENV = "BLADE_MCP_TEST_SERVE";

/** The compiler has no --version verb; the usage banner is the only version source. */
const VERSION_BANNER = /^Blade Compiler v(\S+)/m;

const DOCTOR_TIMEOUT_MS = 60000;
const VERSION_TIMEOUT_MS = 5000;
const SURFACE_TIMEOUT_MS = 10000;
const SERVE_PROBE_TIMEOUT_MS = 8000;

/** How many differing names one surface-drift list reports before it is cut
 *  (the "+N more" entry keeps the count). */
const MAX_DRIFT_NAMES = 12;

/** A result's text block is pretty-printed for a human skimming a transcript —
 *  until it is large, where the indentation is pure cost (it roughly doubles
 *  the size) and nobody is skimming. Past this many characters the text block
 *  is the compact encoding of the same JSON. */
const PRETTY_PRINT_MAX_CHARS = 16 * 1024;

/** The protocol client's restart backoff tops out at 8 s; waiting one out and
 *  retrying is cheaper for everyone than failing the call. Never wait longer. */
const MAX_BACKOFF_WAIT_MS = 9000;

/** Used only when the protocol package names no candidate to read the build
 *  layout from (a fake package in a unit test). */
const FALLBACK_TARGET_FRAMEWORK = "net10.0";
const FALLBACK_EXE_NAME = "Blade.exe";

/**
 * The in-repo build outputs worth probing when neither --compiler nor
 * BLADE_EXE names a binary.
 *
 * The protocol package's own DEFAULT_CANDIDATES are relative to ITS directory
 * — `<repo>/protocol/../bin/...` in a Blade checkout — so vendored under this
 * server's node_modules they point inside node_modules and can never exist.
 * Left at that, "newest in-repo build" was a rule that could not fire here and
 * discovery always fell through to PATH. The checkouts this server CAN know
 * about are probed instead:
 *
 *   1. `BLADE_REPO`, when set — the checkout the user already pointed at;
 *   2. a `Blade` checkout beside this repo — the layout `npm run
 *      vendor:protocol` (`npm pack ../Blade/protocol`) already assumes.
 *
 * The target-framework directory and the executable name are READ OFF the
 * package's candidates rather than written here, so the next framework bump
 * arrives with the re-vendored package instead of needing an edit in two
 * places. The package's own entries follow, for an install where the package
 * is NOT vendored — but only when they do not point inside a node_modules
 * directory, where they cannot exist and would only pad the "candidates
 * searched" line of an error message with paths nobody could build to.
 */
function compilerCandidates(env, pkg) {
  const own = pkg && Array.isArray(pkg.DEFAULT_CANDIDATES) ? pkg.DEFAULT_CANDIDATES : [];
  const sample = own.length ? String(own[0]) : "";
  const tfm = (/[\\/](net\d+(?:\.\d+)?)[\\/]/.exec(sample) || [])[1] || FALLBACK_TARGET_FRAMEWORK;
  const exeName = sample ? path.basename(sample.replace(/\\/g, "/")) : FALLBACK_EXE_NAME;

  const roots = [];
  const repo = env && typeof env.BLADE_REPO === "string" ? env.BLADE_REPO.trim() : "";
  if (repo) roots.push(repo);
  roots.push(path.join(__dirname, "..", "..", "Blade"));

  const out = [];
  for (const root of roots) {
    for (const configuration of ["Release", "Debug"]) {
      out.push(path.join(root, "bin", configuration, tfm, exeName));
    }
  }
  for (const c of own) {
    const inNodeModules = String(c).split(/[\\/]/).indexOf("node_modules") !== -1;
    if (!inNodeModules && out.indexOf(c) === -1) out.push(c);
  }
  return out;
}

/** An error whose message is safe (and useful) to show the caller verbatim. */
class UserError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "UserError";
    this.userFacing = true;
    this.details = details || {};
  }
}

/**
 * `BLADE_MCP_TEST_SERVE` -> {exe, args}.
 *
 * A leading "quoted path" always wins. Unquoted, the first token is the exe —
 * except that on Windows the natural thing to pass is process.execPath, which
 * is routinely `C:\Program Files\nodejs\node.exe`. So when the first token is
 * not itself an existing file, grow the exe across tokens until one names a
 * real file; if none does, fall back to the plain first-token split (which is
 * what a bare command like `node` needs).
 *
 * Arguments containing spaces are not supported unquoted — quote the exe and
 * keep argument paths space-free.
 */
function splitTestServe(raw) {
  if (!raw || typeof raw !== "string" || raw.trim() === "") return undefined;
  const text = raw.trim();
  const quoted = /^"([^"]+)"\s*(.*)$/.exec(text);
  if (quoted) {
    const rest = quoted[2].trim();
    return { exe: quoted[1], args: rest === "" ? [] : rest.split(/\s+/) };
  }
  const parts = text.split(/\s+/);
  if (parts.length > 1 && !fs.existsSync(parts[0])) {
    for (let n = 2; n <= parts.length; n++) {
      const candidate = parts.slice(0, n).join(" ");
      if (fs.existsSync(candidate)) return { exe: candidate, args: parts.slice(n) };
    }
  }
  return { exe: parts[0], args: parts.slice(1) };
}

// --- tool results ------------------------------------------------------------

/** The text rendering of a structured result (see PRETTY_PRINT_MAX_CHARS). */
function resultText(structured) {
  const pretty = JSON.stringify(structured, null, 2);
  return pretty.length > PRETTY_PRINT_MAX_CHARS ? JSON.stringify(structured) : pretty;
}

function toolResult(structured, extraContent) {
  const content = [{ type: "text", text: resultText(structured) }];
  return {
    content: extraContent && extraContent.length ? content.concat(extraContent) : content,
    structuredContent: structured,
  };
}

function toolError(message, extra) {
  const structured = Object.assign({ ok: false, error: message }, extra || {});
  return {
    content: [{ type: "text", text: resultText(structured) }],
    structuredContent: structured,
    isError: true,
  };
}

/** Remediation lines for "the compiler isn't answering" — actionable, not generic.
 *  `opts.fromDoctor` drops the "run blade_doctor" line: doctor is the caller. */
function remediationFor(ctx, resolved, opts) {
  const candidates =
    typeof ctx.candidates === "function" ? ctx.candidates() : (ctx.pkg && ctx.pkg.DEFAULT_CANDIDATES) || [];
  const lines = [
    "Build the compiler: `dotnet build Blade.fsproj -c Release` in your Blade checkout.",
    "Point this server at a binary: set BLADE_EXE=<path to Blade.exe>, or start blade-mcp with --compiler <path>.",
    "Confirm the binary supports the IDE protocol: `<exe> ide serve` should read NDJSON on stdin (older builds predate it).",
    "Run blade_doctor for a full toolchain report. It works even when `ide serve` does not, and it RE-PROBES `ide serve`: once a probe has failed, the other tools keep answering 'unavailable' until blade_doctor finds the compiler again.",
  ];
  if (opts && opts.fromDoctor) lines.pop();
  if (resolved && resolved.origin === "path") {
    lines.unshift(`No local build was found; fell through to \"Blade\" on PATH. Candidates searched: ${candidates.length ? candidates.join(", ") : "(none)"}.`);
  }
  return lines;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run one serve-backed request, waiting out a restart backoff once.
 *
 * After a failure the protocol client refuses to respawn for a short window
 * (500 ms, 2 s, 8 s) and rejects whatever arrives in it with "backing off for
 * Nms". For an editor's keystroke clock that is right; for a tool call it
 * turns "the previous call timed out" into "and so did the next one, for no
 * reason of its own". The window is short and known, so wait it out and try
 * again — once: a second failure is reported as it is.
 *
 * `request` must obtain its client inside (ctx.getClient()), so the retry
 * talks to whatever client is current.
 */
async function callServe(request) {
  try {
    return await request();
  } catch (e) {
    if (classifyServeError(e) !== "backoff") throw e;
    const m = /backing off for (\d+)ms/.exec(String(e && e.message));
    const wait = Math.min((m ? Number(m[1]) : 500) + 50, MAX_BACKOFF_WAIT_MS);
    await sleep(wait);
    return request();
  }
}

/**
 * Why a serve-backed request failed, read off the protocol client's rejection.
 * The client reports every transport failure as a plain Error, so the message
 * is the only signal — and the causes need DIFFERENT advice: telling an agent
 * whose eval merely ran long to "build the compiler" sends it the wrong way.
 *
 *   "protocol"     the compiler answered {"error": ...}: it is alive and does
 *                  not know (or refused) this request
 *   "timeout"      the request outlived its timeout; the client KILLED the
 *                  process to stop it
 *   "crash"        the process exited with a request in flight
 *   "backoff"      a restart is pending after a failure; nothing was sent
 *   "unavailable"  no usable `ide serve` (never started, or latched off)
 */
function classifyServeError(err) {
  if (err && err.protocolError) return "protocol";
  const msg = err && err.message ? String(err.message) : String(err);
  if (/timed out after \d+ms/.test(msg)) return "timeout";
  if (/backing off for \d+ms/.test(msg)) return "backoff";
  if (/ide serve exited \(/.test(msg)) return "crash";
  return "unavailable";
}

const SESSIONS_LOST =
  "Every blade_eval session lived in that process, so their accumulated bindings are gone — re-evaluate the definitions you still need.";

function remediationForCause(cause, ctx, resolved, what) {
  switch (cause) {
    case "protocol":
      return ["This compiler answered but does not know that command — rebuild from a newer Blade checkout."];
    case "timeout":
      return [
        "The request outlived its timeout, so the `ide serve` process was killed to stop it. It respawns on the next call — the compiler itself is fine.",
        SESSIONS_LOST,
        what === "blade_eval"
          ? "If the work is legitimately slow (the g++ fallback lane compiles C++; a large array program takes time), pass a larger `timeoutMs`. Otherwise shrink the computation."
          : "If this input reliably takes this long to typecheck, reduce it to the part you are asking about.",
      ];
    case "crash":
      return [
        "The `ide serve` process exited while handling this request. It respawns on the next call.",
        SESSIONS_LOST,
        "If the same input fails the same way again, that input is crashing the compiler: reduce it to a small reproduction.",
      ];
    case "backoff":
      return ["The compiler process failed a moment ago and is waiting out a short restart backoff — retry this call shortly."];
    default:
      return remediationFor(ctx, resolved);
  }
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
  const cause = classifyServeError(err);
  const extra = {
    resolvedCompiler: resolved,
    serveAvailable: latch === "yes",
    availability: latch,
    protocolError: cause === "protocol",
    cause,
    remediation: remediationForCause(cause, ctx, resolved, what),
  };
  // The process that held them is gone. Said as data too, so a caller can act
  // on it without parsing prose.
  if (cause === "timeout" || cause === "crash") extra.sessionsLost = true;
  return toolError(`${what}: ${err && err.message ? err.message : String(err)}`, extra);
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
  let clientSignature;
  let spawnCount = 0;
  let framesSubscribed = false;
  let frameQueue = [];
  let versionCache; // { signature, version }
  let surfaceCache;
  let kbCache;
  let diagRegistryCache;
  let repoRootCache;
  let corpusRootCache;
  let grCache;

  const testServe = splitTestServe(env[TEST_SERVE_ENV]);

  /** The GR runtime this server can offer the compiler, resolved once.
   *  `{ok:true, grdir, source}` or `{ok:false, reason}` — never throws, and
   *  "not found" is a normal, non-fatal answer (plots degrade to text). */
  function grRuntime() {
    if (grCache === undefined) {
      try {
        grCache = gr.resolveGr({ env, repoRoot: path.join(__dirname, "..") });
      } catch (e) {
        grCache = { ok: false, reason: `GR resolution failed: ${e.message}` };
      }
      log(grCache.ok ? `GR runtime: ${grCache.grdir} (from ${grCache.source})` : `GR runtime unavailable: ${grCache.reason}`);
    }
    return grCache;
  }

  /** The build outputs discovery probes (see compilerCandidates). */
  function candidates() {
    return compilerCandidates(env, pkg);
  }

  /** Re-resolved on every call so a respawn picks up a newer build. */
  function resolved() {
    if (testServe) return { exe: testServe.exe, origin: "test-serve" };
    return pkg.resolveCompiler({ explicitPath: config.compilerPath, env, candidates: candidates() });
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

  /**
   * The environment the `ide serve` child runs in: this context's, plus GRDIR
   * and friends when a GR runtime was found.
   *
   * It is also the environment blade_doctor's one-shot probes run in. A doctor
   * that probes g++ under a different environment than the process that will
   * actually invoke g++ reports a healthy toolchain while evals fail — which
   * is how GR's DLLs shadowing the toolchain's went unnoticed.
   */
  function serveEnv() {
    const g = grRuntime();
    return g.ok ? gr.grEnv(g.grdir, env) : env;
  }

  /** What "the compiler" currently is: its path and its mtime. Changes when a
   *  build lands, when a missing binary appears, when discovery picks another. */
  function binarySignature() {
    let exe;
    try {
      exe = resolved().exe;
    } catch (_) {
      return "(unresolved)";
    }
    try {
      return `${exe}|${fs.statSync(exe).mtimeMs}`;
    } catch (_) {
      return `${exe}|missing`;
    }
  }

  /** Lazy singleton — created on the first serve-backed tool call, not at boot. */
  function getClient() {
    // The protocol client LATCHES "no" after a failed first probe and never
    // looks again. If the binary has changed since this client was built (it
    // did not exist and now does; it was rebuilt), that verdict is about a
    // different compiler: start over. When nothing changed, the latch stands —
    // a compiler that lacks the verb is not re-spawned on every call.
    if (client && clientSignature !== undefined) {
      let latched = false;
      try {
        latched = client.available() === "no";
      } catch (_) {
        /* a client double without available() */
      }
      if (latched && binarySignature() !== clientSignature) {
        log("the compiler binary changed since `ide serve` was found unavailable — probing again");
        resetClient();
      }
    }
    if (!client) {
      subscribeFrames();
      const deps = {
        // Called by the protocol client at EVERY spawn — which makes it the
        // one reliable place to count them (see serveGeneration).
        findCompiler: () => {
          spawnCount++;
          return resolved().exe;
        },
        output: { appendLine: (line) => log(line) },
        cwd: config.cwd,
        // A FUNCTION, not an object: the protocol client re-reads it at every
        // spawn, so a respawn after a crash still gets GR wired up. Returning
        // undefined means "inherit this process's environment" — what a host
        // without GR, running under its own environment, must keep.
        env: () => {
          const e = serveEnv();
          return e === process.env ? undefined : e;
        },
      };
      if (testServe) deps.args = testServe.args;
      client = pkg.createClient(deps, "blade-mcp");
      clientSignature = binarySignature();
      log(`serve client created (exe=${resolved().exe}, origin=${resolved().origin})`);
    }
    return client;
  }

  /**
   * How many `ide serve` processes this context has spawned. Sessions live in
   * that process, so a session whose last eval ran under an earlier generation
   * has lost its definitions — whichever tool's request it was that timed out
   * or crashed the process in between.
   */
  function serveGeneration() {
    return spawnCount;
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

  /**
   * BLADE_CORPUS_DIR -> repoRoot()/tests/corpus -> dirname(exe)/tests/corpus.
   *
   * The checkout comes BEFORE the copy deployed beside the binary, the same
   * rule the compiler itself now applies to stdlib/: the deployed copy is a
   * build artifact, refreshed only by a rebuild, so in a checkout it can lag
   * the sources someone is editing (and it never carries the corpus README).
   * A deployed tree with no checkout still resolves through the last entry.
   */
  function corpusRoot() {
    if (corpusRootCache === undefined) {
      corpusRootCache = null;
      const candidates = [];
      if (env.BLADE_CORPUS_DIR) candidates.push(env.BLADE_CORPUS_DIR);
      const root = repoRoot();
      if (root) candidates.push(path.join(root, "tests", "corpus"));
      try {
        const exe = resolved().exe;
        if (exe && exe !== "Blade") candidates.push(path.join(path.dirname(path.resolve(exe)), "tests", "corpus"));
      } catch (_) {
        /* unresolvable exe */
      }
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

  /**
   * Live binary version from the `--help` banner; "unknown" on any failure.
   *
   * Cached PER BINARY (path + mtime), not for the life of the context:
   * `resolved()` is re-evaluated per call precisely so a rebuild mid-session
   * is picked up, and a version remembered from before the rebuild — or an
   * "unknown" remembered from before the binary existed — would describe a
   * different compiler than the one answering.
   */
  function liveVersion() {
    const signature = binarySignature();
    if (versionCache && versionCache.signature === signature) return Promise.resolve(versionCache.version);
    let exe;
    try {
      exe = resolved().exe;
    } catch (_) {
      return Promise.resolve("unknown");
    }
    return new Promise((resolve) => {
      // Explicit args, always (see rule 2 in the header).
      execFile(exe, ["--help"], { timeout: VERSION_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: serveEnv() }, (err, stdout) => {
        const m = stdout ? VERSION_BANNER.exec(String(stdout)) : null;
        const version = m ? m[1] : "unknown";
        versionCache = { signature, version };
        resolve(version);
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

  /**
   * Throw the current client away so the next getClient() builds a fresh one.
   *
   * The protocol client LATCHES "no" for its whole life once a probe fails
   * (so an editor does not hammer a compiler that lacks the verb). For a
   * server that outlives a `dotnet build`, that latch has to be clearable —
   * otherwise "the compiler was missing when I first asked" becomes "the
   * compiler is unavailable until this server restarts". blade_doctor is the
   * one caller: diagnosing is exactly when re-probing is wanted.
   */
  function resetClient() {
    dispose();
    clientSignature = undefined;
  }

  return {
    config,
    pkg,
    log,
    resolved,
    candidates,
    serveEnv,
    getClient,
    resetClient,
    serveGeneration,
    grRuntime,
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

/** The environment for doctor's one-shot probes: the SAME one the `ide serve`
 *  child gets (see serveEnv), so what doctor reports about g++ is what an eval
 *  will find. A hand-rolled context without serveEnv falls back to its config. */
function probeEnv(ctx) {
  try {
    if (typeof ctx.serveEnv === "function") return ctx.serveEnv();
  } catch (_) {
    /* fall through */
  }
  return ctx.config && ctx.config.env ? ctx.config.env : undefined;
}

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
      { timeout: DOCTOR_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024, cwd: ctx.config.cwd, env: probeEnv(ctx) },
      (err, stdout, stderr) => {
        // Take the last JSON object line: doctor may print warnings first.
        const line = lastJsonLine(stdout);
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

/** The last line of `text` that is one whole JSON object. Both one-shot verbs
 *  used here print exactly one, but a warning may precede it. */
function lastJsonLine(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{") && l.endsWith("}"))
    .pop();
}

/**
 * The language surface the RESOLVED BINARY reports (`blade ide surface`), or
 * null when it cannot be had (no binary, or one predating the verb). Never
 * rejects: this only feeds a comparison.
 */
function runSurfaceJson(ctx) {
  return new Promise((resolve) => {
    let exe;
    try {
      exe = ctx.resolved().exe;
    } catch (_) {
      resolve(null);
      return;
    }
    execFile(
      exe,
      ["ide", "surface"],
      { timeout: SURFACE_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024, cwd: ctx.config.cwd, env: probeEnv(ctx) },
      (err, stdout) => {
        const line = lastJsonLine(stdout);
        if (!line) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(line);
          resolve(parsed && Array.isArray(parsed.diagnostics) ? parsed : null);
        } catch (_) {
          resolve(null);
        }
      }
    );
  });
}

/** A surface array as comparable strings: plain names as they are, keyword
 *  entries by word, diagnostics by "code title" (a retitled code is drift). */
function nameList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => {
      if (typeof v === "string") return v;
      if (!v || typeof v !== "object") return undefined;
      if (typeof v.code === "string") return `${v.code} ${v.title || ""}`.trim();
      return v.word;
    })
    .filter((v) => typeof v === "string");
}

function capNames(names) {
  return names.length > MAX_DRIFT_NAMES
    ? names.slice(0, MAX_DRIFT_NAMES).concat(`… +${names.length - MAX_DRIFT_NAMES} more`)
    : names;
}

/**
 * Compare the binary's surface with the one this server was packaged with.
 *
 * The VERSION STRING cannot do this job: the compiler has reported the same
 * version across months of new diagnostics and builtins, so a stale vendored
 * surface and a current binary agree on it exactly. What actually goes wrong
 * with a stale surface is that NAMES differ — a diagnostic code with no
 * title, a builtin the knowledge layer has never heard of — so the names are
 * what is compared.
 *
 * Returns null when either side is unavailable, false when every name set
 * matches, or `{<set>: {onlyInBinary, onlyInSurface}}` for the sets that
 * differ.
 */
function surfaceDrift(live, packaged) {
  if (!live || !packaged) return null;
  const sets = {
    diagnostics: (s) => nameList(s.diagnostics),
    keywords: (s) => nameList(s.keywords),
    operators: (s) => nameList(s.operators),
    builtins: (s) => nameList(s.builtins),
    staticOnlyBuiltins: (s) => nameList(s.staticOnlyBuiltins),
    builtinCalls: (s) => nameList(s.builtinCalls),
    scalarTypes: (s) => nameList(s.scalarTypes),
    mathIntrinsics: (s) => {
      const m = s.mathIntrinsics && typeof s.mathIntrinsics === "object" ? s.mathIntrinsics : {};
      return Object.keys(m)
        .sort()
        .reduce((acc, arity) => acc.concat(nameList(m[arity]).map((n) => `${arity}:${n}`)), []);
    },
  };
  const out = {};
  for (const key of Object.keys(sets)) {
    const a = sets[key](live);
    const b = sets[key](packaged);
    const inA = new Set(a);
    const inB = new Set(b);
    const onlyInBinary = a.filter((n) => !inB.has(n));
    const onlyInSurface = b.filter((n) => !inA.has(n));
    if (onlyInBinary.length || onlyInSurface.length) {
      out[key] = { onlyInBinary: capNames(onlyInBinary), onlyInSurface: capNames(onlyInSurface) };
    }
  }
  return Object.keys(out).length ? out : false;
}

/** The doctor rows that need attention: status "warn" or "error". Tolerates
 *  any shape — a row this server has never seen is still just a row. */
function toolchainIssues(report) {
  const checks = report && Array.isArray(report.checks) ? report.checks : [];
  return checks
    .filter((c) => c && (c.status === "warn" || c.status === "error"))
    .map((c) => ({ key: c.key, title: c.title, status: c.status, detail: c.detail }));
}

/** Availability + payload schema version, via one tiny real check. */
async function probeServe(ctx) {
  let client;
  try {
    client = ctx.getClient();
    // A latched "no" is an OLD verdict. Re-probe from scratch: the compiler
    // may have been built (or fixed) since, and this is the tool an agent is
    // told to run after doing that.
    if (client.available() === "no" && typeof ctx.resetClient === "function") {
      ctx.resetClient();
      client = ctx.getClient();
    }
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

/** GR availability as doctor data. Tolerates a context built before grRuntime
 *  existed (unit tests hand-roll contexts), reporting "unknown" rather than
 *  making blade_doctor — the tool that must survive everything — throw. */
function grReport(ctx) {
  if (!ctx || typeof ctx.grRuntime !== "function") return { available: "unknown" };
  const g = ctx.grRuntime();
  return g.ok ? { available: true, grdir: g.grdir, source: g.source } : { available: false, reason: g.reason };
}

/**
 * blade_doctor — NEVER returns isError. Diagnosing a broken/absent compiler is
 * precisely this tool's job, so a failure is reported as data.
 */
async function bladeDoctor(args, ctx) {
  const resolved = safeResolved(ctx);
  // The serve probe, the toolchain report, the version banner and the live
  // surface are four independent questions about one binary: ask them at once.
  const [serve, doctor, compilerVersion, liveSurface] = await Promise.all([
    probeServe(ctx),
    runDoctorJson(ctx),
    ctx.liveVersion(),
    runSurfaceJson(ctx),
  ]);
  const surface = ctx.surface();
  const surfaceCompilerVersion = surface && surface.compilerVersion ? surface.compilerVersion : null;
  const drift = surfaceDrift(liveSurface, surface);

  const structured = {
    // Both halves: the toolchain's required core is up (the compiler's own
    // `healthy`), AND `ide serve` answers — without which no compiler-backed
    // tool of this server works, however healthy g++ is.
    ok: !!(doctor.ok && doctor.json && doctor.json.healthy) && serve.available === true,
    resolvedCompiler: resolved,
    compilerVersion,
    surfaceCompilerVersion,
    versionSkew:
      compilerVersion === "unknown" || !surfaceCompilerVersion || surfaceCompilerVersion === "stub"
        ? null
        : compilerVersion !== surfaceCompilerVersion,
    // null = could not compare; false = the binary and the packaged surface
    // name the same language; otherwise the name sets that differ.
    surfaceDrift: drift,
    serveAvailable: serve.available,
    protocolVersion: serve.protocolVersion,
    // Whether blade_eval can upgrade plotly figures to real images. Reported
    // here because "my plots come back as JSON" is a toolchain question, and
    // this tool is where a toolchain question gets answered.
    grRuntime: grReport(ctx),
    toolchain: doctor.ok ? doctor.json : null,
  };
  // The compiler's `healthy` is ONLY the g++ core. A diverged stdlib copy or a
  // half-configured BLAS is a "warn"/"error" row that leaves `ok` true, so
  // those rows are lifted out to where they are seen. ("missing" rows are
  // optional components, not issues.)
  const issues = toolchainIssues(doctor.ok ? doctor.json : null);
  if (issues.length) structured.toolchainIssues = issues;
  if (!doctor.ok) {
    structured.doctorError = doctor.error;
    if (doctor.stderr) structured.doctorStderr = doctor.stderr;
    structured.remediation = remediationFor(ctx, resolved, { fromDoctor: true });
  }
  if (!serve.available && serve.reason) structured.serveError = serve.reason;
  if (!serve.available && !structured.remediation) structured.remediation = remediationFor(ctx, resolved, { fromDoctor: true });
  if (structured.versionSkew || drift) {
    structured.skewNote =
      "the language surface this server was packaged with (surface.json) does not match the compiler resolved here" +
      (structured.versionSkew ? " — they report different versions" : " — same version string, different names (see surfaceDrift)") +
      "; diagnostic titles, blade_explain and the name registries may be stale. " +
      "Regenerate protocol/surface.json in the Blade checkout and re-vendor the protocol package.";
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
  callServe,
  resultText,
  PRETTY_PRINT_MAX_CHARS,
  classifyServeError,
  remediationFor,
  compilerCandidates,
  createContext,
  bladeDoctor,
  probeServe,
  runDoctorJson,
  runSurfaceJson,
  surfaceDrift,
  toolchainIssues,
  lastJsonLine,
};

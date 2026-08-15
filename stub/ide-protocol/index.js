"use strict";

// ============================================================================
// STUB — @blade-lang/ide-protocol 0.0.0-stub — DELETED AT INTEGRATION.
//
// This is NOT the real package. The real one lives in the Blade repo under
// protocol/ (co-located with src/IdeServe.fs, its source of truth) and arrives
// here as a vendored `npm pack` tarball. To swap:
//
//     rm -rf stub/
//     npm pack ../Blade/protocol --pack-destination vendor
//     # package.json:
//     #   "@blade-lang/ide-protocol": "file:vendor/blade-lang-ide-protocol-<v>.tgz"
//     npm install
//
// NOTHING under src/ changes when that happens: src/ consumes only the API
// documented below, which is API-compatible with the real package.
//
// What this stub deliberately simplifies (the only behavioral differences):
//   - restart backoff is a single retry gate rather than the real [500, 2000,
//     8000] ladder with MAX_ESTABLISHED_FAILURES;
//   - `surface` / `diagnosticsKb` return empty-but-well-shaped registries
//     instead of reading generated JSON (so every consumer exercises its
//     graceful-degradation path while the stub is in place);
//   - display frame validation is minimal (mime/encoding/data presence).
//
// The wire protocol itself (NDJSON, id correlation, `event` lines never
// settling an id, `{error}` -> protocolError) is faithful, because that is what
// the MCP server is actually tested against.
// ============================================================================

const cp = require("child_process");
const fs = require("fs");
const path = require("path");

const PING_TIMEOUT_MS = 5000;
const DEFAULT_TIMEOUT_MS = { fast: 10000, full: 30000 };
const RETRY_GATE_MS = 2000;

// --- serveProto: NDJSON framing ---------------------------------------------

function encodeCheck(id, tier, file, source) {
  return JSON.stringify({ id, cmd: "check", tier, file, source }) + "\n";
}

function encodeCheckCells(id, tier, file, cells) {
  return JSON.stringify({ id, cmd: "checkCells", file, cells, tier }) + "\n";
}

function encodePing(id) {
  return JSON.stringify({ id, cmd: "ping" }) + "\n";
}

function encodeEval(id, session, source, cwd) {
  const req = { id, cmd: "eval", session, source };
  if (cwd) req.cwd = cwd;
  return JSON.stringify(req) + "\n";
}

function encodeResetSession(id, session) {
  return JSON.stringify({ id, cmd: "resetSession", session }) + "\n";
}

function encodeShutdown() {
  return JSON.stringify({ cmd: "shutdown" }) + "\n";
}

function decodeLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch (e) {
    return { id: null, error: `malformed JSON from 'ide serve': ${e.message} — ${line.slice(0, 200)}` };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { id: null, error: `non-object JSON line from 'ide serve': ${line.slice(0, 200)}` };
  }
  return obj;
}

function createDecoder() {
  let buf = "";
  return {
    push(chunk) {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop();
      const messages = [];
      for (const raw of lines) {
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (line.trim() === "") continue;
        messages.push(decodeLine(line));
      }
      return messages;
    },
  };
}

const serveProto = {
  encodeCheck,
  encodeCheckCells,
  encodePing,
  encodeEval,
  encodeResetSession,
  encodeShutdown,
  decodeLine,
  createDecoder,
};

// --- display: frames + routing hub ------------------------------------------

const FRAME_VERSION = 1;
const PNG_MIME = "image/png";
const PLOTLY_MIME = "application/vnd.plotly.v1+json";
const MIME_RE = /^[A-Za-z0-9][A-Za-z0-9.+_-]*\/[A-Za-z0-9][A-Za-z0-9.+_-]*$/;

function defaultEncodingFor(mime) {
  if (mime === "application/json" || /\+json$/.test(mime)) return "json";
  if (/^text\//.test(mime)) return "utf8";
  return "base64";
}

function decodeFrame(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, reason: "display frame is not a JSON object" };
  }
  const v = obj.v === undefined ? FRAME_VERSION : obj.v;
  if (typeof v !== "number" || v > FRAME_VERSION) {
    return { ok: false, reason: `unsupported display frame version ${obj.v}` };
  }
  if (typeof obj.mime !== "string" || !MIME_RE.test(obj.mime)) {
    return { ok: false, reason: `display frame "mime" is missing or malformed: ${obj.mime}` };
  }
  const encoding = obj.encoding === undefined ? defaultEncodingFor(obj.mime) : obj.encoding;
  if (["json", "utf8", "base64"].indexOf(encoding) === -1) {
    return { ok: false, reason: `display frame "encoding" is not json/utf8/base64: ${obj.encoding}` };
  }
  if (obj.data === undefined || obj.data === null) {
    return { ok: false, reason: `display frame "data" is missing (mime ${obj.mime})` };
  }
  return { ok: true, frame: { v, mime: obj.mime, encoding, data: obj.data, meta: obj.meta || {} } };
}

function framesFromEval(resp) {
  const list = resp && resp.display;
  if (list === undefined || list === null) return { frames: [], errors: [] };
  if (!Array.isArray(list)) return { frames: [], errors: ['eval response "display" is not an array'] };
  const frames = [];
  const errors = [];
  for (const entry of list) {
    const res = decodeFrame(entry);
    if (res.ok) frames.push(res.frame);
    else errors.push(res.reason);
  }
  return { frames, errors };
}

function isEvent(msg) {
  return !!msg && typeof msg === "object" && typeof msg.event === "string";
}

function frameFromEvent(msg) {
  if (!isEvent(msg) || msg.event !== "display") return { ok: false, reason: "not a display event" };
  return decodeFrame(msg.frame);
}

let listeners = [];
let displayLogger = null;

function setLogger(fn) {
  displayLogger = typeof fn === "function" ? fn : null;
}

function displayLog(line) {
  if (displayLogger) displayLogger(line);
}

function subscribe(fn) {
  listeners.push(fn);
  return {
    dispose() {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
}

function publish(frame, origin) {
  for (const fn of listeners.slice()) {
    try {
      fn(frame, origin || "unknown");
    } catch (e) {
      displayLog(`[display] subscriber failed on a ${frame.mime} frame: ${e && e.message}`);
    }
  }
}

function route(result, origin) {
  for (const reason of (result && result.errors) || []) displayLog(`[display:${origin}] ${reason}`);
  for (const frame of (result && result.frames) || []) publish(frame, origin);
  return result;
}

const display = {
  FRAME_VERSION,
  PNG_MIME,
  PLOTLY_MIME,
  defaultEncodingFor,
  decodeFrame,
  framesFromEval,
  isEvent,
  frameFromEvent,
  setLogger,
  subscribe,
  publish,
  route,
};

// --- replProto (surface parity only; the MCP server does not use it) --------

const replProto = {
  PROMPT: "blade> ",
  isPrompt(line) {
    return typeof line === "string" && line.trimEnd().endsWith("blade>");
  },
};

// --- compiler / repo discovery ----------------------------------------------

const DEFAULT_CANDIDATES = [
  "C:\\Users\\cdupu\\Documents\\GitHub\\Blade\\bin\\Release\\net7.0\\Blade.exe",
  "C:\\Users\\cdupu\\Documents\\GitHub\\Blade\\bin\\Debug\\net7.0\\Blade.exe",
];

/** explicit -> env BLADE_EXE -> newest-mtime candidate -> "Blade" on PATH. */
function resolveCompiler(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  if (opts.explicitPath) return { exe: opts.explicitPath, origin: "explicit" };
  if (env.BLADE_EXE) return { exe: env.BLADE_EXE, origin: "env" };
  let best;
  for (const c of opts.candidates || DEFAULT_CANDIDATES) {
    try {
      const mtime = fs.statSync(c).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: c, mtime };
    } catch (_) {
      /* candidate absent */
    }
  }
  if (best) return { exe: best.path, origin: "candidate" };
  return { exe: "Blade", origin: "path" };
}

function looksLikeRepoRoot(dir) {
  try {
    return fs.existsSync(path.join(dir, "Blade.fsproj")) && fs.existsSync(path.join(dir, "docs", "formalism.md"));
  } catch (_) {
    return false;
  }
}

/** env BLADE_REPO (if it exists) else walk up <=5 levels from dirname(exe). */
function resolveRepoRoot(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  if (env.BLADE_REPO && looksLikeRepoRoot(env.BLADE_REPO)) return env.BLADE_REPO;
  if (!opts.exe) return undefined;
  let dir;
  try {
    dir = path.dirname(path.resolve(opts.exe));
  } catch (_) {
    return undefined;
  }
  for (let i = 0; i < 6; i++) {
    if (looksLikeRepoRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

// --- createClient ------------------------------------------------------------

/**
 * One `ide serve` client. deps = { findCompiler, output:{appendLine}, cwd, args }.
 * Returns { available, check, checkCells, eval, resetSession, dispose }.
 */
function createClient(dependencies, label) {
  const deps = dependencies || {};
  const tag = label || "blade serve";
  const args = deps.args || ["ide", "serve"];

  let proc;
  let nextId = 1;
  let pending = new Map();
  let availability = "unknown";
  let consecutiveFailures = 0;
  let nextSpawnAllowedAt = 0;
  let handshake = null;

  function log(line) {
    if (deps.output && deps.output.appendLine) deps.output.appendLine(`[${tag}] ${line}`);
  }

  function rejectAllPending(reason) {
    const err = new Error(`blade ide serve: ${reason}`);
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  }

  function teardown(reason, isFailure) {
    if (!proc) return;
    const p = proc;
    proc = undefined;
    p.removeAllListeners();
    if (p.stdout) p.stdout.removeAllListeners();
    if (p.stderr) p.stderr.removeAllListeners();
    if (p.exitCode === null && p.signalCode === null) {
      try {
        p.kill();
      } catch (_) {
        /* already gone */
      }
    }
    rejectAllPending(reason);
    if (isFailure) {
      consecutiveFailures++;
      if (consecutiveFailures >= 2) {
        availability = "no";
        log(`${reason} — giving up on 'ide serve' for this session`);
      } else {
        nextSpawnAllowedAt = Date.now() + RETRY_GATE_MS;
        log(`${reason} — retrying after ${RETRY_GATE_MS}ms`);
      }
    }
  }

  function handleStdout(decoder, chunk) {
    for (const msg of decoder.push(chunk)) {
      // An "event" line is never a response, even when it echoes a live id.
      if (isEvent(msg)) {
        if (msg.event === "display") {
          const res = frameFromEvent(msg);
          if (res.ok) publish(res.frame, tag);
          else log(res.reason);
        } else log(`ignoring unknown event "${msg.event}"`);
        continue;
      }
      const id = msg.id;
      if (id === undefined || id === null) {
        if (msg.error) log(`serve error (no id): ${msg.error}`);
        continue;
      }
      const p = pending.get(id);
      if (!p) continue;
      pending.delete(id);
      if (msg.error) {
        const err = new Error(msg.error);
        err.protocolError = true;
        p.reject(err);
      } else p.resolve(msg);
    }
  }

  function spawnProcess() {
    const exe = deps.findCompiler();
    const child = cp.spawn(exe, args, { cwd: deps.cwd, windowsHide: true });
    const decoder = createDecoder();
    proc = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (proc !== child) return;
      handleStdout(decoder, chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (proc !== child) return;
      const text = String(chunk).trimEnd();
      if (text) log(text);
    });
    child.on("error", (e) => {
      if (proc !== child) return;
      teardown(`could not run '${exe} ${args.join(" ")}': ${e.message}`, true);
    });
    child.on("exit", (code, signal) => {
      if (proc !== child) return;
      teardown(`blade ide serve exited (code=${code}${signal ? `, signal=${signal}` : ""})`, true);
    });
  }

  function sendRequest(encode, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        pending.delete(id);
        const reason = `request ${id} timed out after ${timeoutMs}ms`;
        reject(new Error(`blade ide serve: ${reason}`));
        teardown(reason, true);
      }, timeoutMs);
      pending.set(id, {
        resolve: (msg) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        },
      });
      try {
        if (!proc) throw new Error("no active process");
        proc.stdin.write(encode(id));
      } catch (e) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error(`blade ide serve: could not write request: ${e.message}`));
        teardown(`could not write request: ${e.message}`, true);
      }
    });
  }

  function doHandshake() {
    return (async () => {
      try {
        spawnProcess();
      } catch (e) {
        consecutiveFailures++;
        availability = "no";
        log(`could not start 'ide serve': ${e.message}`);
        throw new Error("blade ide serve unavailable");
      }
      let msg;
      try {
        msg = await sendRequest((id) => encodePing(id), PING_TIMEOUT_MS);
      } catch (e) {
        if (proc) teardown(`ping error: ${e.message}`, true);
        throw new Error("blade ide serve unavailable");
      }
      if (!msg || msg.ok !== true) {
        teardown("ping response missing ok:true", true);
        throw new Error("blade ide serve unavailable");
      }
      availability = "yes";
      consecutiveFailures = 0;
      log(`available — serve=${msg.serve}, version=${msg.version || "unknown"}`);
    })();
  }

  function ensureReady() {
    if (proc && availability === "yes") return Promise.resolve();
    if (availability === "no") return Promise.reject(new Error("blade ide serve unavailable"));
    if (handshake) return handshake;
    const now = Date.now();
    if (now < nextSpawnAllowedAt) {
      return Promise.reject(new Error(`blade ide serve: backing off for ${nextSpawnAllowedAt - now}ms`));
    }
    const p = doHandshake();
    handshake = p;
    p.finally(() => {
      if (handshake === p) handshake = null;
    }).catch(() => {});
    return p;
  }

  function available() {
    return availability;
  }

  function check(fileName, source, tier, timeoutMs) {
    const t = tier === "full" ? "full" : "fast";
    const ms = timeoutMs || DEFAULT_TIMEOUT_MS[t];
    return ensureReady().then(() => {
      if (!proc) throw new Error("blade ide serve unavailable");
      return sendRequest((id) => encodeCheck(id, t, fileName, source), ms);
    });
  }

  function checkCells(fileName, cells, tier, timeoutMs) {
    const t = tier === "full" ? "full" : "fast";
    const ms = timeoutMs || DEFAULT_TIMEOUT_MS[t];
    return ensureReady().then(() => {
      if (!proc) throw new Error("blade ide serve unavailable");
      return sendRequest((id) => encodeCheckCells(id, t, fileName, cells), ms);
    });
  }

  function evalCode(session, source, cwd, timeoutMs) {
    const ms = timeoutMs || DEFAULT_TIMEOUT_MS.full;
    return ensureReady().then(() => {
      if (!proc) throw new Error("blade ide serve unavailable");
      return sendRequest((id) => encodeEval(id, session, source, cwd), ms);
    });
  }

  function resetSession(session, timeoutMs) {
    const ms = timeoutMs || DEFAULT_TIMEOUT_MS.fast;
    return ensureReady().then(() => {
      if (!proc) throw new Error("blade ide serve unavailable");
      return sendRequest((id) => encodeResetSession(id, session), ms);
    });
  }

  function dispose() {
    if (proc) {
      try {
        proc.stdin.write(encodeShutdown());
      } catch (_) {
        /* pipe gone; the kill in teardown covers it */
      }
    }
    teardown("blade ide serve disposed", false);
    availability = "unknown";
    consecutiveFailures = 0;
    nextSpawnAllowedAt = 0;
    handshake = null;
  }

  return { available, check, checkCells, eval: evalCode, resetSession, dispose };
}

// --- generated data (stubbed) ------------------------------------------------

const STUB_SURFACE = {
  version: 1,
  compilerVersion: "stub",
  keywords: [],
  operators: [],
  mathIntrinsics: { unary: [], binary: [], complex: [] },
  builtins: [],
  scalarTypes: [],
  builtinCalls: [],
  diagnostics: [],
};

const STUB_KB = { version: 1, codes: {} };

module.exports = {
  serveProto,
  replProto,
  display,
  createClient,
  resolveCompiler,
  resolveRepoRoot,
  DEFAULT_CANDIDATES,
};

// Lazy in the real package (require of a generated JSON file); lazy here too so
// consumers exercise the same access pattern.
Object.defineProperty(module.exports, "surface", {
  enumerable: true,
  get() {
    return STUB_SURFACE;
  },
});

Object.defineProperty(module.exports, "diagnosticsKb", {
  enumerable: true,
  get() {
    return STUB_KB;
  },
});

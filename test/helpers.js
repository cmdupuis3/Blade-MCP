"use strict";

// Shared plumbing for tests that spawn test/fake-serve.js as a real child
// process and talk NDJSON to it. Not a *.test.js file itself (see the note in
// package.json about node's test-file glob), just a helper the other files
// require.

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const gr = require("../src/gr");

const FAKE_SERVE_PATH = path.join(__dirname, "fake-serve.js");

/**
 * A throwaway directory that PASSES src/gr.js's validation on THIS platform —
 * every required entry, created empty. Nothing in this suite loads GR (the
 * fake serve is a Node script), so an empty tree is exactly the right double:
 * it proves the resolve/env plumbing without a 100 MB download.
 *
 * Returns { root, dispose() }. Entries whose last segment has no extension
 * (e.g. "fonts") are created as directories, the rest as empty files.
 */
function makeFakeGrRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blade-mcp-gr-"));
  for (const rel of gr.requiredFiles()) {
    const full = path.join(root, rel);
    if (path.extname(full) === "") {
      fs.mkdirSync(full, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, "");
    }
  }
  return {
    root,
    dispose() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A path that certainly is not a GR installation — for pinning the
 *  "GR unavailable" branch deterministically, whatever the host has lying
 *  around in sibling checkouts. */
const NO_SUCH_GR = path.join(os.tmpdir(), "blade-mcp-no-such-gr-root");

/**
 * Spawn test/fake-serve.js with `extraEnv` layered over the current process
 * env (so FAKE_MODE can be set per test without losing PATH etc.).
 * Returns { proc, send(reqWithoutId) -> id, waitFor(predicate, timeoutMs),
 * lines, dispose() }.
 */
function spawnFakeServe(extraEnv) {
  const proc = spawn(process.execPath, [FAKE_SERVE_PATH], {
    env: Object.assign({}, process.env, extraEnv || {}),
    windowsHide: true,
  });

  const lines = [];
  const waiters = [];
  const rl = readline.createInterface({ input: proc.stdout, terminal: false });
  rl.on("line", (line) => {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      obj = { __raw: line, __parseError: e.message };
    }
    lines.push(obj);
    for (const w of waiters.slice()) {
      if (w.predicate(obj)) w.resolve(obj);
    }
  });

  let nextId = 1;
  function send(req) {
    const withId = req.id === undefined ? Object.assign({ id: nextId++ }, req) : req;
    proc.stdin.write(`${JSON.stringify(withId)}\n`);
    return withId.id;
  }

  /** Resolve with the first (already-seen or future) line matching `predicate`. */
  function waitFor(predicate, timeoutMs) {
    const already = lines.find(predicate);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      let settled = false;
      const entry = {
        predicate,
        resolve: (v) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const idx = waiters.indexOf(entry);
          if (idx !== -1) waiters.splice(idx, 1);
          resolve(v);
        },
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = waiters.indexOf(entry);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(new Error(`timed out after ${timeoutMs || 3000}ms waiting for a matching NDJSON line; seen so far: ${JSON.stringify(lines)}`));
      }, timeoutMs || 3000);
      waiters.push(entry);
    });
  }

  /** Resolve once the process has exited (already-exited is fine too). */
  function waitForExit(timeoutMs) {
    if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(proc.exitCode);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fake-serve did not exit within ${timeoutMs || 3000}ms`)), timeoutMs || 3000);
      proc.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  function dispose() {
    try {
      proc.kill();
    } catch (_) {
      /* already gone */
    }
  }

  return { proc, send, waitFor, waitForExit, lines, dispose };
}

// --- the programs behind test/fixtures/check-*.json -----------------------------
//
// Each fixture is the real compiler's tier-full check payload for one of these
// sources (minus `id`/`tier`), which is what lets the integration suite
// re-derive them from a live compiler and fail when the wire shape moves. To
// regenerate one: check the source at tier full with `raw: true` and store the
// payload, keeping check-error.json's two appended SYNTHETIC entries.

const CLEAN_SOURCE = "let x = 1\nlet y = x + 1\n";

const ERROR_SOURCE = [
  "function f(w: Array<Float64 like Idx<4>>) -> Float64 = w(0) + w(1) + w(2) + w(3)",
  "let a: Array<Float64 like Idx<2>> = [1.0, 2.0]",
  "let r = f(a)",
  "",
].join("\n");

/** The csv `RICH_SOURCE` loads; must sit beside the checked path as obs.csv. */
const RICH_CSV = "1,2\n3,4\n";

/** A provider store read and written, a declared and a deduced symmetry, a
 *  defaulted parameter, a function-body local, a `let mut`, an implicit
 *  conversion (BL3020) — and `a` bound four ways (two function parameters, a
 *  lambda parameter, a top-level value). */
const RICH_SOURCE = [
  "import csv as c",
  "",
  'let store = c.load("obs.csv")',
  "let obs = store.vars.data |> c.read",
  'let saved = c.write("obs_out.csv", obs)',
  "",
  "/// Sum of products of two rows.",
  "function dot(a: T^1, b: T^1) where comm(a, b) = reduce(a * b, (+))",
  "",
  "function scale(a: Float64, s: Float64 = 2.0) -> Float64 = {",
  "    let k = lambda(a: Float64) -> a * s",
  "    k(a)",
  "}",
  "",
  "let mut total = 0",
  "let a = scale(1.5)",
  "",
  "function cross(x: T^1, y: T^1) = reduce(x * y, (+))",
  "let n = 3",
  "let ratio = n * 0.5",
  "",
].join("\n");

module.exports = {
  spawnFakeServe,
  FAKE_SERVE_PATH,
  makeFakeGrRoot,
  NO_SUCH_GR,
  CLEAN_SOURCE,
  ERROR_SOURCE,
  RICH_SOURCE,
  RICH_CSV,
};

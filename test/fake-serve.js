#!/usr/bin/env node
"use strict";

// A standalone NDJSON fake of `blade ide serve`, independent of both
// blade-mcp's src/ and the vendored @blade-lang/ide-protocol package — this
// file has zero requires beyond core Node modules, so it exercises the real
// client (protocol package) and the real server (src/) against a compiler
// double that owes nothing to either.
//
// One JSON object per stdin line in, one JSON object per stdout line out,
// exactly like the real `ide serve` loop. Every diagnostic line goes to
// stderr, matching the "stdout is sacred" rule the real server also follows.
//
// FAKE_MODE selects a misbehavior instead of a fixture:
//   (unset)  answer everything normally (the default double).
//   "mute"   never answer ANYTHING, starting with ping — this is what drives
//            a real client's availability latch to "no" (PING_TIMEOUT_MS).
//   "die"    answer ping normally, then exit(0) right after — this is what
//            drives a real client's teardown+backoff/restart path on the
//            NEXT request, since the process is gone before it arrives.
//   "display" on "eval", emit a {"event":"display"} line BEFORE the eval
//            response — proves a client must not let an event with the
//            in-flight id settle that request (docs/display-frames.md).
//
// Fixture selection for check/checkCells: the submitted text is scanned for
// the literal marker "FAKE_ERROR" — present picks fixtures/check-error.json
// (one BL-coded diagnostic + a small references[] table), absent picks
// fixtures/check-clean.json. eval uses the same marker over a small canned
// pair instead of a fixture file (there is no third payload worth a file).

const readline = require("readline");
const path = require("path");

const FAKE_MODE = process.env.FAKE_MODE || "";
const ERROR_MARKER = "FAKE_ERROR";

const checkClean = require("./fixtures/check-clean.json");
const checkError = require("./fixtures/check-error.json");

function write(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function respondPing(id) {
  write({ id, ok: true, serve: 1, version: "fake-1" });
  if (FAKE_MODE === "die") {
    // Let the write actually flush to the pipe before the process disappears.
    setImmediate(() => process.exit(0));
  }
}

function textOf(req) {
  if (typeof req.source === "string") return req.source;
  if (Array.isArray(req.cells)) return req.cells.join("\n");
  return "";
}

function respondCheck(req) {
  const fixture = textOf(req).indexOf(ERROR_MARKER) !== -1 ? checkError : checkClean;
  const out = Object.assign({ id: req.id, tier: req.tier === "full" ? "full" : "fast" }, fixture);
  if (req.cmd === "checkCells" && Array.isArray(req.cells)) {
    out.windows = req.cells.map((_, i) => ({ startLine: i + 1, endLine: i + 1 }));
  }
  write(out);
}

function respondEval(req) {
  const isError = textOf(req).indexOf(ERROR_MARKER) !== -1;
  const base = isError
    ? {
        id: req.id,
        kept: false,
        exitCode: 1,
        lane: "interp",
        elapsedMs: 1,
        stdout: "",
        stderr: "fake eval error\n",
        bindings: [],
        diagnostics: [
          { severity: "error", line: 1, col: 1, endLine: 1, endCol: 1, message: "fake eval failure (FAKE_ERROR marker)", code: "BL3016" },
        ],
      }
    : {
        id: req.id,
        kept: true,
        exitCode: 0,
        lane: "interp",
        elapsedMs: 1,
        stdout: "2\n",
        stderr: "",
        bindings: [{ name: "x", kind: "value", type: "Int64", value: "2" }],
        diagnostics: [],
      };

  if (FAKE_MODE === "display") {
    // Same "id" as the in-flight request on purpose: this is exactly the
    // shape a client must NOT let settle the pending request (see
    // display.isEvent in the protocol package's client.js).
    write({
      event: "display",
      id: req.id,
      frame: { v: 1, mime: "image/png", encoding: "base64", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" },
    });
    // Deliver the event on the wire before the response line, but don't
    // depend on synchronous write ordering being enough on its own —
    // setImmediate still runs before anything triggered by a new stdin read.
    setImmediate(() => write(base));
    return;
  }
  write(base);
}

function respondResetSession(req) {
  write({ id: req.id, ok: true });
}

function handleLine(line) {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch (e) {
    write({ id: null, error: `fake-serve: malformed JSON: ${e.message}` });
    return;
  }

  if (FAKE_MODE === "mute") return; // never answer anything

  switch (req.cmd) {
    case "ping":
      respondPing(req.id);
      return;
    case "check":
    case "checkCells":
      respondCheck(req);
      return;
    case "eval":
      respondEval(req);
      return;
    case "resetSession":
      respondResetSession(req);
      return;
    case "shutdown":
      // No response, by contract. Exit so nothing lingers after the test
      // that sent it.
      setImmediate(() => process.exit(0));
      return;
    default:
      write({ id: req.id, error: `unknown cmd '${req.cmd}'` });
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", handleLine);
process.stdin.on("end", () => process.exit(0));

process.stderr.write(`[fake-serve] ready (mode=${FAKE_MODE || "default"}, pid=${process.pid}, script=${path.basename(__filename)})\n`);

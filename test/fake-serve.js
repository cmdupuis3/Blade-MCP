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
// WHAT IT MODELS (src/IdeServe.fs + src/ReplSession.fs in the Blade repo).
// The check fixtures are the real compiler's own tier-full payloads, captured
// from the build this suite was last refreshed against; the eval behavior
// below is hand-modelled on the same build:
//
//   * THE DISPLAY RULE. An eval echoes only its "return value": `bindings`
//     holds at most one entry, for a FINAL statement that is a bare
//     expression, under `name: ""`. Declarations and reassignments are silent
//     (`bindings: []`), and `stdout` is the program's own output only.
//   * FAILURES. A front-end rejection is `kept:false, exitCode:1` with spanned
//     diagnostics and an EMPTY stderr. A runtime guard panic prints
//     `error[BLxxxx]: <message>` on stderr and ALSO arrives as a coded
//     diagnostic. A failed g++ fallback lane reports `lane:"gpp"`, its message
//     on stderr, and one code-less 1:1 diagnostic. A failed submission is not
//     kept.
//   * SESSION REPLAY. A session re-runs every committed cell on each eval, so
//     a response carries the display frames of EVERY committed plotting cell,
//     not just the submitted one. Frame ids are `<session tag>-<ordinal>`, the
//     ordinal restarting each run — stable across replays. A bare-expression
//     plot is transient: it shows once and is not replayed. Rebinding a name
//     replaces its cell in place. resetSession forgets the session.
//   * STREAMED FRAMES. A frame with a caller-chosen id (`plot.stream`) goes out
//     as an `{"event":"display"}` line BEFORE the response and is NOT repeated
//     in the response's `display` array; it replays like any other.
//
// Markers in the submitted text select a canned outcome:
//
//   FAKE_ERROR        check: fixtures/check-error.json — the BL3016 payload,
//                     plus two shapes the wire format documents that a small
//                     program does not produce (a diagnostic with no `code`,
//                     and a `references[]` entry whose `def` is null).
//                     eval:  a front-end rejection (BL3016).
//   FAKE_RICH         check: fixtures/check-rich.json — a csv provider store,
//                     providerRead/providerWrite, where-clauses, deduced
//                     symmetry, a BL3020 warning, and `a` bound four ways.
//   FAKE_PANIC        eval: a runtime panic (BL8013, integer division by zero).
//   FAKE_GPP_MISSING  eval: the g++ fallback lane with no g++ on PATH.
//   plot.<fn>(        eval, in a plot mode: one plotly figure frame per call.
//   plot.stream(      eval, any mode: one streamed plotstream event per call.
//
// FAKE_MODE selects a misbehavior or a display variant:
//   (unset)  answer everything normally (the default double).
//   "mute"   never answer ANYTHING, starting with ping — this is what drives
//            a real client's availability latch to "no" (PING_TIMEOUT_MS).
//   "die"    answer ping normally, then exit(0) right after — this is what
//            drives a real client's teardown+backoff/restart path on the
//            NEXT request, since the process is gone before it arrives.
//   "hang"   answer ping, then never answer an eval — a submission that
//            outlives its timeout.
//   "crash"  answer ping, then exit(3) on receiving an eval — the process
//            dying with a request in flight.
//   "display" on "eval", emit a {"event":"display"} line BEFORE the eval
//            response — proves a client must not let an event with the
//            in-flight id settle that request (docs/display-frames.md).
//   "plot"   `plot.<fn>(` calls in an eval produce plotly figure frames — the
//            frames blade-mcp is expected to upgrade to GR images via
//            "renderPlot".
//   "plot-renderfail"
//            same eval, but "renderPlot" answers {"id","error"} — a live
//            compiler that cannot reach GR. Proves the fallback to text.
//   "plot-huge"
//            same eval, but "renderPlot" answers with a >1MB PNG — proves the
//            inline-image cap still applies to a render.
//   "plot-oldcompiler"
//            same eval, but "renderPlot" is not implemented at all (the
//            unknown-cmd answer a compiler predating the verb gives).
//   "plot-raster"
//            on "eval", return an image/png frame the PROGRAM produced — must
//            reach the client untouched, with no renderPlot round trip.
//
// "renderPlot" is answered in every mode except "plot-oldcompiler": a canned
// 1x1 PNG frame echoing the request's plotId (as meta.id, per the protocol)
// and its width/height (as meta.width/meta.height — the real compiler has no
// reason to echo those; it is fixture instrumentation so a test can prove the
// requested size reached the wire).

const readline = require("readline");
const path = require("path");

const FAKE_MODE = process.env.FAKE_MODE || "";
const ERROR_MARKER = "FAKE_ERROR";
const RICH_MARKER = "FAKE_RICH";
const PANIC_MARKER = "FAKE_PANIC";
const GPP_MISSING_MARKER = "FAKE_GPP_MISSING";

const checkClean = require("./fixtures/check-clean.json");
const checkError = require("./fixtures/check-error.json");
const checkRich = require("./fixtures/check-rich.json");

/** A real (1x1, transparent) PNG — small enough to inline everywhere. */
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const PLOTLY_MIME = "application/vnd.plotly.v1+json";
const PLOTSTREAM_MIME = "application/vnd.blade.plotstream.v1+json";

const PROGRAM_PNG_FRAME = {
  v: 1,
  mime: "image/png",
  encoding: "base64",
  data: TINY_PNG_B64,
  meta: { id: "raster-1", backend: "gr" },
};

const PLOT_MODES = new Set(["plot", "plot-renderfail", "plot-huge", "plot-oldcompiler"]);

/** session key -> ordered committed cells [{name, source}] */
const sessions = new Map();

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
  const text = textOf(req);
  const fixture = text.indexOf(ERROR_MARKER) !== -1 ? checkError : text.indexOf(RICH_MARKER) !== -1 ? checkRich : checkClean;
  const out = Object.assign({ id: req.id, tier: req.tier === "full" ? "full" : "fast" }, fixture);
  if (req.cmd === "checkCells" && Array.isArray(req.cells)) {
    out.windows = req.cells.map((_, i) => ({ startLine: i + 1, endLine: i + 1 }));
  }
  write(out);
}

// --- eval ------------------------------------------------------------------------

/** The statements of a submission: non-blank, non-comment lines. Enough for a
 *  double — the real splitter is bracket-aware, and no test here needs that. */
function statementsOf(source) {
  return String(source)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("//"));
}

const DECLARATION = /^(let|function|static|type|import|from|module|struct|interface|impl|Unit)\b/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\s*([+\-*/]?=)(?!=)/;

function isSilent(statement) {
  return DECLARATION.test(statement) || ASSIGNMENT.test(statement);
}

/** The name a declaration binds, for rebind-in-place. */
function bindingName(statement) {
  const m = /^(?:let\s+(?:mut\s+|static\s+|rec\s+)?|function\s+|static\s+function\s+|type\s+)([A-Za-z_][A-Za-z0-9_]*)/.exec(statement);
  return m ? m[1] : null;
}

/** A stable per-session tag, like the compiler's `Frame.tagForSession`. */
function sessionTag(key) {
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return `s${h.toString(16)}`;
}

/** Every `plot.<fn>(...)` call in a statement, as {fn, text, title}. */
function plotCalls(statement) {
  const calls = [];
  const re = /plot\.([a-z_]+)\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(statement)) !== null) {
    const title = /"([^"]*)"\s*:\s*title/.exec(m[2]);
    calls.push({ fn: m[1], text: m[0], title: title ? title[1] : "fake figure" });
  }
  return calls;
}

/** One run of the session: frames from every committed cell, then from the
 *  submission's own statements. Returns {inline, streamed}. */
function runFrames(key, statements) {
  const tag = sessionTag(key);
  const inline = [];
  const streamed = [];
  let ordinal = 0;
  for (const statement of statements) {
    for (const call of plotCalls(statement)) {
      if (call.fn === "stream") {
        const channel = (/"([^"]*)"/.exec(call.text) || [])[1] || "stream";
        streamed.push({
          v: 1,
          mime: PLOTSTREAM_MIME,
          encoding: "json",
          data: { channel, epoch: -1, x: [0, 1], y: [call.text.length, 1] },
          meta: { id: channel, stream: true, backend: "plotly" },
        });
      } else if (PLOT_MODES.has(FAKE_MODE)) {
        ordinal++;
        inline.push({
          v: 1,
          mime: PLOTLY_MIME,
          encoding: "json",
          data: {
            // The call text rides the trace so two different calls are two
            // different figures, as they would be for real.
            data: [{ type: "scatter", mode: "lines", name: call.text, x: [0, 1, 2], y: [0, 1, 4] }],
            layout: { title: { text: call.title } },
          },
          meta: { id: `${tag}-${ordinal}`, backend: "plotly" },
        });
      }
    }
  }
  return { inline, streamed };
}

function respondEval(req) {
  if (FAKE_MODE === "hang") return; // never answers: the caller's timeout fires
  if (FAKE_MODE === "crash") {
    process.exit(3);
    return;
  }

  const source = textOf(req);
  const key = typeof req.session === "string" ? req.session : "default";
  const failure = { id: req.id, kept: false, exitCode: 1, lane: "interp", elapsedMs: 1, stdout: "", bindings: [] };

  if (source.indexOf(ERROR_MARKER) !== -1) {
    write(
      Object.assign({}, failure, {
        stderr: "",
        diagnostics: [
          { severity: "error", line: 1, col: 1, endLine: 1, endCol: 1, message: "fake eval failure (FAKE_ERROR marker)", code: "BL3016" },
        ],
      })
    );
    return;
  }
  if (source.indexOf(PANIC_MARKER) !== -1) {
    write(
      Object.assign({}, failure, {
        stderr: "error[BL8013]: integer division by zero",
        diagnostics: [{ severity: "error", line: 1, col: 1, endLine: 1, endCol: 1, message: "integer division by zero", code: "BL8013" }],
      })
    );
    return;
  }
  if (source.indexOf(GPP_MISSING_MARKER) !== -1) {
    const msg = "Compilation failed:\nSkipped: requires g++, not found";
    write(
      Object.assign({}, failure, {
        lane: "gpp",
        elapsedMs: 0,
        stderr: msg,
        diagnostics: [{ severity: "error", line: 1, col: 1, endLine: 1, endCol: 1, message: msg }],
      })
    );
    return;
  }

  const statements = statementsOf(source);
  const last = statements.length ? statements[statements.length - 1] : "";
  const echoes = last !== "" && !isSilent(last);

  // Commit every statement except a trailing bare expression (transient).
  const cells = (sessions.get(key) || []).slice();
  const committed = echoes ? statements.slice(0, -1) : statements;
  for (const statement of committed) {
    const name = bindingName(statement);
    const at = name ? cells.findIndex((c) => c.name === name) : -1;
    if (at !== -1) cells[at] = { name, source: statement };
    else cells.push({ name, source: statement });
  }
  sessions.set(key, cells);

  const { inline, streamed } = runFrames(key, cells.map((c) => c.source).concat(echoes ? [last] : []));

  const base = {
    id: req.id,
    kept: true,
    exitCode: 0,
    lane: "interp",
    elapsedMs: 1,
    stdout: "",
    stderr: "",
    bindings: echoes ? [{ name: "", type: "Int64", value: "2" }] : [],
    diagnostics: [],
  };

  // Streamed frames go out first, as events carrying the in-flight id.
  for (const frame of streamed) write({ event: "display", id: req.id, frame });

  if (FAKE_MODE === "plot-raster") {
    write(Object.assign({}, base, { display: [PROGRAM_PNG_FRAME] }));
    return;
  }

  if (FAKE_MODE === "display") {
    // Same "id" as the in-flight request on purpose: this is exactly the
    // shape a client must NOT let settle the pending request (see
    // display.isEvent in the protocol package's client.js).
    write({
      event: "display",
      id: req.id,
      frame: { v: 1, mime: "image/png", encoding: "base64", data: TINY_PNG_B64 },
    });
    // Deliver the event on the wire before the response line, but don't
    // depend on synchronous write ordering being enough on its own —
    // setImmediate still runs before anything triggered by a new stdin read.
    setImmediate(() => write(base));
    return;
  }

  // `display` is emitted ONLY when non-empty, like the real encoder.
  write(inline.length ? Object.assign({}, base, { display: inline }) : base);
}

function respondResetSession(req) {
  sessions.delete(typeof req.session === "string" ? req.session : "default");
  write({ id: req.id, ok: true });
}

/** `{id, frame}` — one complete display frame, the same shape an eval's
 *  frames have, per the protocol's RenderPlotResponse. */
function respondRenderPlot(req) {
  if (FAKE_MODE === "plot-renderfail") {
    write({ id: req.id, error: "fake-serve: GR worker unavailable (GRDIR not set?)" });
    return;
  }
  const data = FAKE_MODE === "plot-huge" ? "A".repeat(2 * 1024 * 1024) : TINY_PNG_B64;
  write({
    id: req.id,
    frame: {
      v: 1,
      mime: "image/png",
      encoding: "base64",
      data,
      meta: { id: req.plotId, backend: "gr", width: req.width, height: req.height },
    },
  });
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
    case "renderPlot":
      // "plot-oldcompiler" answers exactly what a compiler predating this verb
      // does — the same line the default branch below writes.
      if (FAKE_MODE === "plot-oldcompiler") {
        write({ id: req.id, error: `unknown cmd '${req.cmd}'` });
        return;
      }
      respondRenderPlot(req);
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

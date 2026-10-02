"use strict";

// sessions.js: blade_eval / blade_reset_session. Focus is display-frame
// conversion (frameContent), dedup across the two frame channels
// (collectFrames), session replay (splitReplayed: a session re-emits every
// committed cell's frames on every eval), the GR plot upgrade and every one of
// its fallbacks (framesToContent), diagnostics trimming, and the failure
// paths — driven with a fake ctx/client, no process.

const os = require("os");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const sessions = require("../../src/sessions");

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const PLOTLY_MIME = "application/vnd.plotly.v1+json";

/** A plotly figure frame as an eval emits it. */
function plotFrame(title, id) {
  const t = title || "fig";
  return {
    v: 1,
    mime: PLOTLY_MIME,
    encoding: "json",
    data: { data: [{ name: t, type: "scatter", x: [0, 1], y: [0, 1] }], layout: { title: { text: t } } },
    meta: { id: id || "plot-1", backend: "plotly" },
  };
}

/** The `{id, frame}` a compiler answers renderPlot with. */
function renderResponse(data) {
  return { id: 7, frame: { v: 1, mime: "image/png", encoding: "base64", data: data || TINY_PNG_B64, meta: { backend: "gr" } } };
}

function makeCtx(overrides) {
  const o = overrides || {};
  return {
    config: { cwd: o.cwd || os.tmpdir() },
    pkg: {
      display: {
        PLOTLY_MIME,
        framesFromEval: o.framesFromEval || (() => ({ frames: [], errors: [] })),
      },
    },
    // Absent unless a test opts in, so the default fake context is a host
    // WITHOUT GR — i.e. the pre-existing text behavior.
    grRuntime: o.grRuntime,
    getClient: () => ({
      eval: o.evalImpl || (async () => ({ exitCode: 0, kept: true, lane: "interp", elapsedMs: 1, stdout: "", stderr: "", bindings: [], diagnostics: [] })),
      resetSession: o.resetSessionImpl || (async () => ({ ok: true })),
      renderPlot: o.renderPlotImpl || (async () => renderResponse()),
    }),
    // bladeEval calls this twice (a discarded pre-clear, then collectFrames'
    // real read) — returning the same fixed array both times is correct for
    // both that flow and the standalone collectFrames tests below, which
    // call it exactly once.
    drainFrames: () => o.drainedFrames || [],
    resolved: () => ({ exe: "Blade.exe", origin: "test" }),
    diagRegistry: () =>
      new Map([
        ["BL8013", { code: "BL8013", title: "integer arithmetic fault", phase: "runtime" }],
        ["BL3020", { code: "BL3020", title: "implicit numeric conversion", phase: "types" }],
      ]),
    log: () => {},
  };
}

/** An eval response in the real wire shape, overridable per test. */
function evalResponse(overrides) {
  return Object.assign(
    { id: 1, kept: true, exitCode: 0, lane: "interp", elapsedMs: 1, stdout: "", stderr: "", bindings: [], diagnostics: [] },
    overrides || {}
  );
}

/** A ctx whose successive evals return `runs[i]` = the frames of run i. */
function replayCtx(runs, extra) {
  let call = 0;
  let frames = [];
  const overrides = Object.assign(
    {
      evalImpl: async () => {
        const run = runs[Math.min(call, runs.length - 1)];
        call++;
        frames = run.frames || [];
        return evalResponse(run.response);
      },
      framesFromEval: () => ({ frames, errors: [] }),
    },
    extra || {}
  );
  return makeCtx(overrides);
}

test("frameContent: an inline base64 PNG under the size limit becomes an image block", () => {
  const block = sessions.frameContent({ mime: "image/png", encoding: "base64", data: TINY_PNG_B64 });
  assert.equal(block.type, "image");
  assert.equal(block.mimeType, "image/png");
  assert.equal(block.data, TINY_PNG_B64);
});

test("frameContent: an oversized image degrades to a text placeholder, not a throw", () => {
  const huge = "A".repeat(2 * 1024 * 1024); // ~1.5MB decoded, over the 1MB inline cap
  const block = sessions.frameContent({ mime: "image/png", encoding: "base64", data: huge });
  assert.equal(block.type, "text");
  assert.match(block.text, /exceeds the 1 MB inline limit/);
});

test("frameContent: text/* frames decode base64 and truncate past the char limit", () => {
  const long = "x".repeat(10000);
  const b64 = Buffer.from(long, "utf8").toString("base64");
  const block = sessions.frameContent({ mime: "text/plain", encoding: "base64", data: b64 });
  assert.equal(block.type, "text");
  assert.match(block.text, /truncated, 10000 chars total/);
});

test("frameContent: json-encoded frames render as pretty-printed text", () => {
  const block = sessions.frameContent({ mime: "application/vnd.plotly.v1+json", encoding: "json", data: { a: 1 } });
  assert.equal(block.type, "text");
  assert.match(block.text, /"a": 1/);
});

test("frameContent: a malformed frame never throws, degrades to a text description", () => {
  const block = sessions.frameContent(null);
  assert.equal(block.type, "text");
});

test("collectFrames: dedupes a frame present on both the inline and streamed channels", () => {
  const frame = { mime: "text/plain", encoding: "utf8", data: "hello" };
  const ctx = makeCtx({
    framesFromEval: () => ({ frames: [frame], errors: [] }),
    drainedFrames: [frame],
  });
  const { frames, errors } = sessions.collectFrames({ display: [frame] }, ctx);
  assert.equal(frames.length, 1);
  assert.equal(errors.length, 0);
});

test("collectFrames: distinct frames from both channels are both kept", () => {
  const inline = { mime: "text/plain", encoding: "utf8", data: "one" };
  const streamed = { mime: "text/plain", encoding: "utf8", data: "two" };
  const ctx = makeCtx({
    framesFromEval: () => ({ frames: [inline], errors: [] }),
    drainedFrames: [streamed],
  });
  const { frames } = sessions.collectFrames({ display: [inline] }, ctx);
  assert.equal(frames.length, 2);
});

test("collectFrames: two figures that agree on length and on their first 64 characters are STILL two figures", () => {
  // The real shape of this hazard: two line plots over one x axis whose y
  // values print to the same width. Everything up to the y array is identical
  // and so is the total length — a sampled key calls them one frame.
  const fig = (y, id) => ({
    v: 1,
    mime: PLOTLY_MIME,
    encoding: "json",
    data: { data: [{ type: "scatter", mode: "lines", x: [0, 1, 2, 3, 4, 5, 6, 7], y }], layout: { autosize: true } },
    meta: { id, backend: "plotly" },
  });
  const a = fig([0, 1, 4, 9], "s1-1");
  const b = fig([0, 2, 8, 7], "s1-2");
  assert.equal(JSON.stringify(a.data).length, JSON.stringify(b.data).length);
  assert.equal(JSON.stringify(a.data).slice(0, 64), JSON.stringify(b.data).slice(0, 64));
  const ctx = makeCtx({ framesFromEval: () => ({ frames: [a, b], errors: [] }) });
  const { frames } = sessions.collectFrames({}, ctx);
  assert.equal(frames.length, 2, "the second plot must not be dropped");
});

test("collectFrames: the same bytes under two plot ids are two plots; under one id they are one", () => {
  const ctx = makeCtx({
    framesFromEval: () => ({ frames: [plotFrame("t", "s1-1"), plotFrame("t", "s1-2")], errors: [] }),
    // the g++ fallback lane re-emits a frame the interpreter attempt already streamed
    drainedFrames: [plotFrame("t", "s1-1")],
  });
  const { frames } = sessions.collectFrames({}, ctx);
  assert.deepEqual(frames.map((f) => f.meta.id), ["s1-1", "s1-2"]);
});

test("frameKey: covers the whole payload and the plot id", () => {
  const base = plotFrame("t", "p1");
  assert.equal(sessions.frameKey(base), sessions.frameKey(plotFrame("t", "p1")));
  assert.notEqual(sessions.frameKey(base), sessions.frameKey(plotFrame("t", "p2")));
  assert.notEqual(sessions.frameKey(base), sessions.frameKey(plotFrame("u", "p1")));
  // a frame with no meta at all is still digestable
  assert.equal(typeof sessions.frameKey({ mime: "text/plain", encoding: "utf8", data: "x" }), "string");
});

// --- what an eval reports -------------------------------------------------------

test("bladeEval: the echoed return value passes through as the single `bindings` entry", async () => {
  const ctx = makeCtx({
    evalImpl: async () => evalResponse({ bindings: [{ name: "", type: "Int64", value: "3" }] }),
  });
  const s = (await sessions.bladeEval({ source: "x + 1" }, ctx)).structuredContent;
  assert.equal(s.ok, true);
  assert.deepEqual(s.bindings, [{ name: "", type: "Int64", value: "3" }]);
  assert.equal(s.hint, undefined);
});

test("bladeEval: a silent declaration is ok:true with no bindings, and that is not an error", async () => {
  const ctx = makeCtx({ evalImpl: async () => evalResponse() });
  const result = await sessions.bladeEval({ source: "let x = 2" }, ctx);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.kept, true);
  assert.deepEqual(result.structuredContent.bindings, []);
  assert.equal(result.structuredContent.displayFrames, 0);
});

test("bladeEval: diagnostics take blade_check's shape — a runtime panic gets its registry title", async () => {
  const ctx = makeCtx({
    evalImpl: async () =>
      evalResponse({
        kept: false,
        exitCode: 1,
        stderr: "error[BL8013]: integer division by zero",
        diagnostics: [{ severity: "error", line: 1, col: 1, endLine: 1, endCol: 1, message: "integer division by zero", code: "BL8013" }],
      }),
  });
  const result = await sessions.bladeEval({ source: "let q = 1 / 0" }, ctx);
  assert.equal(result.isError, undefined, "a program fault is a result, not a tool error");
  const s = result.structuredContent;
  assert.equal(s.ok, false);
  assert.equal(s.kept, false);
  assert.deepEqual(s.diagnostics, [
    {
      code: "BL8013",
      title: "integer arithmetic fault",
      phase: "runtime",
      severity: "error",
      message: "integer division by zero",
      span: { line: 1, col: 1, endLine: 1, endCol: 1 },
    },
  ]);
  assert.equal(s.stderr, "error[BL8013]: integer division by zero");
  assert.equal(s.hint, undefined, "a coded panic explains itself");
});

test("bladeEval: warnings on an accepted submission are reported without failing it", async () => {
  const ctx = makeCtx({
    evalImpl: async () =>
      evalResponse({
        bindings: [{ name: "", type: "Float64", value: "7.5" }],
        diagnostics: [
          { severity: "warning", line: 2, col: 9, endLine: 2, endCol: 10, message: "implicit numeric conversion: ...", code: "BL3020" },
          { severity: "warning", line: 1, col: 1, endLine: 1, endCol: 1, message: "elsewhere in session: implicit numeric conversion: ...", code: "BL3020" },
        ],
      }),
  });
  const s = (await sessions.bladeEval({ source: "m" }, ctx)).structuredContent;
  assert.equal(s.ok, true);
  assert.equal(s.diagnostics.length, 2);
  assert.equal(s.diagnostics[0].title, "implicit numeric conversion");
  assert.match(s.diagnostics[1].message, /^elsewhere in session:/);
});

test("bladeEval: a hand-rolled context with no diagnostic registry still trims", async () => {
  const ctx = makeCtx({
    evalImpl: async () =>
      evalResponse({ kept: false, exitCode: 1, diagnostics: [{ severity: "error", line: 1, col: 1, endLine: 1, endCol: 2, message: "Unbound variable: y", code: "BL2001" }] }),
  });
  delete ctx.diagRegistry;
  const s = (await sessions.bladeEval({ source: "y" }, ctx)).structuredContent;
  assert.equal(s.diagnostics[0].code, "BL2001");
  assert.equal(s.diagnostics[0].title, undefined);
});

test("bladeEval: a g++ fallback lane with no g++ gets a hint naming the fix", async () => {
  const msg = "Compilation failed:\nSkipped: requires g++, not found";
  const ctx = makeCtx({
    evalImpl: async () =>
      evalResponse({
        kept: false,
        exitCode: 1,
        lane: "gpp",
        stderr: msg,
        diagnostics: [{ severity: "error", line: 1, col: 1, endLine: 1, endCol: 1, message: msg }],
      }),
  });
  const s = (await sessions.bladeEval({ source: "let A = fill_random(10)" }, ctx)).structuredContent;
  assert.equal(s.ok, false);
  assert.equal(s.lane, "gpp");
  assert.match(s.hint, /no g\+\+ was found/);
  assert.match(s.hint, /blade_doctor/);
  assert.equal(s.diagnostics[0].code, null);
});

test("failureHint: any other g++ lane failure points at stderr and the doctor row; successes and interp failures get none", () => {
  assert.match(sessions.failureHint({ exitCode: 1, lane: "gpp", stderr: "Compilation failed:\nld: cannot find -lopenblas" }, [{ code: null }]), /that lane failed/);
  assert.equal(sessions.failureHint({ exitCode: 0, lane: "gpp", stderr: "" }, []), undefined);
  assert.equal(sessions.failureHint({ exitCode: 1, lane: "interp", stderr: "" }, [{ code: "BL3001" }]), undefined);
  // a runtime panic raised by the compiled binary is coded: no toolchain hint
  assert.equal(sessions.failureHint({ exitCode: 1, lane: "gpp", stderr: "error[BL8013]: integer division by zero" }, [{ code: "BL8013" }]), undefined);
});

// --- session replay --------------------------------------------------------------

test("replay: a plot a committed cell re-emits is delivered once, then counted as unchanged", async () => {
  const a = plotFrame("squares", "s1-1");
  const ctx = replayCtx([{ frames: [a] }, { frames: [a] }, { frames: [a] }], { grRuntime: GR_OK });

  const first = await sessions.bladeEval({ source: "let shown = plot.line(x, y)" }, ctx);
  assert.equal(first.structuredContent.displayFrames, 1);
  assert.equal(first.structuredContent.plotsRendered, 1);
  assert.equal(first.structuredContent.displayFramesUnchanged, undefined);
  assert.ok(first.content.some((c) => c.type === "image"));

  const second = await sessions.bladeEval({ source: "1 + 1" }, ctx);
  assert.equal(second.structuredContent.displayFrames, 0);
  assert.equal(second.structuredContent.displayFramesUnchanged, 1);
  assert.equal(second.structuredContent.plotsRendered, undefined, "an unchanged plot is not re-rendered");
  assert.match(second.structuredContent.displayNote, /not sent again/);
  assert.equal(second.content.length, 1, "nothing but the structured result");

  const third = await sessions.bladeEval({ source: "2 + 2" }, ctx);
  assert.equal(third.structuredContent.displayFramesUnchanged, 1);
});

test("replay: a new plot is delivered alongside an unchanged one", async () => {
  const a = plotFrame("squares", "s1-1");
  const b = plotFrame("doubles", "s1-2");
  const ctx = replayCtx([{ frames: [a] }, { frames: [a, b] }], { grRuntime: GR_OK });
  await sessions.bladeEval({ source: "let p = plot.line(x, y)" }, ctx);
  const second = await sessions.bladeEval({ source: "let q = plot.line(x, y2)" }, ctx);
  assert.equal(second.structuredContent.displayFrames, 1);
  assert.equal(second.structuredContent.displayFramesUnchanged, 1);
  const labels = second.content.filter((c) => c.type === "text" && /^\[plot:/.test(c.text));
  assert.equal(labels.length, 1);
  assert.match(labels[0].text, /doubles/);
});

test("replay: a plot whose CONTENT changed under the same id is delivered again", async () => {
  const before = plotFrame("squares", "s1-1");
  const after = plotFrame("squares, rebound", "s1-1");
  const ctx = replayCtx([{ frames: [before] }, { frames: [after] }]);
  await sessions.bladeEval({ source: "let p = plot.line(x, y)" }, ctx);
  const second = await sessions.bladeEval({ source: "let y = [0.0, 1.0, 9.0]" }, ctx);
  assert.equal(second.structuredContent.displayFrames, 1);
  assert.equal(second.structuredContent.displayFramesUnchanged, undefined);
});

test("replay: A -> B -> A delivers all three (memory is the PREVIOUS run, not everything ever shown)", async () => {
  const a = plotFrame("A", "s1-1");
  const b = plotFrame("B", "s1-1");
  const ctx = replayCtx([{ frames: [a] }, { frames: [b] }, { frames: [a] }]);
  for (const expected of [1, 1, 1]) {
    const s = (await sessions.bladeEval({ source: "p" }, ctx)).structuredContent;
    assert.equal(s.displayFrames, expected);
  }
});

test("replay: a rejected submission emits nothing and must not make the next run re-deliver everything", async () => {
  const a = plotFrame("squares", "s1-1");
  const ctx = replayCtx([
    { frames: [a] },
    { frames: [], response: { kept: false, exitCode: 1, diagnostics: [{ severity: "error", line: 1, col: 1, endLine: 1, endCol: 2, message: "Unbound variable: y", code: "BL2001" }] } },
    { frames: [a] },
  ]);
  await sessions.bladeEval({ source: "let p = plot.line(x, y)" }, ctx);
  const rejected = await sessions.bladeEval({ source: "y" }, ctx);
  assert.equal(rejected.structuredContent.ok, false);
  const third = (await sessions.bladeEval({ source: "1" }, ctx)).structuredContent;
  assert.equal(third.displayFrames, 0);
  assert.equal(third.displayFramesUnchanged, 1);
});

test("replay: sessions are independent, and blade_reset_session makes a session's plots new again", async () => {
  const a = plotFrame("squares", "s1-1");
  const ctx = replayCtx([{ frames: [a] }]);
  assert.equal((await sessions.bladeEval({ source: "p", session: "one" }, ctx)).structuredContent.displayFrames, 1);
  assert.equal((await sessions.bladeEval({ source: "p", session: "two" }, ctx)).structuredContent.displayFrames, 1, "another session has seen nothing");
  assert.equal((await sessions.bladeEval({ source: "p", session: "one" }, ctx)).structuredContent.displayFrames, 0);

  await sessions.bladeResetSession({ session: "one" }, ctx);
  assert.equal((await sessions.bladeEval({ source: "p", session: "one" }, ctx)).structuredContent.displayFrames, 1);
  assert.equal((await sessions.bladeEval({ source: "p", session: "two" }, ctx)).structuredContent.displayFrames, 0, "resetting one session leaves the other alone");
});

test("replay: asking for a different render size re-delivers the plot; going back to a seen size does not", async () => {
  const a = plotFrame("squares", "s1-1");
  const sizes = [];
  const ctx = replayCtx([{ frames: [a] }], {
    grRuntime: GR_OK,
    renderPlotImpl: async (args) => (sizes.push(`${args.width}x${args.height}`), renderResponse()),
  });
  await sessions.bladeEval({ source: "p" }, ctx);
  const bigger = await sessions.bladeEval({ source: "p", plotWidth: 1600, plotHeight: 1200 }, ctx);
  assert.equal(bigger.structuredContent.displayFrames, 1, "a larger render was asked for: it must arrive");
  assert.equal(bigger.structuredContent.plotsRendered, 1);
  const back = await sessions.bladeEval({ source: "p" }, ctx);
  assert.equal(back.structuredContent.displayFrames, 0);
  assert.equal(back.structuredContent.displayFramesUnchanged, 1);
  assert.deepEqual(sizes, ["800x600", "1600x1200"]);
});

test("replay: stream instalments (several frames under one id) replay as a unit", async () => {
  const instalment = (y) => ({
    v: 1,
    mime: "application/vnd.blade.plotstream.v1+json",
    encoding: "json",
    data: { channel: "train_loss", epoch: -1, x: [0, 1], y },
    meta: { id: "train_loss", stream: true, backend: "plotly" },
  });
  const run = [instalment([0.9, 0.5]), instalment([0.3, 0.2])];
  const ctx = replayCtx([{ frames: run }, { frames: run }]);
  const first = await sessions.bladeEval({ source: "let s = plot.stream(...)" }, ctx);
  assert.equal(first.structuredContent.displayFrames, 2);
  assert.equal(first.content.filter((c) => /plotstream/.test(c.text || "")).length, 2, "a stream frame has no renderer: it is JSON text");
  const second = await sessions.bladeEval({ source: "1" }, ctx);
  assert.equal(second.structuredContent.displayFrames, 0);
  assert.equal(second.structuredContent.displayFramesUnchanged, 2);
});

test("a runaway emitter is capped at MAX_DISPLAY_FRAMES, and the overflow is not remembered as shown", async () => {
  const many = [];
  for (let i = 0; i < sessions.MAX_DISPLAY_FRAMES + 6; i++) many.push({ mime: "text/plain", encoding: "utf8", data: `frame ${i}`, meta: { id: `t-${i}` } });
  const ctx = replayCtx([{ frames: many }, { frames: many }]);
  const first = await sessions.bladeEval({ source: "loop" }, ctx);
  assert.equal(first.structuredContent.displayFrames, sessions.MAX_DISPLAY_FRAMES);
  assert.equal(first.structuredContent.displayFramesOmitted, 6);
  assert.match(first.structuredContent.displayNote, /only the first 24 are included/);
  assert.equal(first.content.length, 1 + sessions.MAX_DISPLAY_FRAMES);

  // committed cells replay: the frames nobody saw arrive now, the rest are unchanged
  const second = await sessions.bladeEval({ source: "1" }, ctx);
  assert.equal(second.structuredContent.displayFrames, 6);
  assert.equal(second.structuredContent.displayFramesUnchanged, sessions.MAX_DISPLAY_FRAMES);
  assert.equal(second.structuredContent.displayFramesOmitted, undefined);
});

test("replay: a transport failure means the process (and its sessions) are gone — the baseline is dropped", async () => {
  const a = plotFrame("squares", "s1-1");
  let call = 0;
  const ctx = makeCtx({
    evalImpl: async () => {
      call++;
      if (call === 2) throw new Error("blade ide serve: request 4 timed out after 1000ms");
      return evalResponse();
    },
    framesFromEval: () => ({ frames: [a], errors: [] }),
  });
  ctx.getClient = ((inner) => () => Object.assign(inner(), { available: () => "yes" }))(ctx.getClient);
  assert.equal((await sessions.bladeEval({ source: "let p = plot.line(x, y)" }, ctx)).structuredContent.displayFrames, 1);
  const failed = await sessions.bladeEval({ source: "slow" }, ctx);
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.cause, "timeout");
  assert.equal(failed.structuredContent.sessionsLost, true);
  // the respawned process starts empty; re-evaluating the cell must show its plot
  assert.equal((await sessions.bladeEval({ source: "let p = plot.line(x, y)" }, ctx)).structuredContent.displayFrames, 1);
});

test("plotTitle: meta.title wins (it is what display.emit callers set), then layout.title in either spelling", () => {
  assert.equal(sessions.plotTitle({ meta: { title: "demo" }, data: { layout: { title: { text: "ignored" } } } }), "demo");
  assert.equal(sessions.plotTitle({ meta: {}, data: { layout: { title: { text: "from layout" } } } }), "from layout");
  assert.equal(sessions.plotTitle({ data: { layout: { title: "plain string" } } }), "plain string");
  assert.equal(sessions.plotTitle({ data: { layout: {} } }), null);
  assert.equal(sessions.plotTitle({ meta: { title: "   " }, data: {} }), null);
});

test("bladeEval: `source` is required and non-empty", async () => {
  const ctx = makeCtx();
  await assert.rejects(() => sessions.bladeEval({}, ctx), /`source` is required/);
  await assert.rejects(() => sessions.bladeEval({ source: "" }, ctx), /`source` is required/);
});

test("bladeEval: session defaults to 'default' and passes through unprefixed", async () => {
  let seenSession;
  const ctx = makeCtx({
    evalImpl: async (session) => {
      seenSession = session;
      return { exitCode: 0, kept: true, lane: "interp", elapsedMs: 1, stdout: "2\n", stderr: "", bindings: [], diagnostics: [] };
    },
  });
  const result = await sessions.bladeEval({ source: "1 + 1" }, ctx);
  assert.equal(seenSession, "default");
  assert.equal(result.structuredContent.session, "default");
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.stdout, "2\n");
});

test("bladeEval: a custom session name passes straight through", async () => {
  let seenSession;
  const ctx = makeCtx({ evalImpl: async (session) => ((seenSession = session), { exitCode: 0, kept: true, lane: "interp", elapsedMs: 1, stdout: "", stderr: "", bindings: [], diagnostics: [] }) });
  await sessions.bladeEval({ source: "1", session: "notebook-cell-3" }, ctx);
  assert.equal(seenSession, "notebook-cell-3");
});

test("bladeEval: protocolError (compiler predates eval) degrades to an actionable isError", async () => {
  const ctx = makeCtx({
    evalImpl: async () => {
      const e = new Error("unknown cmd 'eval'");
      e.protocolError = true;
      throw e;
    },
  });
  const result = await sessions.bladeEval({ source: "1" }, ctx);
  assert.equal(result.isError, true);
  assert.match(result.structuredContent.error, /predates REPL\/notebook support/);
  assert.equal(result.structuredContent.protocolError, true);
});

test("bladeEval: a transport failure returns the shared serveErrorResult shape", async () => {
  const ctx = makeCtx({
    evalImpl: async () => {
      throw new Error("blade ide serve unavailable");
    },
  });
  const result = await sessions.bladeEval({ source: "1" }, ctx);
  assert.equal(result.isError, true);
  assert.match(result.structuredContent.error, /blade_eval:/);
  assert.equal(result.structuredContent.cause, "unavailable");
  assert.equal(result.structuredContent.sessionsLost, undefined);
});

test("bladeEval: a timeout is reported as a timeout — raise timeoutMs, sessions are lost — not as a missing compiler", async () => {
  const ctx = makeCtx({
    evalImpl: async () => {
      throw new Error("blade ide serve: request 7 timed out after 120000ms");
    },
  });
  ctx.getClient = ((inner) => () => Object.assign(inner(), { available: () => "yes" }))(ctx.getClient);
  const result = await sessions.bladeEval({ source: "big" }, ctx);
  assert.equal(result.isError, true);
  const s = result.structuredContent;
  assert.equal(s.cause, "timeout");
  assert.equal(s.sessionsLost, true);
  assert.ok(s.remediation.some((l) => /timeoutMs/.test(l)));
  assert.ok(s.remediation.some((l) => /accumulated bindings are gone/.test(l)));
  assert.ok(!s.remediation.some((l) => /dotnet build/.test(l)), "the compiler is fine; do not send the agent off to rebuild it");
});

// --- the GR plot upgrade and its fallbacks -------------------------------------

const GR_OK = () => ({ ok: true, grdir: "C:/gr", source: "BLADE_GR_PATH" });
const GR_MISSING = () => ({ ok: false, reason: "no GR installation found — set BLADE_GR_PATH" });

test("plot upgrade: with GR, a plotly frame becomes a titled text line plus a real image block", async () => {
  let seenArgs;
  const ctx = makeCtx({
    grRuntime: GR_OK,
    renderPlotImpl: async (args) => ((seenArgs = args), renderResponse()),
    framesFromEval: () => ({ frames: [plotFrame("residuals", "plot-9")], errors: [] }),
  });
  const result = await sessions.bladeEval({ source: "plot.line(x, y)" }, ctx);

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.plotsRendered, 1);
  assert.equal(result.structuredContent.plotRenderNote, undefined);
  // content[0] is always the structured JSON; the frame blocks follow.
  assert.equal(result.content[1].type, "text");
  assert.match(result.content[1].text, /\[plot: residuals — GR render, 800x600\]/);
  assert.equal(result.content[2].type, "image");
  assert.equal(result.content[2].mimeType, "image/png");
  assert.equal(result.content[2].data, TINY_PNG_B64);
  // the request carried the figure spec and pinned the plot's identity
  assert.deepEqual(seenArgs.spec, plotFrame("residuals", "plot-9").data);
  assert.equal(seenArgs.plotId, "plot-9");
  assert.equal(seenArgs.width, 800);
  assert.equal(seenArgs.height, 600);
});

test("plot upgrade: an untitled figure still gets a label", async () => {
  const frame = plotFrame();
  delete frame.data.layout;
  const ctx = makeCtx({ grRuntime: GR_OK, framesFromEval: () => ({ frames: [frame], errors: [] }) });
  const result = await sessions.bladeEval({ source: "p" }, ctx);
  assert.match(result.content[1].text, /\[plot: untitled/);
  assert.equal(result.content[2].type, "image");
});

test("plot upgrade: plotWidth/plotHeight reach the render and are clamped to the legal range", async () => {
  let seenArgs;
  const ctx = makeCtx({
    grRuntime: GR_OK,
    renderPlotImpl: async (args) => ((seenArgs = args), renderResponse()),
    framesFromEval: () => ({ frames: [plotFrame()], errors: [] }),
  });
  await sessions.bladeEval({ source: "p", plotWidth: 1200, plotHeight: 900 }, ctx);
  assert.equal(seenArgs.width, 1200);
  assert.equal(seenArgs.height, 900);

  await sessions.bladeEval({ source: "p", plotWidth: 99999, plotHeight: 1 }, ctx);
  assert.equal(seenArgs.width, 4096);
  assert.equal(seenArgs.height, 64);
});

test("fallback: without GR the frame degrades to JSON text, and the reason is reported once", async () => {
  let renderCalls = 0;
  const ctx = makeCtx({
    grRuntime: GR_MISSING,
    renderPlotImpl: async () => (renderCalls++, renderResponse()),
    framesFromEval: () => ({ frames: [plotFrame("a", "p1"), plotFrame("b", "p2")], errors: [] }),
  });
  const result = await sessions.bladeEval({ source: "p" }, ctx);

  assert.equal(renderCalls, 0, "GR-less hosts must not touch renderPlot at all");
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.plotsRendered, undefined);
  assert.match(result.structuredContent.plotRenderNote, /GR is unavailable: no GR installation found/);
  assert.ok(!result.content.some((c) => c.type === "image"));
  assert.match(result.content[1].text, /\[display application\/vnd\.plotly\.v1\+json\]/);
});

test("fallback: a render failure falls back to text, keeps the eval successful, and is not retried per frame", async () => {
  let renderCalls = 0;
  const ctx = makeCtx({
    grRuntime: GR_OK,
    renderPlotImpl: async () => {
      renderCalls++;
      throw new Error("GR worker exited with code 3221225477");
    },
    framesFromEval: () => ({ frames: [plotFrame("a", "p1"), plotFrame("b", "p2")], errors: [] }),
  });
  const result = await sessions.bladeEval({ source: "p" }, ctx);

  assert.equal(renderCalls, 1, "the first failure must disable rendering for the rest of the eval");
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.displayFrames, 2);
  assert.match(result.structuredContent.plotRenderNote, /GR render failed: GR worker exited/);
  assert.ok(!result.content.some((c) => c.type === "image"));
});

test("fallback: a compiler predating renderPlot (protocolError) falls back with a note saying so", async () => {
  const ctx = makeCtx({
    grRuntime: GR_OK,
    renderPlotImpl: async () => {
      const e = new Error("unknown cmd 'renderPlot'");
      e.protocolError = true;
      throw e;
    },
    framesFromEval: () => ({ frames: [plotFrame()], errors: [] }),
  });
  const result = await sessions.bladeEval({ source: "p" }, ctx);
  assert.equal(result.structuredContent.ok, true);
  assert.match(result.structuredContent.plotRenderNote, /may predate 'renderPlot'/);
});

test("fallback: a renderPlot response with no frame is treated as a failure, not a crash", async () => {
  const ctx = makeCtx({
    grRuntime: GR_OK,
    renderPlotImpl: async () => ({ id: 1 }),
    framesFromEval: () => ({ frames: [plotFrame()], errors: [] }),
  });
  const result = await sessions.bladeEval({ source: "p" }, ctx);
  assert.equal(result.structuredContent.ok, true);
  assert.match(result.structuredContent.plotRenderNote, /returned no frame/);
});

test("the 1 MB inline cap applies to a GR render exactly as to any image frame", async () => {
  const ctx = makeCtx({
    grRuntime: GR_OK,
    renderPlotImpl: async () => renderResponse("A".repeat(2 * 1024 * 1024)),
    framesFromEval: () => ({ frames: [plotFrame()], errors: [] }),
  });
  const result = await sessions.bladeEval({ source: "p" }, ctx);
  assert.ok(!result.content.some((c) => c.type === "image"));
  assert.ok(result.content.some((c) => c.type === "text" && /exceeds the 1 MB inline limit/.test(c.text)));
  // it DID render — the cap is about inlining, not about the render failing
  assert.equal(result.structuredContent.plotsRendered, 1);
});

test("an image/png frame the program itself emitted passes through untouched, with no render round trip", async () => {
  let renderCalls = 0;
  const ctx = makeCtx({
    grRuntime: GR_OK,
    renderPlotImpl: async () => (renderCalls++, renderResponse()),
    framesFromEval: () => ({
      frames: [{ v: 1, mime: "image/png", encoding: "base64", data: TINY_PNG_B64, meta: { backend: "gr" } }],
      errors: [],
    }),
  });
  const result = await sessions.bladeEval({ source: "p" }, ctx);
  assert.equal(renderCalls, 0);
  assert.equal(result.structuredContent.plotsRendered, undefined);
  assert.equal(result.content.length, 2, "just the structured JSON and the image — no extra label");
  assert.equal(result.content[1].type, "image");
  assert.equal(result.content[1].data, TINY_PNG_B64);
});

test("a text frame alongside a plot is unaffected by the upgrade", async () => {
  const ctx = makeCtx({
    grRuntime: GR_OK,
    framesFromEval: () => ({ frames: [{ mime: "text/plain", encoding: "utf8", data: "hello" }, plotFrame()], errors: [] }),
  });
  const result = await sessions.bladeEval({ source: "p" }, ctx);
  assert.equal(result.content[1].text, "hello");
  assert.equal(result.content[3].type, "image");
});

test("plot upgrade: past MAX_PLOT_RENDERS the remaining figures degrade to text with one note", async () => {
  const many = [];
  for (let i = 0; i < sessions.MAX_PLOT_RENDERS + 3; i++) many.push(plotFrame(`fig-${i}`, `p${i}`));
  let renderCalls = 0;
  const ctx = makeCtx({
    grRuntime: GR_OK,
    renderPlotImpl: async () => (renderCalls++, renderResponse()),
    framesFromEval: () => ({ frames: many, errors: [] }),
  });
  const result = await sessions.bladeEval({ source: "p" }, ctx);
  assert.equal(renderCalls, sessions.MAX_PLOT_RENDERS);
  assert.equal(result.structuredContent.plotsRendered, sessions.MAX_PLOT_RENDERS);
  assert.match(result.structuredContent.plotRenderNote, /only the first 8 figures/);
});

test("framesToContent: a context predating grRuntime degrades to text rather than throwing", async () => {
  const ctx = makeCtx({ framesFromEval: () => ({ frames: [plotFrame()], errors: [] }) });
  delete ctx.grRuntime;
  const out = await sessions.framesToContent([plotFrame()], ctx, {});
  assert.equal(out.rendered, 0);
  assert.match(out.note, /without GR support/);
});

test("bladeResetSession: a transport failure is the shared serveErrorResult shape", async () => {
  const ctx = makeCtx({
    resetSessionImpl: async () => {
      throw new Error("blade ide serve unavailable");
    },
  });
  ctx.getClient = ((inner) => () => Object.assign(inner(), { available: () => "no" }))(ctx.getClient);
  const result = await sessions.bladeResetSession({}, ctx);
  assert.equal(result.isError, true);
  assert.match(result.structuredContent.error, /blade_reset_session:/);
});

test("bladeResetSession: defaults session to 'default', returns {ok:true}", async () => {
  let seenSession;
  const ctx = makeCtx({ resetSessionImpl: async (session) => ((seenSession = session), { ok: true }) });
  const result = await sessions.bladeResetSession({}, ctx);
  assert.equal(seenSession, "default");
  assert.deepEqual(result.structuredContent, { ok: true, session: "default" });
});

test("bladeResetSession: protocolError degrades to an actionable isError", async () => {
  const ctx = makeCtx({
    resetSessionImpl: async () => {
      const e = new Error("unknown cmd 'resetSession'");
      e.protocolError = true;
      throw e;
    },
  });
  const result = await sessions.bladeResetSession({ session: "s1" }, ctx);
  assert.equal(result.isError, true);
  assert.match(result.structuredContent.error, /predates resetSession/);
});

// --- source normalization, backoff, restarts -------------------------------------

test("bladeEval: a leading BOM is stripped and a lone surrogate refused before anything is sent", async () => {
  const sent = [];
  const ctx = makeCtx({ evalImpl: async (session, source) => (sent.push(source), evalResponse()) });
  await sessions.bladeEval({ source: "\uFEFFlet x = 1" }, ctx);
  assert.deepEqual(sent, ["let x = 1"]);
  await assert.rejects(() => sessions.bladeEval({ source: 'let s = "\uD83D"' }, ctx), /lone UTF-16 surrogate/);
  assert.equal(sent.length, 1);
});

test("bladeEval: a restart backoff is waited out and the eval retried once", async () => {
  let calls = 0;
  const ctx = makeCtx({
    evalImpl: async () => {
      calls++;
      if (calls === 1) throw new Error("blade ide serve: backing off for 20ms");
      return evalResponse({ bindings: [{ name: "", type: "Int64", value: "2" }] });
    },
  });
  const result = await sessions.bladeEval({ source: "1 + 1" }, ctx);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(calls, 2);
});

test("restart: the first eval of a session AFTER the serve process was replaced says its definitions are gone", async () => {
  let generation = 1;
  const ctx = makeCtx({ evalImpl: async () => evalResponse() });
  ctx.serveGeneration = () => generation;

  const first = await sessions.bladeEval({ source: "let x = 1", session: "work" }, ctx);
  assert.equal(first.structuredContent.sessionRestarted, undefined, "a session's first eval has nothing to lose");
  const second = await sessions.bladeEval({ source: "let y = 2", session: "work" }, ctx);
  assert.equal(second.structuredContent.sessionRestarted, undefined);

  generation = 2; // some request — any tool's — timed out or crashed the process in between
  const third = await sessions.bladeEval({ source: "x + y", session: "work" }, ctx);
  assert.equal(third.structuredContent.sessionRestarted, true);
  assert.match(third.structuredContent.sessionNote, /restarted since this session's previous eval/);
  assert.match(third.structuredContent.sessionNote, /Re-evaluate the definitions/);

  const fourth = await sessions.bladeEval({ source: "1", session: "work" }, ctx);
  assert.equal(fourth.structuredContent.sessionRestarted, undefined, "said once, not on every call after");

  // a session that never ran before the restart is not told it lost anything
  const fresh = await sessions.bladeEval({ source: "1", session: "brand-new" }, ctx);
  assert.equal(fresh.structuredContent.sessionRestarted, undefined);
});

test("restart: a restarted session's plots are new again (its replay baseline died with the process)", async () => {
  let generation = 1;
  const a = plotFrame("squares", "s1-1");
  const ctx = replayCtx([{ frames: [a] }]);
  ctx.serveGeneration = () => generation;
  assert.equal((await sessions.bladeEval({ source: "let p = plot.line(x, y)" }, ctx)).structuredContent.displayFrames, 1);
  assert.equal((await sessions.bladeEval({ source: "1" }, ctx)).structuredContent.displayFrames, 0);
  generation = 2;
  const after = (await sessions.bladeEval({ source: "let p = plot.line(x, y)" }, ctx)).structuredContent;
  assert.equal(after.sessionRestarted, true);
  assert.equal(after.displayFrames, 1, "the agent re-ran the cell in a fresh process: it must see the plot");
  assert.equal(after.displayFramesUnchanged, undefined);
});

test("restart: blade_reset_session clears the marker — a deliberately emptied session is not 'lost' later", async () => {
  let generation = 1;
  const ctx = makeCtx({ evalImpl: async () => evalResponse() });
  ctx.serveGeneration = () => generation;
  await sessions.bladeEval({ source: "let x = 1" }, ctx);
  await sessions.bladeResetSession({}, ctx);
  generation = 2;
  const s = (await sessions.bladeEval({ source: "1" }, ctx)).structuredContent;
  assert.equal(s.sessionRestarted, undefined);
});

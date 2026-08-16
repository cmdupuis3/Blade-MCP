"use strict";

// sessions.js: blade_eval / blade_reset_session. Focus is display-frame
// conversion (frameContent), dedup across the two frame channels
// (collectFrames), the GR plot upgrade and every one of its fallbacks
// (framesToContent), and the protocolError degradation paths — driven with a
// fake ctx/client, no process.

const os = require("os");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const sessions = require("../../src/sessions");

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const PLOTLY_MIME = "application/vnd.plotly.v1+json";

/** A plotly figure frame as an eval emits it. The title also rides the trace's
 *  `name`, EARLY in the JSON, because collectFrames' dedup key is the mime plus
 *  the payload's length and first 64 characters — two figures differing only in
 *  a trailing layout title are one frame as far as it is concerned, and a test
 *  that wants two frames must make them genuinely different. */
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
    log: () => {},
  };
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

test("fallback: without GR the frame degrades to today's JSON text, and the reason is reported once", async () => {
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

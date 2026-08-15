"use strict";

// sessions.js: blade_eval / blade_reset_session. Focus is display-frame
// conversion (frameContent), dedup across the two frame channels
// (collectFrames), and the protocolError degradation paths — driven with a
// fake ctx/client, no process.

const os = require("os");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const sessions = require("../../src/sessions");

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function makeCtx(overrides) {
  const o = overrides || {};
  return {
    config: { cwd: o.cwd || os.tmpdir() },
    pkg: {
      display: {
        framesFromEval: o.framesFromEval || (() => ({ frames: [], errors: [] })),
      },
    },
    getClient: () => ({
      eval: o.evalImpl || (async () => ({ exitCode: 0, kept: true, lane: "interp", elapsedMs: 1, stdout: "", stderr: "", bindings: [], diagnostics: [] })),
      resetSession: o.resetSessionImpl || (async () => ({ ok: true })),
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

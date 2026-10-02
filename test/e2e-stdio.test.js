"use strict";

// End-to-end: the REAL server (src/index.js) over a REAL stdio transport,
// driven by the official MCP SDK Client — the only test in this suite that
// exercises index.js's argv/shutdown wiring and server.js's SDK plumbing
// together. BLADE_MCP_TEST_SERVE points every compiler-backed tool at
// test/fake-serve.js instead of a real Blade.exe, which is what keeps this
// hermetic.

const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const { makeFakeGrRoot, NO_SUCH_GR } = require("./helpers");

const SERVER_ENTRY = path.join(__dirname, "..", "src", "index.js");
const FAKE_SERVE = path.join(__dirname, "fake-serve.js");

/** BLADE_MCP_TEST_SERVE value for `node <fake-serve.js>`, quoted per
 *  compiler.js's splitTestServe contract (process.execPath may contain
 *  spaces, e.g. "C:\Program Files\nodejs\node.exe"; the fake's own path must
 *  not). */
function testServeValue() {
  return `"${process.execPath}" ${FAKE_SERVE}`;
}

/** Connect a fresh client+server pair. `extraEnv` is layered over the
 *  current process env for the SPAWNED server (and, by inheritance, its
 *  fake-serve child). Caller must close() the returned client. */
async function connect(extraEnv) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: Object.assign({}, process.env, { BLADE_MCP_TEST_SERVE: testServeValue() }, extraEnv || {}),
    stderr: "pipe", // keep the child's log noise out of this process's stderr
  });
  const client = new Client({ name: "blade-mcp-e2e-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
}

test("tools/list exposes exactly the 7 documented tools", async () => {
  const { client, transport } = await connect();
  try {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "blade_check",
      "blade_corpus_find",
      "blade_doctor",
      "blade_eval",
      "blade_explain",
      "blade_reset_session",
      "blade_symbols",
    ]);
    // every tool exposes an inputSchema (the client-visible half of its contract)
    for (const t of result.tools) assert.equal(t.inputSchema.type, "object");
    // ...and annotations a client can use to decide what needs confirmation
    for (const t of result.tools) {
      assert.equal(typeof t.annotations.title, "string", t.name);
      assert.equal(typeof t.annotations.readOnlyHint, "boolean", t.name);
    }
    const readOnly = result.tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort();
    assert.deepEqual(readOnly, ["blade_check", "blade_corpus_find", "blade_doctor", "blade_explain", "blade_symbols"]);
  } finally {
    await client.close();
  }
});

test("initialize: the server sends instructions that name the workflow's tools", async () => {
  const { client } = await connect();
  try {
    const instructions = client.getInstructions();
    assert.equal(typeof instructions, "string");
    for (const name of ["blade_check", "blade_explain", "blade_corpus_find", "blade_eval", "blade_doctor"]) {
      assert.ok(instructions.includes(name), `instructions should mention ${name}`);
    }
  } finally {
    await client.close();
  }
});

test("argument validation: a typo'd or mistyped argument is an isError naming it — not a silently ignored one", async () => {
  const { client } = await connect();
  try {
    for (const [name, args, expect] of [
      ["blade_check", { sorce: "let x = 1" }, /unknown argument `sorce` — did you mean `source`\?/],
      ["blade_check", { source: "let x = 1", tier: "bogus" }, /`tier` must be one of "fast", "full"/],
      ["blade_check", { source: "let x = 1", raw: "yes" }, /`raw` must be a boolean/],
      ["blade_eval", { source: "1", timeoutMs: 1 }, /`timeoutMs` must be at least 1000/],
      ["blade_eval", { source: "1", plotWidth: 10 }, /`plotWidth` must be at least 64/],
      ["blade_corpus_find", { maxResults: "ten" }, /`maxResults` must be an integer/],
    ]) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
      assert.match(result.structuredContent.error, expect);
      assert.ok(result.structuredContent.invalidArguments.length >= 1);
    }
    // the same tools, called correctly, still work
    const ok = await client.callTool({ name: "blade_check", arguments: { source: "let x = 1", tier: "fast", raw: false } });
    assert.equal(ok.isError, undefined);
    assert.equal(ok.structuredContent.tier, "fast");
  } finally {
    await client.close();
  }
});

test("blade_explain / blade_corpus_find: a diagnostic code is accepted in either case through the server boundary", async () => {
  const { client } = await connect();
  try {
    for (const code of ["bl3016", "BL3016", "3016"]) {
      const result = await client.callTool({ name: "blade_explain", arguments: { code, maxExamples: 0 } });
      assert.equal(result.isError, undefined, `${code}: ${JSON.stringify(result.structuredContent)}`);
      assert.equal(result.structuredContent.code, "BL3016", `${code} must normalize to BL3016`);
    }
    const found = await client.callTool({ name: "blade_corpus_find", arguments: { code: "bl3016" } });
    assert.ok(
      !(found.structuredContent && Array.isArray(found.structuredContent.invalidArguments)),
      `a lower-case code must pass validation: ${JSON.stringify(found.structuredContent)}`
    );
    // a malformed code is still refused, by the validator
    const bad = await client.callTool({ name: "blade_explain", arguments: { code: "BL316" } });
    assert.equal(bad.isError, true);
    assert.match(bad.structuredContent.error, /`code` must match/);
  } finally {
    await client.close();
  }
});

test("resources/read: an unknown URI is a NOT-FOUND error (-32002), not an internal error", async () => {
  const { client } = await connect();
  try {
    await assert.rejects(
      () => client.readResource({ uri: "blade-docs://no-such-document" }),
      (e) => {
        assert.equal(e.code, -32002, `expected the resource-not-found code, got ${e.code}: ${e.message}`);
        assert.match(e.message, /no-such-document/);
        return true;
      }
    );
    // and the server is still answering afterwards
    const listed = await client.listResources();
    assert.ok(Array.isArray(listed.resources));
  } finally {
    await client.close();
  }
});

test("blade_check round trip: a BOM is stripped and a lone surrogate refused, before the compiler sees either", async () => {
  const { client } = await connect();
  try {
    const bom = await client.callTool({ name: "blade_check", arguments: { source: "\uFEFFlet x = 1\nlet y = x + 1\n" } });
    assert.equal(bom.isError, undefined);
    assert.equal(bom.structuredContent.ok, true);

    const surrogate = await client.callTool({ name: "blade_eval", arguments: { source: 'let s = "\uD83D"' } });
    assert.equal(surrogate.isError, true);
    assert.match(surrogate.structuredContent.error, /lone UTF-16 surrogate/);
    // the session was never touched, and the server did not hang on it
    const after = await client.callTool({ name: "blade_eval", arguments: { source: "1 + 1" } });
    assert.equal(after.structuredContent.ok, true);
  } finally {
    await client.close();
  }
});

test("blade_check round trip: FAKE_ERROR marker source surfaces the fixture's BL3016 diagnostic", async () => {
  const { client, transport } = await connect();
  try {
    const result = await client.callTool({
      name: "blade_check",
      arguments: { source: "// FAKE_ERROR\nlet r = f(a)\n" },
    });
    assert.equal(result.isError, undefined);
    const s = result.structuredContent;
    assert.equal(s.ok, false);
    assert.equal(s.tier, "full");
    assert.equal(s.synthetic, true);
    const coded = s.diagnostics.find((d) => d.code === "BL3016");
    assert.ok(coded, "the check-error.json fixture's BL3016 diagnostic must round-trip through the real server");
    assert.equal(coded.title, "argument extent mismatch");
    assert.equal(coded.phase, "types");
    assert.deepEqual(coded.span, { line: 3, col: 11, endLine: 3, endCol: 12 });
    assert.equal(s.stats.bindings, 3);
    // the text content block must be the same JSON, for clients that only read content[]
    const textBlock = result.content.find((c) => c.type === "text");
    assert.deepEqual(JSON.parse(textBlock.text), s);
  } finally {
    await client.close();
  }
});

test("blade_check round trip: clean source is ok:true with no diagnostics", async () => {
  const { client, transport } = await connect();
  try {
    const result = await client.callTool({
      name: "blade_check",
      arguments: { source: "let x = 1\nlet y = x + 1\n" },
    });
    const s = result.structuredContent;
    assert.equal(s.ok, true);
    assert.deepEqual(s.diagnostics, []);
    assert.deepEqual(s.bindings, [
      { name: "x", kind: "let", line: 1, type: "Int64" },
      { name: "y", kind: "let", line: 2, type: "Int64" },
    ]);
    assert.equal("providers" in s, false);
  } finally {
    await client.close();
  }
});

test("blade_check round trip: provider stores, provenance and function facts survive the trim", async () => {
  const { client } = await connect();
  try {
    const result = await client.callTool({ name: "blade_check", arguments: { source: "// FAKE_RICH\n" } });
    const s = result.structuredContent;
    assert.equal(s.ok, true, "a warning does not fail the check");
    assert.equal(s.stats.warnings, 1);
    assert.equal(s.providers[0].store, "store");
    assert.deepEqual(s.providers[0].vars, [{ name: "data", type: "Array<Int64 like Idx<2>, Idx<2>>" }]);
    assert.deepEqual(s.bindings.find((b) => b.name === "obs").providerRead, { store: "store", member: "vars.data" });
    assert.deepEqual(s.bindings.find((b) => b.name === "saved").providerWrite, { store: "store", member: "vars.data" });
    assert.deepEqual(s.bindings.find((b) => b.name === "dot").where, ["comm(a, b)"]);
    assert.equal(s.bindings.find((b) => b.name === "scale").type, "(a: Float64, s: Float64 = 2.0) -> Float64");
  } finally {
    await client.close();
  }
});

test("blade_symbols round trip: four bindings named `a` come back as four symbols with their own types", async () => {
  const { client } = await connect();
  try {
    const result = await client.callTool({ name: "blade_symbols", arguments: { source: "// FAKE_RICH\n", name: "a" } });
    const s = result.structuredContent;
    assert.equal(s.nameMatch, "exact");
    assert.deepEqual(
      s.symbols.map((sym) => [sym.def.line, sym.kind, sym.type]),
      [
        [8, "param", "Array<T like Idx<_>>"],
        [10, "param", "Float64"],
        [11, "param", undefined],
        [16, "value", "Float64"],
      ]
    );
  } finally {
    await client.close();
  }
});

// --- blade_eval: what a submission reports --------------------------------------

test("blade_eval round trip: a declaration is silent, a trailing expression echoes one value", async () => {
  const { client } = await connect();
  try {
    const decl = await client.callTool({ name: "blade_eval", arguments: { source: "let x = 2" } });
    assert.equal(decl.isError, undefined);
    assert.equal(decl.structuredContent.ok, true);
    assert.equal(decl.structuredContent.kept, true);
    assert.deepEqual(decl.structuredContent.bindings, []);

    const echo = await client.callTool({ name: "blade_eval", arguments: { source: "let y = x + 1\ny" } });
    assert.deepEqual(echo.structuredContent.bindings, [{ name: "", type: "Int64", value: "2" }]);
    assert.equal(echo.structuredContent.displayFrames, 0);
    assert.equal(echo.content.length, 1);
  } finally {
    await client.close();
  }
});

test("blade_eval round trip: a runtime panic is a result (not isError) with a titled, coded diagnostic", async () => {
  const { client } = await connect();
  try {
    const result = await client.callTool({ name: "blade_eval", arguments: { source: "let q = 1 / 0 // FAKE_PANIC" } });
    assert.equal(result.isError, undefined);
    const s = result.structuredContent;
    assert.equal(s.ok, false);
    assert.equal(s.kept, false);
    assert.equal(s.exitCode, 1);
    assert.equal(s.diagnostics[0].code, "BL8013");
    assert.equal(s.diagnostics[0].title, "integer arithmetic fault");
    assert.equal(s.diagnostics[0].phase, "runtime");
    assert.deepEqual(s.diagnostics[0].span, { line: 1, col: 1, endLine: 1, endCol: 1 });
    assert.match(s.stderr, /error\[BL8013\]/);
  } finally {
    await client.close();
  }
});

test("blade_eval round trip: a g++ lane with no g++ carries a hint, since its diagnostic has no code to explain", async () => {
  const { client } = await connect();
  try {
    const result = await client.callTool({ name: "blade_eval", arguments: { source: "// FAKE_GPP_MISSING" } });
    assert.equal(result.isError, undefined);
    const s = result.structuredContent;
    assert.equal(s.lane, "gpp");
    assert.equal(s.ok, false);
    assert.match(s.hint, /no g\+\+ was found/);
  } finally {
    await client.close();
  }
});

test(
  "blade_eval: an eval that outlives timeoutMs is reported as a TIMEOUT, and the next call works again",
  { timeout: 20000 },
  async () => {
    const { client } = await connect({ FAKE_MODE: "hang" });
    try {
      const result = await client.callTool({ name: "blade_eval", arguments: { source: "slow", timeoutMs: 1000 } });
      assert.equal(result.isError, true);
      const s = result.structuredContent;
      assert.equal(s.cause, "timeout");
      assert.equal(s.sessionsLost, true);
      assert.match(s.error, /timed out after 1000ms/);
      assert.ok(s.remediation.some((l) => /timeoutMs/.test(l)));
      assert.ok(!s.remediation.some((l) => /dotnet build/.test(l)));

      // The process was killed and the client is inside its restart backoff.
      // The very NEXT call — no pause — must wait that out and succeed, rather
      // than fail with "backing off for 497ms".
      const after = await client.callTool({ name: "blade_check", arguments: { source: "let x = 1" } });
      assert.equal(after.isError, undefined, JSON.stringify(after.structuredContent));
      assert.equal(after.structuredContent.ok, true);
    } finally {
      await client.close();
    }
  }
);

test("blade_eval: a compiler that dies mid-eval is reported as a CRASH with the sessions lost", { timeout: 20000 }, async () => {
  const { client } = await connect({ FAKE_MODE: "crash" });
  try {
    const result = await client.callTool({ name: "blade_eval", arguments: { source: "1" } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.cause, "crash");
    assert.equal(result.structuredContent.sessionsLost, true);
  } finally {
    await client.close();
  }
});

test(
  "isError path: FAKE_MODE=mute latches serve unavailable, blade_check returns isError with remediation",
  { timeout: 15000 },
  async () => {
    const { client, transport } = await connect({ FAKE_MODE: "mute" });
    try {
      const result = await client.callTool({ name: "blade_check", arguments: { source: "let x = 1" } });
      assert.equal(result.isError, true);
      assert.match(result.structuredContent.error, /blade_check:/);
      assert.ok(Array.isArray(result.structuredContent.remediation));
      assert.ok(result.structuredContent.remediation.length > 0);
    } finally {
      await client.close();
    }
  }
);

// --- the plot upgrade, full stack -----------------------------------------------
//
// BLADE_GR_PATH is pinned in BOTH directions here rather than left to
// discovery: the fallback candidates include a sibling Blade-REPL checkout,
// and whether the developer running the suite happens to have one must not
// decide which branch these tests take.

test("blade_eval: a plotly frame comes back as a REAL image block when GR is available", async () => {
  const gr = makeFakeGrRoot();
  const { client } = await connect({ FAKE_MODE: "plot", BLADE_GR_PATH: gr.root });
  try {
    const result = await client.callTool({ name: "blade_eval", arguments: { source: "plot.line(x, y)", plotWidth: 1200, plotHeight: 900 } });
    const s = result.structuredContent;
    assert.equal(s.ok, true);
    assert.equal(s.displayFrames, 1);
    assert.equal(s.plotsRendered, 1);
    assert.equal(s.plotRenderNote, undefined);

    const image = result.content.find((c) => c.type === "image");
    assert.ok(image, "the plotly figure must arrive as an image block, not as JSON text");
    assert.equal(image.mimeType, "image/png");
    assert.ok(Buffer.from(image.data, "base64").length > 0);

    const label = result.content.find((c) => c.type === "text" && /^\[plot:/.test(c.text));
    assert.ok(label, "a short label naming the figure must accompany the image");
    assert.match(label.text, /fake figure/);
    assert.match(label.text, /1200x900/, "plotWidth/plotHeight must reach the compiler");
    assert.ok(!result.content.some((c) => c.type === "text" && /vnd\.plotly/.test(c.text)));
  } finally {
    await client.close();
    gr.dispose();
  }
});

test("blade_eval: a committed plot is sent ONCE — later evals of the session count it as unchanged", async () => {
  const gr = makeFakeGrRoot();
  const { client } = await connect({ FAKE_MODE: "plot", BLADE_GR_PATH: gr.root });
  try {
    const first = await client.callTool({
      name: "blade_eval",
      arguments: { session: "replay", source: 'let shown = plot.line(px, py, "squares": title)' },
    });
    assert.equal(first.structuredContent.displayFrames, 1);
    assert.equal(first.structuredContent.plotsRendered, 1);
    assert.equal(first.content.filter((c) => c.type === "image").length, 1);

    const second = await client.callTool({ name: "blade_eval", arguments: { session: "replay", source: "1 + 1" } });
    const s2 = second.structuredContent;
    assert.equal(s2.displayFrames, 0);
    assert.equal(s2.displayFramesUnchanged, 1);
    assert.equal(s2.plotsRendered, undefined);
    assert.equal(second.content.filter((c) => c.type === "image").length, 0, "the same picture must not be sent again");

    const third = await client.callTool({
      name: "blade_eval",
      arguments: { session: "replay", source: 'let again = plot.line(px, py2, "doubles": title)' },
    });
    const s3 = third.structuredContent;
    assert.equal(s3.displayFrames, 1);
    assert.equal(s3.displayFramesUnchanged, 1);
    const labels = third.content.filter((c) => c.type === "text" && /^\[plot:/.test(c.text));
    assert.equal(labels.length, 1);
    assert.match(labels[0].text, /doubles/);

    // after a reset the session starts over, and so do its plots
    await client.callTool({ name: "blade_reset_session", arguments: { session: "replay" } });
    const fresh = await client.callTool({
      name: "blade_eval",
      arguments: { session: "replay", source: 'let shown = plot.line(px, py, "squares": title)' },
    });
    assert.equal(fresh.structuredContent.displayFrames, 1);
    assert.equal(fresh.structuredContent.displayFramesUnchanged, undefined);
  } finally {
    await client.close();
    gr.dispose();
  }
});

test("blade_eval: a streamed (event-channel) frame reaches the result, and replays are suppressed like any other", async () => {
  const { client } = await connect({ BLADE_GR_PATH: NO_SUCH_GR });
  try {
    const first = await client.callTool({
      name: "blade_eval",
      arguments: { session: "stream", source: 'let s = plot.stream("train_loss", xs, ys)' },
    });
    assert.equal(first.structuredContent.displayFrames, 1);
    const block = first.content.find((c) => c.type === "text" && /plotstream/.test(c.text));
    assert.ok(block, "a stream frame has no image renderer; it arrives as its JSON");
    assert.match(block.text, /"channel": "train_loss"/);
    assert.equal(first.structuredContent.plotRenderNote, undefined, "nothing here was a plotly figure to render");

    const second = await client.callTool({ name: "blade_eval", arguments: { session: "stream", source: "1" } });
    assert.equal(second.structuredContent.displayFrames, 0);
    assert.equal(second.structuredContent.displayFramesUnchanged, 1);
  } finally {
    await client.close();
  }
});

test("blade_eval: without GR the same frame degrades to JSON text and says why — the eval still succeeds", async () => {
  const { client } = await connect({ FAKE_MODE: "plot", BLADE_GR_PATH: NO_SUCH_GR });
  try {
    const result = await client.callTool({ name: "blade_eval", arguments: { source: "plot.line(x, y)" } });
    const s = result.structuredContent;
    assert.equal(result.isError, undefined);
    assert.equal(s.ok, true);
    assert.equal(s.displayFrames, 1);
    assert.equal(s.plotsRendered, undefined);
    assert.match(s.plotRenderNote, /GR is unavailable/);
    assert.ok(!result.content.some((c) => c.type === "image"));
    assert.ok(result.content.some((c) => c.type === "text" && /vnd\.plotly/.test(c.text)));
  } finally {
    await client.close();
  }
});

test("blade_eval: a live render failure falls back to text and never fails the eval", async () => {
  const gr = makeFakeGrRoot();
  const { client } = await connect({ FAKE_MODE: "plot-renderfail", BLADE_GR_PATH: gr.root });
  try {
    const result = await client.callTool({ name: "blade_eval", arguments: { source: "plot.line(x, y)" } });
    const s = result.structuredContent;
    assert.equal(result.isError, undefined);
    assert.equal(s.ok, true);
    assert.match(s.plotRenderNote, /GR render failed/);
    assert.ok(!result.content.some((c) => c.type === "image"));
  } finally {
    await client.close();
    gr.dispose();
  }
});

test("blade_eval: a compiler predating renderPlot falls back to text, not to an error result", async () => {
  const gr = makeFakeGrRoot();
  const { client } = await connect({ FAKE_MODE: "plot-oldcompiler", BLADE_GR_PATH: gr.root });
  try {
    const result = await client.callTool({ name: "blade_eval", arguments: { source: "plot.line(x, y)" } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.ok, true);
    assert.match(result.structuredContent.plotRenderNote, /predate 'renderPlot'/);
  } finally {
    await client.close();
    gr.dispose();
  }
});

test("blade_eval: a render past the 1 MB inline cap becomes the size placeholder, not a wall of base64", async () => {
  const gr = makeFakeGrRoot();
  const { client } = await connect({ FAKE_MODE: "plot-huge", BLADE_GR_PATH: gr.root });
  try {
    const result = await client.callTool({ name: "blade_eval", arguments: { source: "plot.line(x, y)" } });
    assert.equal(result.structuredContent.ok, true);
    assert.ok(!result.content.some((c) => c.type === "image"));
    assert.ok(result.content.some((c) => c.type === "text" && /exceeds the 1 MB inline limit/.test(c.text)));
  } finally {
    await client.close();
    gr.dispose();
  }
});

test("blade_eval: an image/png frame the program produced still passes through unchanged", async () => {
  const gr = makeFakeGrRoot();
  const { client } = await connect({ FAKE_MODE: "plot-raster", BLADE_GR_PATH: gr.root });
  try {
    const result = await client.callTool({ name: "blade_eval", arguments: { source: "p" } });
    const s = result.structuredContent;
    assert.equal(s.displayFrames, 1);
    assert.equal(s.plotsRendered, undefined, "a raster frame is already an image — no render round trip");
    assert.equal(result.content.length, 2, "structured JSON + the image, with no added label");
    assert.equal(result.content[1].type, "image");
  } finally {
    await client.close();
    gr.dispose();
  }
});

test("unknown tool name is a clean isError, not a transport crash", async () => {
  const { client, transport } = await connect();
  try {
    const result = await client.callTool({ name: "blade_nonexistent", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.structuredContent.error, /unknown tool/);
  } finally {
    await client.close();
  }
});

test("clean shutdown: client.close() ends the transport and the server process exits", async () => {
  const { client, transport } = await connect();
  const pid = transport.pid;
  assert.ok(pid, "transport should expose the spawned server's pid once connected");
  await client.close();
  await waitGone(pid);
});

/** Poll until a pid is no longer signalable (Node's process.kill(pid, 0)
 *  throws ESRCH once the process has exited, on every platform this repo
 *  targets). */
async function waitGone(pid, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 5000);
  for (;;) {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (_) {
      alive = false;
    }
    if (!alive) return;
    if (Date.now() > deadline) throw new Error(`pid ${pid} still alive ${timeoutMs || 5000}ms after close()`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

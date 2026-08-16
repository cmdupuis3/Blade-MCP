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
    assert.equal(s.bindings.length, 2);
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

"use strict";

// Protocol-level tests of test/fake-serve.js ITSELF, independent of blade-mcp
// src/ and independent of the vendored @blade-lang/ide-protocol client. If
// the fake is wrong, every e2e/unit test that trusts it would pass for the
// wrong reason — so this drives it directly over stdin/stdout, the same way
// a real `blade ide serve` child is driven.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnFakeServe } = require("../helpers");

test("default mode: ping answers ok/serve/version", async () => {
  const fake = spawnFakeServe();
  try {
    const id = fake.send({ cmd: "ping" });
    const resp = await fake.waitFor((l) => l.id === id);
    assert.equal(resp.ok, true);
    assert.equal(resp.serve, 1);
    assert.equal(resp.version, "fake-1");
  } finally {
    fake.dispose();
  }
});

test("check: clean source -> check-clean.json fixture, id/tier prepended", async () => {
  const fake = spawnFakeServe();
  try {
    const id = fake.send({ cmd: "check", tier: "full", file: "a.blade", source: "let x = 1\nlet y = x + 1\n" });
    const resp = await fake.waitFor((l) => l.id === id);
    assert.equal(resp.tier, "full");
    assert.equal(resp.version, 1);
    assert.deepEqual(resp.diagnostics, []);
    assert.equal(resp.bindings.length, 2);
    // the real wire shape: source-spelled kinds, declaration spans on bindings,
    // name-token spans on references
    assert.equal(resp.bindings[0].kind, "let");
    assert.deepEqual([resp.bindings[0].line, resp.bindings[0].col], [1, 1]);
    assert.equal(resp.references[0].kind, "value");
    assert.deepEqual(resp.references[0].def, { line: 1, col: 5, endLine: 1, endCol: 6 });
  } finally {
    fake.dispose();
  }
});

test("check: FAKE_ERROR marker -> check-error.json fixture with a BL code", async () => {
  const fake = spawnFakeServe();
  try {
    const id = fake.send({ cmd: "check", tier: "fast", file: "a.blade", source: "// FAKE_ERROR\nlet r = f(a)\n" });
    const resp = await fake.waitFor((l) => l.id === id);
    assert.equal(resp.tier, "fast");
    assert.ok(resp.diagnostics.some((d) => d.code === "BL3016"));
    assert.ok(resp.references.some((r) => r.kind === "type"));
  } finally {
    fake.dispose();
  }
});

test("checkCells: cells joined for marker detection, windows array present", async () => {
  const fake = spawnFakeServe();
  try {
    const id = fake.send({ cmd: "checkCells", tier: "fast", file: "nb.blade", cells: ["let x = 1", "// FAKE_ERROR"] });
    const resp = await fake.waitFor((l) => l.id === id);
    assert.ok(resp.diagnostics.some((d) => d.code === "BL3016"));
    assert.equal(resp.windows.length, 2);
    assert.deepEqual(resp.windows[0], { startLine: 1, endLine: 1 });
  } finally {
    fake.dispose();
  }
});

test("check: FAKE_RICH marker -> check-rich.json (provider store, provenance, where/deduced, a warning)", async () => {
  const fake = spawnFakeServe();
  try {
    const id = fake.send({ cmd: "check", tier: "full", file: "a.blade", source: "// FAKE_RICH\n" });
    const resp = await fake.waitFor((l) => l.id === id);
    assert.equal(resp.providers.length, 1);
    assert.equal(resp.providers[0].provider, "csv");
    assert.ok(resp.bindings.some((b) => b.providerRead));
    assert.ok(resp.bindings.some((b) => b.providerWrite));
    assert.ok(resp.bindings.some((b) => Array.isArray(b.where) && b.where.length));
    assert.deepEqual(resp.diagnostics.map((d) => d.severity), ["warning"]);
    assert.equal(resp.deduced[0].kind, "comm");
  } finally {
    fake.dispose();
  }
});

test("eval: a bare expression echoes ONE binding, under the empty name", async () => {
  const fake = spawnFakeServe();
  try {
    const id = fake.send({ cmd: "eval", session: "default", source: "1 + 1" });
    const resp = await fake.waitFor((l) => l.id === id);
    assert.equal(resp.kept, true);
    assert.equal(resp.exitCode, 0);
    assert.equal(resp.lane, "interp");
    assert.deepEqual(resp.bindings, [{ name: "", type: "Int64", value: "2" }]);
    assert.equal(resp.stdout, "");
    assert.equal("display" in resp, false, "the display field is emitted only when non-empty");
  } finally {
    fake.dispose();
  }
});

test("eval: declarations and reassignments are silent; a trailing expression is what echoes", async () => {
  const fake = spawnFakeServe();
  try {
    const decl = fake.send({ cmd: "eval", session: "s", source: "let x = 2" });
    assert.deepEqual((await fake.waitFor((l) => l.id === decl)).bindings, []);
    const assign = fake.send({ cmd: "eval", session: "s", source: "x = 7" });
    assert.deepEqual((await fake.waitFor((l) => l.id === assign)).bindings, []);
    const mixed = fake.send({ cmd: "eval", session: "s", source: "// a comment\nlet y = x * 10\ny\n" });
    const resp = await fake.waitFor((l) => l.id === mixed);
    assert.equal(resp.kept, true);
    assert.equal(resp.bindings.length, 1);
    assert.equal(resp.bindings[0].name, "");
    // equality is an expression, not a reassignment
    const eq = fake.send({ cmd: "eval", session: "s", source: "x == 7" });
    assert.equal((await fake.waitFor((l) => l.id === eq)).bindings.length, 1);
  } finally {
    fake.dispose();
  }
});

test("eval: FAKE_PANIC -> a runtime panic on stderr AND as a coded diagnostic", async () => {
  const fake = spawnFakeServe();
  try {
    const id = fake.send({ cmd: "eval", session: "default", source: "let q = 1 / 0 // FAKE_PANIC" });
    const resp = await fake.waitFor((l) => l.id === id);
    assert.equal(resp.kept, false);
    assert.equal(resp.exitCode, 1);
    assert.equal(resp.stderr, "error[BL8013]: integer division by zero");
    assert.deepEqual(resp.diagnostics, [
      { severity: "error", line: 1, col: 1, endLine: 1, endCol: 1, message: "integer division by zero", code: "BL8013" },
    ]);
  } finally {
    fake.dispose();
  }
});

test("eval: FAKE_GPP_MISSING -> the g++ lane's failure, with a code-less diagnostic", async () => {
  const fake = spawnFakeServe();
  try {
    const id = fake.send({ cmd: "eval", session: "default", source: "// FAKE_GPP_MISSING" });
    const resp = await fake.waitFor((l) => l.id === id);
    assert.equal(resp.lane, "gpp");
    assert.equal(resp.kept, false);
    assert.match(resp.stderr, /requires g\+\+, not found/);
    assert.equal(resp.diagnostics[0].code, undefined);
  } finally {
    fake.dispose();
  }
});

test("eval: a committed plotting cell's frame REPLAYS on later evals, under a stable id; a bare plot does not", async () => {
  const fake = spawnFakeServe({ FAKE_MODE: "plot" });
  try {
    const a = fake.send({ cmd: "eval", session: "s", source: 'let shown = plot.line(px, py, "squares": title)' });
    const first = await fake.waitFor((l) => l.id === a);
    assert.equal(first.display.length, 1);
    assert.deepEqual(first.bindings, []);
    const firstId = first.display[0].meta.id;

    const b = fake.send({ cmd: "eval", session: "s", source: "1 + 1" });
    const second = await fake.waitFor((l) => l.id === b);
    assert.equal(second.display.length, 1, "the committed cell re-ran, so its frame is here again");
    assert.deepEqual(second.display[0], first.display[0]);

    const c = fake.send({ cmd: "eval", session: "s", source: 'plot.line(px, py2, "doubles": title)' });
    const third = await fake.waitFor((l) => l.id === c);
    assert.deepEqual(third.display.map((f) => f.data.layout.title.text), ["squares", "doubles"]);
    assert.equal(third.display[0].meta.id, firstId);

    const d = fake.send({ cmd: "eval", session: "s", source: "2 + 2" });
    const fourth = await fake.waitFor((l) => l.id === d);
    assert.equal(fourth.display.length, 1, "a bare-expression plot is transient: it is not replayed");

    // another session never sees these
    const e = fake.send({ cmd: "eval", session: "other", source: "3" });
    assert.equal("display" in (await fake.waitFor((l) => l.id === e)), false);
  } finally {
    fake.dispose();
  }
});

test("eval: rebinding a plotting cell replaces it in place; resetSession forgets the session", async () => {
  const fake = spawnFakeServe({ FAKE_MODE: "plot" });
  try {
    const a = fake.send({ cmd: "eval", session: "s", source: 'let shown = plot.line(px, py, "v1": title)' });
    await fake.waitFor((l) => l.id === a);
    const b = fake.send({ cmd: "eval", session: "s", source: 'let shown = plot.line(px, py, "v2": title)' });
    const rebound = await fake.waitFor((l) => l.id === b);
    assert.deepEqual(rebound.display.map((f) => f.data.layout.title.text), ["v2"]);

    const r = fake.send({ cmd: "resetSession", session: "s" });
    await fake.waitFor((l) => l.id === r);
    const c = fake.send({ cmd: "eval", session: "s", source: "1" });
    assert.equal("display" in (await fake.waitFor((l) => l.id === c)), false);
  } finally {
    fake.dispose();
  }
});

test("eval: plot.stream frames go out as EVENTS before the response, never in its display array", async () => {
  const fake = spawnFakeServe();
  try {
    const id = fake.send({ cmd: "eval", session: "s", source: 'let s = plot.stream("train_loss", xs, ys)' });
    const resp = await fake.waitFor((l) => l.id === id && l.event === undefined);
    const event = fake.lines.find((l) => l.event === "display" && l.id === id);
    assert.ok(event, "the stream frame must arrive as an event");
    assert.equal(event.frame.mime, "application/vnd.blade.plotstream.v1+json");
    assert.deepEqual(event.frame.meta, { id: "train_loss", stream: true, backend: "plotly" });
    assert.equal("display" in resp, false);
    assert.ok(fake.lines.indexOf(event) < fake.lines.indexOf(resp));
  } finally {
    fake.dispose();
  }
});

test("eval: FAKE_ERROR marker -> nonzero exit and a diagnostic", async () => {
  const fake = spawnFakeServe();
  try {
    const id = fake.send({ cmd: "eval", session: "default", source: "// FAKE_ERROR" });
    const resp = await fake.waitFor((l) => l.id === id);
    assert.equal(resp.kept, false);
    assert.notEqual(resp.exitCode, 0);
    assert.ok(resp.diagnostics.length > 0);
  } finally {
    fake.dispose();
  }
});

test("resetSession: {ok:true}", async () => {
  const fake = spawnFakeServe();
  try {
    const id = fake.send({ cmd: "resetSession", session: "default" });
    const resp = await fake.waitFor((l) => l.id === id);
    assert.deepEqual(resp, { id, ok: true });
  } finally {
    fake.dispose();
  }
});

test("renderPlot: answers {id, frame} with a base64 PNG, echoing plotId and the requested size", async () => {
  const fake = spawnFakeServe();
  try {
    const id = fake.send({ cmd: "renderPlot", spec: { data: [], layout: {} }, plotId: "plot-7", width: 1200, height: 900 });
    const resp = await fake.waitFor((l) => l.id === id);
    assert.equal(resp.frame.mime, "image/png");
    assert.equal(resp.frame.encoding, "base64");
    assert.equal(resp.frame.meta.id, "plot-7");
    assert.equal(resp.frame.meta.backend, "gr");
    assert.equal(resp.frame.meta.width, 1200);
    assert.equal(resp.frame.meta.height, 900);
    assert.ok(Buffer.from(resp.frame.data, "base64").length > 0);
  } finally {
    fake.dispose();
  }
});

test("FAKE_MODE=plot: eval carries a plotly figure frame in its display array", async () => {
  const fake = spawnFakeServe({ FAKE_MODE: "plot" });
  try {
    const id = fake.send({ cmd: "eval", session: "default", source: "plot.line(x, y)" });
    const resp = await fake.waitFor((l) => l.id === id);
    assert.equal(resp.exitCode, 0);
    assert.equal(resp.display.length, 1);
    assert.equal(resp.display[0].mime, "application/vnd.plotly.v1+json");
    assert.equal(resp.display[0].encoding, "json");
    assert.equal(resp.display[0].data.layout.title.text, "fake figure");
    assert.match(resp.display[0].meta.id, /^s[0-9a-f]+-1$/, "ids are <session tag>-<ordinal>");
  } finally {
    fake.dispose();
  }
});

test("FAKE_MODE=plot-renderfail: renderPlot answers a live {id, error} (GR unreachable)", async () => {
  const fake = spawnFakeServe({ FAKE_MODE: "plot-renderfail" });
  try {
    const id = fake.send({ cmd: "renderPlot", spec: {} });
    const resp = await fake.waitFor((l) => l.id === id);
    assert.match(resp.error, /GR worker unavailable/);
    assert.equal(resp.frame, undefined);
  } finally {
    fake.dispose();
  }
});

test("FAKE_MODE=plot-oldcompiler: renderPlot answers the unknown-cmd line a pre-GR compiler gives", async () => {
  const fake = spawnFakeServe({ FAKE_MODE: "plot-oldcompiler" });
  try {
    const id = fake.send({ cmd: "renderPlot", spec: {} });
    const resp = await fake.waitFor((l) => l.id === id);
    assert.equal(resp.error, "unknown cmd 'renderPlot'");
  } finally {
    fake.dispose();
  }
});

test("FAKE_MODE=plot-huge: renderPlot answers a frame past the 1 MB inline cap", async () => {
  const fake = spawnFakeServe({ FAKE_MODE: "plot-huge" });
  try {
    const id = fake.send({ cmd: "renderPlot", spec: {} });
    const resp = await fake.waitFor((l) => l.id === id, 10000);
    assert.ok(resp.frame.data.length > 1024 * 1024);
  } finally {
    fake.dispose();
  }
});

test("FAKE_MODE=plot-raster: eval carries an image/png frame the program itself produced", async () => {
  const fake = spawnFakeServe({ FAKE_MODE: "plot-raster" });
  try {
    const id = fake.send({ cmd: "eval", session: "default", source: "p" });
    const resp = await fake.waitFor((l) => l.id === id);
    assert.equal(resp.display[0].mime, "image/png");
    assert.equal(resp.display[0].encoding, "base64");
  } finally {
    fake.dispose();
  }
});

test("unknown cmd -> {id, error}", async () => {
  const fake = spawnFakeServe();
  try {
    const id = fake.send({ cmd: "fly" });
    const resp = await fake.waitFor((l) => l.id === id);
    assert.equal(resp.error, "unknown cmd 'fly'");
  } finally {
    fake.dispose();
  }
});

test("FAKE_MODE=mute: never answers ping", async () => {
  const fake = spawnFakeServe({ FAKE_MODE: "mute" });
  try {
    const id = fake.send({ cmd: "ping" });
    await assert.rejects(() => fake.waitFor((l) => l.id === id, 500));
  } finally {
    fake.dispose();
  }
});

test("FAKE_MODE=die: answers ping, then exits before the next request could land", async () => {
  const fake = spawnFakeServe({ FAKE_MODE: "die" });
  try {
    const id = fake.send({ cmd: "ping" });
    const resp = await fake.waitFor((l) => l.id === id);
    assert.equal(resp.ok, true);
    const code = await fake.waitForExit(3000);
    assert.equal(code, 0);
  } finally {
    fake.dispose();
  }
});

test("FAKE_MODE=display: a display event precedes the eval response, same id", async () => {
  const fake = spawnFakeServe({ FAKE_MODE: "display" });
  try {
    const id = fake.send({ cmd: "eval", session: "default", source: "1 + 1" });
    await fake.waitFor((l) => l.event === "display" && l.id === id);
    const respIndex = () => fake.lines.findIndex((l) => l.id === id && l.event === undefined && l.kept !== undefined);
    // Poll briefly for the trailing response line.
    const deadline = Date.now() + 3000;
    while (respIndex() === -1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const eventIndex = fake.lines.findIndex((l) => l.event === "display" && l.id === id);
    const idx = respIndex();
    assert.notEqual(idx, -1, "eval response never arrived");
    assert.ok(eventIndex < idx, "display event must precede the eval response that shares its id");
  } finally {
    fake.dispose();
  }
});

test("FAKE_MODE=hang: answers ping, never answers an eval", async () => {
  const fake = spawnFakeServe({ FAKE_MODE: "hang" });
  try {
    const ping = fake.send({ cmd: "ping" });
    assert.equal((await fake.waitFor((l) => l.id === ping)).ok, true);
    const id = fake.send({ cmd: "eval", session: "default", source: "1" });
    await assert.rejects(() => fake.waitFor((l) => l.id === id, 400));
  } finally {
    fake.dispose();
  }
});

test("FAKE_MODE=crash: answers ping, exits non-zero when an eval arrives", async () => {
  const fake = spawnFakeServe({ FAKE_MODE: "crash" });
  try {
    const ping = fake.send({ cmd: "ping" });
    assert.equal((await fake.waitFor((l) => l.id === ping)).ok, true);
    fake.send({ cmd: "eval", session: "default", source: "1" });
    assert.equal(await fake.waitForExit(3000), 3);
  } finally {
    fake.dispose();
  }
});

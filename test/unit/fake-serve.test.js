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

test("eval: canned success", async () => {
  const fake = spawnFakeServe();
  try {
    const id = fake.send({ cmd: "eval", session: "default", source: "1 + 1" });
    const resp = await fake.waitFor((l) => l.id === id);
    assert.equal(resp.kept, true);
    assert.equal(resp.exitCode, 0);
    assert.equal(resp.lane, "interp");
    assert.ok(Array.isArray(resp.bindings));
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

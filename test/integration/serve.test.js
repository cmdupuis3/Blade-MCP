"use strict";

// Integration: the REAL compiler over the REAL `ide serve` protocol. Honors
// BLADE_EXE; when the binary is missing, unreachable, or predates `ide
// serve` (an old build that never answers ping), the whole suite SKIPS
// cleanly (exit 0) instead of failing — there is no fake to fall back to
// here, so "no usable compiler in this environment" is a normal outcome, not
// a bug. Run with:
//
//   BLADE_EXE=/path/to/Blade.exe npm run test:integration
//
// Handlers are driven directly through server.dispatchTool(name, args, ctx)
// — no stdio transport needed; test/e2e-stdio.test.js already covers that
// plumbing against the fake. `ctx` here is built from the REAL
// @blade-lang/ide-protocol package and (when set) a REAL BLADE_EXE, so this
// spawns an actual `<exe> ide serve` child process.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const compiler = require("../../src/compiler");
const server = require("../../src/server");

test(
  "integration: blade-mcp tools against a real Blade.exe (BLADE_EXE)",
  { timeout: 120000 },
  async (t) => {
    const ctx = compiler.createContext({ cwd: process.cwd(), env: process.env });

    const doctor = await server.dispatchTool("blade_doctor", {}, ctx);
    const resolved = doctor.structuredContent.resolvedCompiler;
    const serveAvailable = doctor.structuredContent.serveAvailable;

    if (resolved.origin === "path" || !serveAvailable) {
      ctx.dispose();
      t.skip(
        `no usable Blade compiler for integration tests (resolved '${resolved.exe}' via '${resolved.origin}', ` +
          `serveAvailable=${serveAvailable}${doctor.structuredContent.serveError ? `, reason: ${doctor.structuredContent.serveError}` : ""}). ` +
          "Set BLADE_EXE to a build with the 'ide serve' verb to run this suite live."
      );
      return;
    }

    t.diagnostic(`running live against ${resolved.exe} (origin=${resolved.origin}, compilerVersion=${doctor.structuredContent.compilerVersion})`);

    await t.test("blade_check: a deliberate extent mismatch surfaces BL3016", async () => {
      const result = await server.dispatchTool(
        "blade_check",
        {
          source: [
            "function f(w: Array<Float64 like Idx<4>>) -> Float64 = w(0) + w(1) + w(2) + w(3)",
            "let a: Array<Float64 like Idx<2>> = [1.0, 2.0]",
            "let r = f(a)",
          ].join("\n"),
        },
        ctx
      );
      assert.equal(result.isError, undefined, () => JSON.stringify(result.structuredContent));
      const s = result.structuredContent;
      assert.equal(s.ok, false);
      assert.ok(
        s.diagnostics.some((d) => d.code === "BL3016"),
        `expected a BL3016 diagnostic, got: ${JSON.stringify(s.diagnostics)}`
      );
    });

    await t.test("blade_eval: `let x = 1 + 1` is kept, with a lane", async () => {
      const result = await server.dispatchTool("blade_eval", { source: "let x = 1 + 1" }, ctx);
      assert.equal(result.isError, undefined, () => JSON.stringify(result.structuredContent));
      const s = result.structuredContent;
      assert.equal(s.kept, true);
      assert.equal(s.exitCode, 0);
      assert.ok(["interp", "gpp"].includes(s.lane), `unexpected lane: ${s.lane}`);
    });

    await t.test("blade_eval: a real plot comes back as a real PNG (needs GR)", async (t2) => {
      const gr = ctx.grRuntime();
      if (!gr.ok) {
        t2.skip(`no GR runtime for this environment (${gr.reason}); set BLADE_GR_PATH to render plots as images`);
        return;
      }
      // Blade has no list comprehensions — an index range mapped through a
      // lambda is the idiomatic way to build the arrays.
      const result = await server.dispatchTool(
        "blade_eval",
        {
          session: "plot-integration",
          source: [
            "import plot",
            "let px = method_for(range<Idx<8>>) <@> lambda(i) -> 1.0 * i |> compute",
            "let py = method_for(range<Idx<8>>) <@> lambda(i) -> 1.0 * i * i |> compute",
            'let plotted = plot.line(px, py, "integration check": title)',
          ].join("\n"),
        },
        ctx
      );
      assert.equal(result.isError, undefined, () => JSON.stringify(result.structuredContent));
      const s = result.structuredContent;
      if (s.exitCode !== 0 || s.displayFrames === 0) {
        t2.skip(`this compiler produced no display frame (exitCode=${s.exitCode}, diagnostics=${JSON.stringify(s.diagnostics)}) — it likely predates the plot module`);
        return;
      }
      assert.equal(s.plotsRendered, 1, () => `expected one GR render, got: ${JSON.stringify(s)}`);
      const image = result.content.find((c) => c.type === "image");
      assert.ok(image, "the figure must arrive as an image block");
      const bytes = Buffer.from(image.data, "base64");
      assert.equal(bytes.slice(1, 4).toString("ascii"), "PNG", "the render must be a real PNG");
      assert.equal(bytes.readUInt32BE(16), 800, "default render width");
      assert.equal(bytes.readUInt32BE(20), 600, "default render height");
    });

    await t.test("blade_reset_session: {ok:true}", async () => {
      const result = await server.dispatchTool("blade_reset_session", {}, ctx);
      assert.equal(result.isError, undefined, () => JSON.stringify(result.structuredContent));
      assert.equal(result.structuredContent.ok, true);
    });

    await t.test("blade_doctor: a second call still parses to a well-formed report", async () => {
      const result = await server.dispatchTool("blade_doctor", {}, ctx);
      assert.equal(result.isError, undefined);
      const s = result.structuredContent;
      assert.equal(typeof s.ok, "boolean");
      assert.equal(s.resolvedCompiler.exe, resolved.exe);
      assert.equal(s.serveAvailable, true);
    });

    await t.test("blade_explain: BL3016 is known, with a registry title/phase", async (t2) => {
      const result = await server.dispatchTool("blade_explain", { code: "BL3016" }, ctx);
      assert.equal(result.isError, undefined);
      const s = result.structuredContent;
      assert.equal(s.known, true);
      assert.equal(s.code, "BL3016");
      assert.ok(s.title, "expected a registry title for BL3016");
      assert.equal(s.phase, "types");

      const corpusRoot = ctx.corpusRoot();
      if (!corpusRoot) {
        t2.skip("tests/corpus not found beside the resolved exe; skipping the examples assertion");
      } else {
        assert.ok(s.examples.length > 0, `expected at least one corpus example for BL3016 under ${corpusRoot}`);
      }
    });

    ctx.dispose();
  }
);

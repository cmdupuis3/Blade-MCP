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
// (g++ must be on PATH for the one subtest that exercises the compiled
// fallback lane — on Windows, C:\msys64\ucrt64\bin. It skips without one.)
//
// Handlers are driven directly through server.dispatchTool(name, args, ctx)
// — no stdio transport needed; test/e2e-stdio.test.js already covers that
// plumbing against the fake. `ctx` here is built from the REAL
// @blade-lang/ide-protocol package and (when set) a REAL BLADE_EXE, so this
// spawns an actual `<exe> ide serve` child process.
//
// Besides exercising the tools, this suite is what keeps the HERMETIC suite
// honest: it re-derives test/fixtures/check-*.json from the live compiler and
// fails when the wire shape those fixtures (and test/fake-serve.js) model has
// moved.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const compiler = require("../../src/compiler");
const server = require("../../src/server");
const { RICH_SOURCE, RICH_CSV, CLEAN_SOURCE, ERROR_SOURCE } = require("../helpers");

const checkClean = require("../fixtures/check-clean.json");
const checkError = require("../fixtures/check-error.json");
const checkRich = require("../fixtures/check-rich.json");

/** The tables whose rendering is deterministic. `calls[]` is left out: its
 *  type strings carry inference-variable ids (`T?10003`) that are free to move
 *  between builds without the wire shape changing. */
const PINNED_TABLES = ["bindings", "providers", "deduced", "kernels"];

test(
  "integration: blade-mcp tools against a real Blade.exe (BLADE_EXE)",
  { timeout: 300000 },
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

    // A scratch directory for everything that needs a real path: the csv the
    // provider program loads, and the cwd evals resolve against.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "blade-mcp-integration-"));
    fs.writeFileSync(path.join(work, "obs.csv"), RICH_CSV);
    const gppRow = ((doctor.structuredContent.toolchain || {}).checks || []).find((c) => c.key === "gpp");
    const gppOk = !!gppRow && gppRow.status === "ok";

    try {
      // --- blade_doctor ---------------------------------------------------------

      await t.test("blade_doctor: the toolchain report arrives whole, with the rows newer compilers added", async () => {
        const s = doctor.structuredContent;
        assert.equal(doctor.isError, undefined);
        assert.ok(s.toolchain, `doctor --json did not parse: ${s.doctorError}`);
        assert.equal(typeof s.toolchain.healthy, "boolean");
        const keys = s.toolchain.checks.map((c) => c.key);
        for (const k of ["dotnet", "stdlib", "gpp", "blas", "llvm"]) assert.ok(keys.includes(k), `expected a '${k}' row, got: ${keys.join(", ")}`);
        for (const c of s.toolchain.checks) {
          assert.ok(["ok", "off", "warn", "missing", "error"].includes(c.status), `unknown status '${c.status}' on row ${c.key}`);
          assert.equal(typeof c.detail, "string");
        }
        assert.equal(s.ok, s.toolchain.healthy);
        // every warn/error row — and nothing else — is lifted out
        const expected = s.toolchain.checks.filter((c) => c.status === "warn" || c.status === "error").map((c) => c.key);
        assert.deepEqual((s.toolchainIssues || []).map((i) => i.key), expected);
        assert.match(s.compilerVersion, /^\d+\.\d+/, "the usage banner must still carry the version");
        assert.equal(s.protocolVersion, 1);
      });

      await t.test("blade_doctor: the packaged language surface names the same language as the binary", async () => {
        const s = doctor.structuredContent;
        assert.notEqual(s.surfaceDrift, null, "this compiler has `ide surface`; the comparison must have run");
        assert.equal(
          s.surfaceDrift,
          false,
          "the vendored @blade-lang/ide-protocol surface.json does not match this compiler — " +
            "re-vendor the protocol package (npm run vendor:protocol, then make sure node_modules really took it). Drift: " +
            JSON.stringify(s.surfaceDrift)
        );
        assert.equal(s.versionSkew, false);
      });

      // --- blade_check ----------------------------------------------------------

      await t.test("blade_check: a deliberate extent mismatch surfaces BL3016", async () => {
        const result = await server.dispatchTool("blade_check", { source: ERROR_SOURCE }, ctx);
        assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
        const s = result.structuredContent;
        assert.equal(s.ok, false);
        const d = s.diagnostics.find((x) => x.code === "BL3016");
        assert.ok(d, `expected a BL3016 diagnostic, got: ${JSON.stringify(s.diagnostics)}`);
        assert.equal(d.title, "argument extent mismatch");
        assert.equal(d.phase, "types");
        assert.equal(d.severity, "error");
        assert.equal(d.span.line, 3);
      });

      await t.test("blade_check: provider store, provenance in both directions, where/deduced, and a warning", async () => {
        const result = await server.dispatchTool("blade_check", { file: path.join(work, "rich.blade"), source: RICH_SOURCE, cwd: work }, ctx);
        assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
        const s = result.structuredContent;
        assert.equal(s.ok, true, JSON.stringify(s.diagnostics));
        assert.deepEqual(s.diagnostics.map((d) => [d.code, d.severity, d.title]), [["BL3020", "warning", "implicit numeric conversion"]]);

        assert.equal(s.providers.length, 1);
        assert.equal(s.providers[0].store, "store");
        assert.equal(s.providers[0].provider, "csv");
        assert.deepEqual(s.providers[0].vars, [{ name: "data", type: "Array<Int64 like Idx<2>, Idx<2>>" }]);

        const by = (name, kind) => s.bindings.find((b) => b.name === name && (!kind || b.kind === kind));
        assert.deepEqual(by("obs").providerRead, { store: "store", member: "vars.data" });
        assert.equal(by("obs").providerWrite, undefined);
        assert.deepEqual(by("saved").providerWrite, { store: "store", member: "vars.data" });
        assert.equal(by("saved").providerRead, undefined);
        assert.deepEqual(by("dot").where, ["comm(a, b)"]);
        assert.deepEqual(by("cross").deducedComm, ["comm(x, y)"]);
        assert.equal(by("total").kind, "let mut");
        assert.equal(by("scale").type, "(a: Float64, s: Float64 = 2.0) -> Float64");
        assert.ok(s.deduced.some((f) => f.kind === "comm" && f.owner === "cross"));
        assert.equal(fs.existsSync(path.join(work, "rich.blade")), false, "checking unsaved text at a path writes nothing");
        assert.equal(fs.existsSync(path.join(work, "obs_out.csv")), false, "a check runs nothing: the write did not happen");
      });

      await t.test("fixtures: the hermetic suite's check payloads are still what this compiler sends", async () => {
        const cases = [
          ["check-clean.json", checkClean, CLEAN_SOURCE, "clean.blade"],
          ["check-error.json", checkError, ERROR_SOURCE, "error.blade"],
          ["check-rich.json", checkRich, RICH_SOURCE, "rich.blade"],
        ];
        for (const [name, fixture, source, file] of cases) {
          const result = await server.dispatchTool("blade_check", { file: path.join(work, file), source, cwd: work, raw: true }, ctx);
          const live = result.structuredContent.payload;
          const hint = `test/fixtures/${name} no longer matches the compiler — regenerate it and re-check what test/fake-serve.js models`;
          assert.deepEqual(Object.keys(live).filter((k) => k !== "id" && k !== "tier").sort(), Object.keys(fixture).sort(), `${hint} (top-level keys)`);
          for (const table of PINNED_TABLES) assert.deepEqual(live[table], fixture[table], `${hint} (${table})`);
          // The fixtures append two documented-but-rare shapes (flagged
          // SYNTHETIC / a null def); everything else must be the live entries.
          const realDiagnostics = fixture.diagnostics.filter((d) => !/^SYNTHETIC/.test(d.message));
          assert.deepEqual(live.diagnostics, realDiagnostics, `${hint} (diagnostics)`);
          const realReferences = fixture.references.filter((r) => r.def !== null);
          assert.deepEqual(live.references, realReferences, `${hint} (references)`);
        }
      });

      await t.test("blade_check: a BOM-prefixed file checks as the CLI checks it — accepted, and with the same spans", async (t2) => {
        // The CLI's reader swallows a UTF-8 BOM; over `ide serve` the text is a
        // JSON string and the U+FEFF would reach the lexer.
        const good = path.join(work, "bom_ok.blade");
        fs.writeFileSync(good, "\uFEFFlet z = 1\nlet w = z + 1\n");
        const ok = await server.dispatchTool("blade_check", { file: good }, ctx);
        assert.equal(ok.structuredContent.ok, true, JSON.stringify(ok.structuredContent.diagnostics));
        assert.deepEqual(ok.structuredContent.bindings.map((b) => [b.name, b.line]), [["z", 1], ["w", 2]]);
        const symbols = await server.dispatchTool("blade_symbols", { file: good }, ctx);
        assert.equal(symbols.structuredContent.symbolCount, 2);
        assert.deepEqual(symbols.structuredContent.symbols.find((sym) => sym.name === "z").def, { line: 1, col: 5, endLine: 1, endCol: 6 });

        // An error on the BOM's own line: the span must be the CLI's, column for column.
        const bad = path.join(work, "bom_err.blade");
        fs.writeFileSync(bad, '\uFEFFlet z: Int64 = "oops"\nlet w = z + 1\n');
        const viaServer = await server.dispatchTool("blade_check", { file: bad, tier: "fast" }, ctx);
        const d = viaServer.structuredContent.diagnostics[0];
        assert.equal(d.code, "BL3001");
        assert.equal(viaServer.structuredContent.diagnostics.length, 1, "one real error — not a bogus parse error at 1:1");
        const { execFileSync } = require("child_process");
        let cli;
        try {
          execFileSync(resolved.exe, ["ide", "check", "--json", bad], { encoding: "utf8", windowsHide: true });
        } catch (e) {
          cli = e.stdout; // exit 1: the file has an error, and the payload is on stdout
        }
        if (!cli) {
          t2.diagnostic("`ide check --json` exited 0 on an erroring file; skipping the CLI span comparison");
          return;
        }
        const cliDiag = JSON.parse(cli.trim().split(/\r?\n/).pop()).diagnostics[0];
        assert.deepEqual(d.span, { line: cliDiag.line, col: cliDiag.col, endLine: cliDiag.endLine, endCol: cliDiag.endCol });
        assert.deepEqual(d.span, { line: 1, col: 16, endLine: 1, endCol: 22 });

        // ...and a real BOM-prefixed program from the checkout, when there is one.
        const repo = ctx.repoRoot();
        const sample = repo ? path.join(repo, "examples", "physics", "16_galilean_boost_tenth_invariant.blade") : null;
        if (sample && fs.existsSync(sample) && fs.readFileSync(sample)[0] === 0xef) {
          const real = await server.dispatchTool("blade_check", { file: sample }, ctx);
          assert.equal(real.structuredContent.stats.errors, 0, JSON.stringify(real.structuredContent.diagnostics));
          assert.ok(real.structuredContent.stats.bindings > 0);
        } else {
          t2.diagnostic("no BOM-prefixed example found in a checkout; the synthetic files above carry the assertion");
        }
      });

      await t.test("blade_check / blade_eval: a lone surrogate is refused at once instead of hanging the compiler", async () => {
        const started = Date.now();
        const check = await server.dispatchTool("blade_check", { source: 'let s = "\uD83D"\n' }, ctx);
        assert.equal(check.isError, true);
        assert.match(check.structuredContent.error, /lone UTF-16 surrogate/);
        const run = await server.dispatchTool("blade_eval", { source: 'let s = "\uD83D"\n', cwd: work }, ctx);
        assert.equal(run.isError, true);
        assert.ok(Date.now() - started < 5000, "refused locally — not after a 30 s timeout");
        // the serve process was never disturbed
        const after = await server.dispatchTool("blade_check", { source: "let x = 1" }, ctx);
        assert.equal(after.structuredContent.ok, true);
      });

      // --- blade_symbols --------------------------------------------------------

      await t.test("blade_symbols: one name bound four ways resolves to four symbols, each with its own type", async () => {
        const result = await server.dispatchTool("blade_symbols", { file: path.join(work, "rich.blade"), source: RICH_SOURCE, cwd: work, name: "a" }, ctx);
        assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
        const s = result.structuredContent;
        assert.deepEqual(
          s.symbols.map((sym) => [sym.def.line, sym.kind, sym.type, sym.useCount]),
          [
            [8, "param", "Array<T like Idx<_>>", 1],
            [10, "param", "Float64", 1],
            [11, "param", undefined, 1],
            [16, "value", "Float64", 0],
          ]
        );
      });

      // --- blade_eval -----------------------------------------------------------

      await t.test("blade_eval: `let x = 1 + 1` is kept, silently; a trailing expression echoes its value", async () => {
        const decl = await server.dispatchTool("blade_eval", { source: "let x = 1 + 1", cwd: work }, ctx);
        assert.equal(decl.isError, undefined, JSON.stringify(decl.structuredContent));
        const s = decl.structuredContent;
        assert.equal(s.kept, true);
        assert.equal(s.exitCode, 0);
        assert.ok(["interp", "gpp"].includes(s.lane), `unexpected lane: ${s.lane}`);
        assert.deepEqual(s.bindings, [], "a declaration reports no binding");

        const echo = await server.dispatchTool("blade_eval", { source: "let y = x * 10\ny + 1", cwd: work }, ctx);
        assert.deepEqual(echo.structuredContent.bindings, [{ name: "", type: "Int64", value: "21" }]);

        // rebind-in-place: a later cell sees the new x through the old y
        await server.dispatchTool("blade_eval", { source: "let x = 5", cwd: work }, ctx);
        const rebound = await server.dispatchTool("blade_eval", { source: "y", cwd: work }, ctx);
        assert.deepEqual(rebound.structuredContent.bindings, [{ name: "", type: "Int64", value: "50" }]);
      });

      await t.test("blade_eval: a long array value is elided after five entries", async () => {
        const result = await server.dispatchTool("blade_eval", { session: "elide", source: "Float64(0..40)", cwd: work }, ctx);
        const s = result.structuredContent;
        assert.equal(s.ok, true, JSON.stringify(s));
        assert.equal(s.bindings.length, 1);
        assert.match(s.bindings[0].type, /^Array<Float64/);
        assert.equal(s.bindings[0].value, "[0.0, 1.0, 2.0, 3.0, 4.0, ...]");
      });

      await t.test("blade_eval: runtime panics come back as titled, coded diagnostics and leave the session unchanged", async () => {
        const cases = [
          ["let q = 1 / 0", "BL8013"],
          ["type I = Idx<3>\nlet arr: Array<Float64 like I> = [1.0, 2.0, 3.0]\nlet k = 5\narr(k)", "BL8006"],
          ["let f = 0.0 / 0.0\nInt64(floor(f))", "BL8014"],
        ];
        for (const [source, code] of cases) {
          const result = await server.dispatchTool("blade_eval", { session: "panic", source, cwd: work }, ctx);
          assert.equal(result.isError, undefined, "a program fault is a result, not a tool failure");
          const s = result.structuredContent;
          assert.equal(s.ok, false, `${code}: ${JSON.stringify(s)}`);
          assert.equal(s.kept, false);
          assert.equal(s.exitCode, 1);
          const d = s.diagnostics.find((x) => x.code === code);
          assert.ok(d, `expected ${code}, got: ${JSON.stringify(s.diagnostics)}`);
          assert.equal(d.severity, "error");
          assert.equal(d.phase, "runtime");
          assert.ok(d.title, `${code} must carry its registry title`);
          assert.match(s.stderr, new RegExp(`error\\[${code}\\]`));
        }
        // nothing from the failed cells joined the session
        const probe = await server.dispatchTool("blade_eval", { session: "panic", source: "q", cwd: work }, ctx);
        assert.equal(probe.structuredContent.ok, false);
        assert.ok(probe.structuredContent.diagnostics.some((d) => d.code === "BL2001"));
      });

      await t.test("blade_eval: a front-end rejection is spanned, coded, and not kept", async () => {
        const result = await server.dispatchTool("blade_eval", { session: "reject", source: 'let z: Int64 = "oops"', cwd: work }, ctx);
        const s = result.structuredContent;
        assert.equal(s.ok, false);
        assert.equal(s.kept, false);
        assert.equal(s.diagnostics[0].code, "BL3001");
        assert.equal(s.diagnostics[0].title, "type mismatch");
        assert.deepEqual(s.diagnostics[0].span, { line: 1, col: 16, endLine: 1, endCol: 22 });
      });

      await t.test("blade_eval: session replay — a committed plot is delivered once; two same-shaped plots are two plots", async () => {
        const first = await server.dispatchTool(
          "blade_eval",
          {
            session: "replay",
            cwd: work,
            source: ["import plot", "let px = [0.0, 1.0, 2.0]", "let py = [0.0, 1.0, 4.0]", 'let shown = plot.line(px, py, "squares": title)'].join("\n"),
          },
          ctx
        );
        const s1 = first.structuredContent;
        if (s1.exitCode !== 0 || s1.displayFrames === 0) {
          t.diagnostic(`this compiler produced no display frame (${JSON.stringify(s1.diagnostics)}); skipping the replay assertions`);
          return;
        }
        assert.equal(s1.displayFrames, 1);

        // An unrelated eval: the compiler re-emits the committed cell's frame
        // (docs/display-frames.md section 10); the agent must not get it twice.
        const second = await server.dispatchTool("blade_eval", { session: "replay", source: "1 + 1", cwd: work }, ctx);
        const s2 = second.structuredContent;
        assert.equal(s2.displayFrames, 0);
        assert.equal(s2.displayFramesUnchanged, 1);
        assert.equal(second.content.length, 1, "no picture, no JSON dump — just the result");

        // Two more plots in ONE submission over the same x axis, with y values
        // that print to the same width: equal-length payloads sharing a long
        // prefix. Both must be delivered.
        const third = await server.dispatchTool(
          "blade_eval",
          {
            session: "replay",
            cwd: work,
            source: ["let py2 = [0.0, 2.0, 8.0]", "let py3 = [0.0, 3.0, 7.0]", "let shown2 = plot.line(px, py2)", "let shown3 = plot.line(px, py3)"].join("\n"),
          },
          ctx
        );
        const s3 = third.structuredContent;
        assert.equal(s3.ok, true, JSON.stringify(s3));
        assert.equal(s3.displayFrames, 2, "two distinct figures, even though their JSON agrees on length and prefix");
        assert.equal(s3.displayFramesUnchanged, 1);

        // Rebinding the data a committed plot reads changes that plot — and only it.
        const fourth = await server.dispatchTool("blade_eval", { session: "replay", source: "let py = [0.0, 1.0, 9.0]", cwd: work }, ctx);
        assert.equal(fourth.structuredContent.displayFrames, 1);
        assert.equal(fourth.structuredContent.displayFramesUnchanged, 2);

        const reset = await server.dispatchTool("blade_reset_session", { session: "replay" }, ctx);
        assert.equal(reset.structuredContent.ok, true);
        const after = await server.dispatchTool("blade_eval", { session: "replay", source: "1 + 1", cwd: work }, ctx);
        assert.equal(after.structuredContent.displayFrames, 0);
        assert.equal(after.structuredContent.displayFramesUnchanged, undefined, "the reset session re-runs nothing");
      });

      await t.test("blade_eval: a streamed stable-id frame (plot.stream) is delivered, as its JSON", async () => {
        const result = await server.dispatchTool(
          "blade_eval",
          { session: "stream", cwd: work, source: ["import plot", 'let s = plot.stream("train_loss", [0.0, 1.0], [0.9, 0.5])'].join("\n") },
          ctx
        );
        const s = result.structuredContent;
        if (s.exitCode !== 0 || s.displayFrames === 0) {
          t.diagnostic(`no stream frame from this compiler (${JSON.stringify(s.diagnostics)}); it may predate plot.stream`);
          return;
        }
        assert.equal(s.displayFrames, 1);
        const block = result.content.find((c) => c.type === "text" && /plotstream/.test(c.text));
        assert.ok(block, `expected the stream frame as text, got: ${JSON.stringify(result.content.map((c) => c.type))}`);
        assert.match(block.text, /"channel": "train_loss"/);
      });

      await t.test("blade_eval: an input the interpreter cannot run falls back to the g++ lane (needs g++)", async (t2) => {
        if (!gppOk) {
          t2.skip(`the doctor's gpp row is '${gppRow ? gppRow.status : "absent"}' — no g++ on PATH for the fallback lane`);
          return;
        }
        // fill_random over an AntisymIdx is one of the interpreter's declared gaps.
        const result = await server.dispatchTool(
          "blade_eval",
          { session: "gpp", cwd: work, source: ["let A: Array<Int64 like AntisymIdx<2, 3>> = fill_random(10)", "A(1, 1) == 0"].join("\n") },
          ctx
        );
        assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
        const s = result.structuredContent;
        if (s.lane !== "gpp") {
          t2.skip("the interpreter handled this input itself — it has grown past the fallback this subtest relies on");
          return;
        }
        assert.equal(s.ok, true, JSON.stringify(s));
        assert.deepEqual(s.bindings, [{ name: "", type: "Bool", value: "true" }]);
        assert.equal(s.hint, undefined);
      });

      await t.test("blade_eval: the g++ lane works WITH a GR runtime present — a provider write lands on disk (needs g++)", async (t2) => {
        if (!gppOk) {
          t2.skip(`the doctor's gpp row is '${gppRow ? gppRow.status : "absent"}' — no g++ on PATH for the fallback lane`);
          return;
        }
        // A GR distribution's bin directory carries its own GCC runtime DLLs; put
        // ahead of the toolchain on the serve child's PATH they make g++ exit 1
        // with no output. This is that failure's reproduction: with GR found
        // (the default on a machine with GRDIR set) the lane must still compile.
        t2.diagnostic(`GR runtime: ${ctx.grRuntime().ok ? ctx.grRuntime().grdir : "none (the shadowing hazard is not exercised here)"}`);
        const result = await server.dispatchTool(
          "blade_eval",
          { session: "gpp-write", cwd: work, source: ["import csv as c", "let A = [[1.0, 2.0], [3.0, 4.0]]", 'let saved = c.write("out.csv", A)'].join("\n") },
          ctx
        );
        assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
        const s = result.structuredContent;
        assert.equal(s.ok, true, `lane ${s.lane}: ${s.stderr}`);
        assert.equal(s.kept, true);
        if (s.lane === "gpp") assert.equal(s.hint, undefined);
        assert.equal(fs.existsSync(path.join(work, "out.csv")), true, "the write ran, relative to the eval's cwd");
      });

      await t.test("a backend-only refusal is NOT reported by blade_check or by the interpreter — as the tier description says", async () => {
        // tests/corpus/loops/154: `REJECT-AT: codegen`, BL7001 from `blade emit`.
        // If this starts failing the compiler has begun reporting backend
        // refusals earlier — good news, and the tier/tool descriptions in
        // src/schemas.js and src/server.js then need to stop saying otherwise.
        const source = [
          "let ts = Float64(0..6)",
          "let r0 = Float64(0..3)",
          "let r1 = 2.0 * Float64(0..3)",
          "let g = (ts <@> lambda(t) -> [r0, r1]) |> compute",
        ].join("\n");
        const check = await server.dispatchTool("blade_check", { source, cwd: work }, ctx);
        assert.equal(check.structuredContent.ok, true, JSON.stringify(check.structuredContent.diagnostics));
        assert.equal(check.structuredContent.tier, "full");
        const run = await server.dispatchTool("blade_eval", { session: "backend-only", source, cwd: work }, ctx);
        assert.equal(run.structuredContent.lane, "interp");
        assert.equal(run.structuredContent.ok, true, JSON.stringify(run.structuredContent.diagnostics));
      });

      await t.test("blade_eval: a real plot comes back as a real PNG (needs GR)", async (t2) => {
        const gr = ctx.grRuntime();
        if (!gr.ok) {
          t2.skip(`no GR runtime for this environment (${gr.reason}); set BLADE_GR_PATH to render plots as images`);
          return;
        }
        // Implicit lifting over an index range is the idiomatic way to build an axis.
        const result = await server.dispatchTool(
          "blade_eval",
          {
            session: "plot-integration",
            cwd: work,
            source: ["import plot", "let px = Float64(0..8)", "let py = px * px", 'let plotted = plot.line(px, py, "integration check": title)'].join("\n"),
          },
          ctx
        );
        assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
        const s = result.structuredContent;
        if (s.exitCode !== 0 || s.displayFrames === 0) {
          t2.skip(`this compiler produced no display frame (exitCode=${s.exitCode}, diagnostics=${JSON.stringify(s.diagnostics)}) — it likely predates the plot module`);
          return;
        }
        assert.deepEqual(s.diagnostics, [], "idiomatic source: no implicit-conversion warnings");
        assert.equal(s.plotsRendered, 1, `expected one GR render, got: ${JSON.stringify(s)}`);
        const label = result.content.find((c) => c.type === "text" && /^\[plot:/.test(c.text));
        assert.match(label.text, /integration check/);
        const image = result.content.find((c) => c.type === "image");
        assert.ok(image, "the figure must arrive as an image block");
        const bytes = Buffer.from(image.data, "base64");
        assert.equal(bytes.slice(1, 4).toString("ascii"), "PNG", "the render must be a real PNG");
        assert.equal(bytes.readUInt32BE(16), 800, "default render width");
        assert.equal(bytes.readUInt32BE(20), 600, "default render height");

        // the same plot, asked for larger, is rendered again at that size
        const bigger = await server.dispatchTool(
          "blade_eval",
          { session: "plot-integration", cwd: work, source: "plotted", plotWidth: 1200, plotHeight: 900 },
          ctx
        );
        const big = bigger.content.find((c) => c.type === "image");
        assert.ok(big, `a larger render was requested: ${JSON.stringify(bigger.structuredContent)}`);
        assert.equal(Buffer.from(big.data, "base64").readUInt32BE(16), 1200);
      });

      await t.test("blade_reset_session: {ok:true}", async () => {
        const result = await server.dispatchTool("blade_reset_session", {}, ctx);
        assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
        assert.equal(result.structuredContent.ok, true);
        // the default session really is empty again
        const probe = await server.dispatchTool("blade_eval", { source: "x", cwd: work }, ctx);
        assert.equal(probe.structuredContent.ok, false);
        assert.ok(probe.structuredContent.diagnostics.some((d) => d.code === "BL2001"));
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
    } finally {
      ctx.dispose();
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
);

"use strict";

// blade_check — typecheck a file or a snippet through the persistent
// `ide serve` process.
//
// The compiler's check payload carries seven arrays, four of which are dense
// span tables (references/calls/kernels/providers) built for an editor's
// navigation features. Handing those to an agent burns its context for no gain,
// so the default output is trimmed to what an agent reasons about —
// diagnostics, bindings, deduced facts, and counts — with `raw: true` as the
// escape hatch for the full payload.

const fs = require("fs");
const path = require("path");
const compiler = require("./compiler");

const { UserError, SNIPPET_BASENAME } = compiler;

/** cwd must exist: the compiler chdirs there to resolve relative data paths. */
function validateCwd(argCwd, ctx) {
  const dir = argCwd || ctx.config.cwd;
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch (e) {
    throw new UserError(`cwd does not exist: ${dir}`, { cwd: dir });
  }
  if (!stat.isDirectory()) throw new UserError(`cwd is not a directory: ${dir}`, { cwd: dir });
  return path.resolve(dir);
}

/**
 * Decide what path and text to send.
 *   file only   -> read it from disk (what the compiler would see)
 *   source only -> synthetic <cwd>/__blade_mcp_snippet__.blade; NOTHING is written
 *   both        -> unsaved-buffer semantics: this text, at that path
 */
function resolveTarget(args, cwd) {
  const hasFile = typeof args.file === "string" && args.file.trim() !== "";
  const hasSource = typeof args.source === "string";
  if (!hasFile && !hasSource) {
    throw new UserError(
      "provide `file` (a path), `source` (Blade text), or both (to check unsaved text at a path)"
    );
  }
  if (hasFile) {
    const file = path.resolve(cwd, args.file);
    if (hasSource) return { file, source: args.source, synthetic: false };
    let source;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch (e) {
      throw new UserError(`could not read ${file}: ${e.message}`, { file });
    }
    return { file, source, synthetic: false };
  }
  return { file: path.join(cwd, SNIPPET_BASENAME), source: args.source, synthetic: true };
}

function pickTier(tier, fallback) {
  return tier === "full" ? "full" : tier === "fast" ? "fast" : fallback;
}

/** Shared by blade_check and blade_symbols. Throws UserError, or the client's error. */
async function runCheck(args, ctx, defaultTier) {
  const cwd = validateCwd(args.cwd, ctx);
  const target = resolveTarget(args, cwd);
  const tier = pickTier(args.tier, defaultTier);
  const payload = await ctx.getClient().check(target.file, target.source, tier, args.timeoutMs);
  return { payload, tier, target, cwd };
}

/** Diagnostic + its registry title. `code` is ABSENT from the payload when empty. */
function trimDiagnostic(d, registry) {
  const code = typeof d.code === "string" && d.code !== "" ? d.code : null;
  const entry = code ? registry.get(code) : undefined;
  const out = { code };
  if (entry && entry.title) out.title = entry.title;
  if (entry && entry.phase) out.phase = entry.phase;
  out.severity = d.severity;
  out.message = d.message;
  out.span = { line: d.line, col: d.col, endLine: d.endLine, endCol: d.endCol };
  return out;
}

function trimBinding(b) {
  const out = { name: b.name, kind: b.kind, type: b.type };
  if (b.concreteType) out.concreteType = b.concreteType;
  return out;
}

function countOf(payload, key) {
  return Array.isArray(payload[key]) ? payload[key].length : 0;
}

function trimPayload(payload, ctx) {
  const registry = ctx.diagRegistry();
  const diags = Array.isArray(payload.diagnostics) ? payload.diagnostics : [];
  const bindings = Array.isArray(payload.bindings) ? payload.bindings : [];
  const errors = diags.filter((d) => d.severity === "error").length;
  const surface = ctx.surface();
  return {
    ok: errors === 0,
    compilerVersion: surface && surface.compilerVersion ? surface.compilerVersion : null,
    diagnostics: diags.map((d) => trimDiagnostic(d, registry)),
    bindings: bindings.map(trimBinding),
    deduced: Array.isArray(payload.deduced) ? payload.deduced : [],
    stats: {
      diagnostics: diags.length,
      errors,
      warnings: diags.filter((d) => d.severity === "warning").length,
      bindings: bindings.length,
      references: countOf(payload, "references"),
      calls: countOf(payload, "calls"),
      kernels: countOf(payload, "kernels"),
      providers: countOf(payload, "providers"),
      deduced: countOf(payload, "deduced"),
    },
  };
}

async function bladeCheck(args, ctx) {
  let res;
  try {
    res = await runCheck(args, ctx, "full");
  } catch (e) {
    if (e && e.userFacing) throw e;
    return compiler.serveErrorResult(ctx, e, "blade_check");
  }

  if (args.raw === true) {
    return compiler.toolResult({
      ok: !(res.payload.diagnostics || []).some((d) => d.severity === "error"),
      tier: res.tier,
      file: res.target.file,
      synthetic: res.target.synthetic,
      raw: true,
      payload: res.payload,
    });
  }

  const trimmed = trimPayload(res.payload, ctx);
  const structured = Object.assign(
    { ok: trimmed.ok, tier: res.tier, file: res.target.file, synthetic: res.target.synthetic },
    trimmed
  );
  if (res.target.synthetic) {
    structured.note = `checked as ${SNIPPET_BASENAME} in ${res.cwd}; no file was written`;
  }
  return compiler.toolResult(structured);
}

module.exports = {
  validateCwd,
  resolveTarget,
  pickTier,
  runCheck,
  trimPayload,
  trimDiagnostic,
  trimBinding,
  bladeCheck,
};

"use strict";

// blade_check — typecheck a file or a snippet through the persistent
// `ide serve` process.
//
// The compiler's check payload carries seven arrays, three of which are dense
// span tables (references/calls/kernels) built for an editor's navigation
// features. Handing those to an agent burns its context for no gain, so the
// default output is trimmed to what an agent reasons about — diagnostics,
// bindings, the provider stores the program loads, deduced facts, and counts —
// with `raw: true` as the escape hatch for the full payload.
//
// Wire facts this file relies on (types/check.d.ts in the protocol package is
// the transcription; src/Ide.fs `renderJson` is the emitter):
//
//   * a binding's line/col/endLine/endCol span its DECLARATION, not its name
//     token — a function's parameters therefore all carry the function's own
//     span. Name-token spans live in `references[]` (see nav.js).
//   * a binding's `kind` is the SOURCE spelling: "let", "let mut", "static",
//     "let static", "function", "static function", "param". (`references[]`
//     uses a different, coarser vocabulary: value/function/param/local/type.)
//   * a function binding's `type` is rendered for a hover — multi-line, one
//     parameter per line, defaults omitted. It is rebuilt here on one line
//     from `params`/`ret`, with the defaults.
//   * an absent value is an absent field, never null.
//   * tier "full" is typecheck + lowering/monomorphization. It does NOT run
//     code generation, so a construct only the C++ backend refuses (a
//     `REJECT-AT: codegen` corpus probe, BL7xxx) checks clean here. blade_eval
//     does not catch those either: its interpreter lane has no backend, and
//     only an input the interpreter cannot run reaches g++.

const fs = require("fs");
const path = require("path");
const compiler = require("./compiler");

const { UserError, SNIPPET_BASENAME } = compiler;

/** A provider store can expose hundreds of variables (a model-output NetCDF);
 *  past this many per list the rest are counted, not listed. */
const MAX_PROVIDER_MEMBERS = 40;

/** ...and a generated program can bind thousands of names. The trimmed result
 *  lists this many (in source order); `stats.bindings` stays exact, and
 *  blade_symbols looks any one of the rest up by name. */
const MAX_BINDINGS = 300;

const BOM = "\uFEFF";

/** A high surrogate with no low one after it, or a low one with no high one
 *  before it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Source text as the compiler must receive it.
 *
 *   * A leading byte-order mark is REMOVED. The CLI reads files through a
 *     BOM-aware reader, so `blade check` accepts a BOM-prefixed file; over
 *     `ide serve` the text travels as a JSON string and the U+FEFF reaches the
 *     lexer, which rejects the whole file at 1:1 ("Expected declaration but
 *     got '\uFEFF'"). The mark occupies no column in the CLI's coordinates
 *     either, so spans agree once it is gone.
 *   * A LONE SURROGATE is refused. It is not encodable as UTF-8; the compiler
 *     cannot parse the request line that carries it and answers with an error
 *     that names no request id — so the call would hang to its timeout and
 *     take the serve process (and every session) with it.
 */
function normalizeSource(text, what) {
  let out = String(text);
  if (out.startsWith(BOM)) out = out.slice(1);
  const at = out.search(LONE_SURROGATE);
  if (at !== -1) {
    const line = out.slice(0, at).split("\n").length;
    throw new UserError(
      `${what || "source"} contains a lone UTF-16 surrogate (line ${line}) — it is not valid Unicode and cannot be sent to the compiler. Replace it with the full character or an escape.`,
      { line }
    );
  }
  return out;
}

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
    if (hasSource) return { file, source: normalizeSource(args.source, "`source`"), synthetic: false };
    let source;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch (e) {
      throw new UserError(`could not read ${file}: ${e.message}`, { file });
    }
    return { file, source: normalizeSource(source, file), synthetic: false };
  }
  return { file: path.join(cwd, SNIPPET_BASENAME), source: normalizeSource(args.source, "`source`"), synthetic: true };
}

function pickTier(tier, fallback) {
  return tier === "full" ? "full" : tier === "fast" ? "fast" : fallback;
}

/** Shared by blade_check and blade_symbols. Throws UserError, or the client's error. */
async function runCheck(args, ctx, defaultTier) {
  const cwd = validateCwd(args.cwd, ctx);
  const target = resolveTarget(args, cwd);
  const tier = pickTier(args.tier, defaultTier);
  const timeoutMs = typeof args.timeoutMs === "number" && args.timeoutMs > 0 ? args.timeoutMs : undefined;
  const payload = await compiler.callServe(() => ctx.getClient().check(target.file, target.source, tier, timeoutMs));
  return { payload, tier, target, cwd };
}

/**
 * One diagnostic, with its registry title and phase. Shared by blade_check and
 * blade_eval, so an agent reads ONE diagnostic shape whichever tool produced it.
 *
 * `code` is ABSENT from the payload when empty; it trims to null. A code the
 * registry does not know (the parser's BL1003/BL1004 are emitted but not
 * registered) simply carries no title. `severity` is passed through verbatim:
 * "error" | "warning" from a check, plus "note" from an eval.
 */
function trimDiagnostic(d, registry) {
  const code = typeof d.code === "string" && d.code !== "" ? d.code : null;
  const entry = code && registry ? registry.get(code) : undefined;
  const out = { code };
  if (entry && entry.title) out.title = entry.title;
  if (entry && entry.phase) out.phase = entry.phase;
  out.severity = d.severity;
  out.message = d.message;
  out.span = { line: d.line, col: d.col, endLine: d.endLine, endCol: d.endCol };
  return out;
}

/**
 * A type string on one line. The compiler renders a function's `type` for an
 * editor hover — "(\n    a: T^1,\n    b: T^1\n) -> T" — which in JSON is a run
 * of escapes that costs tokens and reads worse than "(a: T^1, b: T^1) -> T".
 */
function flattenType(type) {
  if (typeof type !== "string" || type.indexOf("\n") === -1) return type;
  return type
    .replace(/\(\s*\n\s*/g, "(")
    .replace(/\s*\n\s*\)/g, ")")
    .replace(/\s*\n\s*/g, " ");
}

/**
 * A function's signature on one line, WITH parameter defaults — which the
 * compiler's own `type` rendering leaves out and carries on `params[]`
 * instead: `(a: Float64, s: Float64 = 2.0) -> Float64`. Falls back to the
 * flattened `type` for anything that is not a function binding.
 */
function signatureOf(b) {
  if (!Array.isArray(b.params) || typeof b.ret !== "string") return flattenType(b.type);
  const params = b.params.map((p) => {
    const head = `${p.name}: ${flattenType(p.type)}`;
    return typeof p.default === "string" && p.default !== "" ? `${head} = ${p.default}` : head;
  });
  return `(${params.join(", ")}) -> ${flattenType(b.ret)}`;
}

function nonEmptyStrings(value) {
  return Array.isArray(value) && value.length > 0 ? value : undefined;
}

function provenance(p) {
  return p && typeof p === "object" && typeof p.store === "string" && typeof p.member === "string"
    ? { store: p.store, member: p.member }
    : undefined;
}

/**
 * The facts a binding carries beyond its name and position, in the order they
 * are reported. Shared with blade_symbols so the two tools cannot disagree.
 *
 *   type / concreteType   as the compiler rendered them, on one line; a
 *                         function's carries its parameter defaults
 *   where                 the `where` conjuncts as DECLARED (functions)
 *   deducedComm           the symmetry the compiler PROVED, declared or not;
 *                         omitted when empty ("deduction proved nothing")
 *   providerRead          this binding READS that store member
 *   providerWrite         this binding PERSISTS an array that came from that
 *                         store member — the opposite direction, and never on
 *                         the same binding as providerRead
 */
function bindingFacts(b) {
  const out = {};
  if (b.type) out.type = signatureOf(b);
  if (b.concreteType) out.concreteType = flattenType(b.concreteType);
  const where = nonEmptyStrings(b.where);
  if (where) out.where = where;
  const deducedComm = nonEmptyStrings(b.deducedComm);
  if (deducedComm) out.deducedComm = deducedComm;
  const read = provenance(b.providerRead);
  if (read) out.providerRead = read;
  const write = provenance(b.providerWrite);
  if (write) out.providerWrite = write;
  return out;
}

/** `line` is the DECLARATION's first line: it is what tells two same-named
 *  bindings apart (every function with a parameter `a` contributes one). */
function trimBinding(b) {
  const out = { name: b.name, kind: b.kind };
  if (typeof b.line === "number") out.line = b.line;
  // `type` is always present on the wire; keep the key even if a compiler
  // sends it empty, so the documented shape holds.
  out.type = signatureOf(b);
  const facts = bindingFacts(b);
  delete facts.type;
  return Object.assign(out, facts);
}

function capMembers(list, mapper) {
  const all = Array.isArray(list) ? list : [];
  return { shown: all.slice(0, MAX_PROVIDER_MEMBERS).map(mapper), omitted: Math.max(0, all.length - MAX_PROVIDER_MEMBERS) };
}

/**
 * One `let store = alias.load("path")` and the structure the provider derived
 * from the file: named index types (with extents when static), dimension
 * coordinates, and variables with their full array types. This is what lets an
 * agent write `store.vars.<name> |> alias.read` without opening the data file,
 * so — unlike the span tables — it is part of the default output.
 */
function trimProvider(p) {
  const out = { store: p.store, alias: p.alias, provider: p.provider, path: p.path };
  if (typeof p.line === "number") out.line = p.line;
  const idx = capMembers(p.indexTypes, (ix) => (typeof ix.extent === "number" ? { name: ix.name, extent: ix.extent } : { name: ix.name }));
  const dims = capMembers(p.dims, (m) => ({ name: m.name, type: m.type }));
  const vars = capMembers(p.vars, (m) => ({ name: m.name, type: m.type }));
  out.indexTypes = idx.shown;
  out.dims = dims.shown;
  out.vars = vars.shown;
  const omitted = {};
  if (idx.omitted) omitted.indexTypes = idx.omitted;
  if (dims.omitted) omitted.dims = dims.omitted;
  if (vars.omitted) omitted.vars = vars.omitted;
  if (Object.keys(omitted).length) out.omitted = omitted;
  return out;
}

function countOf(payload, key) {
  return Array.isArray(payload[key]) ? payload[key].length : 0;
}

/** The version of the binary that ANSWERED, when the context can say; else
 *  null. (It used to report the packaged surface's `compilerVersion` — a
 *  statement about this server's vendored files, not about the compiler.) */
async function binaryVersion(ctx) {
  if (typeof ctx.liveVersion !== "function") return null;
  try {
    const v = await ctx.liveVersion();
    return typeof v === "string" && v !== "" && v !== "unknown" ? v : null;
  } catch (_) {
    return null;
  }
}

function trimPayload(payload, ctx, compilerVersion) {
  const registry = ctx.diagRegistry();
  const diags = Array.isArray(payload.diagnostics) ? payload.diagnostics : [];
  const bindings = Array.isArray(payload.bindings) ? payload.bindings : [];
  const providers = Array.isArray(payload.providers) ? payload.providers : [];
  const errors = diags.filter((d) => d.severity === "error").length;
  const out = {
    ok: errors === 0,
    compilerVersion: compilerVersion === undefined ? null : compilerVersion,
    diagnostics: diags.map((d) => trimDiagnostic(d, registry)),
    bindings: bindings.slice(0, MAX_BINDINGS).map(trimBinding),
  };
  if (bindings.length > MAX_BINDINGS) out.bindingsOmitted = bindings.length - MAX_BINDINGS;
  // Only when the program loads a store: the key's absence is the common case
  // and costs nothing.
  if (providers.length) out.providers = providers.map(trimProvider);
  out.deduced = Array.isArray(payload.deduced) ? payload.deduced : [];
  out.stats = {
    diagnostics: diags.length,
    errors,
    warnings: diags.filter((d) => d.severity === "warning").length,
    bindings: bindings.length,
    references: countOf(payload, "references"),
    calls: countOf(payload, "calls"),
    kernels: countOf(payload, "kernels"),
    providers: providers.length,
    deduced: countOf(payload, "deduced"),
  };
  return out;
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

  const trimmed = trimPayload(res.payload, ctx, await binaryVersion(ctx));
  const structured = Object.assign(
    { ok: trimmed.ok, tier: res.tier, file: res.target.file, synthetic: res.target.synthetic },
    trimmed
  );
  const notes = [];
  if (res.target.synthetic) notes.push(`checked as ${SNIPPET_BASENAME} in ${res.cwd}; no file was written`);
  if (trimmed.bindingsOmitted) {
    notes.push(
      `${trimmed.stats.bindings} bindings; only the first ${MAX_BINDINGS} are listed — use blade_symbols with \`name\` to look up any of the rest`
    );
  }
  if (notes.length) structured.note = notes.join("; ");
  return compiler.toolResult(structured);
}

module.exports = {
  MAX_PROVIDER_MEMBERS,
  MAX_BINDINGS,
  normalizeSource,
  signatureOf,
  validateCwd,
  resolveTarget,
  pickTier,
  runCheck,
  trimPayload,
  trimDiagnostic,
  trimBinding,
  trimProvider,
  bindingFacts,
  flattenType,
  bladeCheck,
};

"use strict";

// blade_symbols — ONE name-keyed navigation tool.
//
// Editors ask "what is at line 12, column 4?"; an LLM asks "where is
// station_means?". So instead of mirroring the definition/references provider
// pair, this reshapes the compiler's `references[]` (one entry per binder, with
// its def span and every resolved use) against `bindings[]` (which carries the
// types) into a single name-keyed table.
//
// PAIRING A REFERENCE WITH ITS BINDING. The two tables describe the same
// binders in different coordinates, and nothing on the wire links them:
//
//   * references[].def is the NAME TOKEN            (`let x = 1` -> 1:5-1:6)
//   * bindings[].line/col/endLine/endCol span the DECLARATION (1:1-1:10), and a
//     function's parameters all carry the FUNCTION's span
//   * references[] also lists binders that have no bindings[] entry at all —
//     lambda parameters, named types
//
// so "same name" is not enough: `a` is routinely a parameter of three
// functions, a lambda parameter, and a top-level value in one file. A
// reference is therefore paired with the binding that (1) has its name, (2) is
// of a compatible kind, and (3) whose declaration span CONTAINS the
// reference's name token — the innermost such binding when several nest.
// References are walked in source order, so a function's own parameter (in the
// header) claims the function's `param` binding before a same-named lambda
// parameter in the body can; the lambda parameter then correctly reports no
// type, because the compiler recorded none for it.

const compiler = require("./compiler");
const checks = require("./checks");

/** Output rails. A 500-line program lists ~1000 binders (most of them lambda
 *  parameters) with thousands of use spans; unbounded, that is a response no
 *  client can hold. The caps bound the LISTING — `useCount`, `symbolCount` and
 *  `totalSymbols` stay exact — and a `name` filter is the way to see the rest:
 *  a lookup of one name fits comfortably inside all three. */
const MAX_SYMBOLS = 100;
const MAX_USES_PER_SYMBOL = 50;
const MAX_USES_TOTAL = 300;
const MAX_DOC_CHARS = 300;

function hasSpan(s) {
  return !!s && typeof s.line === "number" && typeof s.col === "number";
}

/** Is position (line, col) inside the binding's declaration span? `endCol` is
 *  exclusive. A binding with no end corner (a compiler predating that pair)
 *  degrades to "the declaration starts on this line". */
function declContains(binding, def) {
  if (!hasSpan(binding) || !hasSpan(def)) return false;
  if (typeof binding.endLine !== "number" || typeof binding.endCol !== "number") {
    return binding.line === def.line && binding.col <= def.col;
  }
  if (def.line < binding.line || def.line > binding.endLine) return false;
  if (def.line === binding.line && def.col < binding.col) return false;
  if (def.line === binding.endLine && def.col >= binding.endCol) return false;
  return true;
}

/** references[] says value/function/param/local/type; bindings[] says
 *  let / let mut / static / let static / function / static function / param. */
function kindsCompatible(refKind, bindingKind) {
  const b = String(bindingKind || "");
  if (refKind === "function") return /function/.test(b);
  if (refKind === "param") return b === "param";
  if (refKind === "type") return b === "type";
  if (refKind === "value" || refKind === "local") return b !== "param" && !/function/.test(b);
  return true; // an unknown reference kind: let position decide
}

/** The reference-table class a binding's source spelling belongs to, for a
 *  binding that has to be reported without a reference entry. */
function classOfBinding(bindingKind) {
  const b = String(bindingKind || "");
  if (/function/.test(b)) return "function";
  if (b === "param" || b === "type") return b;
  return b === "" ? null : "value";
}

/** A binding's `///` doc comment, when it has one. This is the lookup tool, so
 *  the doc belongs here (blade_check lists every binding and leaves it out);
 *  it is capped because a section banner above a `let` is attached as its doc. */
function docOf(binding) {
  const doc = typeof binding.doc === "string" ? binding.doc.trim() : "";
  if (doc === "") return {};
  return { doc: doc.length > MAX_DOC_CHARS ? `${doc.slice(0, MAX_DOC_CHARS)}…` : doc };
}

/** Declaration extent as a sortable size — fewer lines first, then fewer columns. */
function declSize(b) {
  const lines = (typeof b.endLine === "number" ? b.endLine : b.line) - b.line;
  const cols = (typeof b.endCol === "number" ? b.endCol : b.col) - b.col;
  return lines * 100000 + cols;
}

function defOrder(a, b) {
  const ad = a.def;
  const bd = b.def;
  if (!hasSpan(ad) && !hasSpan(bd)) return 0;
  if (!hasSpan(ad)) return 1;
  if (!hasSpan(bd)) return -1;
  return ad.line !== bd.line ? ad.line - bd.line : ad.col - bd.col;
}

/** references[] merged with bindings[]; bindings with no references still appear. */
function mergeSymbols(payload) {
  const references = Array.isArray(payload.references) ? payload.references.slice() : [];
  const bindings = Array.isArray(payload.bindings) ? payload.bindings : [];

  const byName = new Map();
  for (const b of bindings) {
    if (!byName.has(b.name)) byName.set(b.name, []);
    byName.get(b.name).push({ binding: b, consumed: false });
  }

  // Source order, so an outer binder claims its binding before an inner
  // same-named one is considered (see the header). Array.prototype.sort is
  // stable, which keeps span-less entries in wire order.
  references.sort(defOrder);

  const symbols = [];
  for (const ref of references) {
    const bucket = byName.get(ref.name) || [];
    const candidates = bucket.filter(
      (s) => !s.consumed && kindsCompatible(ref.kind, s.binding.kind) && declContains(s.binding, ref.def)
    );
    candidates.sort((x, y) => declSize(x.binding) - declSize(y.binding));
    const slot = candidates[0];
    if (slot) slot.consumed = true;
    const uses = Array.isArray(ref.uses) ? ref.uses : [];
    symbols.push(
      Object.assign(
        { name: ref.name, kind: ref.kind || (slot && slot.binding.kind) || null },
        slot ? { bindingKind: slot.binding.kind } : {},
        slot ? checks.bindingFacts(slot.binding) : {},
        slot ? docOf(slot.binding) : {},
        { def: ref.def || null, useCount: uses.length, uses }
      )
    );
  }

  // A binding no reference claimed (an older compiler without references[], or
  // a binder whose name span did not survive): report it from its own span.
  for (const [, bucket] of byName) {
    for (const slot of bucket) {
      if (slot.consumed) continue;
      const b = slot.binding;
      symbols.push(
        Object.assign({ name: b.name, kind: classOfBinding(b.kind), bindingKind: b.kind }, checks.bindingFacts(b), docOf(b), {
          def: { line: b.line, col: b.col, endLine: b.endLine, endCol: b.endCol },
          useCount: 0,
          uses: [],
        })
      );
    }
  }

  symbols.sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    const al = a.def ? a.def.line : 0;
    const bl = b.def ? b.def.line : 0;
    if (al !== bl) return al - bl;
    return (a.def ? a.def.col : 0) - (b.def ? b.def.col : 0);
  });
  return symbols;
}

/** Exact match wins; a case-insensitive substring sweep is the fallback. */
function filterByName(symbols, name) {
  const exact = symbols.filter((s) => s.name === name);
  if (exact.length) return { symbols: exact, match: "exact" };
  const needle = String(name).toLowerCase();
  const loose = symbols.filter((s) => String(s.name).toLowerCase().indexOf(needle) !== -1);
  return { symbols: loose, match: loose.length ? "substring" : "none" };
}

/** `kind` matches either vocabulary: the reference class ("value", "param",
 *  "function", "local", "type") or the binding's source spelling ("let mut",
 *  "static", "static function", ...). */
function matchesKind(symbol, kind) {
  const want = String(kind).trim().toLowerCase();
  return String(symbol.kind || "").toLowerCase() === want || String(symbol.bindingKind || "").toLowerCase() === want;
}

/** One symbol in its reported field order. `bindingKind` is shown only when it
 *  says more than `kind` already does. `allowance` is how many use spans this
 *  symbol may still list: the per-symbol cap, further limited by what is left
 *  of the response-wide budget. */
function shapeSymbol(s, includeUses, allowance) {
  const out = { name: s.name, kind: s.kind };
  if (s.bindingKind && s.bindingKind !== s.kind) out.bindingKind = s.bindingKind;
  for (const key of ["type", "concreteType", "where", "deducedComm", "providerRead", "providerWrite", "doc"]) {
    if (s[key] !== undefined) out[key] = s[key];
  }
  out.def = s.def;
  out.useCount = s.useCount;
  if (includeUses) {
    const room = Math.max(0, Math.min(MAX_USES_PER_SYMBOL, typeof allowance === "number" ? allowance : MAX_USES_PER_SYMBOL));
    out.uses = s.uses.length > room ? s.uses.slice(0, room) : s.uses;
    if (s.uses.length > room) out.usesTruncated = true;
  }
  return out;
}

async function bladeSymbols(args, ctx) {
  let res;
  try {
    res = await checks.runCheck(args, ctx, "fast");
  } catch (e) {
    if (e && e.userFacing) throw e;
    return compiler.serveErrorResult(ctx, e, "blade_symbols");
  }

  let symbols = mergeSymbols(res.payload);
  const total = symbols.length;
  let match;

  if (args.kind) symbols = symbols.filter((s) => matchesKind(s, args.kind));
  if (args.name) {
    const filtered = filterByName(symbols, args.name);
    symbols = filtered.symbols;
    match = filtered.match;
  }

  const includeUses = args.includeUses !== false;
  const matched = symbols.length;
  const listed = matched > MAX_SYMBOLS ? symbols.slice(0, MAX_SYMBOLS) : symbols;

  const diags = Array.isArray(res.payload.diagnostics) ? res.payload.diagnostics : [];
  const structured = {
    ok: true,
    tier: res.tier,
    file: res.target.file,
    synthetic: res.target.synthetic,
    symbolCount: matched,
    totalSymbols: total,
    symbols: [],
  };
  let usesLeft = MAX_USES_TOTAL;
  for (const sym of listed) {
    const shaped = shapeSymbol(sym, includeUses, usesLeft);
    if (shaped.uses) usesLeft -= shaped.uses.length;
    structured.symbols.push(shaped);
  }
  if (match) structured.nameMatch = match;
  const notes = [];
  if (matched > listed.length) {
    structured.truncated = true;
    notes.push(
      `${matched} symbols matched; only the first ${listed.length} (by name) are listed — narrow with \`name\` or \`kind\``
    );
  }
  if (includeUses && structured.symbols.some((s) => s.usesTruncated)) {
    notes.push(
      `a symbol flagged usesTruncated lists only some of its use spans (at most ${MAX_USES_PER_SYMBOL} each, ${MAX_USES_TOTAL} per response); useCount is exact — look that symbol up by name for its uses`
    );
  }
  if (diags.some((d) => d.severity === "error")) {
    notes.push("the source has errors, so name resolution may be partial — run blade_check for the diagnostics");
  }
  if (notes.length) structured.note = notes.join("; ");
  return compiler.toolResult(structured);
}

module.exports = { MAX_SYMBOLS, MAX_USES_PER_SYMBOL, MAX_USES_TOTAL, mergeSymbols, filterByName, matchesKind, declContains, kindsCompatible, bladeSymbols };

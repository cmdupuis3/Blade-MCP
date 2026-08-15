"use strict";

// blade_symbols — ONE name-keyed navigation tool.
//
// Editors ask "what is at line 12, column 4?"; an LLM asks "where is
// station_means?". So instead of mirroring the definition/references provider
// pair, this reshapes the compiler's `references[]` (one entry per binder, with
// its def span and every resolved use) against `bindings[]` (which carries the
// types) into a single name-keyed table.

const compiler = require("./compiler");
const checks = require("./checks");

function samePosition(def, binding) {
  return !!def && def.line === binding.line && def.col === binding.col;
}

function bindingType(binding) {
  const out = {};
  if (binding.type) out.type = binding.type;
  if (binding.concreteType) out.concreteType = binding.concreteType;
  return out;
}

/** references[] merged with bindings[]; bindings with no references still appear. */
function mergeSymbols(payload) {
  const references = Array.isArray(payload.references) ? payload.references : [];
  const bindings = Array.isArray(payload.bindings) ? payload.bindings : [];

  const byName = new Map();
  for (const b of bindings) {
    if (!byName.has(b.name)) byName.set(b.name, []);
    byName.get(b.name).push({ binding: b, consumed: false });
  }

  const symbols = [];
  for (const ref of references) {
    const bucket = byName.get(ref.name) || [];
    let slot = bucket.find((s) => !s.consumed && samePosition(ref.def, s.binding));
    if (!slot) slot = bucket.find((s) => !s.consumed);
    if (slot) slot.consumed = true;
    const uses = Array.isArray(ref.uses) ? ref.uses : [];
    symbols.push(
      Object.assign(
        { name: ref.name, kind: ref.kind || (slot && slot.binding.kind) || null },
        slot ? bindingType(slot.binding) : {},
        { def: ref.def || null, useCount: uses.length, uses }
      )
    );
  }

  for (const [, bucket] of byName) {
    for (const slot of bucket) {
      if (slot.consumed) continue;
      const b = slot.binding;
      symbols.push(
        Object.assign({ name: b.name, kind: b.kind || null }, bindingType(b), {
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
    return al - bl;
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

  if (args.kind) {
    const kind = String(args.kind).toLowerCase();
    symbols = symbols.filter((s) => String(s.kind || "").toLowerCase() === kind);
  }
  if (args.name) {
    const filtered = filterByName(symbols, args.name);
    symbols = filtered.symbols;
    match = filtered.match;
  }

  const includeUses = args.includeUses !== false;
  if (!includeUses) symbols = symbols.map((s) => Object.assign({}, s, { uses: undefined }));

  const diags = Array.isArray(res.payload.diagnostics) ? res.payload.diagnostics : [];
  const structured = {
    ok: true,
    tier: res.tier,
    file: res.target.file,
    synthetic: res.target.synthetic,
    symbolCount: symbols.length,
    totalSymbols: total,
    symbols: symbols.map((s) => {
      const out = { name: s.name, kind: s.kind };
      if (s.type) out.type = s.type;
      if (s.concreteType) out.concreteType = s.concreteType;
      out.def = s.def;
      out.useCount = s.useCount;
      if (includeUses) out.uses = s.uses;
      return out;
    }),
  };
  if (match) structured.nameMatch = match;
  if (diags.some((d) => d.severity === "error")) {
    structured.note =
      "the source has errors, so name resolution may be partial — run blade_check for the diagnostics";
  }
  return compiler.toolResult(structured);
}

module.exports = { mergeSymbols, filterByName, bladeSymbols };

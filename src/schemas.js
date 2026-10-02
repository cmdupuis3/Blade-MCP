"use strict";

// Hand-authored JSON Schema objects for every tool's inputSchema.
//
// Deliberately NOT zod: the MCP SDK accepts plain JSON Schema for tool
// registration, and hand-authored schemas keep this file readable as the
// server's public contract. (The SDK's own request schemas are zod internally;
// that is the SDK's business, not ours.)
//
// Every schema sets additionalProperties:false so a typo'd argument is a loud
// validation failure rather than a silently ignored one — and `validate`
// below is what makes that true: the SDK's low-level Server does not check
// arguments against a tool's inputSchema, so the dispatcher does, with this.

const CWD = {
  type: "string",
  description:
    "Absolute directory the compiler resolves relative data paths against, and the parent of the synthetic path used for bare `source`. Must exist. Defaults to the server's working directory.",
};

/** blade_check / blade_symbols share it: the protocol client's own defaults
 *  (10 s fast, 30 s full) apply when it is omitted. */
const CHECK_TIMEOUT = {
  type: "integer",
  minimum: 1000,
  description:
    "Per-call timeout in milliseconds. Defaults to 10000 at tier fast and 30000 at tier full. Exceeding it kills the compiler process, which discards every blade_eval session's definitions.",
};

const bladeCheck = {
  type: "object",
  properties: {
    file: {
      type: "string",
      description: "Path to a .blade file to check. Combine with `source` to check unsaved buffer text at this path.",
    },
    source: {
      type: "string",
      description:
        "Blade source to check. Without `file` it is checked at a synthetic path <cwd>/__blade_mcp_snippet__.blade — the text travels inline; no scratch file is ever written.",
    },
    tier: {
      type: "string",
      enum: ["fast", "full"],
      default: "full",
      description:
        "`fast` is parse + typecheck + deduction. `full` adds lowering and monomorphization, which is what resolves concrete types and catches lowering-time refusals. Neither runs code generation: a construct only the C++ backend refuses (BL7xxx) still checks clean, and blade_eval's interpreter lane runs it too — only compiling the program (`blade emit` / `blade run` on the command line) reports it.",
    },
    cwd: CWD,
    timeoutMs: CHECK_TIMEOUT,
    raw: {
      type: "boolean",
      default: false,
      description:
        "Return the compiler's untrimmed payload, including the span-heavy references/calls/kernels tables and the fields the trimmed bindings drop (doc comments, per-parameter records, full spans). Off by default because those tables dominate an agent's context.",
    },
  },
  required: [],
  additionalProperties: false,
};

const bladeEval = {
  type: "object",
  properties: {
    source: {
      type: "string",
      description:
        "Blade source to evaluate as the next submission in the session. Only a trailing bare expression is echoed back (declarations are silent), so end with the expression or name whose value you want.",
    },
    session: {
      type: "string",
      default: "default",
      description:
        "Session key. Definitions accumulate across calls with the same key (append, or rebind-in-place by top-level name); a failed submission is not kept.",
    },
    cwd: CWD,
    timeoutMs: {
      type: "integer",
      minimum: 1000,
      default: 120000,
      description:
        "Per-call timeout. The default is generous because the g++ fallback lane compiles C++. Exceeding it kills the compiler process, which discards EVERY session's definitions.",
    },
    plotWidth: {
      type: "integer",
      minimum: 64,
      maximum: 4096,
      default: 800,
      description: "Pixel width of the GR renders of any plots this eval produces. Raise it to read fine detail; the default is legible and cheap.",
    },
    plotHeight: {
      type: "integer",
      minimum: 64,
      maximum: 4096,
      default: 600,
      description: "Pixel height of the GR renders of any plots this eval produces.",
    },
  },
  required: ["source"],
  additionalProperties: false,
};

const bladeResetSession = {
  type: "object",
  properties: {
    session: { type: "string", default: "default", description: "Session key whose accumulated bindings are discarded." },
  },
  required: [],
  additionalProperties: false,
};

const bladeDoctor = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};

const bladeSymbols = {
  type: "object",
  properties: {
    file: { type: "string", description: "Path to a .blade file." },
    source: { type: "string", description: "Blade source (checked at a synthetic path when `file` is absent)." },
    name: { type: "string", description: "Filter to this symbol: exact match first, then case-insensitive substring." },
    kind: {
      type: "string",
      description:
        "Filter by kind, case-insensitively: a reference class (value, function, param, local, type) or a binding's source spelling (let, let mut, static, let static, static function).",
    },
    includeUses: { type: "boolean", default: true, description: "Include use spans (capped: 50 per symbol, 300 per response). `useCount` is always present and exact." },
    tier: { type: "string", enum: ["fast", "full"], default: "fast", description: "Check tier used to gather symbols." },
    cwd: CWD,
    timeoutMs: CHECK_TIMEOUT,
  },
  required: [],
  additionalProperties: false,
};

const bladeExplain = {
  type: "object",
  properties: {
    code: {
      type: "string",
      pattern: "^([Bb][Ll])?\\d{4}$",
      description: "Diagnostic code, with or without the BL prefix, either case (e.g. BL3016, bl3016 or 3016).",
    },
    maxExamples: { type: "integer", minimum: 0, maximum: 10, default: 3, description: "Cap on corpus examples returned." },
    includeSource: { type: "boolean", default: true, description: "Inline each example's source (truncated)." },
  },
  required: ["code"],
  additionalProperties: false,
};

const bladeCorpusFind = {
  type: "object",
  properties: {
    query: { type: "string", description: "Content search: case-insensitive substring over corpus (and examples) sources." },
    intent: {
      type: "string",
      description:
        'What you are trying to write, in words — e.g. "running state / recurrence", "filter rows", "sliding window". Scored against the curated idiom index, falling through to a content search.',
    },
    category: {
      type: "string",
      description:
        'A corpus category directory name, e.g. recursive-arrays, index-types, ppl — or "examples" / "examples/physics" for the worked programs.',
    },
    code: {
      type: "string",
      pattern: "^([Bb][Ll])?\\d{4}$",
      description: "Find corpus files pinning this diagnostic code (// ERROR:, // WARN: or // ABORT: pins).",
    },
    maxResults: { type: "integer", minimum: 1, maximum: 50, default: 8 },
    includeSnippets: { type: "boolean", default: false, description: "Include matching lines with line numbers." },
  },
  required: [],
  additionalProperties: false,
};

// --- validation -----------------------------------------------------------------

function typeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value, type) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    default:
      return true; // a type this file does not use: not ours to reject
  }
}

/** Edit distance, for "did you mean". Argument names are short; no need to be clever. */
function distance(a, b) {
  const row = [];
  for (let j = 0; j <= b.length; j++) row[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}

function nearest(name, candidates) {
  let best;
  for (const c of candidates) {
    const d = distance(String(name).toLowerCase(), c.toLowerCase());
    if (d <= 2 && (!best || d < best.d)) best = { c, d };
  }
  return best ? best.c : undefined;
}

/**
 * Check `args` against one of the schemas above. Returns a list of problems,
 * each a sentence naming the argument — empty when the arguments are valid.
 *
 * It implements exactly the JSON Schema vocabulary this file uses (object with
 * properties / required / additionalProperties:false; string, integer, number
 * and boolean values; enum, minimum, maximum, pattern), and no more. Nothing
 * is coerced: `"yes"` is not a boolean and `"10"` is not an integer, because
 * an argument that quietly meant something else is the bug this exists to stop.
 */
function validate(schema, args) {
  const problems = [];
  if (!schema || schema.type !== "object") return problems;
  if (args === undefined || args === null) args = {};
  if (!matchesType(args, "object")) return [`arguments must be an object, got ${typeName(args)}`];

  const props = schema.properties || {};
  const known = Object.keys(props);

  for (const name of schema.required || []) {
    if (args[name] === undefined) problems.push(`missing required argument \`${name}\``);
  }

  for (const name of Object.keys(args)) {
    const value = args[name];
    const spec = props[name];
    if (!spec) {
      if (schema.additionalProperties === false) {
        const hint = nearest(name, known);
        problems.push(
          `unknown argument \`${name}\`${hint ? ` — did you mean \`${hint}\`?` : ""} (accepted: ${known.length ? known.join(", ") : "none"})`
        );
      }
      continue;
    }
    if (value === undefined) continue;
    if (spec.type && !matchesType(value, spec.type)) {
      problems.push(`\`${name}\` must be ${/^[aeiou]/.test(spec.type) ? "an" : "a"} ${spec.type}, got ${typeName(value)} (${JSON.stringify(value)})`);
      continue;
    }
    if (Array.isArray(spec.enum) && spec.enum.indexOf(value) === -1) {
      problems.push(`\`${name}\` must be one of ${spec.enum.map((v) => JSON.stringify(v)).join(", ")}, got ${JSON.stringify(value)}`);
    }
    if (typeof spec.minimum === "number" && typeof value === "number" && value < spec.minimum) {
      problems.push(`\`${name}\` must be at least ${spec.minimum}, got ${value}`);
    }
    if (typeof spec.maximum === "number" && typeof value === "number" && value > spec.maximum) {
      problems.push(`\`${name}\` must be at most ${spec.maximum}, got ${value}`);
    }
    if (typeof spec.pattern === "string" && typeof value === "string" && !new RegExp(spec.pattern).test(value)) {
      problems.push(`\`${name}\` must match ${spec.pattern}, got ${JSON.stringify(value)}`);
    }
  }
  return problems;
}

module.exports = {
  validate,
  bladeCheck,
  bladeEval,
  bladeResetSession,
  bladeDoctor,
  bladeSymbols,
  bladeExplain,
  bladeCorpusFind,
};

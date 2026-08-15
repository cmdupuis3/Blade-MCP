"use strict";

// Hand-authored JSON Schema objects for every tool's inputSchema.
//
// Deliberately NOT zod: the MCP SDK accepts plain JSON Schema for tool
// registration, and hand-authored schemas keep this file readable as the
// server's public contract. (The SDK's own request schemas are zod internally;
// that is the SDK's business, not ours.)
//
// Every schema sets additionalProperties:false so a typo'd argument is a loud
// validation failure rather than a silently ignored one.

const CWD = {
  type: "string",
  description:
    "Absolute directory the compiler resolves relative data paths against, and the parent of the synthetic path used for bare `source`. Must exist. Defaults to the server's working directory.",
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
      description: "`fast` skips monomorphization; `full` is the complete pipeline and reports concrete types.",
    },
    cwd: CWD,
    raw: {
      type: "boolean",
      default: false,
      description:
        "Return the compiler's untrimmed payload, including the span-heavy references/calls/kernels/providers tables. Off by default because those tables dominate an agent's context.",
    },
  },
  required: [],
  additionalProperties: false,
};

const bladeEval = {
  type: "object",
  properties: {
    source: { type: "string", description: "Blade source to evaluate as the next submission in the session." },
    session: {
      type: "string",
      default: "default",
      description: "Session key. Bindings accumulate across calls with the same key (append, or rebind-in-place by top-level name).",
    },
    cwd: CWD,
    timeoutMs: {
      type: "integer",
      minimum: 1000,
      default: 120000,
      description: "Per-call timeout. The default is generous because the g++ fallback lane compiles C++.",
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
    kind: { type: "string", description: "Filter by binder kind as the compiler reports it (e.g. let, function, param, type)." },
    includeUses: { type: "boolean", default: true, description: "Include every use span. `useCount` is always present." },
    tier: { type: "string", enum: ["fast", "full"], default: "fast", description: "Check tier used to gather symbols." },
    cwd: CWD,
  },
  required: [],
  additionalProperties: false,
};

const bladeExplain = {
  type: "object",
  properties: {
    code: {
      type: "string",
      pattern: "^(BL)?\\d{4}$",
      description: "Diagnostic code, with or without the BL prefix (e.g. BL3016 or 3016).",
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
    category: { type: "string", description: "A corpus category directory name, e.g. recursive-arrays, index-types, ppl." },
    code: { type: "string", pattern: "^(BL)?\\d{4}$", description: "Find corpus files pinning this diagnostic code." },
    maxResults: { type: "integer", minimum: 1, maximum: 50, default: 8 },
    includeSnippets: { type: "boolean", default: false, description: "Include matching lines with line numbers." },
  },
  required: [],
  additionalProperties: false,
};

module.exports = {
  bladeCheck,
  bladeEval,
  bladeResetSession,
  bladeDoctor,
  bladeSymbols,
  bladeExplain,
  bladeCorpusFind,
};

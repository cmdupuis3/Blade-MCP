"use strict";

// Tool + resource registration on the LOW-LEVEL MCP Server class.
//
// Handlers are plain `async (args, ctx) => result` functions living in sibling
// modules; this file only owns the table, the dispatch wrapper, and the SDK
// plumbing. That split is what makes the handlers unit-testable without a
// transport: build a context, swap ctx.getClient for a fake, call the handler.

const compiler = require("./compiler");
const schemas = require("./schemas");
const checks = require("./checks");
const sessions = require("./sessions");
const nav = require("./nav");
const knowledge = require("./knowledge");
const corpus = require("./corpus");
const resources = require("./resources");

const SERVER_INFO = { name: "blade-mcp", version: "0.1.0" };

/** JSON-RPC error code MCP assigns to "that resource does not exist". The SDK's
 *  ErrorCode table does not name it, and without it an unknown URI surfaces as
 *  an internal error (-32603) — "the server broke" rather than "no such thing". */
const RESOURCE_NOT_FOUND = -32002;

/**
 * Sent to the client at initialize, for the model to read before it picks a
 * tool. Short on purpose: what each tool is FOR and the handful of facts that
 * are not guessable from the tool list.
 */
const INSTRUCTIONS = [
  "Blade is an array-functional language (ML-style syntax, numpy-flavored math) compiled to C++. Iteration is declarative: there is no imperative loop — parallel structure is a loop object (method_for / object_for), sequential structure is a recursive array (let rec).",
  "",
  "Workflow:",
  "- blade_check typechecks a file or snippet: diagnostics, bindings, provider stores, deduced symmetry. It typechecks and lowers; it does not run the C++ backend, so backend-only refusals (BL7xxx) are not reported by it — nor by blade_eval's interpreter.",
  "- blade_explain expands any BLxxxx code from a diagnostic. Blade's refusals are deliberate — fix the declaration rather than casting around the error.",
  "- blade_corpus_find answers 'how do I write X in Blade' (pass its intent argument) with the construct to use and real files demonstrating it. Use it before writing something loop-shaped.",
  "- blade_eval runs source in a persistent session. Only a trailing bare expression is echoed; declarations are silent. Plots come back as images.",
  "- blade_symbols looks a name up (type, definition, uses). blade_doctor reports toolchain health and re-probes the compiler after you fix or rebuild it.",
  "",
  "Spans are 1-based with an exclusive endCol. If a compiler-backed tool reports the compiler unavailable, run blade_doctor.",
].join("\n");

/**
 * Load the MCP SDK. Prefers require(); falls back to dynamic import() so an
 * ESM-only SDK build cannot block a CommonJS server (import() works from CJS
 * on every Node this package supports). This is the ONLY place the SDK is
 * loaded.
 */
async function loadSdk() {
  const serverPath = "@modelcontextprotocol/sdk/server/index.js";
  const stdioPath = "@modelcontextprotocol/sdk/server/stdio.js";
  const typesPath = "@modelcontextprotocol/sdk/types.js";
  try {
    return {
      Server: require(serverPath).Server,
      StdioServerTransport: require(stdioPath).StdioServerTransport,
      types: require(typesPath),
      interop: "require",
    };
  } catch (requireErr) {
    const [srv, stdio, types] = await Promise.all([import(serverPath), import(stdioPath), import(typesPath)]);
    return {
      Server: srv.Server,
      StdioServerTransport: stdio.StdioServerTransport,
      types: types.default && types.default.CallToolRequestSchema ? types.default : types,
      interop: "import",
      requireError: requireErr.message,
    };
  }
}

const TOOLS = [
  {
    name: "blade_check",
    description:
      "Typecheck Blade source and return its diagnostics (errors and warnings, each with its registry title and phase), bindings, loaded provider stores, and deduced facts. Pass `file`, `source`, or both (both = check unsaved text at that path); bare `source` is checked inline at a synthetic path and never written to disk. Spans are 1-based with an EXCLUSIVE endCol. Each binding reports its kind as written (let, let mut, static, function, static function, param), its declaration line, its type (plus the monomorphized concreteType at tier full) and, when present, its declared `where` clauses, the symmetry the compiler DEDUCED (`deducedComm`), and provider provenance (`providerRead` / `providerWrite`). A function's type is its one-line signature, parameter defaults included. `providers` lists each `alias.load(...)` store with its index types, dims and variables. A check typechecks and (at tier full) lowers the program; it does NOT run code generation, so a construct only the C++ backend refuses (BL7xxx) still checks clean — and blade_eval's interpreter runs it too; only compiling the program (`blade emit` / `blade run` on the command line) reports it. Output is trimmed for agents: the span-heavy references/calls/kernels tables are counted in `stats` but omitted unless you pass raw:true, and at most 300 bindings are listed. Diagnostic codes (BLxxxx) can be expanded with blade_explain.",
    inputSchema: schemas.bladeCheck,
    annotations: { title: "Typecheck Blade source", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    handler: checks.bladeCheck,
  },
  {
    name: "blade_eval",
    description:
      "Evaluate Blade source in a persistent REPL session. A submission shows only its RETURN VALUE: declarations and reassignments run silently, and `bindings` holds at most one entry — the final statement when it is a bare expression (its `name` is empty), with its type and printed value. So to see a value, END THE SOURCE WITH AN EXPRESSION, e.g. the name you just bound. Array values are elided after the first five entries per level; index or reduce to inspect more. Definitions accumulate across calls sharing a `session` key (append, or rebind-in-place by top-level name). A rejected or panicking submission (`kept: false`) leaves the session unchanged and says why in `diagnostics` — the same shape blade_check reports, and it covers runtime panics such as BL8006 (index out of bounds) and BL8013 (integer division by zero); a message prefixed 'elsewhere in session:' comes from an earlier cell. Plots come back as real PNG images (rendered through GR, sized with `plotWidth`/`plotHeight`) whenever a GR runtime is available; without one they degrade to the figure's JSON and `plotRenderNote` says why. Plots from earlier cells are not re-sent unless they changed (`displayFramesUnchanged` counts them). The interpreter lane is fast; inputs it cannot run fall back to a g++ lane, hence the generous default timeout — an eval that exceeds it kills the compiler process and loses every session (the failed call says `sessionsLost`, and a session's next eval says `sessionRestarted`).",
    inputSchema: schemas.bladeEval,
    // Not read-only: it changes the session, and the program itself may write
    // files (a provider `write`), which is why it is also marked destructive.
    annotations: { title: "Evaluate Blade in a session", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: sessions.bladeEval,
  },
  {
    name: "blade_reset_session",
    description: "Discard a blade_eval session's accumulated bindings (Restart Kernel). The next eval in that session starts empty.",
    inputSchema: schemas.bladeResetSession,
    annotations: { title: "Reset a Blade session", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    handler: sessions.bladeResetSession,
  },
  {
    name: "blade_symbols",
    description:
      "Look up Blade symbols BY NAME in a file or snippet: definition span (the name token), type (and concrete type at tier full), declared `where` clauses and deduced symmetry for functions, provider provenance, its doc comment, use count, and use spans. Merges the compiler's binder table with its reference table, so shadowed names (a parameter `a` in three functions) come back as separate entries, each with its own type; lambda parameters and named types appear too, without a type. `kind` is the reference class (value, function, param, local, type) and `bindingKind` the source spelling where it says more (let, let mut, static, static function); the `kind` filter accepts either, and `name` matches exactly, then as a case-insensitive substring. Not covered, because the compiler's tables do not record them: uses of named types (their useCount is always 0), units, import aliases and imported names, and a `let` inside a block expression. A listing is capped (100 symbols; 50 use spans per symbol, 300 per response) while the counts stay exact — a `name` lookup is the way to see everything about one symbol.",
    inputSchema: schemas.bladeSymbols,
    annotations: { title: "Look up Blade symbols", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    handler: nav.bladeSymbols,
  },
  {
    name: "blade_doctor",
    description:
      "Report the Blade toolchain's health: `blade doctor --json` (.NET, which stdlib root answers, g++/OpenMP, BLAS/LAPACK, NetCDF, MPI, CUDA, clang/LLVM, ...) with the rows needing attention lifted into `toolchainIssues`, plus which compiler binary this server resolved and how, whether `ide serve` answers, the protocol version, whether a GR runtime was found (which is what makes blade_eval return plots as images), and any skew between the binary and the language surface this server was packaged with — by version and, because the version string rarely moves, by comparing the actual names (`surfaceDrift`). Works even when the compiler is missing or broken — that is what it is for — and it re-probes `ide serve`, so run it after building or fixing the compiler.",
    inputSchema: schemas.bladeDoctor,
    annotations: { title: "Blade toolchain health", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    handler: compiler.bladeDoctor,
  },
  {
    name: "blade_explain",
    description:
      "Explain a Blade diagnostic code (BLxxxx): its title and compiler phase, a curated explanation and fix when one exists, and real corpus files that pin this diagnosis (error, warning or runtime abort). Blade's refusals are a feature — they reject a plausible-but-wrong fast path — so the fix is almost always to correct a declaration, not to cast around the error.",
    inputSchema: schemas.bladeExplain,
    annotations: { title: "Explain a Blade diagnostic", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    handler: knowledge.bladeExplain,
  },
  {
    name: "blade_corpus_find",
    description:
      "Find idiomatic Blade. `intent` (\"running state\", \"filter rows\", \"sliding window\") is the one to reach for when you know WHAT you want to write but not HOW — it scores a curated idiom index that names the right construct and the files demonstrating it, falling through to a content search. Also supports `query` (grep), `category` (a corpus directory), and `code` (files pinning a BLxxxx). With no arguments it lists every category with live file counts.",
    inputSchema: schemas.bladeCorpusFind,
    annotations: { title: "Find idiomatic Blade", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    handler: corpus.bladeCorpusFind,
  },
];

function publicTool(tool) {
  const out = { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
  if (tool.annotations) out.annotations = tool.annotations;
  return out;
}

/** Every tool call funnels through here so a throw becomes an isError result. */
async function dispatchTool(name, args, ctx) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return compiler.toolError(`unknown tool: ${name}`, { availableTools: TOOLS.map((t) => t.name) });
  }
  // The low-level Server does not check arguments against inputSchema, so a
  // typo'd name or a string where a number belongs would otherwise reach the
  // handler and be silently ignored or silently defaulted.
  const problems = schemas.validate(tool.inputSchema, args);
  if (problems.length) {
    return compiler.toolError(`${name}: invalid arguments — ${problems.join("; ")}`, {
      invalidArguments: problems,
      accepted: Object.keys((tool.inputSchema && tool.inputSchema.properties) || {}),
    });
  }
  try {
    return await tool.handler(args || {}, ctx);
  } catch (e) {
    if (e && e.userFacing) return compiler.toolError(e.message, e.details);
    ctx.log(`${name} threw: ${e && e.stack ? e.stack : String(e)}`);
    return compiler.toolError(`${name} failed: ${e && e.message ? e.message : String(e)}`);
  }
}

/** Build (but do not connect) the MCP server for a context. */
async function createServer(ctx) {
  const sdk = await loadSdk();
  const { Server, types } = sdk;
  const server = new Server(SERVER_INFO, { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS });

  server.setRequestHandler(types.ListToolsRequestSchema, async () => ({ tools: TOOLS.map(publicTool) }));

  server.setRequestHandler(types.CallToolRequestSchema, async (request) =>
    dispatchTool(request.params.name, request.params.arguments || {}, ctx)
  );

  // The resource list is shorter without a Blade checkout (docs/ is repo-only);
  // the capability itself is always declared so clients need not re-negotiate.
  server.setRequestHandler(types.ListResourcesRequestSchema, async () => ({ resources: resources.list(ctx) }));

  server.setRequestHandler(types.ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    try {
      return await resources.read(uri, ctx);
    } catch (e) {
      // Every way a read fails is "this server cannot give you that resource"
      // — an unknown or unsupported URI, or a doc whose checkout is absent —
      // so answer with the code that says so, keeping the handler's message.
      if (e && typeof e.code === "number") throw e;
      const McpError = types.McpError;
      const message = e && e.message ? e.message : String(e);
      if (typeof McpError === "function") throw new McpError(RESOURCE_NOT_FOUND, message, { uri });
      const err = new Error(message);
      err.code = RESOURCE_NOT_FOUND;
      err.data = { uri };
      throw err;
    }
  });

  return { server, sdk };
}

module.exports = { SERVER_INFO, INSTRUCTIONS, RESOURCE_NOT_FOUND, TOOLS, publicTool, dispatchTool, createServer, loadSdk };

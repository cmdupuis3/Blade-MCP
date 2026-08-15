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

const SERVER_INFO = { name: "blade-mcp", version: "0.1.0" };

/**
 * Load the MCP SDK. Prefers require(); falls back to dynamic import() so an
 * ESM-only SDK build cannot block a CommonJS server (Node >=18 supports
 * import() from CJS). This is the ONLY place the SDK is loaded.
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
      "Typecheck Blade source and return its diagnostics, bindings, and deduced facts. Pass `file`, `source`, or both (both = check unsaved text at that path); bare `source` is checked inline at a synthetic path and never written to disk. Spans are 1-based with an EXCLUSIVE endCol. Output is trimmed for agents: the span-heavy references/calls/kernels/providers tables are omitted unless you pass raw:true. Diagnostic codes (BLxxxx) can be expanded with blade_explain.",
    inputSchema: schemas.bladeCheck,
    handler: checks.bladeCheck,
  },
  {
    name: "blade_eval",
    description:
      "Evaluate Blade source in a persistent REPL session and return its output, bindings with values, and any plots as image content. Bindings accumulate across calls sharing a `session` key (append, or rebind-in-place by top-level name). The interpreter lane is fast; a fallback lane invokes g++, hence the generous default timeout.",
    inputSchema: schemas.bladeEval,
    handler: sessions.bladeEval,
  },
  {
    name: "blade_reset_session",
    description: "Discard a blade_eval session's accumulated bindings (Restart Kernel). The next eval in that session starts empty.",
    inputSchema: schemas.bladeResetSession,
    handler: sessions.bladeResetSession,
  },
  {
    name: "blade_symbols",
    description:
      "Look up Blade symbols BY NAME in a file or snippet: definition span, type (and concrete type at tier full), use count, and every use span. Merges the compiler's binder table with its reference table. Filter with `name` (exact, then case-insensitive substring) and/or `kind`.",
    inputSchema: schemas.bladeSymbols,
    handler: nav.bladeSymbols,
  },
  {
    name: "blade_doctor",
    description:
      "Report the Blade toolchain's health: `blade doctor --json` (g++, BLAS/LAPACK, NetCDF, MPI, CUDA, ...) plus which compiler binary this server resolved and how, whether `ide serve` answers, the protocol version, and any skew between the binary's version and the language surface this server was built against. Works even when the compiler is missing or broken — that is what it is for.",
    inputSchema: schemas.bladeDoctor,
    handler: compiler.bladeDoctor,
  },
];

function publicTool(tool) {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

/** Every tool call funnels through here so a throw becomes an isError result. */
async function dispatchTool(name, args, ctx) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return compiler.toolError(`unknown tool: ${name}`, { availableTools: TOOLS.map((t) => t.name) });
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
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(types.ListToolsRequestSchema, async () => ({ tools: TOOLS.map(publicTool) }));

  server.setRequestHandler(types.CallToolRequestSchema, async (request) =>
    dispatchTool(request.params.name, request.params.arguments || {}, ctx)
  );

  return { server, sdk };
}

module.exports = { SERVER_INFO, TOOLS, publicTool, dispatchTool, createServer, loadSdk };

#!/usr/bin/env node
"use strict";

// blade-mcp entry point: argv -> context -> stdio transport -> shutdown wiring.
//
// STDOUT BELONGS TO THE MCP TRANSPORT. Every diagnostic line in this process
// goes to stderr; a single console.log would corrupt the JSON-RPC stream.

const compiler = require("./compiler");
const { createServer } = require("./server");

const USAGE = `blade-mcp — MCP stdio server for the Blade language

Usage: blade-mcp [--compiler <path to Blade.exe>]

Environment:
  BLADE_EXE         compiler binary (used when --compiler is absent)
  BLADE_REPO        Blade checkout root (enables blade-docs:// resources)
  BLADE_CORPUS_DIR  tests/corpus root override
`;

function parseArgv(argv) {
  const out = { compilerPath: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--compiler" || a === "-c") {
      out.compilerPath = argv[++i];
    } else if (a.startsWith("--compiler=")) {
      out.compilerPath = a.slice("--compiler=".length);
    } else if (a === "--help" || a === "-h") {
      out.help = true;
    }
  }
  return out;
}

function log(line) {
  process.stderr.write(`[blade-mcp] ${line}\n`);
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  if (opts.help) {
    process.stderr.write(USAGE);
    process.exit(0);
  }

  const ctx = compiler.createContext({ compilerPath: opts.compilerPath, cwd: process.cwd(), env: process.env, log });
  const { server, sdk } = await createServer(ctx);
  const transport = new sdk.StdioServerTransport();

  let shuttingDown = false;
  function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down (${reason})`);
    try {
      ctx.dispose();
    } catch (e) {
      log(`dispose failed: ${e && e.message}`);
    }
    try {
      server.close();
    } catch (_) {
      /* already closed */
    }
    process.exit(0);
  }

  transport.onclose = () => shutdown("transport closed");
  process.stdin.on("end", () => shutdown("stdin ended"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await server.connect(transport);
  log(`ready (sdk interop=${sdk.interop}, compiler=${ctx.resolved().exe} [${ctx.resolved().origin}])`);
}

main().catch((e) => {
  process.stderr.write(`[blade-mcp] fatal: ${e && e.stack ? e.stack : String(e)}\n`);
  process.exit(1);
});

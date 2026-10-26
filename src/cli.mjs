#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.mjs';
try { await createServer().connect(new StdioServerTransport()); }
catch { console.error('Council Network MCP could not start. Check the runtime and profile configuration.'); process.exitCode = 1; }

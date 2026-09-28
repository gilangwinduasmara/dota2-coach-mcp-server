#!/usr/bin/env node
'use strict';

/**
 * Dota 2 Coach MCP server.
 *
 * Exposes `analyze_dota2_match` — fetches a match from OpenDota, caches it,
 * and returns the coaching-report-ready JSON summary from ./lib/analyze.js.
 * This is the server deployed at https://dota2-coach.promager.com/mcp, which
 * the dota2-coach Claude Code plugin (a separate repo) points its plugin.json
 * `mcpServers` entry at as a remote HTTP server.
 *
 * Two transports, picked by CLI flag:
 *   node server.js            stdio   (local dev / Claude Desktop, if you want a local server)
 *   node server.js --http     Streamable HTTP on PORT (default 8787) (what's deployed in production)
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { analyzeMatch, AnalyzeError } = require('./lib/analyze');

function createServer() {
  const server = new McpServer({ name: 'dota2-coach', version: '1.0.0' });

  server.registerTool(
    'analyze_dota2_match',
    {
      title: 'Analyze Dota 2 match',
      description:
        'Fetch a public Dota 2 match from OpenDota and return a coaching-report-ready JSON summary: ' +
        'result, draft, per-player stats and benchmark percentiles vs. their rank bracket, objectives/' +
        'teamfight timelines, rank medal, and (with `player`) a deep-dive on one participant (lane ' +
        'efficiency, deaths log, skill build, damage sources, rune control, item/ability usage counts, ' +
        'item timing, gold/xp/net-worth timelines). Use the returned JSON to write the actual coaching ' +
        'analysis yourself — this tool only extracts and translates data, it does not generate advice.',
      inputSchema: {
        match_id: z
          .union([z.string(), z.number()])
          .describe('Numeric Dota 2 match id, e.g. from a Dotabuff/OpenDota/Stratz URL like .../matches/7891234567'),
        player: z
          .string()
          .optional()
          .describe(
            'Focus the deep-dive section on one participant: account_id (exact), personaname (substring, ' +
              'case-insensitive), or hero localized name (substring, case-insensitive). Always pass this ' +
              'when the user asks about their own performance rather than a general match recap. If ' +
              'ambiguous or no match, the tool errors and lists the actual participants — retry with a ' +
              'more specific value (account_id is always unambiguous).'
          ),
        refresh: z.boolean().optional().describe('Bypass the local cache and re-fetch from OpenDota (e.g. the match was reparsed).'),
        no_wait: z
          .boolean()
          .optional()
          .describe("Don't request/wait for a full parse if the match is unparsed; analyze whatever basic data is available."),
      },
    },
    async ({ match_id, player, refresh, no_wait }) => {
      try {
        const summary = await analyzeMatch({
          matchId: match_id,
          player,
          refresh,
          noWait: no_wait,
        });
        return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
      } catch (err) {
        const message = err instanceof AnalyzeError ? err.message : `Error: ${err.message}`;
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    }
  );

  return server;
}

async function runStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function runHttp() {
  const express = require('express');
  const path = require('path');
  const app = express();

  // Landing page at the root, so the domain isn't a bare 404 for anyone who
  // visits it directly; the MCP endpoint itself stays at /mcp below.
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

  app.use(express.json());

  const port = Number(process.env.PORT) || 8787;

  // Stateless mode (the SDK's own recommended pattern for simple tool-calling
  // servers like this one): a fresh server+transport per request, no session
  // bookkeeping. `analyze_dota2_match` is a single self-contained call every
  // time, so there's no cross-request state to preserve, and no session-id
  // Map that can go stale across restarts or multi-instance deploys.
  app.post('/mcp', async (req, res) => {
    try {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('Error handling MCP request:', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  const methodNotAllowed = (req, res) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  app.listen(port, () => {
    console.error(`Dota 2 Coach MCP server listening on http://localhost:${port}/mcp`);
    console.error('Expose this publicly over HTTPS (e.g. via a reverse proxy or tunnel) to add it as a claude.ai custom connector.');
  });
}

const useHttp = process.argv.includes('--http');
(useHttp ? runHttp() : runStdio()).catch((err) => {
  console.error(err);
  process.exit(1);
});

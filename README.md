# dota2-coach-mcp-server

The MCP server behind the [dota2-coach](https://github.com/gilangwinduasmara/dota2-coach)
Claude Code plugin. Exposes one tool, `analyze_dota2_match`, that fetches a
public Dota 2 match from OpenDota and returns a coaching-report-ready JSON
summary (laning, farming, deaths, itemization, objectives, teamfights,
benchmark percentiles, skill build, damage sources, rune control).

This repo is deployed at `https://dota2-coach.promager.com/mcp`, which the
plugin's `.claude-plugin/plugin.json` points to as a remote HTTP MCP server.
Installing the plugin does **not** run any of this code locally — it just
connects to wherever this is deployed.

Inputs: `match_id` (required), `player` (account_id, personaname substring,
or hero name substring, for a deep-dive on one participant), `refresh`
(bypass cache), `no_wait` (don't wait for OpenDota to parse an unparsed
match).

## Deploy (production)

```
npm install
PORT=8787 npm run start:http
```

Then put it behind a reverse proxy that terminates TLS and forwards to that
port, e.g. an Nginx or Caddy config for `dota2-coach.promager.com` proxying
to `http://127.0.0.1:8787`. Keep the process alive across reboots/crashes
with systemd or pm2, for example:

```
pm2 start server.js --name dota2-coach-mcp -- --http
pm2 save
```

Set `DOTA2_COACH_CACHE_DIR` to a persistent path (survives restarts/deploys)
if you don't want to re-fetch/re-parse matches on every redeploy; it
defaults to `./cache` next to this file otherwise.

No auth is implemented; anyone who has the URL can call the tool. That's a
reasonable default since it only proxies OpenDota's own public, free API and
holds no secrets, but consider adding an API key check (via `headers` in the
plugin's `mcpServers` config, once needed) if this ever needs to be locked
down.

## Local dev / stdio

```
npm install
npm start          # stdio, for local testing or a Claude Desktop mcpServers entry
```

## Repo layout

- `server.js`, two transports picked by CLI flag: default stdio, `--http`
  for Streamable HTTP (what's actually deployed).
- `lib/` — the OpenDota fetch/cache/summarize logic. `lib/analyze.js` is the
  entry point; see its interpretation notes cross-referenced in the plugin
  repo's `SKILL.md` for what each output field means.

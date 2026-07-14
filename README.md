# mcp-server-atlassian-jira (UFC fork)

Private UFC fork of
[`aashari/mcp-server-atlassian-jira`](https://github.com/aashari/mcp-server-atlassian-jira)
(forked at upstream commit `aab8b7f2`, one commit past `v3.3.0`), carrying:

1. **Binary response corruption fix** - upstream's `fetchAtlassian()`
   (`src/utils/transport.util.ts`) read *every* response body via
   `response.text()`; for binary endpoints (attachment content, thumbnails,
   exports) that is a lossy, irreversible UTF-8 decode. Fixed: non-JSON/text/XML
   bodies are read via `arrayBuffer()` and returned as
   `{ __binary: true, contentType, byteLength, base64 }`. Covered by
   regression tests in `src/utils/transport.util.test.ts`.
2. **Ported upstream community PR #173** (author `cedral`) -
   `jira_attach` (multipart upload) and
   `jira_get_attachment` (byte-exact download to a local file).
3. **`DOTENV_CONFIG_PATH` with `~`-expansion** in
   `src/utils/config.util.ts@loadFromEnvFile`, plus `USE_DOTENV` toggle -
   credentials live in a per-user file outside any repo/package tree
   (team convention: `~/.claude/jira.env`).
4. **Unconditional `main()`** in `src/index.ts` (the upstream
   `require.main === module` guard broke startup under embedded Node runtimes).
5. **`node:https` transport fallback** (`safeFetch` in
   `src/utils/transport.util.ts`) - in some MCP host processes the global
   `fetch` (undici) fails with `TypeError: fetch failed` despite a live
   network (observed 2026-07-14 in a Claude-Code-session-spawned connector
   instance, while a Desktop-spawned instance on the same machine was fine).
   On that failure the request is retried through the classic `node:https`
   stack (multipart encoded via `new Response(FormData)`, redirects followed
   with `Authorization` dropped cross-host). `FORCE_HTTPS_FALLBACK=true`
   forces the fallback path (diagnostics / emergency lever). Verified live:
   JSON GET, JQL search, and a byte-exact 2.1 MB binary download through the
   media-CDN redirect.

Full background and verification evidence:
`tools/jira-mcp-plugin/README.md` in the `1C_Workspace` repo.

## How this repo is consumed

This repo exists as a **standalone git package** so that `npx` can install it
directly (npx cannot install from a monorepo subdirectory). The
`jira@ufc-1c` Claude Code plugin (marketplace `arcankostenko/1C_Workspace`)
declares:

```json
"command": "npx",
"args": ["-y", "github:asky74/mcp-server-atlassian-jira#v3.3.0-ufc.2"]
```

On first start npm clones this repo (using your system `git` - your existing
GitHub credentials cover the private access), installs devDependencies, and
the `prepare` script compiles TypeScript into `dist/`. Subsequent starts run
from the npx cache. No manual `npm install` step.

**Releases are tags** (`v<upstream>-ufc.<n>`, e.g. `v3.3.0-ufc.1`). To ship an
update: commit, tag, push the tag, then bump the tag in the plugin's
`.mcp.json`.

Local working-clone convention: `1C_Workspace/mcp-servers/mcp-server-atlassian-jira/`
- an inner repo like `BAS_KUP_local/` (own `.git`/origin, not tracked by the
monorepo's whitelist `.gitignore`).

Credentials: `~/.claude/jira.env` with `ATLASSIAN_SITE_NAME`,
`ATLASSIAN_USER_EMAIL`, `ATLASSIAN_API_TOKEN` (see `.env.example`). Never
commit credentials here.

## Development

```bash
npm install        # also builds (prepare -> tsc)
npm test           # 6 suites / 61 tests
```

`manifest.json` + `.mcpbignore` here build the optional Claude Desktop MCPB
bundle (`npx @anthropic-ai/mcpb pack .`) - a personal, per-machine option.
The 2026-07-13 "built-in-node `fetch` blocker" is **not reproducible on
current Desktop** (>=1.20186, Electron 42.5.1 / node 24.17): a probe script
run inside the real MCP runtime on 2026-07-14 got HTTP 200 from both undici
`fetch` and classic `https.get`, and the packed bundle works with the stock
`command: "node"` - no `node.exe` workaround needed. `.mcpbignore` caveat:
patterns are gitignore-style, keep them **anchored** (`/src/`, not `src/`) -
an unanchored `src/` strips `node_modules/*/src` and breaks the bundle.

## Licensing

Upstream declares `"license": "ISC"` in `package.json` but ships no LICENSE
file. This fork keeps the declared license and upstream attribution
(original work: Andi Ashari; attachment tools: `cedral`, PR #173).

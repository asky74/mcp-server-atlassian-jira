# mcp-server-atlassian-jira (UFC fork)

Private UFC fork of
[`aashari/mcp-server-atlassian-jira`](https://github.com/aashari/mcp-server-atlassian-jira)
(forked at upstream commit `aab8b7f2`, one commit past `v3.3.0`), carrying:

1. **Binary response corruption fix** — upstream's `fetchAtlassian()`
   (`src/utils/transport.util.ts`) read *every* response body via
   `response.text()`; for binary endpoints (attachment content, thumbnails,
   exports) that is a lossy, irreversible UTF-8 decode. Fixed: non-JSON/text/XML
   bodies are read via `arrayBuffer()` and returned as
   `{ __binary: true, contentType, byteLength, base64 }`. Covered by
   regression tests in `src/utils/transport.util.test.ts`.
2. **Ported community [PR #173](https://github.com/aashari/mcp-server-atlassian-jira/pull/173)**
   (author `cedral`) — `jira_attach` (multipart upload) and
   `jira_get_attachment` (byte-exact download to a local file).
3. **`DOTENV_CONFIG_PATH` with `~`-expansion** in
   `src/utils/config.util.ts@loadFromEnvFile`, plus `USE_DOTENV` toggle —
   credentials live in a per-user file outside any repo/package tree
   (team convention: `~/.claude/jira.env`).
4. **Unconditional `main()`** in `src/index.ts` (the upstream
   `require.main === module` guard broke startup under embedded Node runtimes).

Full background, verification evidence, and team positioning (this server —
name `jira` — complements, does not replace, `sooperset/mcp-atlassian`):
`tools/jira-mcp-plugin/README.md` in the `1C_Workspace` repo.

## How this repo is consumed

This repo exists as a **standalone git package** so that `npx` can install it
directly (npx cannot install from a monorepo subdirectory). The
`jira@ufc-1c` Claude Code plugin (marketplace `arcankostenko/1C_Workspace`)
declares:

```json
"command": "npx",
"args": ["-y", "github:arcankostenko/mcp-server-atlassian-jira#v3.3.0-ufc.1"]
```

On first start npm clones this repo (using your system `git` — your existing
GitHub credentials cover the private access), installs devDependencies, and
the `prepare` script compiles TypeScript into `dist/`. Subsequent starts run
from the npx cache. No manual `npm install` step.

**Releases are tags** (`v<upstream>-ufc.<n>`, e.g. `v3.3.0-ufc.1`). To ship an
update: commit, tag, push the tag, then bump the tag in the plugin's
`.mcp.json`.

Local working-clone convention: `1C_Workspace/mcp-servers/mcp-server-atlassian-jira/`
— an inner repo like `BAS_KUP_local/` (own `.git`/origin, not tracked by the
monorepo's whitelist `.gitignore`).

Credentials: `~/.claude/jira.env` with `ATLASSIAN_SITE_NAME`,
`ATLASSIAN_USER_EMAIL`, `ATLASSIAN_API_TOKEN` (see `.env.example`). Never
commit credentials here.

## Development

```bash
npm install        # also builds (prepare → tsc)
npm test           # 6 suites / 61 tests
```

`manifest.json` + `.mcpbignore` here build the optional Claude Desktop MCPB
bundle (`npx @anthropic-ai/mcpb pack .`) — a personal, per-machine option
with a known built-in-node `fetch` blocker; see the plugin README.

## Licensing

Upstream declares `"license": "ISC"` in `package.json` but ships no LICENSE
file. This fork keeps the declared license and upstream attribution
(original work: Andi Ashari / `aashari`; attachment tools: `cedral`, PR #173).

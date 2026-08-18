# dsh-enhanced-plugins

English | [中文](README.zh.md)

One installable DeepSeek Harness bundle containing four enhanced capabilities:

- **MCP server manager** — a Settings → Plugins card for stdio and Streamable HTTP servers, revision-fenced edits, secret-masked reads, and one-click Claude Code/Codex import.
- **Plugin market** — a local-snapshot-backed DSH plugin catalog with verified GitHub/npm install sources, installation records, background channel sync, and credential-backed GitHub Token management.
- **Referenced files** — type # in the composer to search the current workspace and inject a bounded UTF-8 file snapshot into the next model request.
- **Product subagent toggles** — persistent Web switches for the official Claude Code and Codex subagent providers, with live tool registration.

The four features keep independent Host, Client, Remote, Settings, and Consumer lifecycles. They share only one package manifest, one bundle patch, and one lazy-CJS browser bundle.

## Requirements

- DeepSeek Harness compatible with the local target checkout at commit 47f943859bef60e4160492346772ded9b24f765a (0.1.0-rc.5 public ABI).
- Node.js 22.19 or newer.
- A Web profile for browser surfaces. Host features that do not require Web continue to follow their own injected-service availability.

Official DSH packages remain peer dependencies and are supplied by the Harness deployment. The package does not copy or patch DSH core.

## Install

Remove separately installed copies first so their old bundle layers do not leave duplicate Client anchors:

~~~sh
dsh plugin --profile web remove dsh-mcp-server-manager dsh-plugin-market dsh-referenced-file dsh-sub-agent-toggle
dsh plugin --profile web add /path/to/dsh-enhanced-plugins
dsh --profile web --dump-config
dsh web
~~~

From a DSH source checkout, prefix the commands with pnpm. Directory and Git installs run the package's prepare script to build every runtime entry. A packed tarball already contains lib:

~~~sh
npm pack
dsh plugin --profile web add ./dsh-enhanced-plugins-0.1.0.tgz
~~~

If pnpm asks for build authorization during a Git install, allow exactly dsh-enhanced-plugins in that profile's pnpm-workspace.yaml and retry.

## Bundle entries

The package contributes stable Loader ids:

| Id | Package entry | Responsibility |
| --- | --- | --- |
| plugin-market | dsh-enhanced-plugins/plugin-market | Marketplace Host routes, catalog, credentials, install/sync |
| mcp-manager | dsh-enhanced-plugins/mcp-server-manager | mcp Settings owner, reconciliation, and Remote |
| referenced-file | dsh-enhanced-plugins/referenced-file | Workspace search and model-context injection |
| subagent-codex | official DSH provider | Codex subagent transport |
| subagent-claude-code | official DSH provider | Claude Code subagent transport |
| subagent-product-toggles | dsh-enhanced-plugins/sub-agent/host | subagent-products Settings owner and Remote |
| subagent-product-toggle-tools | dsh-enhanced-plugins/sub-agent/preset | Live controlled tool Consumers |
| ui-enhanced-plugins | dsh-enhanced-plugins | Single Client-module discovery anchor |

The root entry is deliberately a no-op Host plugin. Browser code mounts each feature as its own child fiber, so missing optional surfaces do not merge their lifecycle or state.

## Configuration

### Plugin market

The plugin-market row in cordis.patch.yml defines:

- profile: target profile for install/remove, default web.
- topic: GitHub discovery topic, default dsh-plugin.
- pageSize: catalog page size, default 12.
- operationTimeoutMs: install/remove timeout, default 120000.
- githubTokenEnv: credential reference, default GITHUB_TOKEN.
- cliPath: optional absolute dsh executable; empty reuses the current Node launcher.

The built-in assets/plugins-cache.json is read-only. A verified synchronized cache and install records live below the DSH home plugin-market data directory. Token values are handled only through ctx.credentials and are never returned to the browser.

### MCP servers

The mcp-manager registers the mcp namespace. Its Web card supports add/remove, import, format auditing, and masked env/header values. The Host owns validation and reconciles each configured server as an independent child fiber. Existing secret-bearing definitions are never rebuilt from a redacted browser snapshot.

### Referenced files

The referenced-file Host schema defaults are:

| Field | Default |
| --- | ---: |
| maxCandidates | 20 |
| maxScannedEntries | 5000 |
| maxDepth | 12 |
| maxReferences | 8 |
| maxFileBytes | 131072 |
| maxTotalBytes | 524288 |
| indexTtlMs | 30000 |
| maxCachedWorkspaces | 8 |

Candidate traversal excludes common generated directories. Every selected path is resolved and containment-checked again at submission. Binary, invalid UTF-8, oversized, non-regular, and outside-workspace files are rejected.

### Product subagents

Both claudeCode and codex default to false in the subagent-products namespace. Toggling a product path-writes only that boolean under revision fencing. The Consumer then mounts or disposes the corresponding official dsh-tool-subagent plugin without restarting the profile.

To scope these tools to selected Agent presets, disable/remove the root subagent-product-toggle-tools row and mount dsh-enhanced-plugins/sub-agent/preset only in those preset compositions. Do not mount both layouts in the same scope.

## Development

The fixed sibling checkout required by this repository's rules is:

~~~text
D:\work\workspace\github\deepseek-harness
~~~

Type checking reads its current public declarations; runtime builds import only public package names and remain self-contained:

~~~sh
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
~~~

The browser bundle uses CSS Modules and only DSH semantic --dsw-alias-* theme tokens. It therefore follows light, dark, and system appearance without feature-owned theme branches.

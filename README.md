# dsh-enhanced-plugins

English | [中文](README.zh.md)

One installable DeepSeek Harness bundle containing five enhanced capabilities:

- **MCP server manager** — a Settings → Plugins card for stdio and Streamable HTTP servers, revision-fenced edits, secret-masked reads, and one-click Claude Code/Codex import.
- **pi-ai model request types** — a Settings → Plugins card that declares configured models as provider-default, text-only, or text-and-image without patching the built-in Models page.
- **Plugin market** — a local-snapshot-backed DSH plugin catalog with verified GitHub/npm install sources, installation records, background channel sync, and credential-backed GitHub Token management.
- **Referenced files** — type # in the composer to search the current workspace and inject a bounded UTF-8 file snapshot into the next model request.
- **Product subagent toggles** — persistent Web switches for the official Claude Code and Codex subagent providers, with live tool registration.

Each feature keeps its own applicable Host, Client, Remote, Settings, and Consumer lifecycle. They share only one package manifest, one bundle patch, and one lazy-CJS browser bundle.

## Requirements

- DeepSeek Harness compatible with the local target checkout at commit 47f943859bef60e4160492346772ded9b24f765a (0.1.0-rc.5 public ABI).
- Node.js 22.19 or newer.
- A Web profile for browser surfaces. Host features that do not require Web continue to follow their own injected-service availability.

Official DSH packages remain peer dependencies and are supplied by the Harness deployment. The package does not copy or patch DSH core.

## Install

### One-step migration on Windows 10/11

[`scripts/migrate-to-enhanced-plugin.ps1`](scripts/migrate-to-enhanced-plugin.ps1) supports the inbox Windows PowerShell 5.1 and does not require `pwsh` or PowerShell 7. It performs these steps in order:

1. Verify that the installation source manifest belongs to `dsh-enhanced-plugins`.
2. Resolve the target DSH runner and inspect the profile's direct dependencies.
3. Remove only legacy plugins that are still direct dependencies, safely skipping missing ones.
4. Install `dsh-enhanced-plugins` from the current checkout; its `prepare` lifecycle builds every runtime entry automatically.
5. Verify that the merged plugin is a direct dependency and no legacy dependency remains.

Preview the migration without changing the profile:

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\migrate-to-enhanced-plugin.ps1 -WhatIf
~~~

Then migrate the default `web` profile:

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\migrate-to-enhanced-plugin.ps1
~~~

Specify another profile and DSH checkout:

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\migrate-to-enhanced-plugin.ps1 `
  -Profile custom `
  -DshCheckout "E:\projects\deepseek-harness"
~~~

Script parameters:

| Parameter | Default | Purpose |
| --- | --- | --- |
| `-Profile` | `web` | DSH profile to migrate |
| `-DshCommand` | `dsh` | DSH executable name on PATH or an absolute executable path |
| `-DshCheckout` | automatic | Explicit DSH source checkout; runs its `pnpm dsh` command when set |
| `-PluginPath` | repository above this script | `dsh-enhanced-plugins` checkout to install |
| `-WhatIf` | off | Show the planned migration without removing or installing anything |
| `-Confirm` | off | Ask for interactive PowerShell confirmation before migration |

Without `-DshCheckout`, the script first uses `dsh` on PATH and then falls back to a `deepseek-harness` checkout beside this repository. `-ExecutionPolicy Bypass` applies only to this `powershell.exe` process and does not change the system policy. The `dsh-sub-agent` source repository is installed under its real package name, `dsh-sub-agent-toggle`, which the script uses.

Migration is complete only after the script prints `Migrated profile '<name>' to dsh-enhanced-plugins.` No manual `npm install`, `npm run build`, or `pnpm run build` is required afterward. Restart DSH once if it was already running.

### Manual install and packaging

Without the migration script, you can pack and install manually. Directory and Git installs run `prepare` to build every runtime entry; a tarball already contains `lib`:

~~~sh
npm pack
dsh plugin --profile web add ./dsh-enhanced-plugins-0.1.0.tgz
~~~

When running manual DSH commands from a DSH source checkout, prefix them with `pnpm`. If pnpm asks for build authorization during a Git install, allow exactly `dsh-enhanced-plugins` in that profile's `pnpm-workspace.yaml` and retry.

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

The root entry is deliberately a no-op Host plugin. Browser code mounts all five features as independent child fibers, so missing optional surfaces do not merge their lifecycle or state. The pi-ai request-type feature needs no additional Loader row: the existing Client discovery anchor owns its browser child, while the official adapter remains the sole owner of `llm-pi-ai`.

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

### pi-ai model request types

The `pi-ai model request types` card appears only while the official `llm-pi-ai` settings namespace is served. It lists model overrides already configured under `providers.<route>.models` and maps its choices as follows:

| Choice | Stored model field |
| --- | --- |
| Provider default | `input` is unset, preserving the installed catalog entry and then the route default |
| Text only | `input: [text]` |
| Text and images | `input: [text, image]` |

Each change uses the public `settings.mutate` API with the descriptor revision and writes only the selected route's complete `models` array, which is the adapter's array-replace field. Every unedited model object and its fields are retained. A conflict or failed write is followed by a fresh describe before another edit is allowed.

The card deliberately lives under Settings → Plugins because the shipped Models editor exposes no public child slot and Client bundle purity forbids importing its private React form. Add or remove model overrides on the Models page (or in `settings.yaml`), then set their request type in this card. Capability declarations are not endpoint probes: claiming image support allows durable image admission and `read_image`, but an endpoint that does not actually accept images can still reject the later provider request.

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

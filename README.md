# dsh-enhanced-plugins

[中文](README.zh.md) | English

An enhancement suite for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness): **seven independently installable Cordis bundles plus one Windows companion**.

- Does not modify DSH core; every Web feature uses public plugin extension points.
- Installs everything in one pass or keeps only the independently packaged features you select.
- Keeps Host, Web Client, and Windows Companion lifecycles and security boundaries separate.

[Features](#features) · [Quick start](#quick-start) · [Feature guide](#feature-guide) · [Compatibility and migration](#compatibility-and-migration) · [Configuration](#configuration) · [Development](#development-and-verification)

## Features

The installer only needs the stable “feature ID.” Every feature also has a self-contained selective package.

| Feature | Feature ID | Selective package | Platform and entry point | What it adds |
| --- | --- | --- | --- | --- |
| [Windows Launcher](#1-windows-launcher) | `windows-launcher` | `dsh-enhanced-windows-launcher` | Windows Start menu | Tray controls for Web, Headless, profiles, source builds, and diagnostics |
| [Desktop alerts and pet](#2-desktop-alerts-and-pet) | `notification` | `dsh-enhanced-notification` | Windows; Settings → Desktop Pet | Task sounds, a custom WAV library, and a native animated pet |
| [Plugin Community](#3-plugin-community) | `plugin-market` | `dsh-enhanced-plugin-market` | Web; Settings → Plugin Community | Search, safely preflight, install, and uninstall community plugins |
| [MCP server manager](#4-mcp-server-manager) | `mcp-server-manager` | `dsh-enhanced-mcp-server-manager` | Web; Settings → Plugins | Manage stdio / Streamable HTTP servers and import local configuration |
| [pi-ai model request types](#5-pi-ai-model-request-types) | `model-input-types` | `dsh-enhanced-model-input-types` | Web; Settings → Plugins | Declare whether a model accepts text-only or image requests |
| [Edit last message](#6-edit-last-message) | `edit-last-message` | `dsh-enhanced-edit-last-message` | Web; latest user message | Change that turn and regenerate in the same session |
| [Product subagents](#7-product-subagents) | `sub-agent` | `dsh-enhanced-sub-agent` | Web; Settings → Subagents | Enable or disable Claude Code / Codex tools in real time |
| [Official Team monitor](#8-official-team-monitor) | `agent-team-monitor` | `dsh-enhanced-agent-team-monitor` | Web; team icon on the current conversation composer | Role-grouped running/history child sessions, native details, Team dependencies and mailbox counts |

The historical aggregate package is `dsh-enhanced-plugins`. Launcher-managed installs now express “all” as every independent Profile package plus the required global Launcher, so any one Profile feature can later be removed without changing the others.

## Quick start

### Requirements

- Node.js 22.19.x, or Node.js 24 and later.
- A recent DSH Web profile that runs from source; see the [DSH Web UI quickstart](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart).
- This repository is verified against DSH [`0.1.2-rc.1`](https://github.com/deepseek-ai/deepseek-harness/tree/76fda729799fe9b3848dbe2c211d4b231032b81e), with local ABI baseline commit `76fda729799fe9b3848dbe2c211d4b231032b81e`.
- Windows Launcher, native sounds, and the desktop pet require a full Windows desktop edition with Windows PowerShell 5.1: Windows 10 version 1607 or later, or Windows 11. The required OS capabilities are the same on Home, Pro, Education / Pro Education, and Enterprise; Windows in S mode, IoT / reduced-footprint editions, and Windows 10 versions 1507 and 1511 are outside this baseline. Windows feature updates outside Microsoft's lifecycle are best-effort because the required Node.js toolchain does not guarantee end-of-life operating systems. The installer does not depend on a particular `tar.exe`. The remaining features are cross-platform.

> [!IMPORTANT]
> DSH remains a developer preview. If a DSH upgrade causes compatibility issues, check the verified version and commit above first.

> [!CAUTION]
> **Check the DSH/plugin repository layout before copying an install command:**
>
> - **Sibling-directory install:** both repositories share the **same parent directory**; use the commands below as written.
> - **Different-directory install:** the repositories have **different parent directories**; add `-DshCheckout "absolute path to the DSH source"` to the command.

### Install every feature

When both repositories share a parent directory, run this from the root of this repository:

```text
<workspace>/
├── deepseek-harness/
└── dsh-enhanced-plugins/
```

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\migrate-to-enhanced-plugin.ps1
```

Omitting `-Features`, or passing `-Features all`, installs the seven **independent** Cordis packages and the required Windows Launcher; it no longer uses the root aggregate package to represent “all.” The launcher is deployed to `%LOCALAPPDATA%\DeepSeekHarness\Launcher` and creates a Start menu shortcut. Add `-CreateLauncherDesktopShortcut` if you also want a desktop shortcut. Running the installer directly only installs or updates the program files; it does not start or open Launcher. An update initiated inside Launcher still performs the required version restart and readiness check.

If the DSH checkout is not a sibling, provide its location explicitly:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\migrate-to-enhanced-plugin.ps1 `
  -DshCheckout "E:\projects\deepseek-harness"
```

### Install selected features

List the stable feature IDs exposed by this version:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\migrate-to-enhanced-plugin.ps1 -ListFeatures
```

Then pass the final set you want to keep. For example, install desktop alerts, MCP management, and message editing only:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\migrate-to-enhanced-plugin.ps1 `
  -Features notification,mcp-server-manager,edit-last-message
```

Common combinations can replace the `-Features` value in that command:

| Goal | Feature set |
| --- | --- |
| Windows desktop experience | `windows-launcher,notification` |
| Agent and model enhancements | `mcp-server-manager,model-input-types,edit-last-message,sub-agent` |
| Plugin discovery and integration management | `plugin-market,mcp-server-manager` |

`-Features` is not an additive list. It describes the **final project feature set** that the target Profile should retain. Windows Launcher is a required global component: it is added by the backend, is not written in the list, and cannot be removed through feature selection. `-Features none` removes this project's Profile packages while keeping Launcher. The installer:

1. Installs dependencies and builds every selected feature.
2. Installs and verifies that every selected bundle or companion loads.
3. Only then removes the aggregate package, unselected sibling features, and declared legacy conflicts.
4. Detects and cleans up the retired file-reference plugin.

### Launcher plugin management

The source installer records the DSH checkout, this repository's source path, Git remote/ref, source revision, and each managed Profile's desired set in `%LOCALAPPDATA%\DeepSeekHarness\Launcher\install-state.json`. The control center's **Plugin Management** page then provides:

- a dynamic feature catalog generated from `packages/*/package.json`, so normal new features do not require Launcher changes;
- first-use default selection, per-Profile desired state, individual install/removal, and aggregate-package migration;
- a safe Git `fetch` with backoff retries, switching retries to HTTP/1.1 after a connection reset and then using only a local `merge --ff-only` so `pull` does not make a second network request; or an exact-commit source ZIP when Git is unavailable; an extracted source directory or manual source ZIP can be bound when the network is unavailable;
- `npm ci`, a production `npm run build`, and runtime-entry validation in a persistent isolated `sources/runtime-*` snapshot only when the source revision or desired feature set changed; Profiles always link to a retained active snapshot, while snapshots no longer referenced by any Profile are safely removed; repository-wide development typechecks remain a source-checkout concern so sibling DSH type paths do not block an isolated install; native stderr warnings remain in the log while failure is determined by the real process exit code; Launcher-owned DSH is stopped only after these checks pass;
- an external coordinator that switches Launcher versions only when the executable hash changes, waits for readiness, rolls back failures, and restores DSH when appropriate; restoration is reported successful only after DSH remains Launcher-owned for 15 consecutive seconds;
- recovery of a still-running or interrupted coordinator after Launcher restarts, plus preservation and partial reconstruction when install state is damaged.

The first version supports only a local DSH source checkout and source installs of this repository. It does not support npx, a global `dsh`, npm-published packages, or GitHub Releases. A dirty, ahead, or diverged Git checkout is never reset, rebased, or overwritten.

If a prerequisite step fails, the installer does not dismantle the previously working combination. Restart the current Web profile once after a successful install if DSH is already running.

## Feature guide

### 1. Windows Launcher

`windows-launcher` · **Start → DeepSeek Harness Launcher** · Windows 10+

![DeepSeek Harness Windows Launcher overview](assets/readme/windows-launcher.png)

A Windows control center outside the Cordis plugin tree for local DSH users who do not want to keep a terminal open.

- **Web control:** inspect status, start, open, restart, or stop Web; identify services already bound to the port without taking ownership of them. Even when browser auto-open is disabled, **Open Page** uses the authentication entry for the current Launcher-owned DSH process, and launch tokens are not written to Launcher logs.
- **Tasks and profiles:** run one-shot Headless tasks and background profiles with unified UTF-8 results and logs.
- **Source maintenance:** **Update Source and Build** (更新源码并构建) runs `git pull --ff-only` against the bound DSH checkout, then `pnpm run clean`, `pnpm install --frozen-lockfile`, and `pnpm run build` in order. **Build Only** (仅构建) uses the current local source, skipping Git updates while still running all three pnpm steps. Without Git, Update Source and Build can also skip the pull after confirmation. Both build buttons stay disabled during an operation to prevent duplicate runs. Before cleaning, Launcher checks the checkout for clean/build scripts and a lockfile, and verifies that pnpm is available. Any failed step stops the remaining steps; lockfile errors never fall back to an unfrozen install. Git progress and pnpm warnings are not treated as failures: the real exit code determines the outcome. The page distinguishes pull, clean, dependency-install, build, and environment failures, with larger log text and an Open Log Folder action. Full UTF-8 output, command-engine errors, and the final outcome remain in `logs/dsh-build.log` across refreshes and page navigation. Stop DSH instances using this checkout before running: clean removes existing build artifacts, which are not restored if a later step fails. Launcher does not automatically stop or restart DSH for this action; start it manually after a successful build.

  The source-operation process temporarily sets `pnpm_config_verify_deps_before_run=false` so pnpm's [automatic install before scripts](https://pnpm.io/settings/build#verifydepsbeforerun) cannot change the lockfile before the explicit frozen install. This does not edit repository or global pnpm settings.

- **Diagnostics:** collect command, port, working directory, status, and log information, with a dedicated DSH Source page.
- **Desktop behavior:** system tray, optional login startup, a centered vertical layout at every window size, per-monitor DPI scaling, and consistent rounded scrollbars for both pages and text areas independent of the Windows theme. Diagnostics, task input/output, source-build logs, and plugin-operation logs share the same styling, with mouse-wheel, touchpad, thumb-dragging, track-paging, and keyboard support. Every log view filters ANSI/ECMA-48 terminal controls that a plain text box cannot interpret, preserving readable content without rewriting the original UTF-8 log file. Launcher remembers the last display and normal window bounds, then remaps them into a visible work area when the display topology changes.

<details>
<summary><strong>Process ownership, exit, and background behavior</strong></summary>

Launcher only stops DSH process trees that it started. A service already using the configured port is shown as an external Web service: the page can be opened, but Launcher will not take it over, restart it, or terminate it.

The tray exposes two exit paths. “Exit Launcher Only” leaves DSH running; “Exit Launcher” first requests a safe stop of Launcher-owned services. If the service is external or the stop times out, exit is cancelled with a reason.

Tasks and profiles run in no-console child processes. User task content travels through a UTF-8 request file to the PowerShell command engine and is never concatenated into `cmd.exe`. Hiding the main window stops foreground polling while the tray and background services continue running.

</details>

<details>
<summary><strong>Login startup, deployment, and source binding</strong></summary>

Login startup is off by default. You can start Launcher in the tray only, or start Launcher and launch DSH Web in the background after a 30-second initialization delay. The modes are mutually exclusive and can both remain disabled.

Versioned deployment directories keep Start menu and login-startup entries pointed at the current release without depending on profile `node_modules`. The installer preserves an explicitly configured DSH command. For a local DSH checkout, it generates and verifies a safe direct CLI entry and records that checkout as the only permitted source-build root.

Settings, runtime state, install state, update requests, and logs live under `%LOCALAPPDATA%\DeepSeekHarness\Launcher`. Launcher remains selected and required in the management UI. The control center does not self-uninstall; run `migrate-to-enhanced-plugin.ps1 -UninstallLauncher` from this repository to remove the program files, shortcuts, and login-startup entry. Logs and user settings are preserved by default.

</details>

### 2. Desktop alerts and pet

`notification` · **Settings → Desktop Pet** · Sounds and pet require Windows 10+

![Desktop alerts, custom sound library, and pet settings](assets/readme/desktop-notifications.png)

- Confirmation, completion, and blocked events can each be disabled or mapped to two built-in sounds or a custom WAV.
- Changing a sound previews it automatically, with a manual preview button as well. Shared gain ranges from 0–100%; 100% is approximately +6 dB, with soft limiting for near-peak PCM / IEEE Float WAV files.
- Each file is limited to 2 MiB and the shared library to 64 files, all stored in the current DSH profile.
- The pet switches live between the Flat Whale, 3D Whale, and Whale Girl characters.

| Aggregate state | Pet behavior |
| --- | --- |
| Idle | Sleeping loop; mouse contact or dragging triggers an interaction, with optional non-topmost idle mode |
| Working | Focused swimming or operating a task panel |
| Confirmation | Surprise, head turn, or question-mark cue; highest priority |
| Completed | A short celebration for top-level tasks only |
| Blocked | A short tired or concerned response for top-level tasks only |

The pet can be dragged across monitors and stores normalized per-monitor positions. Resolution, scale, work-area, or display-topology changes remap it into a visible area; changing the startup corner clears the drag record. The pet stays out of the taskbar and Alt+Tab task switcher; disable it in Settings when you want to hide it. Windows “Show animations” accessibility preferences reduce every state to a representative still frame when animations are disabled.

Both the resident pet and short-lived sound processes are owned by the DSH subprocess service and exit cooperatively when disabled. Companion pipe closure during Ctrl+C, plugin reload, or ordinary shutdown is treated as a normal teardown condition. A known retired pet ID is migrated to Flat Whale on the next launch; other unknown values continue to fail validation.

### 3. Plugin Community

`plugin-market` · **Settings → Plugin Community**

![Plugin Community page](assets/readme/plugin-community.png)

1. The first visit uses a bundled snapshot. “Sync latest index” uses ETags to fetch a schema-validated snapshot published by GitHub Actions every six hours, retrying temporary 429/502/503/504 responses.
2. Search by repository, package, description, or topic. A live preflight checks repository identity, commit, and distribution shape before installation.
3. One-click install is offered only for matching npm bundles with no install lifecycle scripts. Verifiable build-free source bundles can be installed at a pinned commit after confirmation; every other path links to its installation guide.
4. Install and uninstall run as cancellable background jobs. The target profile, bundle patch, and composition are verified afterward, with automatic rollback on failure.
5. The Installed tab separates market-managed plugins from externally managed ones. Only the former can be removed from this page.

<details>
<summary><strong>Index publishing, network proxies, and credentials</strong></summary>

The [`.github/workflows/update-plugin-index.yml`](.github/workflows/update-plugin-index.yml) workflow publishes the `market-index` branch. It enumerates the complete topic, revalidates only new or changed repositories, and refuses to overwrite the last result after an abnormal shrink or failed build. This project is also a built-in verified channel contribution, so it remains discoverable before the remote mirror catches up and is not duplicated afterward.

Neither the bundled snapshot nor automated index sync requires a GitHub token. Host downloads use the global transport installed by DSH 0.1.2-rc.1, including its proxy validation, direct routes, and `NO_PROXY` rules. Set `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` in the launching environment or `$DSH_HOME/.env`; the market does not install or close its own proxy dispatcher. If install preflight hits GitHub API limits, Settings can store a read-only, short-lived fine-grained token. It is sent only to the local DSH Host and stored through the credentials service.

The page displays index generation time. An index older than 24 hours receives an explicit warning while the last usable snapshot remains available.

</details>

### 4. MCP server manager

`mcp-server-manager` · **Settings → Plugins → Plugin configuration → MCP Servers**

![MCP server manager](assets/readme/mcp-server-manager.png)

1. Add a unique name and choose `stdio` or Streamable HTTP.
2. Configure command, arguments, working directory, and environment for `stdio`; configure an HTTP(S) URL and headers for HTTP.
3. The Host can import local Claude Code and Codex configurations in one pass. Duplicates are skipped and unsafe conversions report a reason.
4. Review the format audit at the top of the card and save. The Host starts, updates, or unloads each connection independently.

Environment and header values are masked when existing servers reach the browser. Unchanged secrets are not reconstructed from, or overwritten by, redacted snapshots.

### 5. pi-ai model request types

`model-input-types` · **Settings → Plugins → Plugin configuration → pi-ai model request types**

![pi-ai model request type settings](assets/readme/model-input-types.png)

Add pi-ai model overrides on the DSH Models page or in `settings.yaml`, then choose Provider default, Text only, or Text and images for each model. Changes save immediately.

The card appears only when the official `llm-pi-ai` settings namespace is available. It stores a capability declaration and does not probe the endpoint; verify that the provider truly accepts images before declaring Text and images.

### 6. Edit last message

`edit-last-message` · **Latest editable user-message bubble in the current session**

![Edit and resend the latest user message](assets/readme/edit-last-message.png)

1. Wait for the current session to finish, or stop it first.
2. Select Edit last message and change the text inline.
3. Select Resend or press `Ctrl/⌘ + Enter`; press `Esc` or Cancel to leave edit mode.

Resend stays inside the current session: the plugin replaces model context starting at the edited user message, then generates through the same AgentLoop. The DSH Session log remains an append-only audit record, and side effects from tools that already ran are not rolled back. Messages containing images or other non-text blocks do not expose the editor, preventing silent data loss.

### 7. Product subagents

`sub-agent` · **Settings → Subagents**

![Claude Code and Codex subagent toggles](assets/readme/subagent-toggles.png)

Enabling Claude Code or Codex applies immediately to every Agent preset carrying this controller, including running sessions. Disabling a toggle removes the matching tool in real time. The corresponding product and its official DSH provider must still be installed locally.

Both toggles default to off. Writes use path-addressed operations and settings revisions, so a redacted or stale snapshot cannot overwrite changes from another page or an external editor.

### 8. Official Team monitor

`agent-team-monitor` · **Current conversation composer → Team icon**

![Official Agent Teams read-only monitor](assets/readme/agent-team-monitor.png)

- The session-owned icon appears in the composer's model/context control group after workflow, Agent Teams or native child sessions are detected. Click to open; switching conversations immediately closes the panel and clears old data. No global overlay or header button is registered. Ordinary conversations with no delegation/team activity have no icon.
- “Roles & child sessions” groups exact recorded member names / creation labels while keeping multiple sessions for the same role distinct. Missing labels appear under “Unlabelled role”; no role is inferred from prompts or titles. Filter All / Running / History and inspect each session's title, ID, mode, creation time and state. Discovery includes nested children within this conversation tree, never unrelated roots.
- Click an available session row to enter DSH's native `openSubagent` details view, using the exact parent/child IDs and freshly checked native catalog mode. Running, historical and nested sessions share this path. Selection changes or plugin disposal fence late navigation; missing/corrupt records remain visibly unavailable rather than becoming fabricated sessions.
- Standard `workflow` and experimental Agent Teams are separate mechanisms and are displayed separately. The monitor reads the current session's own `tool-workflow/*` durable records for run names, actually started members, phases and completion/failure/cancellation. It never infers future roles, task dependencies or mailbox data from a script. Members pair by `runId + seq`; inherited workflow history cannot become a new fork's team.
- The Agent Teams view follows the selected Lead or roster-member session. It shows member status, task dependencies/owners/readiness, advisory write-scope overlaps, and queued mailbox counts. Select a task for details; select a member to open its official subagent transcript.
- The Host reads the official `ctx.agentTeams` service. For cold history, the official Agent Teams runtime owns and registers the `agentTeam` projection, which the monitor replays through public `ctx.sessionProjections.restore()`. Logs come from read-only `sessionQuery.observeSession()` observations; no Agent is activated and no second team state is created.
- Only the current conversation is polled (1.5 seconds open / 5 seconds collapsed); hidden pages and disconnected Hosts pause polling. New members and state changes refresh automatically without opening the panel. Click the icon, outside the panel, or press Escape to close. Failed/old replies cannot appear as live state after a session switch or reconnect.
- The monitor **does not enable Agent Teams or workflow**, register model tools, create/wake/interrupt members, edit tasks, or schedule work. Standard workflow monitoring needs no experimental Team package. To inspect live or historical Agent Teams state, enable that runtime separately following its [Team documentation](https://github.com/deepseek-ai/deepseek-harness/tree/76fda729799fe9b3848dbe2c211d4b231032b81e/packages/experimental/agent-team), so it owns and registers the projection.
- Requires the verified DSH `0.1.2-rc.1` source ABI. This plugin neither bundles the private experimental package nor fetches it from npm; Agent Teams history replay requires the official runtime and its projection to be mounted in the active profile. Runtime status and task completion are independent: `inactive` does not mean `completed`, and tasks depend on model-reported updates. Mail bodies and raw provider errors are never sent by the monitor. Views cap at 256 members / 1,000 tasks with explicit truncation and complete totals.
- Workflow views cap at 100 runs / 256 total member rows with complete totals. Unfinished cold records are never presented as live work; a closed enclosing step/turn marks an unfinished run interrupted. The monitor reads public records, never reads/executes workflow scripts, and never presents ordinary subagents as an experimental Team.
- Native discovery uses public `subagents.listDescendants`; read-only `sessionQuery.observeSession()` supplies own titles and turn outcomes. Exact Agent running/idle state takes precedence; residency alone is not execution. History means currently non-running, not necessarily successful. At most 256 child rows are inspected/displayed, prioritizing executing Agents; truncation shows displayed/total counts and filters count displayed rows only. Catalog failures do not hide existing Team/workflow data.

Install only this Profile feature with `-Features agent-team-monitor`; use `-ListFeatures` to inspect all choices. The normal required Windows Launcher behavior is unchanged. Light/dark/system themes and English/Chinese follow DSH settings.

## Compatibility and migration

- **Version pairing:** plugin `3.1.0` targets DSH `0.1.2-rc.1`, source commit `76fda729799fe9b3848dbe2c211d4b231032b81e`; its release tag is `3.1.0/0.1.2-rc.1`. The aggregate, all seven standalone bundles, and Windows Launcher use `3.1.0`.
- **Historical monitoring:** Cold monitor reads use the shared public `sessionQuery.observeSession()` API with `projectionMode: 'none'`, release the observation after reading, and never activate an Agent or commit crash recovery. Custom profiles need a `sessionQuery` provider for historical monitoring; the standard Web profile already supplies one. Agent Teams v1/v2 history compatibility remains owned by the active official Team projection; rejected history is shown as incompatible, never rewritten by this plugin.
- **Installation preflight:** the installer and Launcher plugin updater read `dshEnhanced.compatibility` from the root `package.json` before building, stopping services, or changing a profile. A DSH version mismatch, missing declaration, or mixed plugin package versions stops installation. A matching version whose commit is absent from `sourceCommit` and `additionalSourceCommits`, local source changes, or no Git metadata produces an unverified-source warning.
- **Current interfaces:** Client features use `client-store`, `ui-session`, `ui-chat`, and public Remotes, without the removed `dsh-client-runtime`, `connection.api`, or `hostDescription`. Host settings owners pass validated namespace literals and use `SettingsProvider.installSection()`. Session consumers use `eventAt()` / `snapshotEvents()` and keep `SessionLogOffset` inheritance metadata separate from `SessionHeader`; Team Monitor preserves that exact cut through query observations and projection replay. This project follows the public interfaces of the source commit above.
- **Provider provenance:** the `subagent-codex` and `subagent-claude-code` Loader IDs are unchanged. Their official implementations are re-exported through this package's `sub-agent/codex` and `sub-agent/claude-code` entries (`./codex` and `./claude-code` in the standalone bundle), so the new DeepSeek active-package inventory can resolve ownership without being disabled or changing DSH.
- **Standalone builds:** feature distributions include their own source and build scripts. `npm install --legacy-peer-deps`, `npm run prepare`, and `npm pack` work without a sibling DSH checkout; the matching DSH runtime still supplies public peer services. Rebuilding Windows Launcher requires Windows and a .NET Framework 4.x compiler.
- **Architecture boundary:** Web features extend public Services, events, slots, and settings. Windows Launcher is an independent companion and never joins the Cordis plugin tree.

Check the version pairing without building or installing (add `-DshCheckout` when the checkouts are not siblings):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\migrate-to-enhanced-plugin.ps1 -CheckCompatibility
```

Use the matching plugin release for an older DSH version instead of bypassing peer dependency checks or forcing this release to install.
- **File reference retired:** current DSH provides native [`@` file references](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/context/file-reference). Type `@` in the composer, or `@"` for paths containing spaces. The old `referenced-file` feature ID and `#` snapshot syntax are no longer provided.
- **Automatic cleanup:** `-Features referenced-file` is rejected explicitly. A normal installer run removes the historical selective package or the feature carried by an older aggregate install.

## Configuration

The default composition lives in [`cordis.patch.yml`](cordis.patch.yml). A later profile patch replaces the target Loader row's entire `config`, so an override must restate every field that row still needs.

<details>
<summary><strong>Desktop alert defaults</strong></summary>

| Field | Default | Purpose |
| --- | --- | --- |
| `completionSound` | `subtle` | Completion sound: `off`, `subtle`, `prominent`, or uploaded `custom` |
| `confirmationSound` | `prominent` | Attention sound: `off`, `subtle`, `prominent`, or uploaded `custom` |
| `blockedSound` | `prominent` | Blocked sound: `off`, `subtle`, `prominent`, or uploaded `custom` |
| `soundGain` | `0` | Shared 0–100% positive gain; 100 is approximately +6 dB |
| `petEnabled` | `false` | Show the native global desktop pet |
| `petCharacter` | `classic` | `classic` (Flat Whale), `multiview` (3D Whale), or `whale-girl` |
| `petIdleTopmost` | `true` | Keep the idle pet topmost |
| `petSize` | `112` | `80`, `112`, `144`, or `176` device-independent pixels |
| `petPosition` | `bottom-right` | `top-left`, `top-right`, `bottom-left`, or `bottom-right` |

Six `*CustomSoundFile` / `*CustomSoundName` fields are Host-owned selection references for the three events. The shared catalog is stored at `desktop-notifications/sound-library.json` inside the profile. Upload and choose sounds through Settings instead of editing these fields manually.

</details>

<details>
<summary><strong>Plugin Community Host configuration</strong></summary>

| Field | Default | Purpose |
| --- | --- | --- |
| `profile` | `web` | Target profile for install and uninstall |
| `topic` | `dsh-plugin` | Topic required by validated channel entries |
| `channelUrl` | HTTPS snapshot on `market-index` | Publication used by Sync latest index |
| `pageSize` | `12` | Plugins per page |
| `operationTimeoutMs` | `120000` | Install and uninstall timeout |
| `githubTokenEnv` | `GITHUB_TOKEN` | Credentials reference name |
| `cliPath` | empty | Optional absolute DSH executable path |

Bundled [`assets/plugins-cache.json`](assets/plugins-cache.json) is a read-only bootstrap snapshot and the incremental-validation seed for the first automated index run. The Host owns cached snapshots, ETags, background tasks, and installation records under DSH home. Plugin Community never parses shell commands out of READMEs and never enables `dangerouslyAllowAllBuilds`.

</details>

To expose product-subagent tools to selected Agent presets only, disable or remove the root `subagent-product-toggle-tools` row and mount the appropriate entry inside each target preset:

- Aggregate package: `dsh-enhanced-plugins/sub-agent/preset`
- Selective package: `dsh-enhanced-sub-agent/preset`

Do not mount both layouts in the same scope.

## Development and verification

This repository uses the following read-only sibling checkout as its DSH API, type, and assembled Web UI baseline:

```text
D:\work\workspace\github\deepseek-harness
```

Regular verification commands:

DSH's runtime and `lib/types` must come from the same source build. Passing typecheck against stale declarations does not verify compatibility with an updated checkout.

```powershell
npm install
npm run typecheck
npm test
npm run build
npm run pack:dry-run
git diff --check
```

On Windows, `npm run verify:compat` additionally installs all seven features individually into an isolated DSH home, then checks all-features, reselection, cleanup, and aggregate profiles against the real Host and Client artifacts. It requires built DSH and plugin artifacts and leaves the normal profiles untouched. Reports stay under the Git-ignored `.verify-dsh-home/`. Interactive behavior and light/dark appearance still require the real Web page.

Set `DSH_VERIFY_CHECKOUT` to a prepared copy of the verified DSH source commit when running `npm test` or `npm run verify:compat` against an isolated build. The default remains the sibling checkout, and the installer still checks the declared version.

`npm run verify:launcher` exercises the compiled Launcher and PowerShell command engine in temporary directories, including clean/install/build ordering, failure stops, and real pnpm frozen-lockfile rejection. It requires Windows, Git, and pnpm on `PATH`; it does not clean or rebuild the real DSH checkout.

`npm run verify:pack` packs each standalone distribution, installs only its build dependencies in an isolated directory without DSH peers, runs `prepare`, and checks its repacked entries. The Windows Companion part requires Windows as well.

Browser bundles use CSS Modules and consume only DSH `--dsw-alias-*` semantic theme tokens, so they follow light, dark, and system appearance automatically. See the [DSH plugin development guide](https://deepseek-harness.github.io/deepseek-harness/develop/basic/) and [architecture reference](https://deepseek-harness.github.io/deepseek-harness/reference/) for public extension points.

## License

[MIT](LICENSE)

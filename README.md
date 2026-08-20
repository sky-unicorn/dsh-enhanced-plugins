# dsh-enhanced-plugins

English | [中文](README.zh.md)

`dsh-enhanced-plugins` is an all-in-one enhancement bundle for the [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) Web profile. One installation adds native desktop alerts and a DeepSeek pet, a plugin community, MCP server management, model request-type declarations, workspace file references, last-message editing, and Claude Code / Codex subagent switches.

The package uses only public DSH plugin extension points and does not modify DSH core. Each of the seven features owns its applicable Host, Client, Settings, and runtime lifecycle, so an unavailable optional dependency does not prevent unrelated features from loading.

## Features at a glance

| Feature | Location | Purpose |
| --- | --- | --- |
| [Desktop alerts & pet](#desktop-alerts--pet) | Settings → Desktop pet | Play default or custom task-state sounds and optionally show an animated native DeepSeek fish |
| [Plugin Community](#plugin-community) | Settings → Plugin Community | Find, install, and remove community DSH plugins |
| [MCP server manager](#mcp-server-manager) | Settings → Plugins → Plugin configuration → MCP servers | Manage stdio and Streamable HTTP MCP servers |
| [pi-ai model request types](#pi-ai-model-request-types) | Settings → Plugins → Plugin configuration → pi-ai model request types | Declare whether models accept text or image requests |
| [Workspace file references](#workspace-file-references) | Type `#` in the session composer | Search files and add a text snapshot to the next request |
| [Edit last message](#edit-last-message) | Latest user-message bubble | Revise a turn and regenerate in the current session |
| [Product subagents](#product-subagents) | Settings → Subagents | Enable or disable Claude Code / Codex tools live |

## Requirements

- Node.js 22.19 or newer.
- A DSH Web profile. This repository is currently verified against the DSH `0.1.0-rc.5` public ABI, using local baseline commit `47f943859bef60e4160492346772ded9b24f765a`.
- Windows 10 or newer with Windows PowerShell 5.1 for the native sound and desktop-pet feature. The other bundle features remain portable.
- Official DSH packages are supplied by Harness; this plugin neither copies nor patches DSH core.

DSH is still a developer preview. After upgrading DSH, check this project's supported ABI before upgrading the plugin if compatibility errors appear.

## Installation

The installer handles dependency installation, package build, `web` profile installation, and load verification. Run the following commands from the `dsh-enhanced-plugins` repository root.

### Plugin and DSH source under the same parent directory

Use this directory layout:

```text
<workspace>/
├── deepseek-harness/
└── dsh-enhanced-plugins/
```

The installer discovers the sibling `deepseek-harness` checkout automatically:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\migrate-to-enhanced-plugin.ps1
```

### Plugin and DSH source in different directories

Pass the DSH source checkout explicitly with `-DshCheckout`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\migrate-to-enhanced-plugin.ps1 -DshCheckout "E:\projects\deepseek-harness"
```

Restart DSH once after installation if it is already running.

## Usage

The screenshots below use the Simplified Chinese locale; DSH translates labels according to the selected application language.

### Desktop alerts & pet

Location: **Settings → Desktop pet**. This is an independent entry in the left Settings navigation, not a card under Plugins.

1. Upload one or more WAV files into the shared **Custom sound library**, then independently choose **Off**, either built-in default sound, or any uploaded WAV for task-completion and confirmation sounds. Switching to a playable choice previews it automatically, and the adjacent **Preview** button plays the current choice again; choosing Off stays silent. A shared game-style **Notification gain** slider boosts both built-in and custom sounds: 0% preserves the source level and 100% is about twice the amplitude (+6 dB), with soft limiting near peaks. Gain processing supports PCM and IEEE-float WAV; another playable WAV encoding falls back to its source level. Each file is limited to 2 MiB, the library holds up to 64 files, and all files stay inside the current DSH profile. Existing per-event custom WAVs are imported into the library automatically after an upgrade.
2. Turn on **Enable desktop pet** to show the native DeepSeek fish outside the browser. **Keep idle pet on top** defaults on; when disabled, other windows may cover the idle pet while working, attention, and end reactions remain topmost.
3. Choose its size and starting corner, then drag it anywhere. Physical desktop outer edges block the pet, while adjoining display boundaries stay open so it can move directly to another screen. On mouse release the complete window lands inside the target display's visible work area, and the plugin stores a normalized position per display inside the current profile. Both size and position survive other setting changes and restarts. Resolution, scaling, and work-area changes are clamped back on-screen. If the active display is offline, the pet falls back to another connected display with a saved position or to the configured corner; reconnecting the original display can restore its position. Changing **Starting position** clears the dragged positions and applies that corner again.

The pet uses an independently implemented Hatch-style motion system without copying Codex's private assets or implementation. It hatches in when enabled; **Idle** gently floats, breathes, and performs occasional tricks; **Working** swims with bubbles and a rotating activity ring; and **Needs attention** hops, shakes, pulses, and displays an alert badge. A top-level turn ending also produces a short **Ready** celebration or **Blocked** reaction. State is folded across all sessions, with Needs attention taking highest priority. Completion sounds and end reactions fire only for top-level tasks, so subagents do not create duplicates.

Settings apply live. Pet motion uses native WPF animations so the window remains responsive; hovering triggers a small reaction while keeping the arrow cursor, and dragging temporarily uses the move cursor. When Windows Reduced Motion is enabled, the pet automatically uses static state frames. Turning the pet off closes and joins its managed PowerShell/WPF process; with the pet disabled, sound notifications use a short-lived process and leave no resident helper. The child receives only a fixed script path plus JSON control messages over stdin, and DSH's subprocess service owns tree cleanup.

### Plugin Community

Location: **Settings → Plugin Community**.

1. The first visit reads the bundled catalog snapshot. Select **Sync channel** when you want fresh community data.
2. Search by repository, package name, description, or topic.
3. Open the GitHub repository and verify its source before selecting **Install**.
4. Use the **Installed** tab to inspect or remove plugins installed through this page.
5. Restart the current Web profile after an install or removal, as prompted by the page.

The bundled snapshot works without a GitHub token. If synchronization hits GitHub API limits, open **Configure** and store a read-only, short-lived fine-grained token. It is sent only to the local DSH Host and kept by the credentials service.

![Plugin Community page](assets/readme/plugin-community.png)

### MCP server manager

Location: **Settings → Plugins → Plugin configuration → MCP servers**.

1. Select **Add server**, enter a unique name, and choose a transport.
2. For `stdio`, provide the command, arguments, working directory, and environment variables. For Streamable HTTP, provide an HTTP(S) URL and request headers.
3. Alternatively, select **Import Claude Code and Codex**. The Host reads supported local configuration, skips duplicate names or definitions, and explains entries that cannot be converted safely.
4. Review the format audit at the top of the card, then select **Save**. The Host starts, updates, or disposes each server connection independently after a successful commit.

When the browser reads an existing server, environment-variable and header values are masked. Unchanged secrets are not reconstructed or overwritten from the redacted view.

![MCP server manager](assets/readme/mcp-server-manager.png)

### pi-ai model request types

Location: **Settings → Plugins → Plugin configuration → pi-ai model request types**.

1. Add pi-ai model overrides on DSH's Models page or in `settings.yaml` first.
2. Expand the **pi-ai model request types** card.
3. For each model, select **Provider default**, **Text only**, or **Text and images**. The choice is saved immediately.

The card appears only while the official `llm-pi-ai` settings namespace is available. These are capability declarations, not endpoint probes. Confirm that the provider really accepts image requests before declaring **Text and images**.

![pi-ai model request types](assets/readme/model-input-types.png)

### Workspace file references

Location: **the session composer after selecting a workspace**.

1. Type `#`, then continue with part of a file name or path to narrow the results.
2. Use `↑` / `↓` and `Enter`, or click a result, to insert the reference.
3. Finish the prompt and send it. At submission, the Host resolves the path again, checks workspace containment, and adds a UTF-8 text snapshot to that model request.

Defaults allow up to 8 files, 128 KiB per file, and 512 KiB total. Binary, invalid UTF-8, oversized, non-regular, and outside-workspace files are rejected.

![Referencing workspace files from the composer](assets/readme/referenced-files.png)

### Edit last message

Location: **beside Copy on the latest editable user-message bubble**.

1. Wait for the current session to finish, or stop it manually.
2. Select **Edit last message** and revise the text inline.
3. Select **Resend** or press `Ctrl/⌘ + Enter`. Press `Esc` or select **Cancel** to leave edit mode.

Resending stays in the current session. The plugin replaces the active model context from the edited user message onward and regenerates through the same AgentLoop. The underlying DSH Session log remains append-only audit history, and external side effects from tools that already ran are not rolled back. Messages containing images or other non-text blocks do not expose Edit, preventing silent content loss.

![Editing and resending the last message](assets/readme/edit-last-message.png)

### Product subagents

Location: **Settings → Subagents**.

1. Turn on Claude Code or Codex.
2. The change applies immediately to Agent presets that load this controller, including running sessions; the profile does not need a restart.
3. Turning a product off removes its tool live. The corresponding local product and official DSH provider must still be available.

Both switches default to off. Each update writes only its Boolean path under settings revision fencing, avoiding accidental overwrite of newer edits from another page or external writer.

![Claude Code and Codex subagent switches](assets/readme/subagent-toggles.png)

## Advanced configuration

The default composition is in [`cordis.patch.yml`](cordis.patch.yml). A later profile patch replaces an entire Loader row's `config`; when overriding one, repeat every field that must be preserved.

<details>
<summary>Desktop notification defaults</summary>

| Field | Default | Purpose |
| --- | --- | --- |
| `completionSound` | `subtle` | `off`, `subtle`, `prominent`, or uploaded `custom` task-completion sound |
| `confirmationSound` | `prominent` | `off`, `subtle`, `prominent`, or uploaded `custom` attention sound |
| `soundGain` | `0` | Shared 0–100% positive gain; 0 preserves the source and 100 is about +6 dB |
| `petEnabled` | `false` | Show the native global desktop pet |
| `petIdleTopmost` | `true` | Keep the pet above other windows while it is idle |
| `petSize` | `112` | Pet size: `80`, `112`, `144`, or `176` device-independent pixels |
| `petPosition` | `bottom-right` | Fallback/reset corner: `top-left`, `top-right`, `bottom-left`, or `bottom-right` |

The four `*CustomSoundFile` / `*CustomSoundName` settings fields are Host-owned references to the two selections. The shared catalog is stored in the profile-local `desktop-notifications/sound-library.json`; select and upload custom sounds through the Settings page instead of editing either representation manually.

</details>

<details>
<summary>Plugin Community Host configuration</summary>

| Field | Default | Purpose |
| --- | --- | --- |
| `profile` | `web` | Target profile for installs and removals |
| `topic` | `dsh-plugin` | GitHub discovery topic |
| `pageSize` | `12` | Plugins per catalog page |
| `operationTimeoutMs` | `120000` | Install and removal timeout |
| `githubTokenEnv` | `GITHUB_TOKEN` | Credentials reference name |
| `cliPath` | empty | Optional absolute DSH executable path |

The bundled [`assets/plugins-cache.json`](assets/plugins-cache.json) is read-only. Synchronized cache data and marketplace install records are stored below the DSH home marketplace data directory.

</details>

<details>
<summary>Default workspace-reference limits</summary>

| Field | Default |
| --- | ---: |
| `maxCandidates` | 20 |
| `maxScannedEntries` | 5000 |
| `maxDepth` | 12 |
| `maxReferences` | 8 |
| `maxFileBytes` | 131072 |
| `maxTotalBytes` | 524288 |
| `indexTtlMs` | 30000 |
| `maxCachedWorkspaces` | 8 |

</details>

To expose product-subagent tools only to selected Agent presets, disable or remove the root `subagent-product-toggle-tools` row and mount `dsh-enhanced-plugins/sub-agent/preset` only inside those preset compositions. Do not mount both layouts in the same scope.

## Development and verification

Repository rules use this read-only sibling checkout as the DSH API, type, and real Web assembly baseline:

```text
D:\work\workspace\github\deepseek-harness
```

Run the standard checks with the package manager selected by the repository lockfile:

```powershell
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
git diff --check
```

The browser bundle uses CSS Modules and only DSH `--dsw-alias-*` semantic theme tokens, so it follows light, dark, and system appearance automatically.

## License

[MIT](LICENSE)

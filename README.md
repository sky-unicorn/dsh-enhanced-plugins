# dsh-enhanced-plugins

English | [中文](README.zh.md)

`dsh-enhanced-plugins` is a collection of enhancements for the [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) Web profile. Install all six features in one bundle, or keep only the independent bundles you need.

The project uses public DSH plugin extension points and does not modify DSH core. Each feature owns its Host, Client, Settings, and runtime lifecycle and can be built, installed, and removed independently.

[Feature overview](#feature-overview) · [Quick install](#quick-install) · [Feature guide](#feature-guide) · [Configuration reference](#configuration-reference) · [Development](#development-and-verification)

## Feature overview

The “install name” is the value accepted by the installer’s `-Features` parameter and is the only identifier needed for a selective install.

| Feature | Install name | Where to find it | What it adds |
| --- | --- | --- | --- |
| [Desktop alerts & pet](#desktop-alerts--pet) | `notification` | Settings → Desktop Pet | Event sounds, a custom WAV library, and a native animated DeepSeek fish pet |
| [Plugin Community](#plugin-community) | `plugin-market` | Settings → Plugin Community | Search, install, and remove community DSH plugins |
| [MCP server manager](#mcp-server-manager) | `mcp-server-manager` | Settings → Plugins → Plugin configuration | Manage stdio / Streamable HTTP servers and import local configurations |
| [pi-ai model request types](#pi-ai-model-request-types) | `model-input-types` | Settings → Plugins → Plugin configuration | Declare whether each model accepts text-only or image requests |
| [Edit last message](#edit-last-message) | `edit-last-message` | Latest user-message bubble | Edit that turn and regenerate within the current session |
| [Product subagents](#product-subagents) | `sub-agent` | Settings → Subagents | Enable or disable Claude Code / Codex tools live |

> [!NOTE]
> Workspace file references are no longer an enhanced-plugin feature. The latest official DSH provides [`@` file references](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/context/file-reference): type `@` (or `@"` for a quoted path) in the conversation input and choose a workspace path. The former `referenced-file` install name and its `#` snapshot syntax are retired. They are absent from the aggregate bundle, `-Features referenced-file` is rejected, and a normal installer run removes historical standalone packages or the contribution carried by an older aggregate install.

## Quick install

### Before you start

- Node.js 22.19 or later.
- A current DSH Web profile. This repository is verified against DSH `0.1.0-rc.8`; its local baseline commit is `141eb6fef83422698aef7a981029e843e8161534`.
- Native sounds and the desktop pet require Windows 10 or later and Windows PowerShell 5.1. The other features are cross-platform.

DSH is still a developer preview and may introduce compatibility-breaking changes. If an upgrade breaks the plugin, compare its ABI with the baseline above first.

> [!CAUTION]
> **Check the DSH/plugin repository layout before copying an install command:**
>
> - **Sibling-directory install:** both repositories share the **same parent directory**; use the commands below as written.
> - **Different-directory install:** the repositories have **different parent directories**; add `-DshCheckout "absolute path to the DSH source"` to the command.

### Install every feature

**Sibling-directory install:** when `deepseek-harness` and this repository share a parent directory, run the installer from this repository root:

```text
<workspace>/
├── deepseek-harness/
└── dsh-enhanced-plugins/
```

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\migrate-to-enhanced-plugin.ps1
```

Omitting `-Features` or passing `-Features all` installs the aggregate bundle with all six available features. It does not install the retired file-reference plugin.

### Install selected features

List the features provided by the current checkout:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\migrate-to-enhanced-plugin.ps1 -ListFeatures
```

Then pass comma-separated install names from the feature overview. For example, keep only desktop alerts, MCP management, and editing the last message:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\migrate-to-enhanced-plugin.ps1 -Features notification,mcp-server-manager,edit-last-message
```

`-Features` describes the enhanced feature set the target profile should **retain after the operation**. The installer first builds and installs every selected bundle, then removes the aggregate package, unselected sibling bundles, and declared conflicting legacy packages. It also detects and removes `dsh-enhanced-referenced-file`, `dsh-referenced-file`, or the retired `#` contribution from an older all-in-one `dsh-enhanced-plugins` installation, and prints a reminder to update DSH and use official `@` references. A failed installation does not remove the previously working set early.

**Different-directory install:** if the DSH checkout is elsewhere, pass it explicitly:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\migrate-to-enhanced-plugin.ps1 -DshCheckout "E:\projects\deepseek-harness"
```

The script installs dependencies, builds the packages, installs them into the `web` profile, and verifies that the profile loads. If DSH is already running, restart it once after the script succeeds.

## Feature guide

### Desktop alerts & pet

Install name: `notification` · Location: **Settings → Desktop Pet**

![Desktop alerts, custom sound library, and pet settings](assets/readme/desktop-notifications.png)

Sounds cover three event families: confirmation needed, task completed, and task blocked. Each can independently use off, one of two built-in sounds, or a WAV from the shared library. Changing a playable option previews it automatically, and the Preview button plays it again. A shared 0–100% gain reaches about +6 dB at 100% and softly limits near-peak PCM / IEEE Float WAV files. Each file may be up to 2 MiB; the profile-local library holds up to 64 files.

Enabling the desktop pet shows a native DeepSeek fish outside the browser. Pet Style switches live between the existing Flat Whale and the new 3D Whale; Flat Whale remains the default. It aggregates all sessions into these states:

- **Idle:** sleeps in a continuous low-amplitude breathing loop with drifting `Zzz`; hovering or dragging switches it to a compact, eager-to-play anticipation loop, and leaving it restores sleep. Idle topmost behavior is configurable.
- **Working:** Flat Whale uses its five-frame focused swim; 3D Whale uses twenty-four frames of forceful side swimming with a focused expression, bubbles, and a short wake, without an external progress ring.
- **Confirmation needed:** Flat Whale uses its five-frame surprised alert and pulse ring; 3D Whale uses twenty-four front/side frames of head turns, fin-raising, and a question mark, with no outer ring. This state has the highest priority.
- **Completed:** briefly plays a joyful fin-wave/spatial roll and sparkle sequence for the top-level task only.
- **Blocked:** briefly plays a tired/frustrated sequence for the top-level task only.

Flat Whale keeps its existing five-frame task and idle-interaction sheets. 3D Whale has twenty-four transparent frames for each of six animations: sleep, pointer interaction, working, confirmation, completed, and blocked. Its viewpoints now stay on front, three-quarter, and side poses instead of making rear views the main motion. Pointer interaction is an in-place anticipation loop, while working uses faster side swimming and a wake, with separate poses and timing. Its motion comes from viewpoint, pose, fins, tail, eyes, breathing, and expression instead of static-image shaking or an external spinning ring. The pet can be dragged freely across monitors and beyond desktop edges. On release, it snaps fully into the work area with the greatest overlap, or the nearest screen edge when released in a gap between displays. It stores a normalized position per display and remaps it into the visible work area after resolution, scaling, work-area, or monitor-connectivity changes. Changing Startup Position clears dragged positions and returns it to the selected corner. Windows “Show animations” accessibility preferences automatically select a representative static frame for each state and idle interaction phase when animations are reduced.

Settings apply live. The resident pet and short-lived sound processes are managed through the DSH subprocess service and exit cooperatively without leaving helper processes behind.

### Plugin Community

Install name: `plugin-market` · Location: **Settings → Plugin Community**

![Plugin Community page](assets/readme/plugin-community.png)

1. The first visit uses the bundled plugin snapshot; choose Sync sources when you need current community data.
2. Search by repository, package, description, or topic, and open the GitHub repository to verify its source before installing.
3. Use the Installed tab to inspect or remove items installed by Plugin Community.
4. Restart the current Web profile when prompted after an install or removal.

The bundled snapshot works without a GitHub token. If synchronization hits GitHub API rate limits, save a read-only, short-lived fine-grained token under Configure. The token is sent only to the local DSH Host and stored by the credentials service.

### MCP server manager

Install name: `mcp-server-manager` · Location: **Settings → Plugins → Plugin configuration → MCP Servers**

![MCP server manager](assets/readme/mcp-server-manager.png)

1. Choose Add server, give it a unique name, and select `stdio` or Streamable HTTP.
2. Configure command, arguments, working directory, and environment variables for `stdio`; configure an HTTP(S) URL and headers for HTTP.
3. Import Claude Code and Codex configurations in one step if desired. The Host skips duplicate names or content and explains entries it cannot convert safely.
4. Review the format audit at the top of the card, then save. The Host starts, updates, or removes each server connection independently.

Environment-variable and header values are masked when the browser reads existing servers. Unchanged secrets are never reconstructed from a redacted snapshot or overwritten.

### pi-ai model request types

Install name: `model-input-types` · Location: **Settings → Plugins → Plugin configuration → pi-ai model request types**

![pi-ai model request types](assets/readme/model-input-types.png)

Add pi-ai model overrides on the DSH Models page or in `settings.yaml`, then choose Provider default, Text only, or Text and images for each model. Changes save immediately.

The card appears only while the official `llm-pi-ai` settings namespace is available. It stores a capability declaration and does not probe the endpoint; verify provider support before declaring Text and images.

### Edit last message

Install name: `edit-last-message` · Location: **the latest editable user-message bubble in the current conversation**

![Editing and resending the latest message](assets/readme/edit-last-message.png)

1. Wait for the current run to finish, or stop it first.
2. Choose Edit last message and update the text in place.
3. Choose Resend or press `Ctrl/⌘ + Enter`; press `Esc` or Cancel to exit editing.

Resending stays in the current session. The plugin replaces model context from the edited user message onward, then runs the same AgentLoop again. The DSH Session log remains an append-only audit record, and external side effects from already-executed tools are not rolled back. Messages containing images or other non-text blocks do not expose the editor, which avoids silently dropping content.

### Product subagents

Install name: `sub-agent` · Location: **Settings → Subagents**

![Claude Code and Codex subagent toggles](assets/readme/subagent-toggles.png)

Enable Claude Code or Codex and the change applies immediately to Agent presets that load this controller, including running sessions; no profile restart is needed. Disabling a toggle removes the corresponding tool live. The matching local product and official DSH provider must still be available.

Both toggles default to off. Writes use path-addressed operations and a settings revision fence, so they do not replace unrelated changes from another page or external editor with a stale or redacted snapshot.

## Configuration reference

The default composition lives in [`cordis.patch.yml`](cordis.patch.yml). A later profile patch replaces an entire Loader row’s `config`; repeat every field that must be preserved when overriding one.

<details>
<summary>Desktop-alert defaults</summary>

| Field | Default | Purpose |
| --- | --- | --- |
| `completionSound` | `subtle` | `off`, `subtle`, `prominent`, or uploaded `custom` completion sound |
| `confirmationSound` | `prominent` | `off`, `subtle`, `prominent`, or uploaded `custom` attention sound |
| `blockedSound` | `prominent` | `off`, `subtle`, `prominent`, or uploaded `custom` blocked-task sound |
| `soundGain` | `0` | Shared 0–100% positive gain; 100 is about +6 dB |
| `petEnabled` | `false` | Show the native global desktop pet |
| `petCharacter` | `classic` | Pet style: `classic` (Flat Whale) or `multiview` (3D Whale) |
| `petIdleTopmost` | `true` | Keep the pet above other windows while idle |
| `petSize` | `112` | Pet size: `80`, `112`, `144`, or `176` device-independent pixels |
| `petPosition` | `bottom-right` | Fallback/reset corner: `top-left`, `top-right`, `bottom-left`, or `bottom-right` |

The six `*CustomSoundFile` / `*CustomSoundName` fields are Host-owned references for the three sound selections. The shared catalog is stored at `desktop-notifications/sound-library.json` below the profile; upload and select custom sounds through Settings instead of editing these fields manually.

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

The bundled [`assets/plugins-cache.json`](assets/plugins-cache.json) is read-only. Synchronized cache data and installation records are stored in the marketplace data directory below DSH home.

</details>

To expose product-subagent tools only to selected Agent presets, disable or remove the root `subagent-product-toggle-tools` row and mount the matching entry only inside those preset compositions: use `dsh-enhanced-plugins/sub-agent/preset` for the aggregate package or `dsh-enhanced-sub-agent/preset` for the independent package. Do not mount both layouts in the same scope.

## Development and verification

The repository uses this read-only sibling checkout as the DSH API, type, and real Web assembly baseline:

```text
D:\work\workspace\github\deepseek-harness
```

Standard verification commands:

```powershell
npm install
npm run typecheck
npm test
npm run build
npm run pack:dry-run
git diff --check
```

The browser bundle uses CSS Modules and only DSH `--dsw-alias-*` semantic theme tokens, so it follows light, dark, and system appearance automatically.

## License

[MIT](LICENSE)

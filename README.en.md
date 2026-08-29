[中文](./README.md) | **English**

# dsh-plugin-windows-guard

The DeepSeek Harness (dsh) **Windows pitfall-guard plugin** — **high-frequency
pitfalls distilled from 255 real session archives**, with two capability
layers: guidelines (skills) + proactive protection (hooks/tools):

- **Guideline layer** (since 0.1.0): two self-contained skills auto-loaded by
  scenario — preventive rules for "getting it right the first time";
- **Proactive protection layer** (since 0.2.0, merged from
  `dsh-plugin-pwsh-guard`, which has since been deleted): automatic mojibake
  detection hints for pwsh results, dangerous write-command interception, and
  encoding diagnosis/repair tools.

Zero runtime dependencies, zero build.

## Features

### Guideline layer: two auto-loaded skills

Split into two self-contained skills by trigger scenario (the
`<available_skills>` catalog auto-loads the body when the description
matches):

### `windows-enc` — Encoding and PowerShell parsing (command/file-content errors)

| Section | Content | Source incidents (historical records) |
|---|---|---|
| 1 Environment fact card | pwsh 5.1/7 differences, `-Command` as a single argv with no shell escaping layer, OutputEncoding pinned, exit codes are authoritative | stderr misjudgment (git red progress, NativeCommandError) |
| 2 Three encoding iron rules | always read with `-Encoding UTF8`; write structured files with `WriteAllText(UTF8Encoding($false))`; BOM check / transcoding command templates | GBK misdecoding (`鎻掍欢`/`鈥?`), BOM corrupting package.json (startup incident #2), UTF-16 corruption |
| 3 Quoting and escaping quick reference | PS `''` escaping (backslash doesn't work), double-quote interpolation, `node -e`/`python -c` quoting hell → write a temp file | `SyntaxError: unterminated string literal`, quoting-nesting failures confirmed in testing |
| 4 Three mojibake "don'ts" | mojibake signature table (`鈥?`/`??OK??`/`\uFFFD`) + don't guess / don't quote it / re-read first | `??OK??`, `??? skill ????` mojibake treated as the answer |

### `windows-sys` — System environment (troubleshooting)

| Section | Content | Source incidents |
|---|---|---|
| 1 Paths and filesystem | MAX_PATH/long paths, paths with spaces, EACCES/EBUSY file locks, junctions and `link:` realpath, path formats | `EACCES: realpath '...sock'`, deeply nested npm-cache paths |
| 2 Processes and ports | `netstat` port lookup, `Stop-Process`/`taskkill`, check before kill | port 3080/39090 conflicts, orphan processes |
| 3 Cross-platform misc | CRLF traps, `.cmd` script host/ExecutionPolicy, time zones, case sensitivity | novel-file CRLF checks, run.bat chcp 65001 |

### Proactive protection layer (since 0.2.0, every layer switchable, all on by default)

| Layer | Mechanism | Effect |
|---|---|---|
| L2 | `tools/post-execute` listener | when a `pwsh` tool result shows GBK misdecoding / an FFFD flood / Chinese turned into question marks, automatically appends a `[windows-guard]` fix hint after the result (no interruption, the result body is never rewritten) |
| L3 | `tools/pre-execute` listener | intercepts commands that write JSON/YAML/TOML/GD via `Set-Content`/`Add-Content`/`Out-File` without `-Encoding`, and `>` redirection into structured files; denies them and offers the correct `[System.IO.File]::WriteAllText(...)` form |
| L4 | `windows_encode_detect` / `windows_encode_fix` tools | file encoding diagnosis (BOM/UTF-8/GBK/UTF-16 + confidence) and repair (→ UTF-8 without BOM, automatic `.windowsguard.bak` backup); `dryRun` diagnoses without writing |

> History: the original pwsh-guard L1 system-prompt section is **no longer
> injected** — it has been replaced by the guideline skills above (loaded on
> demand, saving always-on tokens).

## Configuration

Everything in `cordis.patch.yml` is switchable (all on by default):

```yaml
- insert:
    - id: dsh-plugin-windows-guard
      name: dsh-plugin-windows-guard
      config:
        enabled: true     # master switch (false = keep only the guideline skills, degrading to the pure-guideline 0.1.0 form)
        postCheck: true   # L2 pwsh-result mojibake detection + hint
        preCheck: true    # L3 dangerous write-command interception
        detectTools: true # L4 encoding diagnosis/repair tools
```

## Installation

```powershell
# npm (recommended)
dsh plugin --profile web add dsh-plugin-windows-guard
# or GitHub
dsh plugin --profile web add github:Pasumao/dsh-plugin-windows-guard
```

Restart `dsh web` after installing for it to take effect. The package ships
its own `cordis.patch.yml` mount line, applied automatically — no manual
config edits needed; see the Configuration section for the switches.

Install from source (local development / debugging):

```bash
git clone https://github.com/Pasumao/dsh-plugin-windows-guard.git
cd dsh-plugin-windows-guard          # the directory can live anywhere (e.g. your plugins collection dir)
npm install
# Mount into the profile as a link: dependency:
#   add to the profile's package.json dependencies
#   "dsh-plugin-windows-guard": "link:<your-plugins-dir>/dsh-plugin-windows-guard"
#   and add it to dsh.profile.bundles (or insert manually via cordis.patch.yml)
# then pnpm install + restart dsh web
```

## What you'll see after installation

- when `pwsh` tool output contains mojibake (`鈥?`/`鎻掍欢`/`锟斤拷`), a
  `[windows-guard]` fix hint is appended to the end of the result;
- dangerous write commands such as `Set-Content`/`Add-Content`/`Out-File`
  writing JSON/YAML/TOML without `-Encoding` are denied outright, with the
  correct `[System.IO.File]::WriteAllText(...)` form attached;
- the tool list gains `windows_encode_detect` / `windows_encode_fix`
  (encoding diagnosis and repair);
- the skill catalog gains the `windows-enc` / `windows-sys` pitfall-guard
  guideline skills.

## Usage

No configuration needed after installation. When the model runs into a
Windows command/encoding/mojibake/path/process/port task,
`skill({ name: "windows-enc" | "windows-sys" })` auto-loads the matching
guideline; you can also ask the model to load a skill manually to read the
full text.

```text
User: Read D:\dsh\config\comfy_prompt.json and check the config
Model: Before reading, follow the guideline and use Get-Content -Encoding UTF8...
```

```text
User: Fix config.json for me, JSON.parse throws an error
Model: first windows_encode_detect on config.json → "utf-8-bom (confidence high)"
     → windows_encode_fix config.json → converted to UTF-8 without BOM (backup .windowsguard.bak)
     → verify that JSON parsing now passes
```

```powershell
# The model is told (via the guideline skills), and this kind of command is
# blocked by L3 with the correct form given:
# Set-Content -Path data.json -Value $json      ← deny (PS5.1 writes UTF-16LE/BOM)
# [System.IO.File]::WriteAllText("data.json", $json, [System.Text.UTF8Encoding]::new($false))   ← correct
```

### Why split into two skills (design notes)

- **Always-on catalog cost**: two descriptions (~300 tokens) barely grows;
- **Trigger precision**: `windows-enc` covers "command/file-content errors"
  (encoding/escaping/mojibake), `windows-sys` covers "system environment
  troubleshooting" (paths/processes/ports/cross-platform) — clean boundaries,
  no interference between them;
- **Body text halved on demand**: Windows "content error" tasks no longer
  load the entire "system environment" section;
- Reserved for future topics (WSL/winget/containers…) to be folded into
  `windows-sys` extensions.

## Implementation notes

- Guidelines are registered via `ctx.skills.register` (the official skill
  subsystem), with content as the SKILL.md body;
- L2/L3 use `ctx.on('tools/post-execute' | 'tools/pre-execute')`; L4 uses
  `ctx.tools.register` (raw definition shape); no `@deepseek-ai/*` runtime
  packages are imported (with link: realpath resolution, external dependencies
  cannot be resolved from the plugin directory);
- L2 only applies to the tool named `pwsh` with successful results; L3 only
  intercepts the narrow patterns guaranteed to corrupt writes — reads and
  writes with explicit `-Encoding` pass through; the mojibake vocabulary is
  based on measurements from historical sessions (11/12 positive/negative
  cases passed);
- Requires `Node ≥22.5` (`TextDecoder('gbk')` needs full-icu, which official
  builds include by default);
- Changes to skill bodies/tools/guards require a dsh restart (the host reads
  the skills/ directory when applying plugins);
- Every layer's registration has a ctx capability guard: if any layer is
  unavailable it degrades gracefully with a warning — the plugin never fails
  to mount.

## Related plugins

Published plugins cross-referencing each other (more of the DSH plugin
ecosystem):

- [dsh-plugin-workbench](https://www.npmjs.com/package/dsh-plugin-workbench) — VS Code-style workspace file explorer + editable preview
- [dsh-notify](https://www.npmjs.com/package/dsh-notify) — native Windows notification when the agent stops/errors + tray icon
- [dsh-plugin-image-tools](https://www.npmjs.com/package/dsh-plugin-image-tools) — image choice cards / inline reply images / chat image zoom
- [dsh-plugin-dev-kb](https://www.npmjs.com/package/dsh-plugin-dev-kb) — full Markdown mirror of the official dsh docs (plugin development knowledge base)
- [dsh-plugin-choice-refresh](https://www.npmjs.com/package/dsh-plugin-choice-refresh) — "regenerate options" / "more options" on choice cards
- [dsh-plugin-table-zoom](https://www.npmjs.com/package/dsh-plugin-table-zoom) — floating table viewer in chat + one-click Markdown copy

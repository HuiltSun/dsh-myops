# dsh-myops

A small, **dependency-free** replacement for [`dsh-ops`](https://github.com/T-Auto/dsh-ops).
It gives DSH nine tools and needs no npm packages and no native binaries.
Document formats (CSV / DOCX / XLSX / PPTX / PDF) are deliberately out of scope —
use the DSH **`/office` skill family** (`office-docx`, `office-xlsx`, `office-pptx`,
`office-render`, `office-export-pdf`) for document work.

| Tool | Purpose |
| --- | --- |
| `ops_bash` | Run a command with **Git Bash** instead of PowerShell |
| `ops_read` | Read a text file with line numbers (offset/limit, read de-duplication) |
| `ops_glob` | Find files by glob pattern |
| `ops_grep` | Search file contents with a regular expression |
| `ops_write` | Write a file (`dryRun`, `createDirs`, `expectedRevision`, `ifNotExists`) |
| `ops_edit` | Exact-match text replacement; atomic and rejects ambiguous matches |
| `ops_stat` | Type / size / mtime / line count / sha256 |
| `ops_result` | Page through spilled large output |
| `ops_git` | Compact Git: status / diff / log / show / branch / add / commit (no push-history rewrites) |

It is a plain cordis plugin: `package.json` → `index.mjs`, which exports
`{ name, inject, apply }` and registers the tools via `ctx.tools.register`.

## Install into the desktop profile

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The script:

1. **backs up the currently installed `dsh-myops`** (plugin folder +
   `cordis.patch.yml`) to `<workspace>\.backups\myops-<timestamp>\`, verifying that
   source and backup byte counts match before touching anything
2. copies this folder (including `lib/`) over the install **in place** — never
   deleting the directory first, because a missing directory during the host's
   hot reload shows up as `ERR_MODULE_NOT_FOUND` / `unknown tool ops_bash`
3. prints the restart step

Then **restart the DSH desktop app**. Open a new session and the `ops_*` tools
should be available.

### Backup, restore, uninstall

```powershell
# back up only, no changes
powershell -ExecutionPolicy Bypass -File .\install.ps1 -BackupOnly

# roll back to a previous version (backs up the current one first)
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Restore ".backups\myops-20261031-025940"

# uninstall (backs up first, then removes folder + config row)
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

Every backup session contains `manifest.json` (time, action, reason, source and
backup paths, byte counts) plus the copied `dsh-myops/` folder and
`cordis.patch.yml`.

## Test

```powershell
node test/smoke.mjs   # 28 checks: registration, bash, write/edit/stat safety, dedup, glob/grep, spill paging
node test/bench.mjs   # 65 checks: per-tool latency/output cost, timeout stability, process-tree cleanup, session-cwd binding, new params, ops_git, settings page (presets)
```

`test/bench.mjs` also writes `test/bench-report.json`. Exit code 0 means everything passed.

What a bench failure means (newcomers):

| Failing case | Likely area |
| --- | --- |
| `ops_bash/超时控制`, `超时后无 sleep.exe 残留`, `捕获临时目录已清理` | process-tree termination / capture cleanup |
| any `会话 cwd：…` case | `resolveSessionCwd` wiring (wrong path resolution source) |
| `registration missing` | plugin failed to register (syntax/import error) |
| `config maxOutputChars 生效` | plugin config not threaded into `store.present` |
| a settings case (`settings …`) | settings store / route wiring |
| a `mode=` / `exclude` / `stat=` case | the corresponding HTTP-free parameter path |

## Enable tool replacement (hide official tools)

By default the plugin only *adds* the ops tools; the official `pwsh` / `read` /
`glob` / `grep` stay visible. To make it a true replacement, edit the appended
row in **the profile's** `cordis.patch.yml`
(`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`):

```yaml
- insert:
    - id: myops
      name: dsh-myops
      config:
        hideOfficial: ['pwsh', 'read', 'glob', 'grep', 'write', 'edit']
```

`hideOfficial` entries are blocked from execution and removed from the tool surface
per agent. Supported: `pwsh`, `read`, `glob`, `grep`, `write`, `edit` (the six
official tools this plugin replaces). **Restart the DSH desktop app after editing**
— `cordis.patch.yml` is not hot-reloaded.

## Configuration

```yaml
- insert:
    - id: myops
      name: dsh-myops
      config:
        hideOfficial: ['pwsh', 'read', 'glob', 'grep', 'write', 'edit']   # optional
        maxOutputChars: 24000                            # optional output cap
        bashTimeoutMs: 120000                            # optional default bash timeout
        settingsPath: 'C:\Users\me\.dsh\myops-settings.json'  # optional
```

`maxOutputChars` (default **24000**) caps the model-visible text of
`ops_bash`/`ops_read`/`ops_glob`/`ops_grep`/`ops_git`; anything larger is spilled to
disk and the model only gets a **small preview (≤8k chars)** plus an `ops_result` id.
It does not change the 2 MB bash capture limit.
`bashTimeoutMs` is the `ops_bash` default when `timeoutMs` is omitted.

Defaults above are only the initial values. Once the **Desktop settings page** saves
the settings file (`$DSH_HOME/myops-settings.json` by default), the file wins: the
tools read it on every call (cached by mtime), so `maxOutputChars` and
`bashTimeoutMs` changes apply immediately without a restart. `hideOfficial` is the
exception — it is applied when the plugin loads, so toggling it needs a DSH restart.

### 配置档（presets）

`configs/myops-presets.json` 提供 5 个可直接切换的配置档：

```bash
node scripts/apply-preset.mjs list            # 列出所有配置档
node scripts/apply-preset.mjs balanced        # 应用（token-saver/balanced/generous/debug-official/quiet-code）
node scripts/apply-preset.mjs balanced --dry-run
```

脚本会先备份当前文件，再写入 `$DSH_HOME/myops-settings.json`；
`maxOutputChars` / `bashTimeoutMs` 下一次工具调用生效，`hideOfficial` 需重启 DSH。

## Token efficiency

The defaults are tuned so tool results stay small; every value is adjustable in
Settings → `myops 工具` (or `myops-settings.json`):

| Default | Value | Effect |
| --- | --- | --- |
| model-visible output cap | 24000 chars | oversized results spill with a ≤8k-char preview + `ops_result` id |
| `ops_read` lines | 800 | a 3000-line file returns ~8k chars instead of ~60k |
| `ops_glob` results | 200 | bounded worst case |
| `ops_grep` matches | 120 | bounded worst case |
| bash success output | stdout only | no `[exit code: 0, 28ms]` on success; failures/timeouts still print exit code and (slow) timing |
| `hideOfficial` | all six | removes the official `pwsh`/`read`/`glob`/`grep`/`write`/`edit` so only one tool surface is sent |

Measured: the nine tool definitions total **~6.4k chars (~1.8k tokens)** per request
(down from ~9.1k / ~2.5k before trimming). Combined with `hideOfficial` this removes
repeated per-request overhead; large reads now cost ~2.2k tokens instead of ~17k.

## Desktop settings page

When installed in a DSH profile that serves the Web/Desktop client, the package also
ships a client half (`client.js`, declared via `dsh.client` in `package.json`). It
registers **Settings → `myops 工具`**:

| Control | Meaning |
| --- | --- |
| 配置档（快速选择） | token-saver / balanced / generous / debug-official / quiet-code，点击即应用 |
| 模型可见输出上限（字符） | `maxOutputChars`, 1,000–2,000,000 |
| `ops_bash` 默认超时（毫秒） | `bashTimeoutMs`, 1,000–2,147,483,647 |
| 屏蔽官方工具 `pwsh`/`read`/`glob`/`grep`/`write`/`edit` | `hideOfficial`; restart required |

The page also shows the plugin version, platform, registered tools and the settings
file path. It talks to `GET /api/myops-settings/state` and
`POST /api/myops-settings/configure` on the host WebServer; the route accepts only
localhost Host headers, same-origin requests and JSON bodies (no credentials).

> Note: `ops_bash` runs Git Bash from the DSH host process with the host's full
> user-level privileges. It is not confined to the workspace by the file sandbox:
> an agent that can call `ops_bash` can read and write the whole user profile,
> start any program the user can start, and reach the network. There is no
> per-directory or per-command permission layer inside the plugin.

## Bash discovery order

1. `MYOPS_BASH` environment variable
2. `DSH_OPS_BASH` environment variable
3. `C:\Program Files\Git\bin\bash.exe`
4. `C:\Program Files (x86)\Git\bin\bash.exe`
5. `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`
6. `C:\Program Files\Git\usr\bin\bash.exe`
7. `bash` on `PATH`

## Design notes

- Bash execution first tries the DSH `subprocess` service (so policy and
  cancellation apply) and falls back to a direct `child_process.spawn`.
- **Relative paths resolve against the session working directory.** Every path
tool (read/glob/grep/write/edit/stat/git) and the default bash
`workdir` use the DSH `workingDirectory` service (`ctx.workingDirectory.ensure(agent)`),
falling back to `process.cwd()` only when no session exists. Explicit `workdir`
and absolute paths still win. The plugin never resolves against the host
process cwd (that is the profile directory, not the session workspace).
- **Timeouts kill the whole tree on Windows.** `taskkill /T /F` handles the
Windows side; because MSYS2 `fork()` can leave grandchildren (`sleep`, etc.)
with a dead fork-helper as `ParentProcessId` (which `taskkill /T` cannot reach),
`ops_bash` injects a per-call `DSH_MYOPS_RUN_ID` environment variable and, on
timeout, a helper bash kills every MSYS `/proc/<pid>/environ` holder of that
token. The direct-spawn fallback captures output into temp files instead of
pipes, so a surviving grandchild cannot hold the pipe open and delay `close`.
Measured: `timeoutMs=800` returns in 916–925 ms with no `sleep.exe` left behind.
- Bash runs as `bash -c` (not `-lc`): a login shell re-sources `/etc/profile` on
  every call (~135 ms here), and Git Bash already has `mingw64/bin` and `/usr/bin`
  on `PATH` without `-l`. Pass `login: true` when a script needs the profile
  environment; pass `mode: 'direct'` to force the fallback path (debugging) or
  `mode: 'service'` to require the host subprocess service (fails instead of
  silently falling back).
- On timeout the model sees `timed out after <N>ms` plus a `[timeout]` note saying
  the output is partial; the process tree is terminated on a best-effort basis.
- **Large output is spilled, not truncated away.** Bash captures up to 2M chars,
  then anything over `maxOutputChars` is written to
  `%TEMP%\dsh-myops-spill\<id>.txt` and the model gets a small preview (≤8k chars) plus
  `[full output "ops_bash" id=…; call ops_result(id="…") to page]`.
  `ops_result` pages it back with `offset`/`limit`.
- **`ops_read` de-duplicates.** A whole-file read whose content is unchanged since
  the previous read returns
  `(unchanged since last read, rev …, read #N)` instead of the body; pass
  `force: true` to print it again. Windowed reads (`offset`/`limit`) always print.
- `ops_read` defaults to 800 lines and prints `[truncated: pass offset=N to continue]`,
  so reading a large log cannot flood the context in one call.
- `ops_write` / `ops_edit` validate everything before touching disk and replace via
  a temp file + rename, so a failed call never leaves a half-written file.
  `expectedRevision` (sha256 prefix from `ops_stat`) gives compare-and-swap safety.
  `ops_edit` also supports `dryRun` and multiple replacements in one `edits` array.
  Both normalize CRLF/CR to LF before matching, so `oldText` may use LF even in a
  CRLF file — but the rewritten file uses LF line endings.
- **Spill TTL:** the spill store (`%TEMP%\dsh-myops-spill\`) is cleaned at plugin
  start (entries older than 7 days are deleted) and pruned to at most 200 entries
  when a new entry is written (oldest first). Crash leftovers therefore do not grow
  without bound, but there is no background sweeper; `maxAgeMs`/`maxEntries` are
  `createSpillStore` options, not plugin config.
- Document formats (CSV / DOCX / XLSX / PPTX / PDF) are intentionally not handled by
  this plugin; use the DSH `/office` skills (`office-docx`, `office-xlsx`,
  `office-pptx`, `office-render`, `office-export-pdf`) instead.
- `ops_glob` / `ops_grep` skip `.git` and `node_modules`; symlinks are not followed.
- `ops_glob` returns relative paths only by default. Pass `stat: true` to append
  `(size bytes, ISO mtime)` per match (one extra `stat` per file).
- `ops_grep`'s `include` is a single glob and is **not recursive by itself**:
  `include: '*.mjs'` scans only the top level (`scanned 1/1 files`); use
  `**/*.mjs` for recursion. Files larger than 5 MB and binary files are skipped
  (never read into memory). `exclude` is a content regex — matching lines are
  dropped from the results.
- `ops_stat` accepts `paths: [...]` for batch queries; missing entries report
  `<path>: not found` without failing the whole call.
- **`ops_git`** runs the resolved Git executable directly (no shell) with
  `GIT_TERMINAL_PROMPT=0`: `status` summarizes branch/ahead-behind/staged/
  unstaged/untracked (file lists capped at 40), `diff` defaults to `--stat`
  (`stat: false` gives a capped patch), `log` is one-line, `show` defaults to
  `--stat`, `add`/`commit` only touch explicit `paths`. Push and history-changing
  commands are intentionally left to `ops_bash`.
- Empty files report `0 lines` consistently in both `ops_read` and `ops_stat`.

- **Runtime settings + Desktop page.** `lib/settings-store.mjs` persists
  `maxOutputChars`/`bashTimeoutMs`/`hideOfficial` to `$DSH_HOME/myops-settings.json`
  (atomic write, mtime-cached read); `lib/settings-route.mjs` serves the host
  WebServer API; `client.js` (declared by `dsh.client`) registers the
  `settings.section` page. Changing the settings file by hand works the same way;
  a corrupt file falls back to the plugin config defaults.

## Known limits

- `ops_bash` bypasses DSH's file sandbox and runs with the host's user privileges:
  it can read/write the whole user profile and start any program the user can.
  The plugin has no finer-grained allow/deny layer for paths or commands.
- The spill directory is temporary storage; ids are not durable. Cleanup runs at
  plugin start (7-day TTL) and on write (max 200 entries), not periodically.
- `ops_grep` is pure JavaScript (no ripgrep): fine for normal repos, slower on
  very large trees. Files >5 MB are skipped entirely; one file is read at a time.
- Document formats (CSV / DOCX / XLSX / PPTX / PDF) are not handled here; delegate
  to the DSH `/office` skill family.
- The settings page requires a DSH Web/Desktop profile that mounts the `webServer`
  service; on hosts without it the tools still work and settings can be edited in
  `myops-settings.json` directly. The `client.js` half only loads after a DSH
  restart (plugin enablement), and `hideOfficial` changes always need a restart.
- The settings API is localhost-only: it rejects non-local Host headers, cross-site
  `sec-fetch-site` and mismatched `Origin`, and accepts JSON bodies ≤ 64 KB.
- `ops_git` is a compact convenience wrapper, not a full Git client: it exposes
  `status`/`diff`/`log`/`show`/`branch`/`add`/`commit` only. Push, fetch, merge,
  rebase, reset, tag and stash stay in `ops_bash` so the exact command is visible.
  It runs with the host's Git credentials and has no sandbox of its own; `commit`
  uses the repository's configured user.name/user.email.

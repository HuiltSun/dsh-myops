# dsh-myops

A small, **dependency-free** replacement for [`dsh-ops`](https://github.com/T-Auto/dsh-ops).
It gives DSH eleven tools and needs no native binaries and no npm packages.

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
| `ops_read_table` | CSV / TSV with quote handling |
| `ops_read_docx` | DOCX paragraph text (no npm deps; own ZIP reader) |
| `ops_read_pdf` | PDF text layer, best effort — returns a diagnostic instead of mojibake |

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
node test/smoke.mjs
```

31 checks covering registration, bash, write/edit/stat safety semantics,
read de-duplication, glob/grep, spill + `ops_result` paging, and
CSV/DOCX/PDF error paths. Exit code 0 means everything passed.

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
        hideOfficial: ['pwsh', 'read', 'glob', 'grep']
```

`hideOfficial` entries are blocked from execution and removed from the tool surface
per agent. Use a subset if you only want to replace some of them. Restart the app
after editing.

> Note: `ops_bash` runs Git Bash from the DSH host process with the host's full
> user-level privileges. It is not confined to the workspace by the file sandbox.

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
- Bash runs as `bash -c` (not `-lc`): a login shell re-sources `/etc/profile` on
  every call (~135 ms here), and Git Bash already has `mingw64/bin` and `/usr/bin`
  on `PATH` without `-l`.
- **Large output is spilled, not truncated away.** Bash captures up to 2M chars,
  then anything over ~60k chars is written to
  `%TEMP%\dsh-myops-spill\<id>.txt` and the model gets a preview plus
  `[full output "ops_bash" id=…; call ops_result(id="…") to page]`.
  `ops_result` pages it back with `offset`/`limit`.
- **`ops_read` de-duplicates.** A whole-file read whose content is unchanged since
  the previous read returns
  `(unchanged since last read, rev …, read #N)` instead of the body; pass
  `force: true` to print it again. Windowed reads (`offset`/`limit`) always print.
- `ops_read` defaults to 2000 lines and prints `[truncated: pass offset=N to continue]`,
  so reading a large log cannot flood the context in one call.
- `ops_write` / `ops_edit` validate everything before touching disk and replace via
  a temp file + rename, so a failed call never leaves a half-written file.
  `expectedRevision` (sha256 prefix from `ops_stat`) gives compare-and-swap safety.
- `ops_glob` / `ops_grep` skip `.git` and `node_modules`.
- Empty files report `0 lines` consistently in both `ops_read` and `ops_stat`.
- PDF analysis is best effort: it parses `/ToUnicode` CMaps for CID fonts and
  **falls back to a readable "unsupported" message rather than emitting garbled
  text**. Scanned PDFs have no text layer and are not OCR'd.

## Known limits

- `ops_bash` bypasses DSH's file sandbox and runs with the host's user privileges.
- The spill directory is temporary storage; ids are not durable.
- `ops_grep` is pure JavaScript (no ripgrep): fine for normal repos, slower on
  very large trees. `ops_read_table` assumes UTF-8.
- `ops_read_docx` reads `word/document.xml` only (no headers/footers, no table
  structure); legacy `.doc` is unsupported.

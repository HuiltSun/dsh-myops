# Changelog

## v1.4.0 — 2026-10-31

### 新增 Desktop 设置页

- 新增 `client.js`（`dsh.client` 声明，`platform: 'web'`）：在 DSH 设置里注册
  **`myops 工具`** 分区，可编辑：模型可见输出上限（`maxOutputChars`）、
  `ops_bash` 默认超时（`bashTimeoutMs`）、屏蔽官方工具
  （`pwsh`/`read`/`glob`/`grep`，需重启生效）。页面同时显示版本、平台、已注册
  工具列表与设置文件路径。
- 新增 `lib/settings-store.mjs`：`$DSH_HOME/myops-settings.json` 持久化，
  mtime 缓存读取、原子写入、范围校验；损坏/缺失回落插件配置默认值。
- 新增 `lib/settings-route.mjs`：`GET /api/myops-settings/state` 与
  `POST /api/myops-settings/configure`，仅接受 localhost + 同源 + JSON 请求。
- 工具侧：`maxOutputChars`、`bashTimeoutMs` 改为**每次调用读取设置**（即时生效，
  无需重启）；`hideOfficial` 在插件加载时应用。
- `package.json`：新增 `./client` 导出、`files` 包含 `client.js`、`dsh.client`
  声明；`install.ps1` 同步复制 `client.js`。

### 测试

- `test/bench.mjs` 扩展到 78 项：settings store 校验/落盘、真实 HTTP 路由
  （state/configure/跨源拒绝）、改设置后即时生效、默认 bash 超时、`client.js`
  模块加载与 `settings.section` 注册。

---

## v1.3.0 — 2026-10-31

### 新增工具 `ops_git`

- 紧凑的 Git 操作（`action`）：`status` / `diff` / `log` / `show` / `branch` /
  `add` / `commit`。直接 exec 解析到的 `git`（不经 shell，
  `GIT_TERMINAL_PROMPT=0`，无颜色/无分页器）。
- `status`：分支与 ahead/behind（来自 `--porcelain=v1 -b`）、staged/unstaged/
  untracked/conflict 计数与文件列表（每类最多 40 个）。
- `diff`：默认 `--stat`；`stat: false` 输出补丁（默认最多 200 行）；`staged` /
  `file` 可选。`log`：一行式 + decorate，默认 20 条。`show`：默认 `--stat`，
  `full: true` 输出补丁。`add`/`commit` 只处理显式 `paths`；`commit` 必须给
  `message`。
- 刻意不暴露 push/fetch/merge/rebase/reset/tag/stash —— 这些仍通过 `ops_bash`
  执行，命令对用户可见。

### 测试

- `test/bench.mjs` 扩展到 69 项（新增临时仓库上的 ops_git 9 个用例：status/
  add/commit/log/diff stat/patch/branch/show）。

---

## v1.2.0 — 2026-10-31

### 新增参数与能力

- **`ops_bash`**：
  - `mode: 'auto' | 'direct' | 'service'` — `direct` 强制走直连回退路径（方便复现
    fallback bug），`service` 强制要求宿主 subprocess 服务（不可用时直接报错，
    不再静默降级）。
  - `login: true` — 用 `bash -lc` 登录 shell（source `/etc/profile` 与用户 profile），
    供依赖 profile 环境变量的脚本使用；默认仍是更快的 `bash -c`。
  - 超时输出新增 `timed out after <N>ms` 与 `[timeout] … output is partial` 提示。
- **`ops_grep`**：新增 `exclude` 正则（对匹配到的行做内容排除）；`include` 的
  非递归语义、>5 MB 文件跳过写进工具描述与 README。
- **`ops_glob`**：新增 `stat: true`，为每个结果附带 `size` 与 ISO `mtime`。
- **`ops_stat`**：新增 `paths: [...]` 批量查询（缺失项报 `not found`，不中断整批）。
- **配置**：新增 `maxOutputChars`（默认 60000）控制 `ops_bash`/`ops_read`/
  `ops_glob`/`ops_grep` 的模型可见输出上限；超过部分仍走 spill + `ops_result`。

### 修复

- **Windows 直连回退路径的超时现在真正生效**。此前 `timeoutMs=800` 的
  `sleep 3` 要 3043 ms 才返回：`child.kill('SIGKILL')` 只杀 `bash.exe`，
  MSYS2 fork 出的孙进程还持着 stdout/stderr 管道，`close` 事件被拖到命令
  自然结束。现在超时会终止整棵进程树：
  - `taskkill /PID <pid> /T /F` 终止 Windows 侧进程；
  - MSYS2 的孙进程（如 `sleep`）`ParentProcessId` 指向已退出的 fork 辅助
    进程，`taskkill /T` 追不到；改为启动命令时注入随机环境变量
    `DSH_MYOPS_RUN_ID`，超时时用一个不带该变量的辅助 bash 扫描
    `/proc/<pid>/environ` 并 `kill -9` 所有命中进程。
  - 直连路径的输出改写入临时文件（而非管道），捕获目录在结束时清理。
  - 实测：`timeoutMs=800` + `sleep 3` 连续 5 次 **916–925 ms** 返回，
    无 `sleep.exe` 残留，无临时目录泄漏。
- **相对路径绑定会话工作目录**：所有路径型工具（`ops_read` / `ops_glob` /
  `ops_grep` / `ops_write` / `ops_edit` / `ops_stat` / `ops_read_table` /
  `ops_read_docx` / `ops_read_pdf`）和 `ops_bash` 的默认 `workdir` 改为按
  DSH 的 `workingDirectory` 服务解析（`session.header.cwd` 兜底）；显式
  `workdir` 与绝对路径优先。此前相对路径会落到宿主进程 cwd
  （`~/.dsh/profiles/desktop`）。
- `ops_edit` 描述补充：多块 `edits` + `dryRun` 已存在；CRLF/CR 匹配前会
  规范化为 LF，写回文件使用 LF。

### 文档

- README 补齐：grep `include` 非递归与 >5 MB 跳过、`exclude`、glob 不跟随
  symlink、spill 的 7 天 TTL / 200 条上限与清理时机、read_table 仅 UTF-8 及
  错误文案、docx 加密报错、`ops_bash` 权限边界、bench 失败项对应关系。

### 测试

- `test/bench.mjs` 扩展到 60 项：新增 `mode=direct/service`、`login`、超时
  提示、`exclude`、glob `stat`、stat 批量、`maxOutputChars` 配置用例，
  以及原有的超时稳定性、孤儿进程、临时目录、11 个会话 cwd 用例。

---

## v1.1.0 — 2026-10-31

从 4 个工具扩展到 11 个，仍然零依赖。

### 新增工具

- **`ops_write`** — 写文件。支持 `dryRun`（只报告计划）、`createDirs`、`ifNotExists`，
  以及 `expectedRevision`（sha256 前缀）做 compare-and-swap。写入走临时文件 + rename，
  失败不会留下半截文件。
- **`ops_edit`** — 精确文本替换。每个 `oldText` 必须恰好出现一次，0 次或多次都拒绝；
  先算完全部替换再落盘，失败时原文件字节不变。
- **`ops_stat`** — 文件：类型/大小/mtime/是否文本/行数/sha256；目录：条目数、一层总大小。
- **`ops_result`** — 大输出分页续读。
- **`ops_read_table`** — CSV/TSV，自动推断分隔符、处理引号内逗号与多行单元格。
- **`ops_read_docx`** — 自研 ZIP 解析（stored/deflate），提取 `word/document.xml` 段落。
- **`ops_read_pdf`** — 解析 `/ToUnicode` CMap 解码 CID 字体；无可用映射或有乱码风险时
  返回说明性 `unsupported`，不会吐乱码。

### 新增能力

- **大输出 spill**：`ops_bash` 采集上限提到 2M 字符；超过约 60k 字符的输出现落盘到
  `%TEMP%\dsh-myops-spill\`，模型收到预览 + `[full output id=…]` 提示，可用
  `ops_result` 翻页。修复了此前 60k 之后内容直接丢失的问题。
- **读去重**：全文重复读同一文件时返回
  `(unchanged since last read, rev …, read #N)`，`force: true` 可强制重打。
  只在整文件读取时生效，`offset`/`limit` 窗口读取总是返回内容。

### 修复

- `ops_read` 行数 off-by-one（末尾换行导致多算一行）。
- 空文件行数不一致：`ops_read` 与 `ops_stat` 现在统一为 `0 lines`。
- `install.ps1` 递归复制 `lib/`；此前只复制 4 个顶层文件，安装后缺模块。
- `install.ps1` 不再先删目录再重建 —— 该竞态会导致宿主热加载报
  `ERR_MODULE_NOT_FOUND` / `unknown tool ops_bash`。
- `ops_bash` 由 `bash -lc` 改为 `bash -c`，单次调用 ~226ms → ~32ms。
  Git Bash 在非登录 shell 下 PATH 已完整，无需 `-l`。

### 安装与备份

- 覆盖、回滚、卸载前都会自动备份到 `<workspace>\.backups\myops-<时间戳>\`
  并校验字节数，附带 `manifest.json`。
- 新增 `-BackupOnly` / `-Restore` 两个入口。

### 测试

- `test/smoke.mjs` — 31 项冒烟（注册、bash、写操作安全语义、去重、glob/grep、
  spill 翻页、文档错误路径），退出码 0 为通过。
- `test/doc/selftest.mjs` — 113 项文档解析自测（CSV/TSV/DOCX/PDF 含真实 PDF）。

---

## v1.0.0 — 2026-10-30

首个版本：`ops_bash`（Git Bash）、`ops_read`、`ops_glob`、`ops_grep`，
外加带自动备份的安装脚本。

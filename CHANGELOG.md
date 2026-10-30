# Changelog

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

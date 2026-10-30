# Issue 归档

本文件记录 dsh-myops 的已知问题与取舍。**本轮只做稳定性修复**（Windows 超时进程树 + 会话工作目录绑定），下列 3 项已知细节本轮不改动。

## 暂不修复（已归档）

### ISSUE-001 `ops_read` 的 spill 边界偏薄

- **现象**：2000 行全文读约 **59,968 字符**，正好在 60,000 字符 spill 线下方；文件再大一点就会从"全文"变成"预览 + `[full output id=…]` 翻页"。
- **影响**：低。属设计取舍（60k 是模型可见输出上限），但边界不直观。
- **可能方向**：按行数而非字符预估是否 spill；或在 header 提示"接近上限"。
- **状态**：已知，本轮不改。

### ISSUE-002 `ops_grep` 的 `include` 非递归

- **现象**：`include: '*.mjs'` 只扫根级文件（输出 `scanned 1/1 files`），要递归必须写 `**/*.mjs`。
- **影响**：低。输出里的 `scanned X/Y` 能提示扫描范围，但容易被忽略成"没有匹配"。
- **可能方向**：`include` 不含 `**` 时自动按 `**/<pattern>` 递归。
- **状态**：已知，本轮不改。

### ISSUE-003 `ops_read_table` 中 CJK 列宽按字符数对齐

- **现象**：`陈小明` 这类全角字符按 1 个字符计宽，表格列会轻微歪斜（单元格内容正确）。
- **影响**：纯外观。
- **可能方向**：按 East Asian Width 计算显示宽度（全角算 2）。
- **状态**：已知，本轮不改。

## 本轮已实现（v1.2.0）

- `ops_bash`：`mode: direct|service`、`login: true`、超时提示。
- `ops_grep`：`exclude` 内容排除。
- `ops_glob`：`stat: true` 返回 size/mtime。
- `ops_stat`：`paths` 批量。
- 配置：`maxOutputChars`。
- 文档：grep include 非递归、>5 MB 跳过、spill TTL/200 条上限、read_table UTF-8 错误文案、docx 加密报错、glob symlink、权限边界、bench 失败含义。

## 排期中（大功能，本轮不动）

### ISSUE-006 GBK/GB2312 编码的 CSV/TSV

- **现象**：`ops_read_table` 只按 UTF-8 解码，GBK 文件报 `not valid UTF-8 text`，无法读取。
- **方向**：加 `encoding` 参数（Node `TextDecoder` 支持 `gbk`/`gb18030`，需验证 full-icu）；或先做启发式判定。
- **验收**：GBK fixture 能正确输出表格；非法字节仍给可读错误。

### ISSUE-007 PDF 密码 / OCR

- **现象**：加密 PDF 只返回 unsupported；扫描件无文本层时同样 unsupported。
- **方向**：密码参数需要 Standard Security Handler 解密（RC4/AES），工作量大；OCR 需外部引擎，违反零依赖。
- **建议**：保持现状，依赖外部工具（用户显式调用 CLI）。

### ISSUE-008 docx 页眉/页脚/脚注

- **现象**：只读 `word/document.xml`，`header1.xml` / `footer1.xml` / `footnotes.xml` 不在输出里。
- **方向**：按 `word/_rels/document.xml.rels` 解析关系后合并多个 part；注意段落顺序与去重。

### ISSUE-009 grep 流式读取

- **现象**：当前逐文件 `readFile`（单文件 5 MB 上限，超限直接跳过），没有流式扫描。
- **方向**：`createReadStream` + 按行切分；可顺便把 5 MB 上限提为可配置。

### ISSUE-010 CJK 列宽（原 ISSUE-003）

- 同 ISSUE-003，表格列宽按字符数对齐导致全角字符歪斜。

### ISSUE-011 `-Restore` 后不自动验证

- **现象**：`install.ps1 -Restore` 只复制文件，不跑任何自检。
- **方向**：恢复后跑 `node --check index.mjs lib/*.mjs` + 最小注册冒烟（伪 ctx），失败则提示回滚。

### ISSUE-012 spill 周期性清理

- **现象**：只在插件启动时清理 7 天过期文件 + 写入时按 200 条淘汰，没有后台定时器。
- **影响**：单进程长期运行时，spill 目录最多 200 条，不会无限增长；跨进程崩溃残留靠下次启动清理。
- **方向**（可选）：定期 `cleanupExpired`。

## 已修复（v1.1.0 稳定性修复）

- **ISSUE-004**：Windows 直连回退路径 `timeoutMs` 不生效（`timeoutMs=800` 实测 3,043 ms 才返回，且遗留 `sleep.exe`）。
  已修复：`taskkill /T /F` + `DSH_MYOPS_RUN_ID` 扫描 MSYS `/proc/<pid>/environ` 杀 fork 孙进程，直连捕获改用临时文件。
  复测：连续 5 次 **916–925 ms** 返回，无孤儿进程、无临时目录泄漏。
- **ISSUE-005**：所有路径型工具（含 `ops_bash` 默认 `workdir`）的相对路径会落到宿主进程 cwd（`~/.dsh/profiles/desktop`），而非会话工作区。
  已修复：统一走 DSH `workingDirectory` 服务，显式 `workdir` / 绝对路径仍优先。

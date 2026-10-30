# Issue 归档

本文件记录 dsh-myops 的已知问题与取舍。**v2.0.0 起文档类工具已移除**（详见文末“已移除”），当前插件只保留代码/文本工具。

## 暂不修复（已归档）

### ISSUE-001 `ops_read` 的 spill 边界偏薄

- **现象**：2000 行全文读约 **59,968 字符**，正好在 60,000 字符 spill 线下方；文件再大一点就会从“全文”变成“预览 + `[full output id=…]` 翻页”。
- **影响**：低。属设计取舍（60k 是模型可见输出上限），但边界不直观。
- **可能方向**：按行数而非字符预估是否 spill；或在 header 提示“接近上限”。
- **状态**：已知，暂不修。

### ISSUE-002 `ops_grep` 的 `include` 非递归

- **现象**：`include: '*.mjs'` 只扫根级文件（输出 `scanned 1/1 files`），要递归必须写 `**/*.mjs`。
- **影响**：低。输出里的 `scanned X/Y` 能提示扫描范围，但容易被忽略成“没有匹配”。
- **可能方向**：`include` 不含 `**` 时自动按 `**/<pattern>` 递归。
- **状态**：已知，暂不修。

### ISSUE-009 `ops_grep` 无流式读取

- **现象**：逐文件 `readFile`（单文件 >5 MB 直接跳过，不读入内存），没有流式按行扫描。
- **影响**：正常仓库无感；超大单文件直接跳过（不会 OOM，但也不会匹配）。
- **方向**：`createReadStream` + 按行切分；可顺便把 5 MB 上限提为可配置。
- **状态**：已知，暂不修。

### ISSUE-011 `install.ps1 -Restore` 后不自动验证

- **现象**：`-Restore` 只复制文件，不跑任何自检。
- **方向**：恢复后跑 `node --check index.mjs lib/*.mjs` + 最小注册冒烟（伪 ctx），失败则提示回滚。
- **状态**：已知，暂不修。

### ISSUE-012 spill 周期性清理

- **现象**：只在插件启动时清理 7 天过期文件 + 写入时按 200 条淘汰，没有后台定时器。
- **影响**：单进程长期运行时 spill 目录最多 200 条，不会无限增长；跨进程崩溃残留靠下次启动清理。
- **方向**（可选）：定期 `cleanupExpired`。
- **状态**：已知，暂不修。

## 已移除（v2.0.0）

以下文档类工具与问题随工具删除而关闭，文档处理改用 DSH 的 `/office` 技能系列：

- `ops_read_table`（ISSUE-003 CJK 列宽、ISSUE-006 GBK/GB2312 编码）；
- `ops_read_docx`（ISSUE-008 页眉/页脚/脚注）；
- `ops_read_pdf`（ISSUE-007 PDF 密码/OCR，含 vendored pdf.js 4.10.38 与 `lib/vendor/pdfjs/`）；
- 相关 fixture：`test/doc/`、`scripts/extract_pdf_text.mjs`、`scripts/build_pdf_docx.py`。

文档工作请使用：`office-docx`、`office-xlsx`、`office-pptx`、`office-render`、`office-export-pdf`（必要时 `office-recalculate`）。

## 已实现（v1.2.0+）

- `ops_bash`：`mode: direct|service`、`login: true`、超时提示；`ops_grep` `exclude`；`ops_glob` `stat`；`ops_stat` `paths` 批量；`maxOutputChars` / `bashTimeoutMs` 配置（v1.4.0 起可设置页实时修改前者）。
- v1.3.0 新增 `ops_git`；v1.4.0 新增 Desktop 设置页（`client.js` + `lib/settings-store.mjs` + `lib/settings-route.mjs`）。

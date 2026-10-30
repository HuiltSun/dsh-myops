# dsh-myops 逐工具效率验证报告

- **时间**：2026-10-31 03:21–03:26（Asia/Shanghai）
- **环境**：Windows / Node v26.8.1 / Git Bash；工作区 `E:\dsh-myops`；插件 v1.1.0 已装入 desktop profile 并在当前会话注册
- **结论**：**9/9 工具在真实会话中可用；65/65 效率/回归用例通过；回归 0 失败**。首轮发现的超时问题与会话 cwd 问题已修复并复测；文档类工具已在 v2.0.0 移除（见文末）。

## 验证方法

1. **进程内基准**（`node test/bench.mjs`，新增）：用伪 ctx 调 `apply()` 注册全部工具后，逐工具跑真实负载，记录 `execute()` 中位耗时（`performance.now`，不含模型往返与宿主 IPC）和**模型可见输出字符数**（上下文成本）。64 个用例覆盖正常路径、分页、去重、CAS、错误路径、超时进程树清理、会话 cwd 绑定与 header 兜底、新参数与设置页。
2. **会话内实测**：9 个工具各走真实注册路径调用一次，确认安装版本可用、输出符合契约。
3. **回归**：`node test/smoke.mjs` → 31 passed / 0 failed；`node test/doc/selftest.mjs` → 0 failures。

## 逐工具结果

| 工具 | 代表性负载 | 中位耗时（进程内） | 输出体积 | 会话内实测 |
| --- | --- | --- | --- | --- |
| `ops_bash` | `echo` | **28.5 ms** | 29 ch | 正常，宿主服务路径 150–173 ms/次 |
| `ops_bash` | 超时 `sleep 3`（timeoutMs=800） | **917–925 ms** ✓ | 35 ch | 宿主服务路径 823 ms（正常） |
| `ops_bash` | `seq 1 40000`（触发 spill） | 38.3 ms | 59,997 ch 预览 | 正常（大输出落盘） |
| `ops_read` | 2000 行全文 | 3.56 ms | 59,968 ch | 正常（含截断提示） |
| `ops_read` | 重复读（去重命中） | **0.74 ms** | **172 ch**（-99.7%） | 正常 |
| `ops_read` | 窗口读 offset/limit | 0.49 ms | 1,273 ch | 正常 |
| `ops_glob` | `**/*.mjs` | 0.97 ms | 154 ch | 正常（9 个文件） |
| `ops_grep` | 全仓函数定义扫描 | 2.61 ms | 8,104 ch | 正常 |
| `ops_write` | 写入 + 自动建目录 | 1.04 ms | 104 ch | 正常（rev 返回） |
| `ops_edit` | 两处精确替换 | 1.14 ms | 162 ch | 正常（每处行号返回） |
| `ops_stat` | 文件 / 目录 | 0.45 / 0.60 ms | 163 / 120 ch | 正常（rev 与 edit 一致） |
| `ops_result` | 末页翻页 | 1.36 ms | 137 ch | 正常（`[end]` 正确） |
| `ops_read_table` | 引号 CSV / 500 行 | 0.33 / 0.70 ms | 248 / 1,500 ch | 正常（自动推断分隔符） |
| `ops_read_docx` | min.docx | 0.26 ms | 186 ch | 正常（CJK、实体、制表符） |
| `ops_read_pdf` | 6 个 fixture（含 ToUnicode/ObjStm/扫描件/加密） | 0.12–0.75 ms | 64–186 ch | 正常（中文正确解码，扫描件/加密给出 unsupported） |

> 进程内耗时是工具本身的净成本；会话内 `ops_bash` 的 150–173 ms 含宿主 subprocess 服务与进程启动开销（首次 173 ms、后续 ~150 ms）。

## 关键效率结论

1. **`bash -c` 与 `-lc` 差距确认**：28.5 ms vs 170.9 ms —— 登录 shell 每次多付约 **142 ms**（CHANGELOG 声称的 135 ms 量级吻合）。
2. **读去重收益确认**：同一 2000 行文件第二次读只花 172 字符（原 59,968），**省 99.7% 输出**，耗时 3.56 → 0.74 ms。
3. **spill 机制确认**：`seq 1 40000` 全量落盘，模型只收 59,997 字符预览；`ops_result` 翻到第 29999 行仍正确（bench 中翻到 40000 行 + `[end]`）。
4. **文档解析开销可忽略**：docx/PDF/CSV 全在 **1 ms 以内**，且错误路径（非 zip、扫描件、加密 PDF）都返回可读说明而非乱码/异常。
5. **写操作安全语义正确**：`dryRun` 不落盘、`ifNotExists` / `expectedRevision` 冲突按预期拒绝，`ops_edit` 的 0 次/多次匹配都先校验后落盘。

## 发现的问题（首轮）

1. **[中→已修复] 备用直连路径的超时没有真正生效**：首轮 `timeoutMs=800` 实测 3043 ms；已改为 `taskkill /T /F` + `DSH_MYOPS_RUN_ID` 扫描 MSYS `/proc/<pid>/environ` 杀 fork 孙进程，且直连捕获改用临时文件（见“修复后复测”）。
2. **[低→已修复] 默认工作目录是宿主进程 cwd**：已统一按 DSH `workingDirectory` 服务解析（`Session header.cwd` 兜底），显式 `workdir` / 绝对路径仍优先。
3. **[低] 60k 边界很薄**：2000 行全量读 = 59,968 字符，正好在 spill 线（60k）下方；稍大文件即切换成"预览 + 翻页"模式。
4. **[提示] `ops_grep` 的 `include` 非递归**：`include: '*.mjs'` 只扫根级文件（`scanned 1/1`），要递归需 `**/*.mjs`。
5. **[外观] `ops_read_table` 中日韩列宽按字符数对齐**，`陈小明` 等宽字符导致列轻微歪斜（内容正确）。

## 复现

```bash
node test/bench.mjs              # 81 项效率/回归用例，结果写 test/bench-report.json
npm test                         # 31 项 smoke
cd test/doc && node selftest.mjs # 文档解析自测
```

新增产物：`test/bench.mjs`（验证脚本）、`test/bench-report.json`（原始数据）；`package.json` 增加 `npm run bench`。

## 修复后复测（2026-10-31 03:33–03:41）

### 1. Windows 直连回退路径的进程树终止

- 实现：超时时并行执行 `taskkill /PID <pid> /T /F`（Windows 侧）与辅助 bash（按注入的 `DSH_MYOPS_RUN_ID` 扫描 `/proc/<pid>/environ` 后 `kill -9`）。后者覆盖 MSYS2 `fork()` 造成的孙进程（它们的 Windows `ParentProcessId` 指向已退出的 fork 辅助进程，`taskkill /T` 追不到）。
- 直连捕获从管道改为临时文件（`%TEMP%/dsh-myops-bash-*`），结束时清理；孙进程即使短暂存活也不再阻塞 `close`。
- 复测（`sleep 3` + `timeoutMs=800`，连续 5 次）：**916.4 / 924.7 / 918.6 / 919.9 / 923.3 ms（max 924.7 ms）**，全部 `timed out`、输出无 `NEVER`；结束后 `tasklist` 无 `sleep.exe` 残留，临时目录无泄漏。
- 宿主 subprocess 服务路径不受影响：实测 823 ms 正常中止。

### 2. 会话工作目录绑定

- 新增 `lib/common.mjs → resolveSessionCwd(exec, ctx)`：优先 `exec.workdir`，其次 `workingDirectory.ensure(agent)`，再退回 `agent.session.header.cwd`，最后 `process.cwd()`。
- 11 个路径型工具（`ops_read/glob/grep/write/edit/stat/read_table/read_docx/read_pdf` + `ops_bash` 默认 `workdir`）全部接入；`ops_result` 无路径不受影响。
- 复测：bench 新增 12 个用例（11 个相对路径 + 1 个 header 兜底）全部通过；显式 `workdir` 覆盖仍生效。
- 已 `install.ps1` 安装到 desktop profile（备份 `E:\.backups\myops-20261031-033924`）；**需重启 DSH 桌面端**后运行中的宿主才会加载新代码。

### 3. 回归

## v2.1.0 补充（token 优化）

按“A→B”顺序执行：A 为配置层（settings + profile patch），B 为代码层。

- A（配置）：`~/.dsh/myops-settings.json` 与 profile `cordis.patch.yml` 均改为
  `maxOutputChars: 24000`、`hideOfficial: ['pwsh','read','glob','grep','write','edit']`（需重启生效）。
- B（代码）：默认值下调（read 800 行、glob 200、grep 120）、spill 预览封顶 8k 字符、
  bash 成功调用静默、9 个工具描述/ schema 精简（9,098 → 6,401 字符）、
  `hideOfficial` 支持 write/edit。
- 实测：工具定义 ~2,527 → **~1,778 tokens/请求**；3000 行大读取可见输出
  59,968 → **8,084 字符（~2.2k tokens）**；`echo hi` 的输出从 20+ 字符降为 `hi`。
- bench 65/65、smoke 28/28。

## v2.0.0 补充（移除文档类工具）

- 按用户要求放弃 `ops_read_table` / `ops_read_docx` / `ops_read_pdf`，文档处理改由 DSH 的 `/office` 技能系列承担（`office-docx` / `office-xlsx` / `office-pptx` / `office-render` / `office-export-pdf`）。
- 删除 `lib/doc-tools.mjs`、`lib/vendor/pdfjs/`（pdf.js 4.10.38）、`test/doc/`（全部 fixture 与 `selftest.mjs`）、`scripts/` 下的 PDF→DOCX 脚本。
- bench 新增 2 个回归项：`文档类 ops 不再注册`、`文档解析代码已删除`；其余用例（bash/read/glob/grep/write/edit/stat/result/git、设置页、超时、cwd）全部保留并通过。
- 历史上方逐工具表包含已移除工具的数据，仅作记录，不再属于当前工具面。

## v1.5.0 补充（Mozilla pdf.js）

- `lib/vendor/pdfjs/` 引入 pdfjs-dist 4.10.38 legacy build（Apache-2.0，附 LICENSE/PROVENANCE），`ops_read_pdf` 优先用它，失败回退原手写解析器。
- 新增 `password` 参数；真实中文 PDF 实测从“unsupported（误判扫描件）”变为正确抽取 408 字符；第二份真实 PDF 输出 817 字符。
- bench 新增 3 项：pdf.js 模块可加载、逐行重建（simple.pdf → `1| Hello PDF …`）、password 参数传递；既有 6 个 fixture 的回归全部保持通过（pdf.js 拒绝的合成 PDF 仍由手写解析器给出原诊断）。

## v1.4.0 补充（Desktop 设置页）

- 新增 `client.js`（`settings.section`）与 `lib/settings-store.mjs` / `lib/settings-route.mjs`；设置持久化到 `$DSH_HOME/myops-settings.json`。
- bench 新增 9 个用例：store 校验/落盘、真实 HTTP 路由 GET/POST/跨源 403、修改设置后下一次工具调用即生效（`maxOutputChars` 2000 → 预览）、默认 `bashTimeoutMs=1000` 超时、`client.js` 以模块加载器格式注册 `settings.section`。
- `hideOfficial` 仍需重启生效；页面会明确提示。

## v1.3.0 补充（新增 `ops_git`）

- 新增 `lib/git-tools.mjs` → `ops_git`：`status/diff/log/show/branch/add/commit`，直接 exec git（无 shell、无网络、无分页器）。
- bench 在临时仓库上新增 9 个用例（status 未跟踪、add 显式路径、commit、log、diff --stat、diff patch、branch、show）全部通过；提交/暂存都只作用于显式 `paths`。
- 刻意不提供 push/merge/rebase/reset：这类命令仍在 `ops_bash` 里显式执行。

## v1.2.0 补充（A+B 批次：文档 + 低风险参数）

- 新增参数均已在 `test/bench.mjs` 覆盖：`ops_bash` `mode=direct`（meta 报 `mode: direct`）/ `mode=service`（无服务时直接报错、不降级）/ `login=true`（`bash -lc`）；超时输出新增 `timed out after 800ms` + `[timeout] … output is partial`；`ops_grep` `exclude`；`ops_glob` `stat=true`（size + ISO mtime）；`ops_stat` `paths` 批量（缺失项 `not found`）；`apply({maxOutputChars:300})` 后大文件读走 spill 预览（256 字符 + `[full output … id=…]`）。
- 澄清并修正了首轮清单中的 5 处不准确之处（`ops_edit` 已有 dryRun/多块、`ops_read_table` 支持 `;` 分隔符、窗口读去重已在 README、grep >5 MB 文件直接跳过、hideOfficial 重启规则已写明）。
- 文档补齐：grep `include` 非递归、grep >5 MB 跳过、glob symlink 不跟随、spill 7 天 TTL + 200 条上限与清理时机、read_table 仅 UTF-8 及错误文案、docx 加密报错、`ops_bash` 权限边界、bench 失败项含义、配置 `maxOutputChars`。
- 大功能（GBK、PDF 密码/OCR、docx 页眉页脚、grep 流式、CJK 列宽、`-Restore` 自检、spill 周期清理）已归档到 `docs/KNOWN-ISSUES.md` 的 ISSUE-006..012。

## v2.2.0 补充（设置页配置档）

- 设置页新增五个配置档按钮（token-saver / balanced / generous / debug-official / quiet-code），点击直接应用并显示当前 ✓；与 configs/myops-presets.json 同源。
- bench 新增「设置页内置配置档」断言（65 项），smoke 28 项。

## v2.2.1 补充（glob 上限对齐官方）

- `ops_glob` 结果上限 200 → 100（`MAX_GLOB_RESULTS`），与官方 `glob` 的 100 对齐；
  修正了「大 glob 比被替换的官方工具更耗 token」的反向偏差。
- 实测：500 文件全量 glob，输出 2559 → 1279 字符，单次省 ~1.3k 字符（≈360 token）。
- 同步更新 README 默认值表、CHANGELOG、用户手册（v2.2.1）与版本号。

## v2.2.2 补充（读写冲突修复）

- **读去重按智能体隔离**：此前 `index.mjs` 只有一份全局 `createReadDedup`，子智能体/队友
  读过某文件后，本体会读到 `content omitted` 桩。现按 `agent.session.id` / `agent.id`
  分实例（LRU 64），同会话内去重不受影响；smoke 新增跨智能体断言。
- **`ops_edit` 支持 `expectedRevision`**：与 `ops_write` 同语义的 sha256 前缀 CAS，
  失配报 `revision mismatch` 且不写盘；此前“读完→他人修改→edit”会静默覆盖。
- **`ops_read` 头部输出 `rev <8>`**：读→改→校验可直接把 rev 传给 `expectedRevision`，
  不必再调 `ops_stat`。
- smoke 28 → 34 项，bench 65 项全通过。

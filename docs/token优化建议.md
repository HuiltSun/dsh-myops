# dsh-myops token 优化建议

> 目标：进一步降低每一轮请求与每一次工具调用的 token 开销。
> 依据：对 `index.mjs`、`lib/*.mjs`、`configs/myops-presets.json`、`README.md` 的静态阅读；
> 文中数字凡标"估算"的均为字符数量级推算，未实测。

## 现状基线（已经做得好的部分）

- 大输出 spill 落盘 + `ops_result` 分页，预览封顶 ≤8k 字符；
- `ops_read` 按会话/智能体去重，重复读只回一行 stub；
- bash 成功输出静默（不打 `[exit code: 0]`），耗时只在慢调用/失败时打印；
- `ops_git` status 文件列表封顶 40、diff 默认 `--stat`、log 单行；
- `ops_grep` 跳过二进制与 >5 MB 文件，单行截 400 字符；
- glob 上限 100 与官方对齐。

以下建议按"收益 ÷ 风险"排序。

---

## P0 · 每次请求都付的固定开销

### 1. 默认开启 hideOfficial（最大单项收益）

当前三处默认值都是"不隐藏"：

- `lib/settings-store.mjs` 的 `SETTINGS_DEFAULTS.hideOfficial = []`
- 仓库根 `cordis.patch.yml` 模板只 insert、不带 config
- README 也写明 "By default the plugin only *adds* the ops tools"

结果：默认安装下，每个请求同时携带 **官方 6 个工具的 schema + ops 9 个工具的 schema**。
官方工具描述通常比 ops 版更长（估算 6 个合计 ≥3k 字符 / ≥900 token，每轮都付），
而且模型可能误选官方工具，产生一次失败/绕路的额外轮次。

建议：把默认改为隐藏全部 6 个（`SETTINGS_DEFAULTS`、patch 模板、`configs` 里的默认档三处对齐），
调试需求交给 `debug-official` 预设显式打开。README 中"默认只新增"一节同步修改。

### 2. 精简 9 个工具的 description 与参数描述

README 实测定义合计 ~6.4k 字符（~1.8k token），且**每次请求整段重发**。仍可砍 25–35%（估算）。
三类内容对模型无用，属于"给人看的文档"或"内部实现细节"：

| 位置 | 现文 | 建议 |
| --- | --- | --- |
| `ops_bash.description` | `...full user privileges, not sandboxed. On timeout the output is partial and the process tree is terminated.` | 整句删除（安全提示写 README 即可，模型据此行动无增益） |
| `ops_bash.mode` 描述 | `auto: service then direct; direct: force fallback; service: require service.` | 实现细节。`mode` 是调试参数，建议整体从 schema 移除、改由 settings/env 控制；保留的话压成 `debug: force exec path` |
| `ops_bash.login` 描述 | `Use bash -lc (sources profile). Default false (bash -c, faster).` | 压成 `Load profile env (slower).` |
| `path` 参数描述 | `Absolute or session-relative path.` 在 read/write/edit/stat 出现 4 次，另有 3 处 `Defaults to session working directory.` | 统一压成 `Path.` / `Dir.`；行为放不进描述也不影响使用（模型见过一次输出就会） |
| `ops_edit.description` | `...all edits are atomic (nothing written on failure). ... Matching normalizes CRLF/CR as LF; output file uses LF.` | 语义可保留一句 `Exact-match, each oldText must be unique; atomic.`，行尾归一化细节删除 |
| `ops_write.description` | `...Returns Wrote N lines (B bytes) to <path> (rev).` | 返回值格式模型见一次即知，删除 |
| `expectedRevision` 描述 | 两处约 100 字符长句 | 压成 `CAS guard: fail unless file sha256 starts with this prefix.` 一处即可 |
| `ops_result.description` | 约 260 字符 | 保留 `[more]/[end]` 语义，删除重复的用法引导 |

另：JSON schema 的 `additionalProperties: false` 等结构性字段开销无法避免，但**枚举、必填名、类型名都是每轮重复付**——新增参数前问一下"模型真会用吗"（典型反例：`mode`）。

### 3. 工具数收敛的长期选项

`ops_stat` 与 `ops_glob(stat:true)`、`ops_read` 头部信息高度重叠。若愿意承担一次行为变更，
可把 stat 能力并入 read/glob（或给 ops_stat 加 `in: [...]` 后退役独立工具），每轮省一整条 schema。
收益中等、风险中等，放 P2。

---

## P1 · 每次调用的输出体积（会随会话历史反复计费）

工具结果一旦进入上下文，后续每一轮都会随历史重发（若宿主无上下文裁剪/缓存，成本是乘性的）。
**首屏输出越小，收益越大**——这比截断上限本身更关键。

### 4. spill 预览下限 8k 太高，且 token-saver 档名不副实

`lib/output-spill.mjs`：`previewBudget = min(limit, max(8_000, limit/3))`。
`maxOutputChars=12000`（token-saver 档）时预览仍是 **8000 字符**，占满上限的 2/3——"极致省 token"
实际只约束了未超限的小输出。建议：预览下限改为独立可配项（默认 4k），随 settings 文件热生效。
权衡：预览变小 → `ops_result` 翻页轮次变多，每页也有 header/footer 固定开销；4k 是较稳妥的折中。

### 5. hint 文案重复 id、重复元数据

`[full output "ops_bash" id=abc123, 45678 bytes, 900 lines; call ops_result(id="abc123") to page]`
同一 id 出现两次、label 对模型无增益（每次 spill 都付 ~40 冗余字符）。压成
`[spilled id=abc123 (45678B/900 lines) → ops_result(id)]` 之类，一次调用省 30–50 字符，量大管饱。

### 6. `ops_grep` 单行 400 字符上限偏松

最坏 120 匹配 × 400 字符 ≈ 48k > 默认 24k 上限 → 必然触发 spill + 翻页一次往返。
建议行截断降到 ~200，或给 matches 总段加字符预算（先按总预算装满、剩余标 `+N more`）。
压缩/单行 JSON 文件里 400 字符的截断行对模型定位价值也有限。

### 7. `ops_read` 行号固定 4 位补零 + 绝对路径头

- `padStart(Math.max(4, width))`：300 行的文件每行仍是 ` 123| `，多打 2–3 个空格；
  800 行约多 ~2k 字符（估算）。改为按实际位数 `padStart(width)`。
- 头行 `File: E:/很长/的/绝对/路径/...`：当目标在会话 cwd 内时改显相对路径，
  长路径仓库每读一次省 20–60 字符（grep/glob 已用相对路径，read 对齐即可）。

### 8. `ops_glob(stat: true)` 的 ISO mtime 太长

`2026-10-31T02:59:40.1234567Z` 约 30 字符 × 100 文件 ≈ 3k 字符，毫秒与对模型几乎无用。
改日期（必要时到分钟）即可。

### 9. bash 超时提示句

`[timeout] ... Child processes were terminated on a best-effort basis — a few may survive briefly in fallback mode.`
后半句是实现细节，压成 `[timeout] output above is partial` 即可（失败路径本来低频，收益小，顺手做）。

---

## P2 · 让阈值可配，而不是写死

当前只有 `maxOutputChars` / `bashTimeoutMs` 走 settings 热更新。建议把以下常量纳入
`myops-settings.json` + 设置页 + presets（都只需加字段、改 `outputLimitNow` 式读取点）：

| 常量 | 现值 | 位置 | 为什么值得暴露 |
| --- | --- | --- | --- |
| `DEFAULT_READ_LINES` | 800 | `lib/common.mjs` | 长会话里首屏 800 行是最大单笔历史负担，激进用户想降到 200–300 |
| `MAX_GREP_MATCHES` | 120 | `lib/common.mjs` | 与 grep 单行截断配套 |
| `MAX_GLOB_RESULTS` | 100 | `lib/common.mjs` | 大仓用户会想降到 50 |
| spill 预览上限 | 8000（写死） | `lib/output-spill.mjs` | 即上文第 4 条 |
| 行号/路径显示开关 | 无 | read | 可选 `compact: true` |

同时给 `token-saver` 预设配套收紧这组值（如 read 300 / grep 60×200 / glob 50 / 预览 4000），
让"预设"名副其实。

---

## 优先级汇总

| 优先级 | 动作 | 预计收益 | 风险 |
| --- | --- | --- | --- |
| P0-1 | hideOfficial 默认全开 | 每轮省官方 6 工具 schema（估 ≥900 token）+ 消除误选轮次 | 低（重启生效，已有预设验证过） |
| P0-2 | 精简工具描述/移除 mode | 每轮省 ~400–600 token（估） | 低，纯文案 |
| P1-4 | 预览下限 8k→4k 可配 | 每次大输出省 ~4k 字符且随历史反复计费 | 中（翻页轮次略增） |
| P1-6 | grep 单行 400→200 | 减少一次 spill 往返 | 低 |
| P1-7/8 | 行号补零/相对路径/mtime 格式 | 每次调用省几十到两千字符 | 低 |
| P2 | 阈值入 settings | 把选择权交给用户 | 低 |

## 验证方法

1. 用现有 `test/bench.mjs` 的 latency/output-cost 用例回归，确认无行为破坏；
2. 加一个"字符数快照"测试：对 9 个工具定义的 description+schema 直接 `JSON.stringify` 计长，
   把"≤N 字符"作为断言，防止文案膨胀悄悄回退（这类回归最难靠肉眼发现）；
3. 改动前后各跑一轮固定脚本（read 大文件 / grep 大仓 / bash 长输出），对比
   `store.present` 出口字符数与 `ops_result` 调用次数。

---

## 实施状态（v2.3.0，2026-10-31）

| 条目 | 状态 | 实测 |
| --- | --- | --- |
| P0-1 hideOfficial 默认全开 | ✅ 已完成 | `SETTINGS_DEFAULTS` + presets + 设置页默认值 |
| P0-2 精简 description | ✅ 已完成 | 9 个定义 6411 → **5504 字符（-14%）**；`mode` 参数保留（bench 覆盖 direct/service），描述压成调试用语 |
| P1-4 预览下限 8k→4k 可配 | ✅ 已完成 | `settings.previewChars`（默认 4000，热生效），预览 = max(下限, cap/4)；`seq 40000` 8110 → **6073 字符** |
| P1-5 hint 文案重复 id | ✅ 已完成 | `[full output id="…" (…B/… lines); page with ops_result]`，每次 spill 省 ~40 字符 |
| P1-6 grep 单行 400→200 | ✅ 已完成 | — |
| P1-7 行号补零 / 相对路径 | ✅ 已完成 | 行号按实际宽度；会话 cwd 内显示相对路径 |
| P1-8 glob mtime 精简 | ✅ 已完成 | `(1234B, 2026-10-31 02:59)`，每文件省 ~14 字符 |
| P1-9 bash 超时文案 | ✅ 已完成 | 删除 best-effort 实现细节句 |
| P2 阈值全部入 settings | ⏳ 未做 | `DEFAULT_READ_LINES`/`MAX_GREP_MATCHES`/`MAX_GLOB_RESULTS` 仍为常量（`previewChars` 已先行入 settings） |

验证：bench **67/67**（新增「工具定义体积 ≤ 5600 字符」快照断言，防文案回退）、smoke **34/34**。

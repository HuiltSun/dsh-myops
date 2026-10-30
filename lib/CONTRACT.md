# lib 模块契约

`index.mjs` 是插件入口，**由 Lead 独占维护**。子智能体只写自己名下的 `lib/*.mjs`，
不要改 `index.mjs`、`lib/common.mjs` 或其他人的文件。

## 共同要求

- 纯 ESM，只允许 `node:` 内置模块，**不允许任何 npm 依赖**。
- 只读 `lib/common.mjs` 的导出，不要重复实现。
- 每个工具模块导出一个 `buildXxxTools(deps)` 工厂，返回**工具定义数组**；
  工具定义形状：

```js
{
  name: 'ops_xxx',
  description: '模型可见的说明（英文，简短）',
  parameters: { type: 'object', properties: {...}, required: [...], additionalProperties: false },
  output: OUTPUT,               // 从 lib/common.mjs 引入
  isConcurrencySafe: () => true | false,
  async execute(args, exec) { return '字符串'; },  // 必须返回 string
}
```

- `execute` 抛异常表示失败；正常结果一律返回字符串。
- 输出要紧凑：给模型的文本尽量少但信息完整。
- 文件头写一段注释说明该模块用途。
- 完成后必须自测：`node --check <你的文件>`，并用伪 ctx 跑通每个工具。

## node 可执行文件

```
<DSH 安装目录>\resources\runtime\x64\primary-runtime\dependencies\node\bin\node.exe
```

## 模块分配

| 文件 | 负责人 | 导出 |
| --- | --- | --- |
| `lib/write-tools.mjs` | 子智能体 A | `buildWriteTools(deps)` → `ops_write`、`ops_edit`、`ops_stat` |
| `lib/output-spill.mjs` | 子智能体 B | `createSpillStore(options)`、`buildResultTool(store)` → `ops_result` |
| `lib/read-dedup.mjs` | 子智能体 C | `createReadDedup(options)` |

## 各模块接口

### A. `lib/write-tools.mjs`

```js
export function buildWriteTools(deps = {}) // deps 目前为空，可忽略
```

- `ops_write`：`{ path, content, dryRun?, createDirs?, expectedRevision?, ifNotExists? }`
  - 默认自动建父目录；写 UTF-8（行尾统一 `\n`）。
  - 文件已存在且传了 `expectedRevision` 时必须匹配当前内容 sha256 前缀，否则报错。
  - `ifNotExists: true` 时文件已存在则报错。
  - 返回如 `Wrote 42 lines (1234 bytes) to E:/a/b.txt (rev 1a2b3c4d)`；`dryRun` 时返回计划不落盘。
- `ops_edit`：`{ path, edits: [{ oldText, newText }], dryRun?, expectedRevision? }`
  - 每个 `oldText` 必须**恰好出现一次**，0 次或多次都报错并说明次数。
  - 按顺序应用，全部成功才写盘（先算好新内容），返回每个编辑的起始行号与总行数变化。
  - `expectedRevision` 与 `ops_write` 同义：先用当前内容 sha256 前缀校验，失配报 `revision mismatch` 且不写盘；
    不带该参数时为 last-writer-wins（并发场景请显式传）。
- `ops_stat`：`{ path }`
  - 文件：type/size/mtime/是否为文本/行数（<5MB 时）/sha256 前缀。
  - 目录：条目数、子目录数、总大小（只算一层）。

### B. `lib/output-spill.mjs`

```js
export function createSpillStore(options = {}) // { dir?, maxAgeMs?, maxEntries? }
export function buildResultTool(store)         // → [ops_result def]
```

- `store.put(text, { label })` → `{ id, path, bytes, lines }`，把完整内容写到磁盘。
- `store.read(id, { offset = 1, limit = 500 })` → 带行号的片段 + `[more: offset=N]` 提示。
- `store.present(text, { limit, label, previewChars })` → 短文本原样返回；超限时返回
  小预览 + `[full output id="xxx" (131072B/900 lines); page with ops_result]`。
  预览 = `max(previewChars, floor(limit/4))`，`previewChars` 由 `settings.previewChars` 传入（默认 4000）。
- 目录默认 `os.tmpdir()/dsh-myops-spill`；id 用短随机串，文件名安全。
- 启动时清理超过 `maxAgeMs` 的旧文件（默认 7 天），失败静默。
- `ops_result` 参数：`{ id, offset?, limit? }`。

### C. `lib/read-dedup.mjs`

```js
export function createReadDedup(options = {}) // { maxEntries? }
```

- `observe(path, text)` → `{ unchanged, revision, previousRevision?, readCount }`
  - 键为规范化绝对路径（大小写不敏感）。
  - 内容 sha256 未变则 `unchanged: true`，并累计 `readCount`。
  - 插件在 `index.mjs` 里按 owner（`agent.session.id` / `agent.id`）各建一个实例：
    读去重状态**绝不跨智能体共享**，否则子智能体/队友读过即会让调用方看到假 `unchanged` 桩。
- `forget(path)`、`reset()`、`size`。
- 纯内存，LRU 上限默认 512。不要自己读文件，调用方传入已读内容。

### D. `lib/settings-store.mjs`

```json
{ "maxOutputChars": 24000, "previewChars": 4000, "bashTimeoutMs": 120000,
  "hideOfficial": ["pwsh", "read", "glob", "grep", "write", "edit"] }
```

- `normalizeSettings()` 校验并补默认值：`previewChars` 200–200000，越界回落默认。
- `hideOfficial` 默认屏蔽全部 6 个官方工具；设置文件存在时以文件为准。
- `maxOutputChars` / `previewChars` / `bashTimeoutMs` 下一次工具调用生效；
  `hideOfficial` 在插件加载时应用（需重启）。

### E. 文档类工具（已移除）

`ops_read_table` / `ops_read_docx` / `ops_read_pdf` 已从插件移除。文档（CSV、DOCX、
XLSX、PPTX、PDF）统一交给 DSH 的 `/office` 系列技能处理；插件只负责代码/文本工具。

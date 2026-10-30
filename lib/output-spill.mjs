/**
 * lib/output-spill.mjs — 大输出落盘（spill）与分页续读。
 *
 * 为什么需要：模型上下文只能装下有限字符。工具输出超过上限时，把完整内容写到
 * 临时目录里的一个文件，只把截断预览和 `id` 交给模型；模型再通过 `ops_result`
 * 按行分页读取剩余内容。这样长日志/长列表不会一次性灌爆上下文，也不会丢数据。
 *
 * 设计约束：
 *   - 只用 `node:` 内置模块，无 npm 依赖。
 *   - 默认目录 `os.tmpdir()/dsh-myops-spill`，id 是短 hex 随机串，文件名 `<id>.txt`
 *     只含 [0-9a-f]，绝不包含路径分隔符（同时避免任何用户输入进入路径）。
 *   - 可选 `<id>.json` 侧车文件只存 label/bytes/lines 元数据，写入失败静默忽略。
 *   - 构造时清理过期文件（默认 7 天），任何失败静默忽略；写入时按条数上限淘汰最旧的。
 *   - 所有面向模型的错误都是可读字符串。
 *
 * 导出：
 *   createSpillStore({ dir?, maxAgeMs?, maxEntries? })
 *     - put(text, { label })            → { id, path, bytes, lines }
 *     - read(id, { offset?, limit? })   → 带行号片段 + 末尾 [more: offset=N] / [end]
 *     - present(text, { limit?, label? }) → 未超限原样返回；超限返回预览 + id 提示
 *   buildResultTool(store)              → [ops_result 工具定义]
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    MAX_OUTPUT_CHARS,
    OUTPUT,
    capText,
    numberLines,
    requireString,
    splitLines,
} from './common.mjs';

const DEFAULT_DIR = join(tmpdir(), 'dsh-myops-spill');
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_READ_LIMIT = 500;
const MAX_READ_LIMIT = 5_000;
// spill 预览下限（字符）：超过上限时只回这么多预览 + 一行提示，其余用 ops_result 翻页。
const DEFAULT_PREVIEW_CHARS = 4_000;
// 单次分页返回的字符上限：行数限制之外的第二道闸，防止超长单行撑爆上下文。
const MAX_FRAGMENT_CHARS = MAX_OUTPUT_CHARS;

const ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const SPILL_FILE_RE = /^([A-Za-z0-9_-]{4,64})\.(txt|json)$/;

/** 把任意输入收敛成整数选项（非法值用 fallback，越界钳到 [min, max]）。 */
function intOption(value, fallback, min, max) {
    if (value === undefined || value === null || value === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
}

/** 校验并返回 spill id；非法 id 直接报错，绝不让它参与路径拼接。 */
function normalizeId(value) {
    const id = requireString(value, 'id');
    if (!ID_RE.test(id)) {
        throw new Error(
            `invalid output id ${JSON.stringify(id)}: expected 4-64 characters of A-Z, a-z, 0-9, "_" or "-"`,
        );
    }
    return id;
}

/** label 只用于展示：压成单行并截断。 */
function cleanLabel(value) {
    if (typeof value !== 'string') return '';
    const oneLine = value.replace(/\s+/g, ' ').trim();
    if (!oneLine) return '';
    return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}

/**
 * 创建 spill 存储。参数：
 *   dir        落盘目录，默认 os.tmpdir()/dsh-myops-spill
 *   maxAgeMs   构造时清理早于该时长（毫秒）的文件，默认 7 天；<= 0 表示“全部清理”
 *   maxEntries 目录内最多保留的条数（<= 0 时回落默认值），写入时淘汰最旧文件
 * 构造本身不抛异常：目录建不出来会在第一次 put 时以可读错误暴露。
 */
export function createSpillStore(options = {}) {
    const dir = typeof options.dir === 'string' && options.dir.trim()
        ? options.dir.trim()
        : DEFAULT_DIR;
    const maxAgeMs = Number.isFinite(options.maxAgeMs) && options.maxAgeMs >= 0
        ? options.maxAgeMs
        : DEFAULT_MAX_AGE_MS;
    const maxEntries = Number.isFinite(options.maxEntries) && options.maxEntries > 0
        ? Math.floor(options.maxEntries)
        : DEFAULT_MAX_ENTRIES;

    // id → label 的内存缓存（Map 插入序即 LRU 淘汰顺序）；读侧车失败时回退到磁盘。
    const labels = new Map();

    try { mkdirSync(dir, { recursive: true }); } catch { /* 第一次 put 时再报 */ }
    cleanupExpired();

    function txtPath(id) {
        return join(dir, `${id}.txt`);
    }

    function metaPath(id) {
        return join(dir, `${id}.json`);
    }

    function ensureDir() {
        try {
            mkdirSync(dir, { recursive: true });
        } catch (error) {
            throw new Error(`cannot create spill directory ${dir}: ${error?.message ?? error}`);
        }
    }

    /** 删除过期 spill 文件；只碰本模块自己的文件名，失败静默。 */
    function cleanupExpired() {
        let names;
        try { names = readdirSync(dir); } catch { return; }
        const now = Date.now();
        for (const name of names) {
            if (!SPILL_FILE_RE.test(name)) continue;
            const full = join(dir, name);
            try {
                const stat = statSync(full);
                if (!stat.isFile()) continue;
                // maxAgeMs <= 0：一律视为过期（便于测试与显式清空）。
                if (maxAgeMs <= 0 || now - stat.mtimeMs > maxAgeMs) unlinkSync(full);
            } catch { /* 并发删除/权限问题都忽略 */ }
        }
    }

    /** 按 maxEntries 淘汰最旧文件；protectId 是刚写入的 id，绝不在本轮被删。 */
    function pruneEntries(protectId) {
        let names;
        try { names = readdirSync(dir); } catch { return; }
        const files = [];
        for (const name of names) {
            const match = SPILL_FILE_RE.exec(name);
            if (!match || match[2] !== 'txt') continue;
            try {
                const stat = statSync(join(dir, name));
                if (stat.isFile()) files.push({ id: match[1], mtime: stat.mtimeMs });
            } catch { /* ignore */ }
        }
        if (files.length <= maxEntries) return;
        let excess = files.length - maxEntries;
        files.sort((a, b) => a.mtime - b.mtime);
        for (const { id } of files) {
            if (excess <= 0) break;
            if (id === protectId) continue;
            try { unlinkSync(txtPath(id)); } catch { /* ignore */ }
            try { unlinkSync(metaPath(id)); } catch { /* ignore */ }
            labels.delete(id);
            excess -= 1;
        }
    }

    /** 分配一个不与现有文件冲突的短随机 id（12 位 hex）。 */
    function allocateId() {
        for (let attempt = 0; attempt < 32; attempt += 1) {
            const id = randomBytes(6).toString('hex');
            if (labels.has(id)) continue;
            if (existsSync(txtPath(id)) || existsSync(metaPath(id))) continue;
            return id;
        }
        throw new Error('could not allocate a spill file id');
    }

    function rememberLabel(id, label) {
        if (!label) return;
        labels.set(id, label);
        while (labels.size > maxEntries) {
            const oldest = labels.keys().next();
            if (oldest.done) break;
            labels.delete(oldest.value);
        }
    }

    /** 读取 label：先内存，再侧车文件；都没有就返回空串。 */
    function labelFor(id) {
        const known = labels.get(id);
        if (typeof known === 'string' && known) return known;
        try {
            const meta = JSON.parse(readFileSync(metaPath(id), 'utf8'));
            const label = cleanLabel(meta?.label);
            if (label) {
                labels.set(id, label);
                return label;
            }
        } catch { /* 元数据可选 */ }
        return '';
    }

    /**
     * 把完整文本写到磁盘。
     * @returns {{ id: string, path: string, bytes: number, lines: number }}
     */
    function put(text, putOptions = {}) {
        const content = typeof text === 'string' ? text : String(text ?? '');
        const label = cleanLabel(putOptions?.label);
        ensureDir();

        const id = allocateId();
        const filePath = txtPath(id);
        const bytes = Buffer.byteLength(content, 'utf8');
        try {
            writeFileSync(filePath, content, 'utf8');
        } catch (error) {
            throw new Error(`cannot spill output to ${filePath}: ${error?.message ?? error}`);
        }
        const lines = splitLines(content).length;

        rememberLabel(id, label);
        try {
            writeFileSync(
                metaPath(id),
                JSON.stringify({
                    id,
                    label: label || undefined,
                    bytes,
                    lines,
                    createdAt: Date.now(),
                }),
                'utf8',
            );
        } catch { /* 侧车元数据失败不影响主流程 */ }

        pruneEntries(id);
        return { id, path: filePath, bytes, lines };
    }

    /**
     * 按行读取一段已落盘输出，带行号；末尾给出续读偏移或 [end]。
     * id 不存在时抛可读错误。
     */
    function read(idValue, readOptions = {}) {
        const id = normalizeId(idValue);
        const filePath = txtPath(id);

        let content;
        try {
            content = readFileSync(filePath, 'utf8');
        } catch {
            throw new Error(
                `unknown output id "${id}": no spilled output at ${filePath}. ` +
                'Use the id printed in a "[full output id=...]" hint.',
            );
        }

        const lines = splitLines(content);
        const total = lines.length;
        let bytes = 0;
        try { bytes = statSync(filePath).size; } catch { bytes = Buffer.byteLength(content, 'utf8'); }
        const label = labelFor(id);
        const labelText = label ? ` "${label}"` : '';

        const offset = intOption(readOptions?.offset, 1, 1, Number.MAX_SAFE_INTEGER);
        const limit = intOption(readOptions?.limit, DEFAULT_READ_LIMIT, 1, MAX_READ_LIMIT);

        if (total === 0) {
            return `Output ${id}${labelText} is empty (0 lines).\n[end]`;
        }
        if (offset > total) {
            return `Output ${id}${labelText} has ${total} lines; offset ${offset} is past the end. No more content.\n[end]`;
        }

        // 行数按 limit 截取，再按字符数二次收缩，保证单页不会过大。
        let count = Math.min(limit, total - offset + 1);
        let body = '';
        for (;;) {
            body = numberLines(lines.slice(offset - 1, offset - 1 + count), offset);
            if (body.length <= MAX_FRAGMENT_CHARS || count === 1) break;
            count = Math.max(1, Math.floor(count / 2));
        }
        if (body.length > MAX_FRAGMENT_CHARS) {
            const capped = capText(lines[offset - 1], MAX_FRAGMENT_CHARS - 200);
            body = numberLines(
                [`${capped.text}${capped.truncated ? ' …[line truncated]' : ''}`],
                offset,
            );
        }

        const end = offset + count - 1;
        const windowed = offset > 1 || end < total;
        const header = `Output ${id}${labelText} (${total} lines, ${bytes} bytes)` +
            (windowed ? `, lines ${offset}-${end}` : '');
        const footer = end < total ? `[more: offset=${end + 1}]` : '[end]';
        return `${header}\n${body}\n${footer}`;
    }

    /**
     * 短文本原样返回；超限时落盘并返回截断预览 + `[full output id=...]` 提示。
     * 落盘失败时退化为纯截断（提示里说明原因），绝不因此让工具失败。
     */
    function present(text, presentOptions = {}) {
        const content = typeof text === 'string' ? text : String(text ?? '');
        const limit = intOption(presentOptions?.limit, MAX_OUTPUT_CHARS, 1, Number.MAX_SAFE_INTEGER);
        const capped = capText(content, limit);
        if (!capped.truncated) return content;

        const label = cleanLabel(presentOptions?.label);
        let info;
        try {
            info = put(content, { label });
        } catch (error) {
            return `${capped.text}\n[output truncated at ${limit} chars; ` +
                `full output could not be spilled: ${error?.message ?? error}]`;
        }

        const hint = `[full output id="${info.id}" (${info.bytes}B/${info.lines} lines); page with ops_result]`;
        // 预览与提示共享 limit，但预览本身封顶：spill 的意义就是少喂 token，
        // 大上限（如 24000/60000）不再意味着把整段上限都回给模型。
        // 下限默认 4000（可通过 settings.previewChars 热调），并随 limit 按 1/4 增长。
        const previewMin = intOption(presentOptions?.previewChars, DEFAULT_PREVIEW_CHARS, 100, Number.MAX_SAFE_INTEGER);
        const previewBudget = Math.min(limit, Math.max(previewMin, Math.floor(limit / 4)));
        let previewLimit = Math.min(previewBudget, limit - hint.length - 2);
        if (previewLimit < Math.min(limit, 80)) previewLimit = Math.min(limit, Math.max(0, limit - hint.length - 2));
        if (previewLimit < 0) previewLimit = 0;
        let preview = content.slice(0, previewLimit);
        // 尽量停在整行边界，避免预览以半行结尾。
        const lastNewline = preview.lastIndexOf('\n');
        if (lastNewline > preview.length * 0.6) preview = preview.slice(0, lastNewline);
        return `${preview}${preview ? '\n' : ''}${hint}`;
    }

    return {
        dir,
        maxAgeMs,
        maxEntries,
        put,
        read,
        present,
        cleanup: cleanupExpired,
    };
}

/**
 * 生成 `ops_result` 工具定义；`store` 必须来自 `createSpillStore`。
 * 该工具只读、可并发。
 */
export function buildResultTool(store) {
    if (!store || typeof store.read !== 'function') {
        throw new Error('buildResultTool(store) requires the store returned by createSpillStore()');
    }

    return [{
        name: 'ops_result',
        description:
            'Page a large tool output spilled to disk by its id. Returns numbered lines ending with ' +
            '"[more: offset=N]" or "[end]".',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Spill id from a "[full output id=...]" hint.' },
                offset: { type: 'number', description: '1-based line to start from. Defaults to 1.' },
                limit: {
                    type: 'number',
                    description: `Maximum number of lines to return. Defaults to ${DEFAULT_READ_LIMIT}.`,
                },
            },
            required: ['id'],
            additionalProperties: false,
        },
        output: OUTPUT,
        isConcurrencySafe: () => true,
        async execute(args) {
            const id = requireString(args?.id, 'id');
            return store.read(id, { offset: args?.offset, limit: args?.limit });
        },
    }];
}

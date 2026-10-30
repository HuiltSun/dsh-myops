/**
 * lib/common.mjs — 所有工具模块共享的常量与纯函数。
 * 由 Lead 维护；子智能体只读不改。
 */

import { sep, isAbsolute, resolve as resolvePath, join } from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_OUTPUT_CHARS = 60_000;
export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const MAX_GLOB_RESULTS = 500;
export const MAX_GREP_MATCHES = 300;
export const DEFAULT_READ_LINES = 2_000;
export const MAX_READ_BYTES = 5_000_000;

export const SEP = sep;

/** 截断文本并如实报告是否被截断。 */
export function capText(text, limit = MAX_OUTPUT_CHARS) {
    if (typeof text !== 'string') text = String(text ?? '');
    if (text.length <= limit) return { text, truncated: false, chars: text.length };
    return { text: text.slice(0, limit), truncated: true, chars: text.length };
}

/** 去掉 ANSI 转义序列。 */
export function stripAnsi(text) {
    // eslint-disable-next-line no-control-regex
    return String(text ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

/** Windows 反斜杠路径转 posix 风格，便于展示与匹配。 */
export function toPosix(p) {
    const s = String(p ?? '');
    return SEP === '\\' ? s.split('\\').join('/') : s;
}

/** 相对路径按 base 解析成绝对路径。 */
export function resolveWorkdir(workdir, base = process.cwd()) {
    if (!workdir) return base;
    return isAbsolute(workdir) ? workdir : resolvePath(base, workdir);
}

/** 可复现的 bash 环境（无颜色、无分页器）。 */
export function shellEnv(extra) {
    return {
        ...process.env,
        NO_COLOR: '1',
        TERM: 'dumb',
        PAGER: 'cat',
        GIT_PAGER: 'cat',
        ...(extra ?? {}),
    };
}

/** 工具返回值统一转成模型可见文本。 */
export function asText(value) {
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

/** 所有工具共用的输出契约（当前桌面端只接受 string）。 */
export const OUTPUT = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: asText(value) }],
};

/** 参数校验：必填字符串。 */
export function requireString(value, name) {
    const s = typeof value === 'string' ? value.trim() : '';
    if (!s) throw new Error(`${name} is required`);
    return s;
}

/** 单行摘要用：把多行文本压成一行。 */
export function firstLine(text, max = 120) {
    const line = String(text ?? '').split(/\r?\n/, 1)[0] ?? '';
    return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** 内容摘要（sha256，短前缀），用于 CAS 与去重。 */
export function hashText(text, length = 16) {
    return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, length);
}

/** 判断相对路径是否命中 .git / node_modules 排除规则。 */
export function isExcludedPath(p) {
    const s = toPosix(p);
    return s.includes('/.git/') || s.startsWith('.git/')
        || s.includes('/node_modules/') || s.startsWith('node_modules/');
}

/** 按行拆分并修正末尾换行造成的多余空行。 */
export function splitLines(text) {
    const lines = String(text ?? '').split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return lines;
}

/** 给行号加上对齐前缀。 */
export function numberLines(lines, startLine, width) {
    const w = Math.max(4, width ?? String(startLine + lines.length).length);
    return lines.map((line, i) => `${String(startLine + i).padStart(w)}| ${line}`).join('\n');
}

export { join };

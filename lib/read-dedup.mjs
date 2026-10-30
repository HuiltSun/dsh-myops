/**
 * lib/read-dedup.mjs — 读去重：按路径记住上一次读到的内容摘要（sha256），
 * 内容没变时让 ops_read 只回一行提示，省掉重复的上下文。
 *
 * 用法（由 index.mjs 调用）：
 *   const dedup = createReadDedup();            // { maxEntries = 512 }
 *   const info = dedup.observe(absPath, text);  // 调用方已经读完文件
 *   if (info.unchanged) 返回简短提示（rev 用 info.revision）
 *   else                返回全文（revision 可用于后续 expectedRevision）
 *
 * 语义：
 *   - 只要之前观察过该路径，结果就带 previousRevision：
 *       unchanged=true  → previousRevision === revision（上次记录的就是这一版）；
 *       unchanged=false → previousRevision 是变化前那一版的摘要。
 *   - readCount 是该路径累计被读取的次数（内容变化不清零；仅首次观察、forget、
 *     reset 或 LRU 淘汰后再观察时重新从 1 开始）。
 *   - 键为规范化绝对路径：相对路径按 baseDir（默认创建时的 cwd）解析，
 *     末尾分隔符去掉；Windows 下统一小写，做到大小写不敏感。
 *   - 纯内存 Map + LRU：每次 observe 都把条目移到最新，条目数超过 maxEntries
 *     （默认 512）时淘汰最久未使用的。
 *   - 本模块不读文件、不落盘、不依赖任何 npm 包；内容由调用方传入。
 */

import { Buffer } from 'node:buffer';
import { resolve as resolvePath, sep } from 'node:path';
import { hashText } from './common.mjs';

const DEFAULT_MAX_ENTRIES = 512;

/** 把 maxEntries 规整成正整数；非法值回退默认值。 */
function normalizeMaxEntries(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_ENTRIES;
  return Math.floor(n);
}

/** 调用方可能传字符串、Buffer 或空值；统一成待哈希的文本。 */
function coerceText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return String(value);
}

/** 去掉末尾分隔符，但保留根：`C:\`、`/`、`\\srv\share\`。 */
function stripTrailingSeparators(p) {
  if (p === '/' || p === '\\') return p;
  if (/^[A-Za-z]:[\\/]$/.test(p)) return p;
  if (/^\\\\[^\\/]+[\\/][^\\/]+[\\/]$/.test(p)) return p;
  let out = p;
  while (out.length > 1 && (out.endsWith('/') || out.endsWith('\\'))) {
    out = out.slice(0, -1);
  }
  return out;
}

export function createReadDedup(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const maxEntries = normalizeMaxEntries(opts.maxEntries);
  // 契约要求键大小写不敏感；Windows 文件系统本身不区分大小写，其他平台可用
  // caseInsensitive 显式覆盖（POSIX 上区分大小写才是对的）。
  const caseInsensitive = typeof opts.caseInsensitive === 'boolean'
    ? opts.caseInsensitive
    : sep === '\\';
  const baseDir = typeof opts.baseDir === 'string' && opts.baseDir
    ? resolvePath(opts.baseDir)
    : process.cwd();

  /** @type {Map<string, { revision: string, readCount: number }>} 插入顺序即 LRU 顺序 */
  const entries = new Map();

  /** 规范化路径 → 缓存键；相对路径按 baseDir 解析。 */
  function keyFor(filePath) {
    const raw = typeof filePath === 'string' ? filePath.trim() : '';
    if (!raw) throw new Error('path is required');
    // resolvePath 同时处理绝对路径、相对路径与盘符/根路径，并做规范化。
    const abs = stripTrailingSeparators(resolvePath(baseDir, raw));
    return caseInsensitive ? abs.toLowerCase() : abs;
  }

  /** 把已存在的条目移到最新（Map 尾部 = 最近使用）。 */
  function touch(key) {
    const entry = entries.get(key);
    if (!entry) return undefined;
    entries.delete(key);
    entries.set(key, entry);
    return entry;
  }

  /** 超出上限时从头部淘汰最久未用的条目。 */
  function evictOverflow() {
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  /**
   * 记录一次读取，返回本次与上次内容的关系。
   * @param {string} filePath
   * @param {string|Buffer} text 调用方已读到的完整内容
   * @returns {{ unchanged: boolean, revision: string, previousRevision?: string, readCount: number }}
   */
  function observe(filePath, text) {
    const key = keyFor(filePath);
    const revision = hashText(coerceText(text));
    const existing = entries.get(key);

    if (!existing) {
      entries.set(key, { revision, readCount: 1 });
      evictOverflow();
      return { unchanged: false, revision, readCount: 1 };
    }

    const previousRevision = existing.revision;
    const unchanged = previousRevision === revision;
    const entry = touch(key);
    entry.revision = revision;
    entry.readCount += 1;
    return { unchanged, revision, previousRevision, readCount: entry.readCount };
  }

  /**
   * 忘掉某个路径的历史；已在缓存中返回 true，否则 false。
   * 非法路径不抛异常（幂等清理场景更友好）。
   * @param {string} filePath
   * @returns {boolean}
   */
  function forget(filePath) {
    let key;
    try {
      key = keyFor(filePath);
    } catch {
      return false;
    }
    return entries.delete(key);
  }

  /**
   * 清空所有记录，返回被清掉的条目数。
   * @returns {number}
   */
  function reset() {
    const cleared = entries.size;
    entries.clear();
    return cleared;
  }

  return {
    observe,
    forget,
    reset,
    get size() {
      return entries.size;
    },
  };
}

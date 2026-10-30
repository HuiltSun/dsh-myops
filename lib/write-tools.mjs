/**
 * lib/write-tools.mjs — mutation / metadata tools for dsh-myops.
 *
 * Exposes `buildWriteTools(deps)` returning the tool definitions for:
 *   - ops_write : write a UTF-8 file (line endings normalized to "\n"),
 *                 with dryRun / createDirs / expectedRevision (sha256 prefix) /
 *                 ifNotExists guards. Default: create parent directories.
 *   - ops_edit  : apply exact-string replacements. Every oldText must occur
 *                 exactly once; all edits are computed in memory first and only
 *                 written when every edit validated, so a failed edit never
 *                 touches the file.
 *   - ops_stat  : file metadata (type/size/mtime/text?/lines/sha256 prefix) or
 *                 directory summary (entries, subdirectories, one-level size).
 *
 * Only node: builtins are used. Shared helpers come from ./common.mjs — no
 * re-implementation of output shape, hashing, path display or line splitting.
 */

import { promises as fsp, createReadStream } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import {
    OUTPUT,
    MAX_READ_BYTES,
    requireString,
    hashText,
    toPosix,
    resolveWorkdir,
    resolveSessionCwd,
    splitLines,
    firstLine,
} from './common.mjs';

/** 5 MB: same threshold ops_read / ops_stat use to decide "read it whole". */
const MAX_TEXT_STAT_BYTES = MAX_READ_BYTES;

/* ------------------------------------------------------------------ */
/* small local helpers (no equivalents in common.mjs)                 */
/* ------------------------------------------------------------------ */

/** Normalize CRLF / lone CR to "\n" (write-tools policy: files use LF). */
function toLf(text) {
    return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Number of lines in already-normalized text.
 * An empty file has 0 lines; a trailing newline does not add an empty line.
 */
function countLines(text) {
    const s = String(text ?? '');
    if (s.length === 0) return 0;
    return splitLines(s).length;
}

/** "1 line" / "N lines". */
function lineWord(n) {
    return n === 1 ? 'line' : 'lines';
}

/** Number of (possibly overlapping) substring occurrences. */
function countOccurrences(haystack, needle) {
    if (!needle) return 0;
    let count = 0;
    let idx = haystack.indexOf(needle);
    while (idx !== -1) {
        count += 1;
        idx = haystack.indexOf(needle, idx + 1);
    }
    return count;
}

/** 1-based line number of a character offset. */
function lineAt(text, index) {
    if (index <= 0) return 1;
    return text.slice(0, index).split('\n').length;
}

/** Resolve a tool path against the session working directory (or an explicit base). */
function resolveTarget(rawPath, base = process.cwd()) {
    return resolveWorkdir(rawPath, base);
}

/** Show an absolute path in posix form for stable model-facing output. */
function display(absPath) {
    return toPosix(absPath);
}

/** stat that returns null for ENOENT instead of throwing. */
async function statOrNull(absPath) {
    try {
        return await fsp.stat(absPath);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

/**
 * Write text atomically: a sibling temp file + rename. A failure (permissions,
 * disk full, rename refused) leaves the destination untouched.
 */
async function atomicWriteFile(absPath, text) {
    const dir = dirname(absPath);
    const suffix = `${process.pid}-${randomBytes(6).toString('hex')}`;
    const tmp = join(dir, `.${basename(absPath)}.dsh-myops-${suffix}.tmp`);
    try {
        await fsp.writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' });
        await fsp.rename(tmp, absPath);
    } catch (error) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw error;
    }
}

/** sha256 of a file's raw bytes, streamed (safe for large files). */
async function hashFile(absPath) {
    return await new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = createReadStream(absPath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

/** Decode a UTF-8 sample, backing off to the last ASCII byte on truncation. */
function decodeUtf8Sample(buffer) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
        return { text: decoder.decode(buffer), ok: true };
    } catch {
        // The sample may cut a multi-byte sequence; retry before the last ASCII byte.
        let cut = -1;
        for (let i = buffer.length - 1; i >= 0; i -= 1) {
            if (buffer[i] < 0x80) { cut = i + 1; break; }
        }
        if (cut <= 0) return { text: '', ok: false };
        try {
            return { text: decoder.decode(buffer.subarray(0, cut)), ok: true };
        } catch {
            return { text: '', ok: false };
        }
    }
}

/** Heuristic: is this byte buffer plausible UTF-8 text? */
function looksText(buffer, truncatedSample) {
    if (buffer.length === 0) return true;
    if (buffer.includes(0)) return false;
    const decoded = decodeUtf8Sample(buffer);
    if (decoded.ok) return true;
    // A truncated sample cannot prove the file is binary (it may have cut a
    // multi-byte sequence); only a full-file decode failure decides "binary".
    return truncatedSample;
}

/** Read at most `count` leading bytes without loading the whole file. */
async function readHead(absPath, count) {
    const handle = await fsp.open(absPath, 'r');
    try {
        const buffer = Buffer.alloc(count);
        const { bytesRead } = await handle.read(buffer, 0, count, 0);
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close().catch(() => {});
    }
}

/** Compact, one-line preview of an edit needle for reports. */
function preview(text, max = 40) {
    const flat = firstLine(text, max + 1);
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Validate `edits` and normalize them to LF, returning a clean array. */
function normalizeEdits(edits) {
    if (!Array.isArray(edits) || edits.length === 0) {
        throw new Error('edits must be a non-empty array of { oldText, newText }');
    }
    return edits.map((edit, i) => {
        const label = `edits[${i}]`;
        if (!edit || typeof edit !== 'object') throw new Error(`${label} must be an object`);
        if (typeof edit.oldText !== 'string' || edit.oldText.length === 0) {
            throw new Error(`${label}.oldText must be a non-empty string`);
        }
        const newText = edit.newText === undefined ? '' : edit.newText;
        if (typeof newText !== 'string') throw new Error(`${label}.newText must be a string`);
        return { oldText: toLf(edit.oldText), newText: toLf(newText) };
    });
}

/* ------------------------------------------------------------------ */
/* tool factory                                                       */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* ops_stat 单路径描述（execute 里循环调用，支持批量）                */
/* ------------------------------------------------------------------ */

async function describeStat(abs) {
    const shown = display(abs);
    const stat = await statOrNull(abs);
    if (!stat) return `${shown}: not found`;
    const mtime = stat.mtime.toISOString();

    if (stat.isDirectory()) {
        const dirents = await fsp.readdir(abs, { withFileTypes: true });
        let files = 0;
        let dirs = 0;
        let other = 0;
        let size = 0;
        await Promise.all(dirents.map(async (entry) => {
            const child = join(abs, entry.name);
            try {
                const childStat = await fsp.stat(child);
                if (childStat.isDirectory()) dirs += 1;
                else if (childStat.isFile()) { files += 1; size += childStat.size; }
                else other += 1;
            } catch {
                other += 1;
            }
        }));
        const parts = [`files ${files}`, `dirs ${dirs}`];
        if (other) parts.push(`other ${other}`);
        return [
            `${shown} (dir)`,
            `entries: ${dirents.length} (${parts.join(', ')})`,
            `size (one level): ${size} bytes`,
            `mtime: ${mtime}`,
        ].join('\n');
    }

    if (!stat.isFile()) {
        return [`${shown} (other)`, `size: ${stat.size} bytes`, `mtime: ${mtime}`].join('\n');
    }

    const size = stat.size;
    let text = null;
    let lines = null;
    let sha256;
    let buffer = null;
    if (size <= MAX_TEXT_STAT_BYTES) {
        buffer = await fsp.readFile(abs);
        sha256 = createHash('sha256').update(buffer).digest('hex');
    } else {
        sha256 = await hashFile(abs);
        buffer = await readHead(abs, 8192);
    }
    // <= 5 MB: the whole file was read, so text/binary detection can be authoritative.
    // Larger files: sample the head and stay conservative.
    const hasWholeFile = size <= MAX_TEXT_STAT_BYTES;
    const sample = hasWholeFile ? buffer : buffer.subarray(0, 8192);
    text = looksText(sample, !hasWholeFile);
    if (text) {
        if (hasWholeFile) {
            lines = countLines(buffer.toString('utf8'));
        } else {
            lines = null; // intentionally skipped above the 5 MB threshold
        }
    }

    const out = [
        `${shown} (file)`,
        `size: ${size} bytes`,
        `mtime: ${mtime}`,
        `text: ${text ? 'yes' : 'no'}`,
    ];
    if (text) out.push(lines === null ? 'lines: skipped (>= 5 MB)' : `lines: ${lines}`);
    out.push(`sha256: ${sha256.slice(0, 16)}`);
    return out.join('\n');
}

export function buildWriteTools(deps = {}) {
    const ctx = deps?.ctx;

    /* ---------------- ops_write ---------------- */
    const writeTool = {
        name: 'ops_write',
        description:
            'Write a UTF-8 text file (parents created, LF endings). Guards: dryRun, ifNotExists, ' +
            'expectedRevision (sha256 prefix). Returns Wrote N lines (B bytes) to <path> (rev).',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute or session-relative path.' },
                content: { type: 'string', description: 'UTF-8 content (empty allowed).' },
                dryRun: { type: 'boolean', description: 'Report only, no write.' },
                createDirs: { type: 'boolean', description: 'Create parents (default true).' },
                expectedRevision: {
                    type: 'string',
                    description: 'Fail unless the existing file content sha256 starts with this prefix (stale-write guard).',
                },
                ifNotExists: { type: 'boolean', description: 'Fail when the target file already exists.' },
            },
            required: ['path', 'content'],
            additionalProperties: false,
        },
        output: OUTPUT,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const path = requireString(args?.path, 'path');
            if (typeof args?.content !== 'string') throw new Error('content is required (string)');
            const content = toLf(args.content);
            const abs = resolveTarget(path, await resolveSessionCwd(exec, ctx));
            const shown = display(abs);
            const dryRun = args?.dryRun === true;
            const createDirs = args?.createDirs !== false;

            const existing = await statOrNull(abs);
            if (existing?.isDirectory()) throw new Error(`path is a directory: ${shown}`);
            const exists = Boolean(existing);
            const currentText = exists ? await fsp.readFile(abs, 'utf8') : '';
            const currentRev = exists ? hashText(currentText) : '';
            const newRev = hashText(content);
            const lines = countLines(content);
            const bytes = Buffer.byteLength(content, 'utf8');

            if (args?.ifNotExists === true && exists) {
                throw new Error(`file already exists: ${shown} (ifNotExists=true, current rev ${currentRev.slice(0, 8)})`);
            }
            if (args?.expectedRevision !== undefined && args?.expectedRevision !== null) {
                const expected = String(args.expectedRevision).trim().toLowerCase();
                if (!expected) throw new Error('expectedRevision must be a non-empty sha256 prefix');
                if (!exists) {
                    throw new Error(`expectedRevision was given but the file does not exist: ${shown}`);
                }
                if (!currentRev.startsWith(expected)) {
                    throw new Error(
                        `revision mismatch for ${shown}: expected prefix "${expected}", current rev ${currentRev.slice(0, 8)} ` +
                        `(file was modified since it was read; re-read it before writing)`,
                    );
                }
            }

            const parent = dirname(abs);
            const parentStat = await statOrNull(parent);
            if (!parentStat) {
                if (!createDirs) {
                    throw new Error(`parent directory does not exist: ${display(parent)} (createDirs=false)`);
                }
            } else if (!parentStat.isDirectory()) {
                throw new Error(`parent path is not a directory: ${display(parent)}`);
            }

            if (dryRun) {
                const action = exists
                    ? `overwrite ${shown} (rev ${currentRev.slice(0, 8)} -> ${newRev.slice(0, 8)})`
                    : `create ${shown} (rev ${newRev.slice(0, 8)})`;
                const mkdirNote = !parentStat && createDirs ? `, creating parent ${display(parent)}` : '';
                return `[dry-run] Would write ${lines} ${lineWord(lines)} (${bytes} bytes): ${action}${mkdirNote}`;
            }

            if (!parentStat) await fsp.mkdir(parent, { recursive: true });
            await atomicWriteFile(abs, content);
            return `Wrote ${lines} ${lineWord(lines)} (${bytes} bytes) to ${shown} (rev ${newRev.slice(0, 8)})`;
        },
    };

    /* ---------------- ops_edit ---------------- */
    const editTool = {
        name: 'ops_edit',
        description:
            'Exact string replacements: each oldText must occur once; all edits are atomic (nothing written on failure). ' +
            'Supports multiple edits, dryRun and expectedRevision (stale-write guard). Matching normalizes CRLF/CR as LF; output file uses LF.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute or session-relative path.' },
                edits: {
                    type: 'array',
                    description: 'Ordered exact replacements. Every oldText must be unique in the file at its turn.',
                    items: {
                        type: 'object',
                        properties: {
                            oldText: { type: 'string', description: 'Exact text to replace; must occur exactly once.' },
                            newText: { type: 'string', description: 'Replacement text (may be empty to delete).' },
                        },
                        required: ['oldText', 'newText'],
                        additionalProperties: false,
                    },
                },
                dryRun: { type: 'boolean', description: 'Validate and describe the edits without touching the disk.' },
                expectedRevision: {
                    type: 'string',
                    description: 'Fail unless the pre-edit content sha256 starts with this prefix (stale-write guard; take it from ops_read/ops_stat rev).',
                },
            },
            required: ['path', 'edits'],
            additionalProperties: false,
        },
        output: OUTPUT,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const path = requireString(args?.path, 'path');
            const edits = normalizeEdits(args?.edits);
            const abs = resolveTarget(path, await resolveSessionCwd(exec, ctx));
            const shown = display(abs);
            const dryRun = args?.dryRun === true;

            const stat = await statOrNull(abs);
            if (!stat) throw new Error(`file does not exist: ${shown}`);
            if (stat.isDirectory()) throw new Error(`path is a directory: ${shown}`);

            const raw = await fsp.readFile(abs, 'utf8');
            if (args?.expectedRevision !== undefined && args?.expectedRevision !== null) {
                const expected = String(args.expectedRevision).trim().toLowerCase();
                if (!expected) throw new Error('expectedRevision must be a non-empty sha256 prefix');
                const currentRev = hashText(raw);
                if (!currentRev.startsWith(expected)) {
                    throw new Error(
                        `revision mismatch for ${shown}: expected prefix "${expected}", current rev ${currentRev.slice(0, 8)} ` +
                        `(file was modified since it was read; re-read it before editing)`,
                    );
                }
            }
            const original = toLf(raw);
            const beforeLines = countLines(original);
            let text = original;
            const applied = [];

            for (let i = 0; i < edits.length; i += 1) {
                const { oldText, newText } = edits[i];
                const count = countOccurrences(text, oldText);
                if (count !== 1) {
                    const times = count === 0 ? '0 times' : `${count} times`;
                    throw new Error(
                        `edit #${i + 1} failed: oldText ${times} in ${shown} (must occur exactly once); ` +
                        `no changes were written. oldText starts with: ${JSON.stringify(preview(oldText))}`,
                    );
                }
                const index = text.indexOf(oldText);
                const startLine = lineAt(text, index);
                text = text.slice(0, index) + newText + text.slice(index + oldText.length);
                applied.push({ index: i + 1, startLine, oldText, newText });
            }

            const afterLines = countLines(text);
            const delta = afterLines - beforeLines;
            const deltaText = delta > 0 ? `+${delta}` : String(delta);

            if (dryRun) {
                const detail = applied
                    .map((e) => `  #${e.index} line ${e.startLine}: ${JSON.stringify(preview(e.oldText, 24))} -> ${JSON.stringify(preview(e.newText, 24))}`)
                    .join('\n');
                return `[dry-run] Would apply ${applied.length} edit(s) to ${shown}\n${detail}\n  lines ${beforeLines} -> ${afterLines} (${deltaText})`;
            }

            await atomicWriteFile(abs, text);
            const detail = applied
                .map((e) => `  #${e.index} line ${e.startLine}: ${JSON.stringify(preview(e.oldText, 24))} -> ${JSON.stringify(preview(e.newText, 24))}`)
                .join('\n');
            const rev = hashText(text).slice(0, 8);
            return `Edited ${shown} (${applied.length} edit(s), rev ${rev})\n${detail}\n  lines ${beforeLines} -> ${afterLines} (${deltaText})`;
        },
    };

    /* ---------------- ops_stat ---------------- */
    const statTool = {
        name: 'ops_stat',
        description:
            'Show file/dir metadata: size, mtime, text?, lines, sha256; dir: entries and one-level size. ' +
            'Pass `paths` to batch.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute or session-relative path.' },
                paths: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Several paths to describe in one call (mutually exclusive with `path`; missing entries report "not found").',
                },
            },
            additionalProperties: false,
        },
        output: OUTPUT,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const raw = [];
            if (typeof args?.path === 'string' && args.path.trim()) raw.push(args.path);
            if (Array.isArray(args?.paths)) {
                for (const item of args.paths) {
                    if (typeof item === 'string' && item.trim()) raw.push(item);
                }
            }
            if (!raw.length) throw new Error('path or paths is required');
            const base = await resolveSessionCwd(exec, ctx);
            const blocks = [];
            for (const item of raw) {
                blocks.push(await describeStat(resolveTarget(item, base)));
            }
            return blocks.join('\n\n');
        },
    };

    return [writeTool, editTool, statTool];
}

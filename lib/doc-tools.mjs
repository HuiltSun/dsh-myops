/**
 * lib/doc-tools.mjs — 文档读取工具（只读，零 npm 依赖）。
 *
 * 提供三个工具：
 *   - ops_read_table : 读取 CSV/TSV/SSV，自动推断分隔符，支持引号字段与 offset/limit 翻页。
 *   - ops_read_docx  : 自解析 .docx（ZIP 中央目录 + 本地文件头，inflateRaw 解压
 *                      word/document.xml），抽取 <w:p>/<w:t> 段落文本。
 *   - ops_read_pdf   : 尽力提取 PDF 文本层（扫描 stream、FlateDecode 解压、抽取 Tj/TJ），
 *                      并用字体 /ToUnicode CMap 解码 Type0/Identity-H 的 CID 字形码；
 *                      解码质量不达标时返回说明性字符串，绝不抛出未处理异常。
 *
 * 只允许 node: 内置模块；共享常量与纯函数来自 ./common.mjs。
 */

import { readFile, stat } from 'node:fs/promises';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { OUTPUT, requireString, capText, toPosix, resolveWorkdir, resolveSessionCwd, numberLines } from './common.mjs';

/* ------------------------------------------------------------------ */
/* 常量与错误类型                                                      */
/* ------------------------------------------------------------------ */

const MAX_TABLE_BYTES = 20_000_000;
const MAX_ARCHIVE_BYTES = 64_000_000;
const DEFAULT_TABLE_LIMIT = 50;
const DEFAULT_TABLE_MAX_LIMIT = 5_000;
const DEFAULT_DOC_LIMIT = 200;
const DEFAULT_DOC_MAX_LIMIT = 5_000;
const DEFAULT_PDF_LIMIT = 200;
const DEFAULT_PDF_MAX_LIMIT = 20_000;
const MAX_CELL_CHARS = 80;
const MAX_COLUMNS_INLINE = 8;
const MAX_PDF_STREAM_BYTES = 16 * 1024 * 1024;

/** 可直接反馈给模型的读取错误（execute 会转成字符串）。 */
class DocReadError extends Error {
    constructor(message) {
        super(message);
        this.name = 'DocReadError';
    }
}

/** PDF 文本提取能力之外的情况：按契约返回 "PDF text extraction unsupported ..."。 */
class PdfUnsupportedError extends Error {
    constructor(reason) {
        super(reason);
        this.name = 'PdfUnsupportedError';
    }
}

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */

function errorText(toolName, err) {
    const message = err && err.message ? err.message : String(err);
    return `${toolName} error: ${message}`;
}

/** 把 args.path 解析成绝对路径：相对路径按会话工作目录（或显式 workdir）解析。 */
async function resolveInputPath(value, exec, deps) {
    const raw = requireString(value, 'path');
    if (isAbsolute(raw)) return raw;
    const base = deps && deps.workdir
        ? resolveWorkdir(deps.workdir)
        : await resolveSessionCwd(exec, deps && deps.ctx);
    return resolvePath(base, raw);
}

function describePath(absPath) {
    return toPosix(absPath);
}

/** 读取文件并把 ENOENT/EACCES/目录/过大等情况转成可读错误。 */
async function loadFile(absPath, maxBytes, toolName) {
    let info;
    try {
        info = await stat(absPath);
    } catch (err) {
        if (err && err.code === 'ENOENT') {
            throw new DocReadError(`${toolName}: file not found: ${describePath(absPath)}`);
        }
        if (err && err.code === 'EACCES') {
            throw new DocReadError(`${toolName}: permission denied: ${describePath(absPath)}`);
        }
        throw new DocReadError(`${toolName}: cannot stat ${describePath(absPath)}: ${err.message}`);
    }
    if (!info.isFile()) {
        throw new DocReadError(`${toolName}: not a regular file: ${describePath(absPath)}`);
    }
    if (info.size > maxBytes) {
        throw new DocReadError(
            `${toolName}: file too large (${info.size} bytes > ${maxBytes} bytes): ${describePath(absPath)}`,
        );
    }
    try {
        return await readFile(absPath);
    } catch (err) {
        throw new DocReadError(`${toolName}: cannot read ${describePath(absPath)}: ${err.message}`);
    }
}

/** 解析整数参数并夹在 [min, max]。 */
function readInt(value, name, fallback, min, max) {
    if (value === undefined || value === null || value === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new DocReadError(`${name} must be an integer`);
    const i = Math.trunc(n);
    if (i < min) throw new DocReadError(`${name} must be >= ${min} (got ${i})`);
    return Math.min(i, max);
}

/** 统一收尾：截断到输出上限并追加说明。 */
function finishOutput(text, deps) {
    const limit = (deps && Number.isFinite(deps.maxOutputChars) && deps.maxOutputChars > 0)
        ? deps.maxOutputChars
        : undefined;
    const capped = typeof limit === 'number' ? capText(text, limit) : capText(text);
    return capped.truncated
        ? `${capped.text}\n[output truncated at ${capped.text.length} of ${capped.chars} chars]`
        : capped.text;
}

/* ------------------------------------------------------------------ */
/* CSV / TSV                                                           */
/* ------------------------------------------------------------------ */

const DELIM_NAMES = new Map([
    [',', ','],
    ['\t', '\\t'],
    [';', ';'],
    ['|', '|'],
]);

/** 用户显式指定的分隔符（支持 "tab"/"\\t" 简写）；null 表示自动推断。 */
function parseDelimiterArg(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') throw new DocReadError('delimiter must be a string');
    const raw = value.trim();
    if (!raw) return null;
    const lower = raw.toLowerCase();
    if (lower === 'tab' || raw === '\\t' || raw === '\t') return '\t';
    if (lower === 'comma') return ',';
    if (lower === 'semicolon') return ';';
    if (lower === 'pipe') return '|';
    if (raw.length !== 1) {
        throw new DocReadError(`delimiter must be a single character (got ${JSON.stringify(value)})`);
    }
    return raw;
}

/** 在引号外统计符号出现次数（只看前几行，足够判断表头分隔符）。 */
function countUnquoted(text, symbol, maxLines) {
    let count = 0;
    let lines = 0;
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') i++;
                else inQuotes = false;
            }
            continue;
        }
        if (ch === '"') {
            inQuotes = true;
            continue;
        }
        if (ch === '\n') {
            lines++;
            if (lines >= maxLines) break;
            continue;
        }
        if (ch === symbol) count++;
    }
    return count;
}

function detectDelimiter(text) {
    const candidates = [',', '\t', ';', '|'];
    let best = ',';
    let bestScore = -1;
    for (const symbol of candidates) {
        const score = countUnquoted(text, symbol, 5);
        if (score > bestScore) {
            best = symbol;
            bestScore = score;
        }
    }
    return { delimiter: best, score: bestScore };
}

/** RFC4180 风格解析：双引号包裹、"" 转义、字段内换行、CRLF。 */
function parseDelimited(text, delimiter) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;
    const n = text.length;
    const pushField = () => { row.push(field); field = ''; };
    const pushRow = () => { pushField(); rows.push(row); row = []; };

    while (i < n) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 2;
                    continue;
                }
                inQuotes = false;
                i++;
                continue;
            }
            field += ch;
            i++;
            continue;
        }
        if (ch === '"' && field === '') {
            inQuotes = true;
            i++;
            continue;
        }
        if (ch === delimiter) {
            pushField();
            i++;
            continue;
        }
        if (ch === '\r') {
            if (text[i + 1] === '\n') i++;
            pushRow();
            i++;
            continue;
        }
        if (ch === '\n') {
            pushRow();
            i++;
            continue;
        }
        field += ch;
        i++;
    }
    if (field.length > 0 || row.length > 0) pushRow();

    while (rows.length > 0 && rows[rows.length - 1].every((cell) => cell.trim() === '')) {
        rows.pop();
    }
    return rows;
}

function compactCell(value) {
    let s = String(value ?? '').replace(/\r\n?/g, '\n');
    s = s.replace(/[\t\f\v]+/g, ' ').replace(/ *\n */g, ' ').trim();
    if (s.length > MAX_CELL_CHARS) s = `${s.slice(0, MAX_CELL_CHARS - 1)}…`;
    return s;
}

function padCell(value, width) {
    const s = compactCell(value);
    return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/** 行数很多时用 "# + 对齐列" 的紧凑表格；列太多时改成逐行 col: value。 */
function renderTable(header, shownRows, startIndex, totalRows) {
    const columns = Math.max(
        header.length,
        ...shownRows.map((r) => r.length),
        1,
    );
    const headerCells = [];
    for (let c = 0; c < columns; c++) headerCells.push(compactCell(header[c] ?? ''));

    const vertical = columns > MAX_COLUMNS_INLINE;
    const parts = [];
    if (!vertical) {
        const widths = new Array(columns).fill(0);
        const rowCells = shownRows.map((r) => {
            const cells = [];
            for (let c = 0; c < columns; c++) cells.push(compactCell(r[c] ?? ''));
            return cells;
        });
        for (let c = 0; c < columns; c++) {
            widths[c] = headerCells[c].length;
            for (const cells of rowCells) widths[c] = Math.max(widths[c], cells[c].length);
        }
        const numWidth = String(startIndex + shownRows.length - 1).length;
        const headerLine = [
            '#'.padStart(numWidth),
            ...headerCells.map((cell, c) => padCell(cell, widths[c])),
        ].join('  ').replace(/\s+$/, '');
        parts.push(headerLine);
        shownRows.forEach((r, rIdx) => {
            const cells = rowCells[rIdx];
            parts.push([
                String(startIndex + rIdx).padStart(numWidth),
                ...cells.map((cell, c) => padCell(cell, widths[c])),
            ].join('  ').replace(/\s+$/, ''));
        });
    } else {
        shownRows.forEach((r, rIdx) => {
            const recordParts = [`# ${startIndex + rIdx}`];
            for (let c = 0; c < columns; c++) {
                const key = headerCells[c] || `col${c + 1}`;
                recordParts.push(`  ${key}: ${compactCell(r[c] ?? '')}`);
            }
            parts.push(recordParts.join('\n'));
        });
    }
    return parts.join(vertical ? '\n\n' : '\n');
}

function tableToolDefinition(deps) {
    return {
        name: 'ops_read_table',
        description:
            'Read a delimited text table (CSV/TSV/SSV). Infers the delimiter unless given, '
            + 'handles quoted fields and CRLF, and returns an aligned table with row numbers. '
            + 'Use offset/limit to page through large files.',
        parameters: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Table file path (absolute, or relative to the session working directory).',
                },
                delimiter: {
                    type: 'string',
                    description: 'Field delimiter. Omit to auto-detect: , tab ; | ("tab" accepted).',
                },
                limit: {
                    type: 'number',
                    description: `Maximum data rows to return (default ${DEFAULT_TABLE_LIMIT}).`,
                },
                offset: {
                    type: 'number',
                    description: 'First data row to return, 1-based (default 1; header is always shown).',
                },
            },
            required: ['path'],
            additionalProperties: false,
        },
        output: OUTPUT,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const toolName = 'ops_read_table';
            let absPath = '';
            try {
                const a = args ?? {};
                absPath = await resolveInputPath(a.path, exec, deps);
                const requestedDelimiter = parseDelimiterArg(a.delimiter);
                const limit = readInt(a.limit, 'limit', DEFAULT_TABLE_LIMIT, 1, DEFAULT_TABLE_MAX_LIMIT);
                const offset = readInt(a.offset, 'offset', 1, 1, Number.MAX_SAFE_INTEGER);
                const buf = await loadFile(absPath, MAX_TABLE_BYTES, toolName);

                if (buf.includes(0)) {
                    throw new DocReadError(
                        `${toolName}: file looks binary (NUL bytes), not a CSV/TSV table: ${describePath(absPath)}`,
                    );
                }
                let text = buf.toString('utf8');
                if (text.includes('\uFFFD')) {
                    const replacementRatio = (text.match(/\uFFFD/g) || []).length / Math.max(text.length, 1);
                    if (replacementRatio > 0.1) {
                        throw new DocReadError(
                            `${toolName}: file is not valid UTF-8 text (replacement chars), cannot read as a table: ${describePath(absPath)}`,
                        );
                    }
                }
                text = text.replace(/^\uFEFF/, '');
                if (!text.trim()) {
                    return `${toolName}: table is empty: ${describePath(absPath)}`;
                }

                const inferred = requestedDelimiter ? null : detectDelimiter(text);
                const delimiter = requestedDelimiter ?? inferred.delimiter;
                const rows = parseDelimited(text, delimiter);
                if (rows.length === 0) {
                    return `${toolName}: no rows parsed from ${describePath(absPath)}`;
                }

                const header = rows[0];
                const dataRows = rows.slice(1);
                const totalRows = dataRows.length;
                if (totalRows === 0) {
                    const cols = header.map((cell) => compactCell(cell)).join(', ');
                    return `${toolName}: ${describePath(absPath)} has a header but no data rows.\nColumns: ${cols}`;
                }
                if (offset > totalRows) {
                    throw new DocReadError(
                        `offset ${offset} is beyond row count ${totalRows}: ${describePath(absPath)}`,
                    );
                }

                const start = offset - 1;
                const selected = dataRows.slice(start, start + limit);
                const delimiterLabel = DELIM_NAMES.get(delimiter) ?? JSON.stringify(delimiter);
                const source = inferred ? 'auto' : 'given';
                const columns = Math.max(header.length, ...selected.map((r) => r.length), 1);

                const headerLines = [
                    `Table ${describePath(absPath)}`,
                    `delimiter=${delimiterLabel} (${source}) | ${columns} columns | ${totalRows} data rows`
                    + ` | showing rows ${offset}-${start + selected.length}`,
                ];
                const body = renderTable(header, selected, offset, totalRows);
                const shownEnd = start + selected.length;
                const footer = shownEnd < totalRows
                    ? `[more: showing ${offset}-${shownEnd} of ${totalRows} rows; call with offset=${shownEnd + 1}]`
                    : '';
                const out = [headerLines.join('\n'), '', body, footer].filter(Boolean).join('\n');
                return finishOutput(out, deps);
            } catch (err) {
                return errorText(toolName, err);
            }
        },
    };
}

/* ------------------------------------------------------------------ */
/* DOCX                                                               */
/* ------------------------------------------------------------------ */

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CEN_SIG = 0x02014b50;
const ZIP_LOC_SIG = 0x04034b50;

function findEndOfCentralDirectory(buf) {
    if (buf.length < 22) return -1;
    const min = Math.max(0, buf.length - 65_557);
    for (let i = buf.length - 22; i >= min; i--) {
        if (buf.readUInt32LE(i) === ZIP_EOCD_SIG) return i;
    }
    return -1;
}

/** 读 ZIP 中央目录条目列表。 */
function listZipEntries(buf) {
    const eocd = findEndOfCentralDirectory(buf);
    if (eocd < 0) {
        throw new DocReadError(
            'not a ZIP archive (no end-of-central-directory record found); expected a .docx/OOXML file',
        );
    }
    const entryCount = buf.readUInt16LE(eocd + 10);
    const centralOffset = buf.readUInt32LE(eocd + 16);
    if (centralOffset >= buf.length) {
        throw new DocReadError('corrupt ZIP archive: central directory offset is outside the file');
    }
    if (centralOffset === 0xffffffff || entryCount === 0xffff) {
        throw new DocReadError('ZIP64 archives are not supported');
    }

    const entries = [];
    let pos = centralOffset;
    for (let i = 0; i < entryCount; i++) {
        if (pos + 46 > buf.length) throw new DocReadError('corrupt ZIP archive: truncated central directory');
        if (buf.readUInt32LE(pos) !== ZIP_CEN_SIG) {
            throw new DocReadError('corrupt ZIP archive: bad central directory entry signature');
        }
        const compressedSize = buf.readUInt32LE(pos + 20);
        const uncompressedSize = buf.readUInt32LE(pos + 24);
        const nameLength = buf.readUInt16LE(pos + 28);
        const extraLength = buf.readUInt16LE(pos + 30);
        const commentLength = buf.readUInt16LE(pos + 32);
        const localOffset = buf.readUInt32LE(pos + 42);
        if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
            throw new DocReadError('ZIP64 archives are not supported');
        }
        if (pos + 46 + nameLength > buf.length) {
            throw new DocReadError('corrupt ZIP archive: truncated central directory entry');
        }
        const entryName = buf.subarray(pos + 46, pos + 46 + nameLength).toString('utf8');
        entries.push({
            name: entryName,
            method: buf.readUInt16LE(pos + 10),
            compressedSize,
            uncompressedSize,
            localOffset,
        });
        pos += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

/** 按中央目录信息读取并解压一个 ZIP 条目（stored / deflate）。 */
function readZipEntry(buf, entry) {
    const local = entry.localOffset;
    if (local + 30 > buf.length) {
        throw new DocReadError(`corrupt ZIP archive: local header for ${entry.name} is outside the file`);
    }
    if (buf.readUInt32LE(local) !== ZIP_LOC_SIG) {
        throw new DocReadError(`corrupt ZIP archive: bad local header signature for ${entry.name}`);
    }
    const nameLength = buf.readUInt16LE(local + 26);
    const extraLength = buf.readUInt16LE(local + 28);
    const dataStart = local + 30 + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataStart > buf.length || dataEnd > buf.length) {
        throw new DocReadError(`corrupt ZIP archive: truncated data for ${entry.name}`);
    }
    const data = buf.subarray(dataStart, dataEnd);
    if (entry.method === 0) return Buffer.from(data);
    if (entry.method === 8) {
        try {
            return inflateRawSync(data);
        } catch (err) {
            throw new DocReadError(`failed to inflate ${entry.name}: ${err.message}`);
        }
    }
    throw new DocReadError(
        `unsupported ZIP compression method ${entry.method} for ${entry.name} (only stored/deflate are supported)`,
    );
}

function decodeXmlCodePoint(code) {
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return '\uFFFD';
    }
    try {
        return String.fromCodePoint(code);
    } catch {
        return '\uFFFD';
    }
}

function decodeXmlEntities(value) {
    if (!value.includes('&')) return value;
    return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (match, entity) => {
        if (entity === 'amp') return '&';
        if (entity === 'lt') return '<';
        if (entity === 'gt') return '>';
        if (entity === 'quot') return '"';
        if (entity === 'apos') return "'";
        if (entity[0] === '#') {
            if (entity[1] === 'x' || entity[1] === 'X') {
                return decodeXmlCodePoint(Number.parseInt(entity.slice(2), 16));
            }
            return decodeXmlCodePoint(Number.parseInt(entity.slice(1), 10));
        }
        return match;
    });
}

/** 一个 <w:p> 的正文 → 文本（<w:t> 文本 + tab/br）。 */
function paragraphText(body) {
    let text = '';
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:cr\s*\/>/g;
    let match;
    while ((match = re.exec(body)) !== null) {
        if (match[1] !== undefined) {
            text += decodeXmlEntities(match[1]);
        } else if (match[0].startsWith('<w:tab')) {
            text += '\t';
        } else {
            text += '\n';
        }
    }
    return text.replace(/^[ \t]+/gm, '').replace(/[ \t]+$/gm, '').trim();
}

/** 从 word/document.xml 抽取段落文本。 */
function extractDocxParagraphs(xml) {
    const paragraphs = [];
    const paragraphRe = /<w:p(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/w:p>)/g;
    let match;
    while ((match = paragraphRe.exec(xml)) !== null) {
        if (match[1] === undefined) {
            paragraphs.push('');
            continue;
        }
        paragraphs.push(paragraphText(match[1]));
    }
    // 连续空段落压成一个空行，去掉首尾空行。
    const compact = [];
    for (const paragraph of paragraphs) {
        if (paragraph === '' && compact.length > 0 && compact[compact.length - 1] === '') continue;
        compact.push(paragraph);
    }
    while (compact.length > 0 && compact[compact.length - 1] === '') compact.pop();
    while (compact.length > 0 && compact[0] === '') compact.shift();
    return compact;
}

function findEntry(entries, name) {
    return entries.find((entry) => entry.name === name) ?? null;
}

function docxToolDefinition(deps) {
    return {
        name: 'ops_read_docx',
        description:
            'Extract paragraph text from a .docx (Word/OOXML) file. Parses the ZIP container '
            + 'and word/document.xml directly (stored/deflate), returning numbered paragraphs.',
        parameters: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Path to a .docx file (absolute, or relative to the session working directory).',
                },
                limit: {
                    type: 'number',
                    description: `Maximum paragraphs to return (default ${DEFAULT_DOC_LIMIT}).`,
                },
            },
            required: ['path'],
            additionalProperties: false,
        },
        output: OUTPUT,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const toolName = 'ops_read_docx';
            try {
                const a = args ?? {};
                const absPath = await resolveInputPath(a.path, exec, deps);
                const limit = readInt(a.limit, 'limit', DEFAULT_DOC_LIMIT, 1, DEFAULT_DOC_MAX_LIMIT);
                const buf = await loadFile(absPath, MAX_ARCHIVE_BYTES, toolName);

                const entries = listZipEntries(buf);
                if (entries.some((entry) => entry.name === 'EncryptedPackage')) {
                    throw new DocReadError(
                        `${toolName}: document is encrypted/password-protected: ${describePath(absPath)}`,
                    );
                }
                const documentEntry = findEntry(entries, 'word/document.xml');
                if (!documentEntry) {
                    const names = entries
                        .map((entry) => entry.name)
                        .filter((name) => !name.endsWith('/'))
                        .slice(0, 12);
                    throw new DocReadError(
                        `${toolName}: not a Word document (missing word/document.xml): ${describePath(absPath)}`
                        + (names.length ? `\nZIP entries: ${names.join(', ')}` : ''),
                    );
                }
                const xmlBuffer = readZipEntry(buf, documentEntry);
                const xml = xmlBuffer.toString('utf8');
                const paragraphs = extractDocxParagraphs(xml);
                if (paragraphs.length === 0) {
                    return `${toolName}: no paragraph text found in ${describePath(absPath)} `
                        + '(word/document.xml has no <w:p> text)';
                }

                const total = paragraphs.length;
                const shown = paragraphs.slice(0, limit);
                const header = `DOCX ${describePath(absPath)}\n`
                    + `${total} paragraphs | showing 1-${shown.length}`;
                const body = numberLines(shown, 1, String(shown.length).length);
                const footer = shown.length < total
                    ? `[truncated: ${total - shown.length} more paragraphs; call with limit=${Math.min(total, limit * 2)}]`
                    : '';
                return finishOutput([header, '', body, footer].filter(Boolean).join('\n'), deps);
            } catch (err) {
                return errorText(toolName, err);
            }
        },
    };
}

/* ------------------------------------------------------------------ */
/* PDF                                                                */
/* ------------------------------------------------------------------ */

/*
 * 尽力提取 PDF 文本层。流程：
 *   1. 扫描间接对象与 stream 段；对 FlateDecode 流解压。
 *   2. 收集页面资源里 /Font 名称 → 字体对象，再解析字体对象的 /ToUnicode CMap
 *      （beginbfchar / beginbfrange），得到"字符码 → Unicode"映射。
 *   3. 按内容流里 Tf 指定的字体，用对应的 CMap 解码 Tj/TJ 里的字节串；
 *      没有 ToUnicode 的 Type0/Type3 字体视为不可解码（标记 bad unit）。
 *   4. 质量闸：不可解码码位或不可打印字符占比过高时，不返回乱码，
 *      改为返回 "PDF text extraction unsupported for this file: <原因>"。
 */

const PDF_WS = new Set([' ', '\t', '\r', '\n', '\f', '\0']);
const PDF_DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);
const MAX_QUALITY_BAD_RATIO = 0.3;
const MAX_QUALITY_SUSPICIOUS_RATIO = 0.3;

function isPdfWhitespace(ch) {
    return PDF_WS.has(ch);
}

function isPdfDelimiter(ch) {
    return PDF_DELIM.has(ch);
}

function isNumericWord(word) {
    return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(word);
}

/* ---------------- 字节串 / 十六进制串 ---------------- */

/** PDF 字节串 → JS 字符串（UTF-16BE BOM / UTF-8 / Latin-1 依次尝试）。 */
function decodePdfBytes(bytes) {
    if (bytes.length === 0) return '';
    const buf = Buffer.from(bytes);
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
        const swapped = Buffer.alloc(buf.length - 2);
        for (let i = 2; i + 1 < buf.length; i += 2) {
            swapped[i - 2] = buf[i + 1];
            swapped[i - 1] = buf[i];
        }
        return swapped.toString('utf16le');
    }
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        return buf.subarray(3).toString('utf8');
    }
    const latin = buf.toString('latin1');
    if (/[\x80-\xFF]/.test(latin)) {
        const utf8 = buf.toString('utf8');
        if (!utf8.includes('\uFFFD')) return utf8;
    }
    return latin;
}

/** 读取 PDF 字面量字符串 ( ... )，返回原始字节数组（不预先解码）。 */
function readPdfLiteralBytes(text, start) {
    let i = start + 1;
    let depth = 1;
    const bytes = [];
    while (i < text.length) {
        const ch = text[i];
        if (ch === '\\') {
            const next = text[i + 1];
            if (next === undefined) {
                i++;
                break;
            }
            if (next === 'n') { bytes.push(10); i += 2; }
            else if (next === 'r') { bytes.push(13); i += 2; }
            else if (next === 't') { bytes.push(9); i += 2; }
            else if (next === 'b') { bytes.push(8); i += 2; }
            else if (next === 'f') { bytes.push(12); i += 2; }
            else if (next === '(' || next === ')' || next === '\\') {
                bytes.push(next.charCodeAt(0));
                i += 2;
            } else if (next === '\r') {
                i += 2;
                if (text[i] === '\n') i++;
            } else if (next === '\n') {
                i += 2;
            } else if (next >= '0' && next <= '7') {
                let octal = next;
                i += 2;
                for (let k = 0; k < 2 && text[i] >= '0' && text[i] <= '7'; k++) {
                    octal += text[i];
                    i++;
                }
                bytes.push(Number.parseInt(octal, 8) & 0xff);
            } else {
                bytes.push(next.charCodeAt(0) & 0xff);
                i += 2;
            }
            continue;
        }
        if (ch === '(') {
            depth++;
            bytes.push(40);
            i++;
            continue;
        }
        if (ch === ')') {
            depth--;
            i++;
            if (depth === 0) break;
            bytes.push(41);
            continue;
        }
        bytes.push(ch.charCodeAt(0) & 0xff);
        i++;
    }
    return { bytes, next: i };
}

/** 读取 PDF 十六进制字符串 <...>，返回原始字节数组。 */
function readPdfHexBytes(text, start) {
    let i = start + 1;
    let hex = '';
    while (i < text.length && text[i] !== '>') {
        const ch = text[i];
        if ((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')) hex += ch;
        i++;
    }
    if (i < text.length) i++;
    if (hex.length % 2 === 1) hex += '0';
    const bytes = [];
    for (let k = 0; k < hex.length; k += 2) bytes.push(Number.parseInt(hex.slice(k, k + 2), 16));
    return { bytes, next: i };
}

/** CMap 目标串（UTF-16BE 十六进制）→ JS 字符串。 */
function decodeCMapTarget(hex) {
    if (!hex) return '';
    let h = hex;
    if (h.length % 2 === 1) h += '0';
    const units = [];
    for (let i = 0; i < h.length; i += 2) units.push(Number.parseInt(h.slice(i, i + 2), 16));
    if (units.length === 0) return '';
    let out = '';
    for (let i = 0; i + 1 < units.length; i += 2) out += String.fromCharCode((units[i] << 8) | units[i + 1]);
    if (units.length % 2 === 1) out += String.fromCharCode(units[units.length - 1]);
    return out;
}

/** 解析 ToUnicode CMap 的 beginbfchar / beginbfrange。 */
function parseToUnicodeCMap(text) {
    const map = new Map();
    let codeBytes = 1;
    const noteCode = (hex) => {
        if (hex) codeBytes = Math.max(codeBytes, Math.ceil(hex.length / 2));
    };

    const codespaceRe = /begincodespacerange([\s\S]*?)endcodespacerange/g;
    let block;
    while ((block = codespaceRe.exec(text)) !== null) {
        const pairRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
        let pair;
        while ((pair = pairRe.exec(block[1])) !== null) noteCode(pair[1]);
    }

    const bfcharRe = /beginbfchar([\s\S]*?)endbfchar/g;
    while ((block = bfcharRe.exec(text)) !== null) {
        const pairRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g;
        let pair;
        while ((pair = pairRe.exec(block[1])) !== null) {
            noteCode(pair[1]);
            map.set(Number.parseInt(pair[1], 16), decodeCMapTarget(pair[2]));
        }
    }

    const bfrangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
    while ((block = bfrangeRe.exec(text)) !== null) {
        const entryRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g;
        let entry;
        while ((entry = entryRe.exec(block[1])) !== null) {
            noteCode(entry[1]);
            const lo = Number.parseInt(entry[1], 16);
            const hi = Number.parseInt(entry[2], 16);
            if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo || hi - lo > 65_535) continue;
            if (entry[3] !== undefined) {
                const base = decodeCMapTarget(entry[3]);
                const units = [];
                for (let i = 0; i < base.length; i++) units.push(base.charCodeAt(i));
                if (units.length === 0) continue;
                for (let code = lo; code <= hi; code++) {
                    const shifted = units.slice();
                    shifted[shifted.length - 1] = (shifted[shifted.length - 1] + (code - lo)) & 0xffff;
                    map.set(code, String.fromCharCode(...shifted));
                }
            } else {
                const hexes = [];
                const itemRe = /<([0-9A-Fa-f]*)>/g;
                let item;
                while ((item = itemRe.exec(entry[4])) !== null) hexes.push(item[1]);
                for (let i = 0; i < hexes.length; i++) map.set(lo + i, decodeCMapTarget(hexes[i]));
            }
        }
    }

    return { map, codeBytes };
}

/* ---------------- 间接对象解析 ---------------- */

/** 从 << 开始找配对的 >>（跳过字符串与十六进制串）。返回 '>>' 之后的下标，-1 表示失败。 */
function findPdfDictEnd(text, start) {
    let depth = 0;
    let i = start;
    while (i < text.length - 1) {
        const ch = text[i];
        if (ch === '(') {
            const result = readPdfLiteralBytes(text, i);
            i = result.next;
            continue;
        }
        if (ch === '<') {
            if (text[i + 1] === '<') {
                depth++;
                i += 2;
                continue;
            }
            const result = readPdfHexBytes(text, i);
            i = result.next;
            continue;
        }
        if (ch === '>' && text[i + 1] === '>') {
            depth--;
            i += 2;
            if (depth === 0) return i;
            continue;
        }
        i++;
    }
    return -1;
}

/** 扫描文件里的所有间接对象（含 stream 数据），并展开 /ObjStm 对象流。 */
function collectPdfObjects(buf) {
    const raw = buf.toString('latin1');
    const objects = new Map();
    const headerRe = /(?:^|[\s>\]])(\d+)\s+(\d+)\s+obj\b/g;
    let match;
    while ((match = headerRe.exec(raw)) !== null) {
        const num = Number(match[1]);
        const bodyStart = match.index + match[0].length;
        let bodyEnd = raw.indexOf('endobj', bodyStart);
        if (bodyEnd < 0) bodyEnd = raw.length;
        let dictEnd = bodyEnd;
        let data = null;
        const streamIdx = raw.indexOf('stream', bodyStart);
        if (streamIdx >= 0 && streamIdx < bodyEnd) {
            const after = raw[streamIdx + 6];
            if (after === '\r' || after === '\n') {
                let dataStart = streamIdx + 6;
                if (raw[dataStart] === '\r') dataStart++;
                if (raw[dataStart] === '\n') dataStart++;
                const endStream = raw.indexOf('endstream', dataStart);
                if (endStream >= 0 && endStream < bodyEnd) {
                    let dataEnd = endStream;
                    if (raw[dataEnd - 1] === '\n') dataEnd--;
                    if (raw[dataEnd - 1] === '\r') dataEnd--;
                    if (dataEnd >= dataStart) data = buf.subarray(dataStart, dataEnd);
                    dictEnd = streamIdx;
                    headerRe.lastIndex = bodyEnd;
                }
            }
        }
        if (!objects.has(num)) {
            objects.set(num, {
                num,
                dict: raw.slice(bodyStart, dictEnd),
                data,
                embedded: false,
            });
        }
    }

    // 展开 /Type /ObjStm 里的压缩对象（字体字典常放在这里）。
    for (const obj of [...objects.values()]) {
        if (!obj.data || !/\/Type\s*\/ObjStm\b/.test(obj.dict)) continue;
        try {
            const decoded = decodePdfStream({ dict: obj.dict, data: obj.data });
            if (!decoded) continue;
            const nMatch = /\/N\s+(\d+)/.exec(obj.dict);
            const firstMatch = /\/First\s+(\d+)/.exec(obj.dict);
            const count = nMatch ? Number(nMatch[1]) : 0;
            const first = firstMatch ? Number(firstMatch[1]) : 0;
            if (!count || !Number.isFinite(first) || first > decoded.length) continue;
            const pairs = [];
            const pairRe = /(\d+)\s+(\d+)/g;
            let pair;
            while ((pair = pairRe.exec(decoded.slice(0, first))) !== null && pairs.length < count) {
                pairs.push([Number(pair[1]), Number(pair[2])]);
            }
            if (pairs.length !== count) continue;
            pairs.sort((a, b) => a[1] - b[1]);
            for (let i = 0; i < pairs.length; i++) {
                const [num, offset] = pairs[i];
                const start = first + offset;
                const end = i + 1 < pairs.length ? first + pairs[i + 1][1] : decoded.length;
                if (start >= end || start >= decoded.length) continue;
                if (!objects.has(num)) {
                    objects.set(num, { num, dict: decoded.slice(start, end), data: null, embedded: true });
                }
            }
        } catch { /* 单个对象流损坏不影响整体 */ }
    }
    return objects;
}

/** 解析名字 → 字体对象引用的映射（页面资源 /Font 字典）。 */
function collectFontNameRefs(buf, objects) {
    const raw = buf.toString('latin1');
    const map = new Map();
    const scan = (text) => {
        const dictRe = /\/Font\s*<</g;
        let match;
        while ((match = dictRe.exec(text)) !== null) {
            const start = match.index + match[0].length - 2;
            const end = findPdfDictEnd(text, start);
            if (end < 0) continue;
            const inner = text.slice(start + 2, end - 2);
            const refRe = /\/([A-Za-z0-9#_.+\-]+)\s+(\d+)\s+(\d+)\s+R/g;
            let ref;
            while ((ref = refRe.exec(inner)) !== null) {
                if (!map.has(ref[1])) map.set(ref[1], Number(ref[2]));
            }
            dictRe.lastIndex = end;
        }
        const fontRefRe = /\/Font\s+(\d+)\s+(\d+)\s+R/g;
        let fontRef;
        while ((fontRef = fontRefRe.exec(text)) !== null) {
            const target = objects.get(Number(fontRef[1]));
            if (!target) continue;
            const inner = target.dict;
            const refRe = /\/([A-Za-z0-9#_.+\-]+)\s+(\d+)\s+(\d+)\s+R/g;
            let ref;
            while ((ref = refRe.exec(inner)) !== null) {
                if (!map.has(ref[1])) map.set(ref[1], Number(ref[2]));
            }
        }
    };
    scan(raw);
    for (const obj of objects.values()) scan(obj.dict);
    return map;
}

/** 从字体对象构造解码信息（含 ToUnicode CMap）。 */
function fontInfoFromRef(ref, objects, depth = 0) {
    if (depth > 4) return null;
    const obj = objects.get(ref);
    if (!obj) return null;
    let dict = obj.dict;
    const refOnly = /^\s*(\d+)\s+(\d+)\s+R\s*$/.exec(dict);
    if (refOnly) return fontInfoFromRef(Number(refOnly[1]), objects, depth + 1);

    const subtype = (/\/Subtype\s*\/([A-Za-z0-9+\-.]+)/.exec(dict) || [])[1] ?? '';
    if (!subtype && !/\/BaseFont/.test(dict) && !/\/ToUnicode/.test(dict)) return null;

    const type0 = subtype === 'Type0' || /\/Identity-[HV]/.test(dict);
    let cmap = null;
    const toUnicode = /\/ToUnicode\s+(\d+)\s+(\d+)\s+R/.exec(dict);
    if (toUnicode) {
        const cmapObj = objects.get(Number(toUnicode[1]));
        if (cmapObj) {
            let cmapText = null;
            if (cmapObj.data) cmapText = decodePdfStream({ dict: cmapObj.dict, data: cmapObj.data });
            else if (/beginbfchar|beginbfrange/.test(cmapObj.dict)) cmapText = cmapObj.dict;
            if (cmapText) cmap = parseToUnicodeCMap(cmapText);
        }
    }

    const codeBytes = type0 ? 2 : Math.max(1, cmap ? Math.min(cmap.codeBytes, 2) : 1);
    const undecodable = !cmap && (type0 || subtype === 'Type3');
    return {
        subtype,
        type0,
        codeBytes,
        cmap: cmap ? cmap.map : null,
        cmapSize: cmap ? cmap.map.size : 0,
        undecodable,
    };
}

function buildFontMap(objects, nameRefs) {
    const fontMap = new Map();
    for (const [name, ref] of nameRefs) {
        const info = fontInfoFromRef(ref, objects);
        if (info) fontMap.set(name, info);
    }
    return fontMap;
}

/* ---------------- 内容流 ---------------- */

/** 把内容流切成操作数/操作符 token（字符串保留原始字节）。 */
function tokenizePdfContent(content) {
    const tokens = [];
    let i = 0;
    const n = content.length;
    while (i < n) {
        const ch = content[i];
        if (ch === '%') {
            const newline = content.indexOf('\n', i);
            i = newline < 0 ? n : newline + 1;
            continue;
        }
        if (isPdfWhitespace(ch)) {
            i++;
            continue;
        }
        if (ch === '(') {
            const result = readPdfLiteralBytes(content, i);
            tokens.push({ t: 'string', v: result.bytes });
            i = result.next;
            continue;
        }
        if (ch === '<') {
            if (content[i + 1] === '<') {
                tokens.push({ t: 'op', v: '<<' });
                i += 2;
                continue;
            }
            const result = readPdfHexBytes(content, i);
            tokens.push({ t: 'string', v: result.bytes });
            i = result.next;
            continue;
        }
        if (ch === '>') {
            i += content[i + 1] === '>' ? 2 : 1;
            continue;
        }
        if (ch === '[') {
            tokens.push({ t: 'arrStart' });
            i++;
            continue;
        }
        if (ch === ']') {
            tokens.push({ t: 'arrEnd' });
            i++;
            continue;
        }
        if (ch === '/') {
            let j = i + 1;
            while (j < n && !isPdfWhitespace(content[j]) && !isPdfDelimiter(content[j])) j++;
            tokens.push({ t: 'name', v: content.slice(i + 1, j) });
            i = j;
            continue;
        }
        if (ch === '{' || ch === '}') {
            i++;
            continue;
        }
        let j = i;
        while (j < n && !isPdfWhitespace(content[j]) && !isPdfDelimiter(content[j])) j++;
        if (j === i) {
            i++;
            continue;
        }
        const word = content.slice(i, j);
        i = j;
        if (isNumericWord(word)) tokens.push({ t: 'number', v: Number(word) });
        else tokens.push({ t: 'op', v: word });
    }
    return tokens;
}

/** 用字体 CMap 解码展示字节串，并累计质量统计。 */
function decodeShowBytes(bytes, font, stats) {
    if (!bytes || bytes.length === 0) return '';
    if (font && font.cmap && font.cmap.size > 0) {
        let out = '';
        if (font.codeBytes === 2) {
            for (let i = 0; i + 1 < bytes.length; i += 2) {
                stats.units++;
                const mapped = font.cmap.get((bytes[i] << 8) | bytes[i + 1]);
                if (mapped !== undefined) out += mapped;
                else { out += '\uFFFD'; stats.bad++; }
            }
            if (bytes.length % 2 === 1) {
                stats.units++;
                stats.bad++;
                out += '\uFFFD';
            }
        } else {
            for (const byte of bytes) {
                stats.units++;
                const mapped = font.cmap.get(byte);
                if (mapped !== undefined) out += mapped;
                else { out += '\uFFFD'; stats.bad++; }
            }
        }
        return out;
    }
    if (font && font.undecodable) {
        const glyphCount = font.codeBytes === 2 ? Math.ceil(bytes.length / 2) : bytes.length;
        stats.units += glyphCount;
        stats.bad += glyphCount;
        return '';
    }
    const decoded = decodePdfBytes(bytes);
    // 未知字体且字节串含 NUL：很可能是不受支持的 2 字节 CID 字形码，不猜文本。
    if (bytes.includes(0) || decoded.includes('\u0000')) {
        stats.units += Math.ceil(bytes.length / 2);
        stats.bad += Math.ceil(bytes.length / 2);
        return '';
    }
    stats.units += Array.from(decoded).length;
    return decoded;
}

/** 从内容流抽取展示文本（Tj/TJ/'/"），按字体 CMap 解码并用 Tm/Td 粗略断行。 */
function textFromPdfContent(content, fontMap) {
    const tokens = tokenizePdfContent(content);
    const stats = { units: 0, bad: 0 };
    let out = '';
    let lastY = null;
    let currentFont = null;
    let operands = [];
    const arrayStack = [];

    const newline = () => {
        if (out.length > 0 && !out.endsWith('\n')) out += '\n';
    };
    const pushOperand = (value) => {
        if (arrayStack.length > 0) arrayStack[arrayStack.length - 1].items.push(value);
        else operands.push(value);
    };
    const lastBytes = () => {
        for (let k = operands.length - 1; k >= 0; k--) {
            if (Array.isArray(operands[k])) return operands[k];
        }
        return null;
    };
    const lastArray = () => {
        for (let k = operands.length - 1; k >= 0; k--) {
            if (operands[k] && Array.isArray(operands[k].items)) return operands[k];
        }
        return null;
    };
    const lastFontName = () => {
        for (let k = operands.length - 1; k >= 0; k--) {
            if (operands[k] && typeof operands[k] === 'object' && operands[k].fontName !== undefined) {
                return operands[k].fontName;
            }
        }
        return null;
    };
    const numbers = () => operands.filter((value) => typeof value === 'number');

    for (const token of tokens) {
        if (token.t === 'arrStart') {
            const array = { items: [] };
            pushOperand(array);
            arrayStack.push(array);
            continue;
        }
        if (token.t === 'arrEnd') {
            arrayStack.pop();
            continue;
        }
        if (token.t === 'string' || token.t === 'number') {
            pushOperand(token.v);
            continue;
        }
        if (token.t === 'name') {
            pushOperand({ fontName: token.v });
            continue;
        }
        if (token.t !== 'op') continue;

        const op = token.v;
        if (op === 'Tj') {
            const bytes = lastBytes();
            if (bytes) out += decodeShowBytes(bytes, currentFont, stats);
        } else if (op === 'TJ') {
            const array = lastArray();
            if (array) {
                for (const item of array.items) {
                    if (Array.isArray(item)) {
                        out += decodeShowBytes(item, currentFont, stats);
                    } else if (typeof item === 'number' && item < -100) {
                        out += ' ';
                    }
                }
            }
        } else if (op === "'" || op === '"') {
            const bytes = lastBytes();
            newline();
            if (bytes) out += decodeShowBytes(bytes, currentFont, stats);
        } else if (op === 'Tf') {
            const name = lastFontName();
            currentFont = name !== null ? (fontMap.get(name) ?? null) : null;
        } else if (op === 'Td' || op === 'TD') {
            const nums = numbers();
            if (nums.length >= 2 && Math.abs(nums[1]) > 0.001) newline();
        } else if (op === 'T*') {
            newline();
        } else if (op === 'Tm') {
            const nums = numbers();
            if (nums.length >= 6) {
                const y = nums[5];
                if (lastY !== null && Math.abs(y - lastY) > 0.01) newline();
                lastY = y;
            }
        } else if (op === 'BT') {
            newline();
            lastY = null;
        } else if (op === 'ET') {
            newline();
        }
        operands = [];
        arrayStack.length = 0;
    }
    return { text: out, stats };
}

/** 扫描 buffer 里的 stream ... endstream 段（跳过 endstream 里的 "stream"）。 */
function collectPdfStreams(buf) {
    const raw = buf.toString('latin1');
    const streams = [];
    let index = 0;
    for (;;) {
        const start = raw.indexOf('stream', index);
        if (start < 0) break;
        index = start + 6;
        if (start >= 3 && raw.slice(start - 3, start) === 'end') continue;
        const prev = start > 0 ? raw[start - 1] : '\n';
        if (!isPdfWhitespace(prev) && prev !== '>') continue;
        let dataStart = start + 6;
        if (raw[dataStart] === '\r') dataStart++;
        if (raw[dataStart] === '\n') dataStart++;
        const end = raw.indexOf('endstream', dataStart);
        if (end < 0) break;
        let dataEnd = end;
        if (raw[dataEnd - 1] === '\n') dataEnd--;
        if (raw[dataEnd - 1] === '\r') dataEnd--;
        if (dataEnd >= dataStart) {
            streams.push({
                dict: raw.slice(Math.max(0, start - 1500), start),
                data: buf.subarray(dataStart, dataEnd),
            });
        }
        index = end + 9;
    }
    return streams;
}

function classifyPdfStream(dict) {
    if (/\/Subtype\s*\/Image/.test(dict)) return 'image';
    if (/\/FlateDecode/.test(dict)) return 'flate';
    if (/\/Filter/.test(dict)) return 'other-filter';
    return 'raw';
}

/** 解压一个 PDF 流，返回内容文本；无法处理时返回 null。 */
function decodePdfStream(stream) {
    const kind = classifyPdfStream(stream.dict);
    if (kind === 'image' || kind === 'other-filter') return null;
    if (kind === 'raw') return stream.data.toString('latin1');
    const attempts = [];
    try {
        attempts.push(inflateSync(stream.data, { maxOutputLength: MAX_PDF_STREAM_BYTES }));
    } catch { /* try raw deflate next */ }
    try {
        attempts.push(inflateRawSync(stream.data, { maxOutputLength: MAX_PDF_STREAM_BYTES }));
    } catch { /* ignore */ }
    for (const buffer of attempts) {
        if (buffer && buffer.length > 0) return buffer.toString('latin1');
    }
    return null;
}

function normalizePdfText(text) {
    return text
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.replace(/[ \t\u00a0]+$/g, ''))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function isPdfContentStream(text) {
    if (!text) return false;
    if (!/\bBT\b/.test(text)) return false;
    return /\bTj\b|\bTJ\b/.test(text);
}

/** 质量闸数据：不可解码码位比例 / 可疑字符比例。 */
function assessPdfText(text, stats) {
    let visible = 0;
    let suspicious = 0;
    for (const ch of text) {
        if (/\s/.test(ch)) continue;
        visible++;
        const cp = ch.codePointAt(0);
        if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) {
            suspicious++;
            continue;
        }
        if (cp === 0xfffd || cp === 0xfffe || cp === 0xffff || (cp >= 0xe000 && cp <= 0xf8ff)) {
            suspicious++;
        }
    }
    return {
        visible,
        badRatio: stats.units > 0 ? stats.bad / stats.units : 1,
        suspiciousRatio: visible > 0 ? suspicious / visible : 1,
    };
}

/** 尽力抽取 PDF 文本层；失败抛 PdfUnsupportedError，非 PDF 抛 DocReadError。 */
function extractPdfText(buf) {
    if (buf.length < 8) throw new PdfUnsupportedError('file is too short to be a PDF');
    const head = buf.subarray(0, 1024).toString('latin1');
    if (!head.includes('%PDF-')) {
        throw new DocReadError('not a PDF file (missing %PDF header)');
    }
    const raw = buf.toString('latin1');
    if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(raw)) {
        throw new PdfUnsupportedError('document is encrypted (text extraction requires decryption credentials)');
    }

    const streams = collectPdfStreams(buf);
    if (streams.length === 0) {
        throw new PdfUnsupportedError('no stream objects found (unsupported or corrupt PDF structure)');
    }

    const objects = collectPdfObjects(buf);
    const fontMap = buildFontMap(objects, collectFontNameRefs(buf, objects));

    const decoded = [];
    for (const stream of streams) {
        const content = decodePdfStream(stream);
        if (content && isPdfContentStream(content)) decoded.push(content);
    }
    if (decoded.length === 0) {
        throw new PdfUnsupportedError(
            'no text layer found (scanned/image-only content, or unsupported content stream encoding)',
        );
    }

    const pieces = [];
    const totals = { units: 0, bad: 0 };
    for (const content of decoded) {
        const { text, stats } = textFromPdfContent(content, fontMap);
        totals.units += stats.units;
        totals.bad += stats.bad;
        if (text.trim()) pieces.push(text);
    }
    const text = normalizePdfText(pieces.join('\n\n'));
    const quality = assessPdfText(text, totals);
    if (!text.trim()) {
        throw new PdfUnsupportedError(
            totals.units > 0
                ? 'text operators found but no glyph could be decoded (CID font encoding without a usable ToUnicode map)'
                : 'no extractable text layer found (scanned/image-only page)',
        );
    }
    if (quality.badRatio > MAX_QUALITY_BAD_RATIO) {
        throw new PdfUnsupportedError(
            `CID font encoding without a usable ToUnicode map (${Math.round(quality.badRatio * 100)}% of glyph codes undecodable)`,
        );
    }
    if (quality.suspiciousRatio > MAX_QUALITY_SUSPICIOUS_RATIO) {
        throw new PdfUnsupportedError(
            `decoded text is mostly non-printable/replacement characters (${Math.round(quality.suspiciousRatio * 100)}%)`,
        );
    }
    return text;
}

function pdfToolDefinition(deps) {
    return {
        name: 'ops_read_pdf',
        description:
            'Best-effort extraction of the text layer from a PDF. Decodes Tj/TJ strings with the embedded '
            + 'ToUnicode CMaps (CID/Type0 fonts) and returns an explanatory message when the file cannot be decoded.',
        parameters: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Path to a .pdf file (absolute, or relative to the session working directory).',
                },
                limit: {
                    type: 'number',
                    description: `Maximum text lines to return (default ${DEFAULT_PDF_LIMIT}).`,
                },
            },
            required: ['path'],
            additionalProperties: false,
        },
        output: OUTPUT,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const toolName = 'ops_read_pdf';
            let absPath = '';
            try {
                const a = args ?? {};
                absPath = await resolveInputPath(a.path, exec, deps);
                const limit = readInt(a.limit, 'limit', DEFAULT_PDF_LIMIT, 1, DEFAULT_PDF_MAX_LIMIT);
                const buf = await loadFile(absPath, MAX_ARCHIVE_BYTES, toolName);

                let text;
                try {
                    text = extractPdfText(buf);
                } catch (err) {
                    if (err instanceof PdfUnsupportedError) {
                        return `PDF text extraction unsupported for this file: ${err.message} (${describePath(absPath)})`;
                    }
                    throw err;
                }

                const lines = text.split('\n');
                const total = lines.length;
                const shown = lines.slice(0, limit);
                const width = String(shown.length).length;
                const body = shown.map((line, i) => `${String(i + 1).padStart(width)}| ${line}`).join('\n');
                const header = `PDF ${describePath(absPath)}\n${total} lines | showing 1-${shown.length}`;
                const footer = shown.length < total
                    ? `[truncated: ${total - shown.length} more lines; call with limit=${Math.min(total, limit * 2)}]`
                    : '';
                return finishOutput([header, '', body, footer].filter(Boolean).join('\n'), deps);
            } catch (err) {
                if (err instanceof DocReadError || !absPath) return errorText(toolName, err);
                return `PDF text extraction unsupported for this file: ${err && err.message ? err.message : String(err)}`
                    + (absPath ? ` (${describePath(absPath)})` : '');
            }
        },
    };
}

/* ------------------------------------------------------------------ */
/* 工厂                                                               */
/* ------------------------------------------------------------------ */

export function buildDocTools(deps = {}) {
    const definitions = [tableToolDefinition(deps), docxToolDefinition(deps), pdfToolDefinition(deps)];
    return definitions;
}

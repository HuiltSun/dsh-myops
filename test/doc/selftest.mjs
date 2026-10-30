import { pathToFileURL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { Buffer } from 'node:buffer';

const moduleUrl = pathToFileURL(resolve('../../lib/doc-tools.mjs')).href;
const { buildDocTools } = await import(moduleUrl);
const tools = buildDocTools({});
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

let fails = 0;
function check(label, cond, detail) {
    if (cond) console.log(`PASS  ${label}`);
    else { fails++; console.log(`FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
}
function show(label, text, max = 1800) {
    console.log(`\n===== ${label} =====`);
    console.log(text.length > max ? `${text.slice(0, max)}\n...[${text.length - max} more chars]` : text);
    console.log(`----- (${text.length} chars, ${text.split('\n').length} lines) -----`);
}

console.log('tools:', tools.map((t) => t.name).join(', '));
check('exports exactly three tools', tools.length === 3
    && Boolean(byName.ops_read_table && byName.ops_read_docx && byName.ops_read_pdf));
for (const t of tools) {
    check(`${t.name}: CONTRACT.md tool shape`, typeof t.description === 'string'
        && t.parameters?.type === 'object'
        && typeof t.parameters.additionalProperties === 'boolean'
        && Array.isArray(t.parameters.required)
        && t.output?.schema?.type === 'string'
        && typeof t.isConcurrencySafe === 'function' && t.isConcurrencySafe() === true
        && typeof t.execute === 'function');
}

const fixture = process.cwd();
const exec = { workdir: fixture };
const call = async (name, args, execCtx = exec) => {
    let value;
    try {
        value = await byName[name].execute(args, execCtx);
    } catch (err) {
        fails++;
        console.log(`FAIL  ${name} ${JSON.stringify(args)} threw: ${err.message}`);
        return '';
    }
    check(`${name} ${JSON.stringify(args)} returns string`, typeof value === 'string');
    return value;
};

/* ================= ops_read_table ================= */

const t1 = await call('ops_read_table', { path: 'people.csv' });
show('table people.csv (auto delimiter)', t1);
check('CSV: comma inferred', t1.includes('delimiter=, (auto)'));
check('CSV: quoted comma preserved', t1.includes('likes commas, and "quotes"'));
check('CSV: quoted newline flattened', t1.includes('multi line cell'));
check('CSV: CJK cell', t1.includes('陈小明'));
check('CSV: 3 columns / 4 rows', t1.includes('3 columns | 4 data rows'));

const t2 = await call('ops_read_table', { path: 'people.csv', limit: 2, offset: 2 });
show('table people.csv offset=2 limit=2', t2);
check('CSV page: rows 2-3', t2.includes('showing rows 2-3'));
check('CSV page: more hint', t2.includes('offset=4'));
check('CSV page: header always shown', t2.includes('name') && t2.includes('age') && t2.includes('note'));

const t3 = await call('ops_read_table', { path: 'people.csv', offset: 99 });
show('table offset beyond range (readable error)', t3);
check('CSV: offset error readable', t3.startsWith('ops_read_table error:') && t3.includes('beyond row count'));

const t4 = await call('ops_read_table', { path: 'items.tsv' });
show('table items.tsv (auto tab)', t4);
check('TSV: tab inferred', t4.includes('delimiter=\\t (auto)'));
check('TSV: quoted comma cell', t4.includes('Beta, Inc.'));
check('TSV: 3 data rows', t4.includes('3 data rows'));

const t5 = await call('ops_read_table', { path: 'eu.csv' });
check('SSV: semicolon inferred', t5.includes('delimiter=; (auto)'));
const t6 = await call('ops_read_table', { path: 'eu.csv', delimiter: 'semicolon' });
check('SSV: explicit delimiter alias', t6.includes('delimiter=; (given)'));

const t7 = await call('ops_read_table', { path: 'empty.csv' });
show('table empty.csv', t7);
check('empty: readable', t7.includes('table is empty'));

const t8 = await call('ops_read_table', { path: 'binary.csv' });
show('table binary.csv', t8);
check('binary: readable error', t8.startsWith('ops_read_table error:') && t8.includes('binary'));

const t9 = await call('ops_read_table', { path: 'plain.txt' });
check('plain text: no crash, string', typeof t9 === 'string');

const t10 = await call('ops_read_table', { path: 'does-not-exist.csv' });
check('missing CSV: readable', t10.startsWith('ops_read_table error:') && t10.includes('file not found'));
const t11 = await call('ops_read_table', { path: 'people.csv', delimiter: ';;' });
check('bad delimiter: readable', t11.startsWith('ops_read_table error:') && t11.includes('single character'));
const t12 = await call('ops_read_table', { path: 'people.csv', limit: 0 });
check('bad limit: readable', t12.startsWith('ops_read_table error:') && t12.includes('limit'));
const t13 = await call('ops_read_table', {});
check('missing path: readable', t13.startsWith('ops_read_table error:') && t13.includes('path is required'));
const t14 = await call('ops_read_table', { path: 'people.csv' }, {});
check('no exec.workdir: cwd fallback gives readable result', typeof t14 === 'string' && t14.length > 0);
const t15 = await call('ops_read_table', { path: resolve(fixture, 'people.csv') });
check('absolute path works', t15.includes('4 data rows'));
const t16 = await call('ops_read_table', { path: 'people.csv', delimiter: ',' });
check('explicit comma delimiter', t16.includes('delimiter=, (given)'));

/* big CSV truncation */
{
    const rows = ['id,val,note'];
    for (let i = 1; i <= 120; i++) rows.push(`${i},${i * 10},"row, ${i}"`);
    await writeFile(join(fixture, 'big.csv'), rows.join('\n'), 'utf8');
    const t = await call('ops_read_table', { path: 'big.csv' });
    check('big CSV: default limit 50', t.includes('showing rows 1-50') && t.includes('of 120 rows') && t.includes('offset=51'));
    const tail = await call('ops_read_table', { path: 'big.csv', limit: 5, offset: 118 });
    check('big CSV: last page', tail.includes('showing rows 118-120') && !tail.includes('more:'));
    const wide = ['a,b,c,d,e,f,g,h,i,j'];
    for (let i = 1; i <= 3; i++) wide.push('1,2,3,4,5,6,7,8,9,10');
    await writeFile(join(fixture, 'wide.csv'), wide.join('\n'), 'utf8');
    const w = await call('ops_read_table', { path: 'wide.csv' });
    show('table wide.csv (vertical record mode)', w);
    check('wide table: vertical col: value mode', w.includes('a: 1') && w.includes('j: 10') && w.includes('# 1'));
}

/* ================= ops_read_docx ================= */

const d1 = await call('ops_read_docx', { path: 'min.docx' });
show('docx min.docx (deflate)', d1);
check('DOCX: header', d1.includes('DOCX') && d1.includes('paragraphs'));
check('DOCX: XML entity amp', d1.includes('Myops Docx Test & More'));
check('DOCX: CJK paragraph', d1.includes('第一段：中文测试'));
check('DOCX: tab preserved', d1.includes('Tabbed') && d1.includes('\t'));
check('DOCX: <w:br/> becomes line break', d1.includes('Tabbed\nline2'));
check('DOCX: XML entity lt/gt/quot', d1.includes('spaced <tag> "q"'));
check('DOCX: table cell paragraphs', d1.includes('cell A') && d1.includes('cell B'));
check('DOCX: instrText skipped', !d1.includes('PAGE') && d1.includes('tail'));
check('DOCX: consecutive empty paragraphs collapsed', !d1.includes('\n\n\n'));

const d2 = await call('ops_read_docx', { path: 'stored.docx' });
check('DOCX stored (method 0) works', d2.includes('Myops Docx Test & More'));

const d3 = await call('ops_read_docx', { path: 'min.docx', limit: 2 });
show('docx min.docx limit=2', d3);
check('DOCX limit: truncation note', d3.includes('more paragraphs') && d3.includes('showing 1-2'));

const d4 = await call('ops_read_docx', { path: 'fake.docx' });
show('docx fake.docx (not a zip)', d4);
check('DOCX: non-zip readable', d4.startsWith('ops_read_docx error:') && d4.includes('not a ZIP'));
const d5 = await call('ops_read_docx', { path: 'nodoc.docx' });
show('docx nodoc.docx (missing word/document.xml)', d5);
check('DOCX: missing part readable', d5.startsWith('ops_read_docx error:') && d5.includes('missing word/document.xml'));
const d6 = await call('ops_read_docx', { path: 'missing.docx' });
check('DOCX: missing file readable', d6.startsWith('ops_read_docx error:') && d6.includes('file not found'));
const d7 = await call('ops_read_docx', { path: 'people.csv' });
check('DOCX: wrong type readable', d7.startsWith('ops_read_docx error:'));

/* ================= ops_read_pdf: fixtures ================= */

const p1 = await call('ops_read_pdf', { path: 'simple.pdf' });
show('pdf simple.pdf (plain Helvetica, no CMap)', p1);
check('PDF: Tj text', p1.includes('Hello PDF'));
check('PDF: escaped parens', p1.includes('Second line (with parens)'));
check('PDF: TJ array with kerning space', p1.includes('A B'));
check('PDF: second BT block', p1.includes('line three'));
check('PDF: line numbering', /^\s*1\|/m.test(p1));

const p2 = await call('ops_read_pdf', { path: 'simple.pdf', limit: 2 });
check('PDF limit: truncation note', p2.includes('more lines') && p2.includes('showing 1-2'));

const p3 = await call('ops_read_pdf', { path: 'fake.pdf' });
show('pdf fake.pdf (not a PDF)', p3);
check('PDF: garbage readable', (p3.startsWith('PDF text extraction unsupported for this file:')
    || p3.startsWith('ops_read_pdf error:')) && p3.includes('%PDF'));
const p4 = await call('ops_read_pdf', { path: 'encrypted.pdf' });
show('pdf encrypted.pdf', p4);
check('PDF: encrypted readable', p4.startsWith('PDF text extraction unsupported for this file:') && p4.includes('encrypted'));
const p5 = await call('ops_read_pdf', { path: 'scanned.pdf' });
show('pdf scanned.pdf (no text layer)', p5);
check('PDF: no text layer readable', p5.startsWith('PDF text extraction unsupported for this file:') && p5.includes('text layer'));
const p6 = await call('ops_read_pdf', { path: 'missing.pdf' });
check('PDF: missing file readable', p6.startsWith('ops_read_pdf error:') && p6.includes('file not found'));
const p7 = await call('ops_read_pdf', {});
check('PDF: missing path readable', p7.startsWith('ops_read_pdf error:'));

/* ---- synthetic PDF with ToUnicode CMap (Chinese, Identity-H) ---- */
function makePdf(objects) {
    let out = '%PDF-1.4\n';
    for (const [num, body] of objects) out += `${num} 0 obj\n${body}\nendobj\n`;
    out += 'trailer\n<< /Root 1 0 R >>\n%%EOF\n';
    return Buffer.from(out, 'latin1');
}
function streamObject(data, extra = '') {
    return `<< /Length ${data.length}${extra} >>\nstream\n${data.toString('latin1')}\nendstream`;
}
const cMap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CMapName /MyopsTest-H def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    '4 beginbfchar',
    '<0001> <5B66>',
    '<0002> <751F>',
    '<0003> <8BC1>',
    '<0004> <0020>',
    'endbfchar',
    '1 beginbfrange',
    '<0010> <0012> <4E00>',
    'endbfrange',
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
].join('\n');
const cmapStream = deflateSync(Buffer.from(cMap, 'latin1'));
const contentCjk = Buffer.from(
    'BT /F1 18 Tf 72 720 Td <00010002> Tj '
    + '0 -24 Td [<0003> -300 <0010>] TJ '
    + '<00040004000100020003> \' ET',
    'latin1',
);
const contentStream = deflateSync(contentCjk);
const pdfCjk = makePdf([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R '
        + '/Resources << /Font << /F1 5 0 R >> >> >>'],
    [4, streamObject(contentStream, ' /Filter /FlateDecode')],
    [5, '<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /Identity-H '
        + '/DescendantFonts [7 0 R] /ToUnicode 6 0 R >>'],
    [6, streamObject(cmapStream, ' /Filter /FlateDecode')],
    [7, '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SimSun >>'],
]);
await writeFile(join(fixture, 'tounicode.pdf'), pdfCjk);
const p8 = await call('ops_read_pdf', { path: 'tounicode.pdf' });
show('pdf tounicode.pdf (Type0 Identity-H + ToUnicode CMap)', p8);
check('ToUnicode: Chinese glyphs decoded', p8.includes('学生'));
check('ToUnicode: bfrange glyph decoded', p8.includes('一') && p8.includes('证'));
check('ToUnicode: no replacement chars', !p8.includes('\uFFFD'));
check('ToUnicode: quote operator line break', p8.includes('学生证'));

/* ---- Type0 Identity-H without ToUnicode => must be unsupported, not garbage ---- */
const contentNoMap = deflateSync(Buffer.from('BT /F1 18 Tf 72 720 Td <000100020003> Tj ET', 'latin1'));
const pdfNoMap = makePdf([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R '
        + '/Resources << /Font << /F1 5 0 R >> >> >>'],
    [4, streamObject(contentNoMap, ' /Filter /FlateDecode')],
    [5, '<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /Identity-H '
        + '/DescendantFonts [7 0 R] >>'],
    [7, '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SimSun >>'],
]);
await writeFile(join(fixture, 'cid-nomap.pdf'), pdfNoMap);
const p9 = await call('ops_read_pdf', { path: 'cid-nomap.pdf' });
show('pdf cid-nomap.pdf (CID font without ToUnicode)', p9);
check('CID no CMap: unsupported, not garbage', p9.startsWith('PDF text extraction unsupported for this file:')
    && /ToUnicode|decodab/.test(p9));
check('CID no CMap: no raw glyph dump', !/[^\x00-\x7F]/.test(p9.split('\n')[0]));

/* ---- modern PDF: font dicts inside a compressed /ObjStm object stream ---- */
{
    const contentObjStm = deflateSync(Buffer.from('BT /F1 18 Tf 72 720 Td <00010002> Tj ET', 'latin1'));
    const cmapStream2 = deflateSync(Buffer.from(cMap, 'latin1'));
    const embedded5 = '<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /Identity-H '
        + '/DescendantFonts [6 0 R] /ToUnicode 9 0 R >>';
    const embedded6 = '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SimSun >>';
    const headerText = `5 0 6 ${embedded5.length + 1}\n`;
    const objStmText = `${headerText}${embedded5}\n${embedded6}`;
    const objStmData = deflateSync(Buffer.from(objStmText, 'latin1'));
    const pdfObjStm = makePdf([
        [1, '<< /Type /Catalog /Pages 2 0 R >>'],
        [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
        [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources 8 0 R >>'],
        [4, streamObject(contentObjStm, ' /Filter /FlateDecode')],
        [8, '<< /Font << /F1 5 0 R >> >>'],
        [9, streamObject(cmapStream2, ' /Filter /FlateDecode')],
        [10, `<< /Type /ObjStm /N 2 /First ${headerText.length} /Length ${objStmData.length} `
            + '/Filter /FlateDecode >>\nstream\n' + objStmData.toString('latin1') + '\nendstream'],
    ]);
    await writeFile(join(fixture, 'objstm.pdf'), pdfObjStm);
    const p10 = await call('ops_read_pdf', { path: 'objstm.pdf' });
    show('pdf objstm.pdf (font dict inside compressed /ObjStm)', p10);
    check('ObjStm: font map resolved from object stream', p10.includes('学生'));
    check('ObjStm: no replacement chars', !p10.includes('\uFFFD'));
}

/* ---- control-character "text" => quality gate must reject instead of returning garbage ---- */
{
    const garbage = deflateSync(Buffer.from('BT /F1 12 Tf 72 720 Td (\x01\x02\x03\x04\x05\x06\x07\x08) Tj ET', 'latin1'));
    const pdfGarbage = makePdf([
        [1, '<< /Type /Catalog /Pages 2 0 R >>'],
        [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
        [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>'],
        [4, streamObject(garbage, ' /Filter /FlateDecode')],
    ]);
    await writeFile(join(fixture, 'control-garbage.pdf'), pdfGarbage);
    const p11 = await call('ops_read_pdf', { path: 'control-garbage.pdf' });
    show('pdf control-garbage.pdf (control chars => quality gate)', p11);
    check('quality gate: control-char text rejected', p11.startsWith('PDF text extraction unsupported for this file:')
        && /non-printable|replacement/.test(p11));
}

/* ================= real-world PDFs (optional, local only) ================= */
// 真实文件测试不随仓库发布。需要时设置环境变量：
//   set MYOPS_REAL_PDF=C:\path\to\file.pdf
// 预期为「有文本层」或「扫描件」都可以，这里只要求：不返回乱码（无 U+FFFD），
// 或者给出明确的 unsupported 说明。
const realPdfs = process.env.MYOPS_REAL_PDF
    ? [{ path: process.env.MYOPS_REAL_PDF }]
    : [];
for (const item of realPdfs) {
    const name = item.path.split(/[\\/]/).pop();
    let exists = true;
    try { await readFile(item.path); } catch { exists = false; }
    if (!exists) { console.log(`SKIP  real PDF not found: ${item.path}`); continue; }
    const text = await call('ops_read_pdf', { path: item.path, limit: 12 });
    show(`pdf real: ${name}`, text);
    check(`real PDF ${name}: no replacement chars or unsupported notice`,
        text.startsWith('PDF text extraction unsupported for this file:') || !text.includes('\uFFFD'));
}

/* matplotlib-like PDF (if present in fixtures) */
for (const candidate of ['back.pdf', '../back.pdf']) {
    let exists = true;
    try { await readFile(resolve(fixture, candidate)); } catch { exists = false; }
    if (!exists) continue;
    const text = await call('ops_read_pdf', { path: resolve(fixture, candidate), limit: 8 });
    show(`pdf matplotlib-like: ${candidate}`, text);
    check('matplotlib PDF: no garbage (either readable or unsupported)',
        text.startsWith('PDF text extraction unsupported for this file:') || !text.includes('\uFFFD'));
}

console.log(`\nTOTAL FAILURES: ${fails}`);
process.exitCode = fails === 0 ? 0 : 1;

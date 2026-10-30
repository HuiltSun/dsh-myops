/**
 * test/smoke.mjs — dsh-myops 冒烟测试（无外部依赖）。
 *
 * 直接调用 apply(fake ctx) 注册全部工具，然后逐个真跑一遍。
 * 用法：
 *   node test/smoke.mjs
 * 退出码 0 = 全部通过。
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function expectError(name, fn, includes) {
  try {
    await fn();
    ok(name, false, 'expected an error but none was thrown');
  } catch (error) {
    const message = String(error?.message ?? error);
    ok(name, includes ? message.includes(includes) : true, message);
  }
}

const defs = new Map();
const ctx = {
  tools: { register: (d) => { defs.set(d.name, d); return () => {}; }, restrict: () => () => {} },
  logger: { info: () => {}, warn: () => {} },
  on: () => {},
  get: () => undefined,
  effect: () => {},
};

apply(ctx, {});
const T = (name) => defs.get(name);
const work = mkdtempSync(join(tmpdir(), 'myops-smoke-'));

console.log('--- registration ---');
const expected = [
  'ops_bash', 'ops_read', 'ops_glob', 'ops_grep', 'ops_write', 'ops_edit',
  'ops_stat', 'ops_result', 'ops_read_table', 'ops_read_docx', 'ops_read_pdf', 'ops_git',
];
ok('all 12 tools registered', expected.every((n) => defs.has(n)), [...defs.keys()].join(','));

console.log('--- ops_bash ---');
const bashOut = String(await T('ops_bash').execute({ command: 'echo SMOKE_OK; pwd' }));
ok('bash runs', bashOut.includes('SMOKE_OK'), bashOut.split('\n')[0]);
ok('bash reports exit code', bashOut.includes('exit code: 0'));

console.log('--- ops_write / ops_edit / ops_stat ---');
const file = join(work, 'a.txt');
const wrote = String(await T('ops_write').execute({ path: file, content: 'one\ntwo\nthree' }));
ok('write creates file', readFileSync(file, 'utf8') === 'one\ntwo\nthree', wrote);
ok('write reports revision', /rev [0-9a-f]{6,}/.test(wrote), wrote);

await expectError('write ifNotExists rejects existing', () => T('ops_write').execute({ path: file, content: 'x', ifNotExists: true }), 'already exists');

const dry = String(await T('ops_write').execute({ path: file, content: 'CHANGED', dryRun: true }));
ok('dryRun does not write', readFileSync(file, 'utf8').startsWith('one'), dry);
ok('dryRun says dry-run', dry.includes('dry-run'), dry);

const edited = String(await T('ops_edit').execute({ path: file, edits: [{ oldText: 'two', newText: 'TWO' }] }));
ok('edit applies', readFileSync(file, 'utf8') === 'one\nTWO\nthree', edited);

const intact = readFileSync(file, 'utf8');
await expectError('edit rejects oldText missing', () => T('ops_edit').execute({ path: file, edits: [{ oldText: 'zzz', newText: 'y' }] }), '0 times');
ok('failed edit leaves file intact', readFileSync(file, 'utf8') === intact);

const dupFile = join(work, 'dup.txt');
await T('ops_write').execute({ path: dupFile, content: 'aaa\nbbb' });
const dupBefore = readFileSync(dupFile, 'utf8');
await expectError('edit rejects oldText repeated', () => T('ops_edit').execute({ path: dupFile, edits: [{ oldText: 'a', newText: 'z' }] }), 'times');
ok('repeated-edit leaves file intact', readFileSync(dupFile, 'utf8') === dupBefore);

const stat = String(await T('ops_stat').execute({ path: file }));
ok('stat file reports size/lines/sha256', /size:/.test(stat) && /lines:/.test(stat) && /sha256:/.test(stat), stat.split('\n').slice(0, 4).join(' | '));

console.log('--- ops_read + 去重 ---');
// 去重的收益只在文件足够大时体现：小文件的 "unchanged" 提示可能比正文还长。
const bigRead = join(work, 'big.txt');
writeFileSync(bigRead, Array.from({ length: 400 }, (_, i) => `row ${i + 1} ${'x'.repeat(20)}`).join('\n'));
const bigFirst = String(await T('ops_read').execute({ path: bigRead }));
const bigSecond = String(await T('ops_read').execute({ path: bigRead }));
ok('large file first read returns body', bigFirst.includes('1| row 1'), bigFirst.split('\n')[0]);
ok('large file second read is de-duplicated', bigSecond.includes('unchanged since last read'), bigSecond.split('\n')[0]);
ok('dedup saves output on large file', bigSecond.length * 4 < bigFirst.length, `${bigFirst.length} -> ${bigSecond.length}`);

const first = String(await T('ops_read').execute({ path: file }));
const second = String(await T('ops_read').execute({ path: file }));
ok('first read returns body', first.includes('1| one'), first.split('\n')[0]);
ok('second read is de-duplicated', second.includes('unchanged since last read'), second.split('\n')[0]);
const forced = String(await T('ops_read').execute({ path: file, force: true }));
ok('force reprints body', forced.includes('1| one'));

const empty = join(work, 'empty.txt');
writeFileSync(empty, '');
const emptyRead = String(await T('ops_read').execute({ path: empty }));
ok('empty file is 0 lines', emptyRead.includes('(0 lines'), emptyRead.split('\n')[0]);
const emptyStat = String(await T('ops_stat').execute({ path: empty }));
ok('empty file stat agrees on 0 lines', /lines: 0/.test(emptyStat), emptyStat.split('\n')[3]);

console.log('--- ops_glob / ops_grep ---');
const globOut = String(await T('ops_glob').execute({ pattern: '*.json', path: join(work) }));
ok('glob finds nothing in empty dir', globOut.includes('No files matched'), globOut.split('\n')[0]);
writeFileSync(join(work, 'b.json'), '{"k":"v"}');
const globOut2 = String(await T('ops_glob').execute({ pattern: '*.json', path: work }));
ok('glob finds json', globOut2.includes('b.json'), globOut2.split('\n')[0]);
const grepOut = String(await T('ops_grep').execute({ pattern: '"k"', path: work, include: '**/*.json' }));
ok('grep finds match', grepOut.includes('b.json:1'), grepOut.split('\n')[1] ?? grepOut);

console.log('--- ops_result (spill + paging) ---');
const big = String(await T('ops_bash').execute({ command: 'seq 1 40000' }));
const id = /id="([0-9a-f]+)"/.exec(big)?.[1];
ok('large bash output is spilled', Boolean(id), big.split('\n').slice(-1)[0]);
if (id) {
  const page = String(await T('ops_result').execute({ id, offset: 39999, limit: 3 }));
  ok('ops_result pages to the end', page.includes('39999|') && page.includes('40000|'), page.split('\n').slice(0, 4).join(' | '));
  await expectError('ops_result rejects unknown id', () => T('ops_result').execute({ id: 'deadbeef' }), 'unknown output id');
}

console.log('--- ops_read_table / docx / pdf ---');
const csv = join(work, 'a.csv');
writeFileSync(csv, 'name,note\n"Zhang, S","says ""hi"""\nLi,plain\n');
const tableOut = String(await T('ops_read_table').execute({ path: csv }));
ok('csv handles quoted commas', tableOut.includes('Zhang, S') && tableOut.includes('says "hi"'), tableOut.split('\n').slice(0, 3).join(' | '));

const notDocx = join(work, 'not.docx');
writeFileSync(notDocx, 'plain text');
const docxErr = String(await T('ops_read_docx').execute({ path: notDocx }));
ok('docx on non-zip is readable error', /error/i.test(docxErr), docxErr.split('\n')[0]);

const notPdf = join(work, 'not.pdf');
writeFileSync(notPdf, 'plain text');
const pdfErr = String(await T('ops_read_pdf').execute({ path: notPdf }));
ok('pdf on non-pdf is readable error', /error|unsupported/i.test(pdfErr), pdfErr.split('\n')[0]);

console.log('');
console.log(`SUMMARY: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('failed checks:', failures.join(', '));
  process.exit(1);
}

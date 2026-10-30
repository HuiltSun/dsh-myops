/**
 * test/bench.mjs — dsh-myops 工具逐项效率验证（无外部依赖）。
 *
 * 与 smoke.mjs 的区别：smoke 只回答“对不对”，bench 同时回答“多快、多贵”：
 *   - 每个工具跑真实工作负载，记录 execute() 自身耗时（performance.now，不含模型往返）
 *   - 记录模型可见输出体积（字符数）——上下文成本
 *   - 校验输出格式与该工具的契约声明
 *
 * 用法：
 *   node test/bench.mjs
 * 退出码 0 = 全部通过；1 = 有失败项。
 * 结果同时写入 test/bench-report.json（供生成报告）。
 */

import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { apply } from '../index.mjs';
import { createSettingsStore, normalizeSettings } from '../lib/settings-store.mjs';
import { createSettingsRoute } from '../lib/settings-route.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const defs = new Map();
const SESSION_CWD_PROVIDER = {
  // 模拟 DSH 的 workingDirectory 服务：ensure(agent, signal) → 会话工作目录
  async ensure(agent) {
    if (!agent) throw new Error('workingDirectory.ensure requires an agent');
    return SESSION_DIR;
  },
};
let SESSION_DIR = process.cwd();
const ctx = {
  tools: { register: (d) => { defs.set(d.name, d); return () => {}; }, restrict: () => () => {} },
  logger: { info: () => {}, warn: () => {} },
  on: () => {},
  get: (name) => (name === 'workingDirectory' ? SESSION_CWD_PROVIDER : undefined),
  effect: () => {},
};
const agent = { id: 'bench-agent', ctx: { get: (name) => (name === 'workingDirectory' ? SESSION_CWD_PROVIDER : undefined) } };
const agentExec = { agent, signal: new AbortController().signal };
apply(ctx, {});

const T = (name) => {
  const tool = defs.get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool;
};

const results = [];
const failures = [];

/** 只做断言、不跑工具的用例行。 */
function checkOnly(tool, name, ok, detail = '') {
  const row = {
    tool,
    name,
    reps: 1,
    firstMs: 0,
    medianMs: 0,
    chars: 0,
    bytes: 0,
    status: ok ? 'pass' : 'fail',
    note: 'assertion',
    sample: String(detail).slice(0, 200),
  };
  if (!ok) failures.push(`${tool}/${name}: ${detail}`);
  results.push(row);
}

/** 跑一个用例 reps 次，记录耗时/输出体积，并做断言。 */
async function bench(tool, name, args, { reps = 5, check, note = '', exec, maxMs } = {}) {
  const times = [];
  let text = '';
  let error = null;
  try {
    for (let i = 0; i < reps; i += 1) {
      const t0 = performance.now();
      text = String(await T(tool).execute(args, exec));
      times.push(performance.now() - t0);
    }
  } catch (e) {
    error = String(e?.message ?? e);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const row = {
    tool,
    name,
    reps,
    firstMs: times.length ? +times[0].toFixed(2) : null,
    medianMs: median == null ? null : +median.toFixed(2),
    chars: error ? 0 : text.length,
    bytes: error ? 0 : Buffer.byteLength(text, 'utf8'),
    status: 'pass',
    error,
    note,
    sample: error ? String(error).split('\n')[0] : text.split('\n').slice(0, 3).join(' ⏎ ').slice(0, 220),
  };
  if (error) {
    row.status = 'fail';
    failures.push(`${tool}/${name}: threw ${error}`);
  } else if (check) {
    try {
      const verdict = check(text);
      if (verdict !== true && verdict !== undefined) {
        row.status = 'fail';
        row.error = String(verdict);
        failures.push(`${tool}/${name}: ${verdict}`);
      }
    } catch (e) {
      row.status = 'fail';
      row.error = String(e?.message ?? e);
      failures.push(`${tool}/${name}: check error ${row.error}`);
    }
  }
  if (row.status === 'pass' && typeof maxMs === 'number' && times.length) {
    const slowest = Math.max(...times);
    if (slowest > maxMs) {
      row.status = 'fail';
      row.error = `slowest ${slowest.toFixed(1)}ms > ${maxMs}ms`;
      failures.push(`${tool}/${name}: ${row.error}`);
    }
  }
  results.push(row);
  return text;
}

/** 期望抛错。 */
async function benchError(tool, name, args, includes, { reps = 3, exec } = {}) {
  const times = [];
  let message = '';
  try {
    for (let i = 0; i < reps; i += 1) {
      const t0 = performance.now();
      try {
        await T(tool).execute(args, exec);
        message = '<no error thrown>';
      } catch (e) {
        message = String(e?.message ?? e);
      }
      times.push(performance.now() - t0);
    }
  } finally {
    const sorted = [...times].sort((a, b) => a - b);
    const row = {
      tool,
      name,
      reps,
      firstMs: +times[0].toFixed(2),
      medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2),
      chars: message.length,
      bytes: Buffer.byteLength(message, 'utf8'),
      status: 'pass',
      note: 'expected error',
      sample: message.split('\n')[0].slice(0, 200),
    };
    if (!message.includes(includes)) {
      row.status = 'fail';
      failures.push(`${tool}/${name}: expected "${includes}", got "${message}"`);
    }
    results.push(row);
  }
}

const work = mkdtempSync(join(tmpdir(), 'myops-bench-'));
const bigTxt = join(work, 'big.txt');
writeFileSync(bigTxt, Array.from({ length: 2000 }, (_, i) => `row ${i + 1} ${'x'.repeat(40)}`).join('\n'));
const midTxt = join(work, 'mid.txt');
writeFileSync(midTxt, Array.from({ length: 300 }, (_, i) => `line ${i + 1} :: ${'y'.repeat(60)}`).join('\n'));
const oneTxt = join(work, 'one.txt');
writeFileSync(oneTxt, 'alpha\nbeta\ngamma\n');
const emptyFile = join(work, 'empty.txt');
writeFileSync(emptyFile, '');

/* ------------------------------------------------------------------ */
/* 0. 注册                                                             */
/* ------------------------------------------------------------------ */
const EXPECTED = [
  'ops_bash', 'ops_read', 'ops_glob', 'ops_grep', 'ops_write', 'ops_edit',
  'ops_stat', 'ops_result', 'ops_git',
];
const missing = EXPECTED.filter((n) => !defs.has(n));
if (missing.length) failures.push(`registration missing: ${missing.join(', ')}`);
if (defs.size !== EXPECTED.length) failures.push(`registered ${defs.size} tools, expected ${EXPECTED.length}`);

/* ------------------------------------------------------------------ */
/* 1. ops_bash                                                         */
/* ------------------------------------------------------------------ */
await bench('ops_bash', 'echo (git bash -c)', { command: 'echo BENCH_OK' }, {
  reps: 7,
  check: (t) => (t.includes('BENCH_OK') ? true : 'missing BENCH_OK'),
});
await bench('ops_bash', 'bash -lc 登录 shell 对照', { command: 'bash -lc "echo LOGIN"' }, {
  reps: 5,
  check: (t) => (t.includes('LOGIN') ? true : 'missing LOGIN'),
});
const spillOut = await bench('ops_bash', 'seq 40000（触发 spill）', { command: 'seq 1 40000' }, {
  reps: 2,
  check: (t) => {
    if (!/id="([0-9a-f]+)"/.test(t)) return 'no spill id in output';
    if (!/\[full output/.test(t)) return 'no full-output hint';
    return true;
  },
});
const spillId = /id="([0-9a-f]+)"/.exec(spillOut)?.[1];
await benchError('ops_bash', '空 command 拒绝', { command: '   ' }, 'command is required');
await bench('ops_bash', '超时控制（timeoutMs=800，命令 sleep 3）', { command: 'sleep 3; echo NEVER', timeoutMs: 800 }, {
  reps: 3,
  maxMs: 1000,
  check: (t) => (/timed out after 800ms/.test(t) && /\[timeout\]/.test(t) && !t.includes('NEVER')
    ? true : 'timeout marker/partial hint missing'),
});
await bench('ops_bash', 'mode=direct 强制回退路径', { command: 'echo DIRECT_MODE', mode: 'direct' }, {
  reps: 3,
  check: (t) => (t.includes('DIRECT_MODE') && /mode: direct\b/.test(t) ? true : 'direct mode not reported'),
});
await bench('ops_bash', 'mode=service 无服务时报错', { command: 'echo NEVER', mode: 'service' }, {
  reps: 1,
  check: (t) => (/subprocess service unavailable/.test(t) ? true : 'service mode should fail instead of falling back'),
});
await bench('ops_bash', 'login=true 登录 shell', { command: 'echo LOGIN_OK', login: true }, {
  reps: 2,
  check: (t) => (t.includes('LOGIN_OK') ? true : 'login shell failed'),
});
{
  // 超时后：不留孤儿进程，也不留临时捕获目录
  const { execFileSync: execSyncTool } = await import('node:child_process');
  let leftoverSleep = '';
  try {
    leftoverSleep = execSyncTool('tasklist', ['/FI', 'IMAGENAME eq sleep.exe', '/NH', '/FO', 'CSV'], { encoding: 'utf8' })
      .split('\n').filter((line) => /sleep\.exe/i.test(line)).join(' | ');
  } catch { /* none */ }
  checkOnly('ops_bash', '超时后无 sleep.exe 残留', leftoverSleep === '', leftoverSleep);
  const captureDirs = readdirSync(tmpdir()).filter((name) => name.startsWith('dsh-myops-bash-'));
  checkOnly('ops_bash', '捕获临时目录已清理', captureDirs.length === 0, captureDirs.join(' | '));
}

/* ------------------------------------------------------------------ */
/* 2. ops_read + 去重                                                  */
/* ------------------------------------------------------------------ */
const readFirst = await bench('ops_read', '2000 行全文首次读', { path: bigTxt, limit: 2000 }, {
  reps: 1,
  check: (t) => (t.includes('2000 lines') && t.includes('1| row 1') ? true : 'bad header/body'),
});
await bench('ops_read', '重复读（去重命中）', { path: bigTxt, limit: 2000 }, {
  reps: 5,
  check: (t) => (t.includes('unchanged since last read') ? true : 'dedup not triggered'),
});
const readSecond = String(await T('ops_read').execute({ path: bigTxt, limit: 2000, force: true }));
const dedupSaving = (1 - (String(await T('ops_read').execute({ path: bigTxt, limit: 2000 })).length / Math.max(1, readFirst.length))) * 100;
await bench('ops_read', '窗口读 offset/limit', { path: bigTxt, offset: 1000, limit: 20 }, {
  reps: 5,
  check: (t) => (t.includes('showing 1000-1019') && t.includes('1000|') ? true : 'bad window'),
});
await bench('ops_read', '空文件', { path: emptyFile }, {
  reps: 1,
  check: (t) => (t.includes('(0 lines') ? true : 'expected 0 lines'),
});
void readSecond;

/* ------------------------------------------------------------------ */
/* 3. ops_glob                                                         */
/* ------------------------------------------------------------------ */
await bench('ops_glob', '**/*.mjs（当前工作区）', { pattern: '**/*.mjs', path: process.cwd() }, {
  reps: 5,
  check: (t) => (t.includes('index.mjs') ? true : 'index.mjs not found'),
});
await bench('ops_glob', 'README/CHANGELOG 列表', { pattern: '*.md', path: process.cwd() }, {
  reps: 5,
  check: (t) => (t.includes('README.md') && t.includes('CHANGELOG.md') ? true : 'markdown glob wrong'),
});
await bench('ops_glob', 'stat=true 返回元信息', { pattern: '*.md', path: process.cwd(), stat: true }, {
  reps: 3,
  check: (t) => (/README\.md \(\d+ bytes, .+Z\)/.test(t) ? true : 'no size/mtime in glob output'),
});

/* ------------------------------------------------------------------ */
/* 4. ops_grep                                                         */
/* ------------------------------------------------------------------ */
await bench('ops_grep', '函数定义扫描', { pattern: 'function ', path: process.cwd(), include: '**/*.mjs' }, {
  reps: 5,
  check: (t) => (t.includes('scanned') ? true : 'no scan stats'),
});
await bench('ops_grep', '大小写不敏感', { pattern: 'OPS_BASH', path: process.cwd(), include: '**/*.md', caseInsensitive: true }, {
  reps: 3,
  check: (t) => (t.includes('ops_bash') ? true : 'case-insensitive match missing'),
});
await bench('ops_grep', 'exclude 内容排除', { pattern: 'export function', path: process.cwd(), include: '**/*.mjs', exclude: 'apply' }, {
  reps: 3,
  check: (t) => (t.includes('export function') && !t.includes('apply')
    ? true : 'exclude did not filter matching lines'),
});
await benchError('ops_grep', '非法正则拒绝', { pattern: '(', path: process.cwd() }, 'invalid regular expression');

/* ------------------------------------------------------------------ */
/* 5. ops_write / 6. ops_edit / 7. ops_stat                            */
/* ------------------------------------------------------------------ */
const wFile = join(work, 'out', 'w.txt');
const wrote = await bench('ops_write', '写入（自动建目录）', { path: wFile, content: 'a\nb\nc\n' }, {
  reps: 5,
  check: (t) => (/Wrote 3 lines .*rev [0-9a-f]{6,}/.test(t) ? true : 'bad write receipt'),
});
await bench('ops_write', 'dryRun 不落盘', { path: wFile, content: 'CHANGED', dryRun: true }, {
  reps: 3,
  check: (t) => (t.includes('dry-run') && readFileSync(wFile, 'utf8') === 'a\nb\nc\n' ? true : 'dryRun wrote or lied'),
});
await benchError('ops_write', 'ifNotExists 冲突', { path: wFile, content: 'x', ifNotExists: true }, 'already exists');
const rev = /rev ([0-9a-f]+)/.exec(wrote)?.[1];
await bench('ops_write', 'expectedRevision 命中', { path: wFile, content: 'a\nB\nc\n', expectedRevision: rev }, {
  reps: 1,
  check: (t) => (/Wrote 3 lines/.test(t) ? true : 'CAS write failed'),
});
await benchError('ops_write', 'expectedRevision 失配', { path: wFile, content: 'zzz', expectedRevision: 'deadbeef' }, 'revision mismatch');

await bench('ops_edit', '两处替换', { path: wFile, edits: [{ oldText: 'a', newText: 'A' }, { oldText: 'c', newText: 'C' }] }, {
  reps: 1,
  check: (t) => (readFileSync(wFile, 'utf8') === 'A\nB\nC\n' ? true : 'edit result wrong'),
});
await benchError('ops_edit', 'oldText 缺失拒绝', { path: wFile, edits: [{ oldText: 'nope', newText: 'x' }] }, '0 times');
await benchError('ops_edit', 'oldText 多次拒绝', { path: wFile, edits: [{ oldText: 'B', newText: 'x' }] }, 'exactly once');

await bench('ops_stat', '文件 stat', { path: midTxt }, {
  reps: 5,
  check: (t) => (/lines: 300/.test(t) && /sha256: [0-9a-f]{8,}/.test(t) ? true : 'bad stat'),
});
await bench('ops_stat', '目录 stat', { path: work }, {
  reps: 3,
  check: (t) => (/entries:/.test(t) ? true : 'bad dir stat'),
});
await bench('ops_stat', 'paths 批量', { paths: ['package.json', 'README.md', 'no-such-file.txt'] }, {
  reps: 1,
  check: (t) => (t.includes('package.json (file)') && t.includes('README.md (file)') && /no-such-file\.txt: not found/.test(t)
    ? true : 'batch stat output wrong'),
});

/* ------------------------------------------------------------------ */
/* 8. ops_result                                                       */
/* ------------------------------------------------------------------ */
if (spillId) {
  await bench('ops_result', '翻页到末尾', { id: spillId, offset: 39999, limit: 3 }, {
    reps: 5,
    check: (t) => (t.includes('39999|') && t.includes('40000|') ? true : 'paging wrong'),
  });
  await benchError('ops_result', '未知 id 拒绝', { id: 'deadbeef' }, 'unknown output id');
} else {
  failures.push('ops_result: no spill id to page');
}

/* ------------------------------------------------------------------ */
/* 9. 文档类工具已移除（改用 /office 系列技能）                          */
/* ------------------------------------------------------------------ */
{
  const removed = ['ops_read_table', 'ops_read_docx', 'ops_read_pdf'];
  checkOnly('registration', '文档类 ops 不再注册', removed.every((name) => !defs.has(name)), removed.join(','));
  const leftover = ['doc-tools.mjs', 'vendor/pdfjs'].filter((name) => existsSync(join(HERE, '..', 'lib', name)));
  checkOnly('registration', '文档解析代码已删除', leftover.length === 0, leftover.join(','));
}

/* ------------------------------------------------------------------ */
/* 13. ops_git（临时仓库）                                           */
/* ------------------------------------------------------------------ */
{
  let gitBin = null;
  try { execFileSync('git', ['--version'], { encoding: 'utf8' }); gitBin = 'git'; } catch { gitBin = null; }
  checkOnly('ops_git', 'git 可用', gitBin !== null, 'git not found on PATH');
  if (gitBin) {
    const repo = join(work, 'repo');
    mkdirSync(repo, { recursive: true });
    execFileSync(gitBin, ['init', '-q'], { cwd: repo });
    execFileSync(gitBin, ['config', 'user.email', 'bench@local'], { cwd: repo });
    execFileSync(gitBin, ['config', 'user.name', 'bench'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'hello\n');

    await bench('ops_git', 'status（未跟踪）', { action: 'status', path: repo }, {
      reps: 1, exec: agentExec,
      check: (t) => (t.includes('untracked') && t.includes('a.txt') ? true : 'status missed untracked file'),
    });
    await bench('ops_git', 'add 显式路径', { action: 'add', path: repo, paths: ['a.txt'] }, {
      reps: 1, exec: agentExec,
      check: (t) => (/Staged 1 path\(s\)/.test(t) && /staged: a\.txt/.test(t) ? true : 'add did not stage'),
    });
    await bench('ops_git', 'commit', { action: 'commit', path: repo, message: 'bench commit' }, {
      reps: 1, exec: agentExec,
      check: (t) => (/Committed [0-9a-f]+ bench commit/.test(t) ? true : 'commit failed'),
    });
    await bench('ops_git', 'log', { action: 'log', path: repo, limit: 5 }, {
      reps: 1, exec: agentExec,
      check: (t) => (t.includes('bench commit') ? true : 'log missing commit'),
    });
    writeFileSync(join(repo, 'a.txt'), 'hello\nworld\n');
    await bench('ops_git', 'diff --stat', { action: 'diff', path: repo }, {
      reps: 1, exec: agentExec,
      check: (t) => (t.includes('a.txt') && /\d+ \+/.test(t) ? true : 'diff stat missing'),
    });
    await bench('ops_git', 'diff patch（stat=false）', { action: 'diff', path: repo, stat: false }, {
      reps: 1, exec: agentExec,
      check: (t) => (t.includes('+world') ? true : 'patch missing hunk'),
    });
    await bench('ops_git', 'branch', { action: 'branch', path: repo }, {
      reps: 1, exec: agentExec,
      check: (t) => (/^\*/m.test(t) ? true : 'no current branch marker'),
    });
    await bench('ops_git', 'show', { action: 'show', path: repo, ref: 'HEAD' }, {
      reps: 1, exec: agentExec,
      check: (t) => (t.includes('bench commit') ? true : 'show missing commit'),
    });
  }
}

/* ------------------------------------------------------------------ */
/* 14. 设置页：settings store / HTTP 路由 / 动态上限 / client 加载      */
/* ------------------------------------------------------------------ */
{
  // 14a. store 验证 + 落盘往返
  const storeFile = join(work, 'settings-store.json');
  const store = createSettingsStore({ file: storeFile, defaults: { maxOutputChars: 60000, bashTimeoutMs: 120000 } });
  checkOnly('settings', '默认值来自插件配置', store.read().maxOutputChars === 60000 && store.read().bashTimeoutMs === 120000);
  store.update({ maxOutputChars: 1234, bashTimeoutMs: 5000, hideOfficial: ['pwsh', 'bogus', 'pwsh'] });
  const saved = JSON.parse(readFileSync(storeFile, 'utf8'));
  checkOnly('settings', '校验并丢弃非法 hideOfficial', saved.maxOutputChars === 1234 && saved.bashTimeoutMs === 5000 &&
    JSON.stringify(saved.hideOfficial) === '["pwsh"]', JSON.stringify(saved));
  checkOnly('settings', '越界值回落默认', normalizeSettings({ maxOutputChars: 1 }, { maxOutputChars: 60000 }).maxOutputChars === 60000);

  // 14b. HTTP 路由（真实 http 服务）
  const routeStore = createSettingsStore({ file: join(work, 'route-settings.json') });
  const route = createSettingsRoute({ store: routeStore, version: 'test-1.4.0', tools: ['ops_bash', 'ops_git'] });
  const server = http.createServer((req, res) => { void route.handler(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const state = await (await fetch(`${origin}/api/myops-settings/state`)).json();
    checkOnly('settings', 'GET state', state.version === 'test-1.4.0' && state.settings.maxOutputChars === 24000 &&
      state.restartRequiredFor.includes('hideOfficial') && state.tools.length === 2, JSON.stringify(state).slice(0, 160));
    const post = await fetch(`${origin}/api/myops-settings/configure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ maxOutputChars: 4321, hideOfficial: ['read'] }),
    });
    const postBody = await post.json();
    checkOnly('settings', 'POST configure', post.status === 200 && postBody.settings.maxOutputChars === 4321 &&
      JSON.stringify(postBody.settings.hideOfficial) === '["read"]' && routeStore.read().maxOutputChars === 4321, JSON.stringify(postBody).slice(0, 160));
    const cross = await fetch(`${origin}/api/myops-settings/configure`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ maxOutputChars: 9999 }),
    });
    checkOnly('settings', '拒绝跨源 POST', cross.status === 403, `status=${cross.status}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // 14c. 动态 maxOutputChars：改设置文件后下一次调用即生效
  const dynSettingsFile = join(work, 'dyn-settings.json');
  const dynFile = join(work, 'dyn.txt');
  writeFileSync(dynFile, Array.from({ length: 500 }, (_, i) => `line ${i + 1} ${'z'.repeat(90)}`).join('\n'));
  const defs4 = new Map();
  const ctx4 = {
    tools: { register: (d) => { defs4.set(d.name, d); return () => {}; }, restrict: () => () => {} },
    logger: { info: () => {}, warn: () => {} },
    on: () => {},
    get: (name) => (name === 'workingDirectory' ? SESSION_CWD_PROVIDER : undefined),
    effect: (fn) => { fn(); },
  };
  apply(ctx4, { settingsPath: dynSettingsFile });
  const first = String(await defs4.get('ops_read').execute({ path: dynFile }, agentExec));
  writeFileSync(dynSettingsFile, JSON.stringify({ maxOutputChars: 2000, bashTimeoutMs: 1000 }));
  const second = String(await defs4.get('ops_read').execute({ path: dynFile, force: true }, agentExec));
  checkOnly('settings', '保存后立即生效（无需重启）',
    !first.includes('full output') && second.includes('full output') && second.length < 2500,
    `first=${first.length}ch second=${second.length}ch`);

  // 14d. 设置里默认 bash 超时（未显式传 timeoutMs）
  const startedAt = performance.now();
  const timedText = String(await defs4.get('ops_bash').execute({ command: 'sleep 3' }, agentExec));
  const timedMs = performance.now() - startedAt;
  checkOnly('ops_bash', 'settings.bashTimeoutMs 作为默认超时',
    timedMs < 2500 && /timed out after 1000ms/.test(timedText), `ms=${Math.round(timedMs)}`);

  // 14e. client.js 以 DSH client-plugin 格式加载并注册 settings.section
  let entry = null;
  const fakeWindow = { __ModuleLoader__: { load: (value) => { entry = value; } } };
  new Function('window', readFileSync(join(HERE, '..', 'client.js'), 'utf8'))(fakeWindow);
  const fakeReact = { createElement: () => null, useEffect: () => {}, useMemo: (fn) => fn(), useState: () => [null, () => {}] };
  const exportsClient = entry?.factory?.((name) => {
    if (name === 'react') return fakeReact;
    throw new Error(`unexpected require: ${name}`);
  });
  const registrations = [];
  const clientCtx = { slots: { inject: (_name, run) => run(), register: (value, component) => { registrations.push({ value, component }); } } };
  exportsClient?.apply?.(clientCtx);
  checkOnly('settings', 'client.js 注册 settings.section',
    entry?.id === 'dsh-myops' && exportsClient?.name === 'myops-settings' && registrations.length === 1 &&
    registrations[0].value.name === 'settings.section' && registrations[0].value.id === 'myops' &&
    typeof registrations[0].component === 'function',
    `registrations=${registrations.length}`);
}

/* ------------------------------------------------------------------ */
/* 15. 会话工作目录绑定（workingDirectory 服务）                        */
/* ------------------------------------------------------------------ */
const cwdDir = join(work, 'session-cwd');
mkdirSync(cwdDir, { recursive: true });
writeFileSync(join(cwdDir, 'rel.txt'), 'rel-needle line\nsecond\n');
writeFileSync(join(cwdDir, 'cwd-marker.cwd'), 'marker\n');
const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase();
SESSION_DIR = cwdDir;

await bench('ops_bash', '会话 cwd：pwd -W', { command: 'pwd -W' }, {
  reps: 1, exec: agentExec,
  check: (t) => (norm(t).includes(norm(cwdDir)) ? true : `pwd not session cwd: ${t.split('\n')[0]}`),
});
await bench('ops_bash', '显式 workdir 覆盖会话 cwd', { command: 'pwd -W', workdir: work }, {
  reps: 1, exec: agentExec,
  check: (t) => (norm(t).includes(norm(work)) ? true : `workdir override failed: ${t.split('\n')[0]}`),
});
await bench('ops_read', '会话 cwd：相对路径', { path: 'rel.txt' }, {
  reps: 1, exec: agentExec,
  check: (t) => (t.includes('rel-needle') ? true : 'relative read missed session cwd'),
});
await bench('ops_glob', '会话 cwd：相对 glob', { pattern: '*.cwd' }, {
  reps: 1, exec: agentExec,
  check: (t) => (t.includes('cwd-marker.cwd') ? true : 'relative glob missed session cwd'),
});
await bench('ops_grep', '会话 cwd：相对 grep', { pattern: 'rel-needle' }, {
  reps: 1, exec: agentExec,
  check: (t) => (t.includes('rel.txt') ? true : 'relative grep missed session cwd'),
});
await bench('ops_write', '会话 cwd：相对写入', { path: 'out/w.txt', content: 'one\ntwo\n' }, {
  reps: 1, exec: agentExec,
  check: () => (readFileSync(join(cwdDir, 'out', 'w.txt'), 'utf8') === 'one\ntwo\n' ? true : 'relative write missed session cwd'),
});
await bench('ops_edit', '会话 cwd：相对编辑', { path: 'out/w.txt', edits: [{ oldText: 'two', newText: 'TWO' }] }, {
  reps: 1, exec: agentExec,
  check: () => (readFileSync(join(cwdDir, 'out', 'w.txt'), 'utf8') === 'one\nTWO\n' ? true : 'relative edit missed session cwd'),
});
await bench('ops_stat', '会话 cwd：相对 stat', { path: 'out/w.txt' }, {
  reps: 1, exec: agentExec,
  check: (t) => (norm(t).includes(norm(cwdDir)) && /lines: 2/.test(t) ? true : 'relative stat missed session cwd'),
});
{
  // 没有 workingDirectory 服务时，退回到 Session header 的 cwd
  const headerAgent = { id: 'bench-agent-header', session: { header: { cwd: cwdDir } } };
  await bench('ops_stat', '会话 cwd：Session header 兜底', { path: 'rel.txt' }, {
    reps: 1,
    exec: { agent: headerAgent, signal: new AbortController().signal },
    check: (t) => (norm(t).includes(norm(cwdDir)) && /lines: 2/.test(t) ? true : 'header cwd fallback failed'),
  });
}
SESSION_DIR = process.cwd();

/* ------------------------------------------------------------------ */
/* 16. 可配置输出上限（plugin config.maxOutputChars）                 */
/* ------------------------------------------------------------------ */
{
  const defs2 = new Map();
  const ctx2 = {
    tools: { register: (d) => { defs2.set(d.name, d); return () => {}; }, restrict: () => () => {} },
    logger: { info: () => {}, warn: () => {} },
    on: () => {},
    get: (name) => (name === 'workingDirectory' ? SESSION_CWD_PROVIDER : undefined),
    effect: () => {},
  };
  apply(ctx2, { maxOutputChars: 1500, settingsPath: join(work, 'cfg-settings.json') });
  const capped = String(await defs2.get('ops_read').execute({ path: bigTxt }, agentExec));
  checkOnly('ops_read', 'config maxOutputChars 生效', capped.length < 3000 && /full output .* id=/.test(capped),
    `chars=${capped.length}`);
}

/* ------------------------------------------------------------------ */
/* 输出                                                               */
/* ------------------------------------------------------------------ */
const pass = results.filter((r) => r.status === 'pass').length;
const fail = results.length - pass;
console.log('\n=== dsh-myops 逐工具效率验证 ===\n');
const w = [12, 34, 8, 10, 9, 6];
console.log(
  'tool'.padEnd(w[0]) + 'case'.padEnd(w[1]) + 'median'.padStart(w[2]) +
  'first'.padStart(w[3]) + 'chars'.padStart(w[4]) + '  status',
);
for (const r of results) {
  console.log(
    r.tool.padEnd(w[0]) + r.name.padEnd(w[1]) +
    `${r.medianMs == null ? '-' : r.medianMs.toFixed(2)}`.padStart(w[2]) +
    `${r.firstMs == null ? '-' : r.firstMs.toFixed(2)}`.padStart(w[3]) +
    `${r.chars}`.padStart(w[4]) + `  ${r.status}${r.error ? ` (${r.error})` : ''}`,
  );
}
console.log(`\nops_read 去重节省: ${dedupSaving.toFixed(1)}% 输出体积`);
console.log(`SUMMARY: ${pass} passed, ${fail} failed, ${results.length} cases`);

const report = {
  when: new Date().toISOString(),
  node: process.version,
  cwd: process.cwd(),
  dedupSavingPercent: +dedupSaving.toFixed(1),
  cases: results,
  failures,
};
mkdirSync(join(HERE), { recursive: true });
writeFileSync(join(HERE, 'bench-report.json'), JSON.stringify(report, null, 2));
console.log('report: test/bench-report.json');
if (fail > 0) process.exit(1);

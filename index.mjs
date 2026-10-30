/**
 * dsh-myops — a lightweight, dependency-free replacement for dsh-ops.
 *
 * Tools provided to the DSH agent:
 *   - ops_bash       : run a command with Git Bash instead of PowerShell
 *   - ops_read       : read a text file with line numbers (offset/limit, read de-duplication)
 *   - ops_glob       : find files by glob pattern
 *   - ops_grep       : search file contents with a regular expression
 *   - ops_write      : write a file (dryRun / createDirs / expectedRevision / ifNotExists)
 *   - ops_edit       : exact-match text replacements (atomic, rejects ambiguous matches)
 *   - ops_stat       : type / size / mtime / line count / sha256
 *   - ops_result     : page through spilled large output
 *   - ops_git        : compact Git status / diff / log / show / branch / add / commit
 *
 * Document formats (CSV / DOCX / XLSX / PPTX / PDF) are intentionally NOT part of
 * this plugin: use the /office skill family (office-docx, office-xlsx, office-pptx,
 * office-render, office-export-pdf) for document work.
 *
 * A cordis plugin: exports `name`, `inject` and `apply(ctx)`. Tools are plain
 * objects registered through `ctx.tools.register(...)` (the same contract dsh-ops
 * uses), so no `@deepseek-ai/dsh-tools` import is required.
 *
 * Bash execution tries the host `subprocess` service first (so DSH policy and
 * cancellation still apply) and falls back to a direct `child_process.spawn`
 * from the host process when that service is unavailable.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  statSync,
  mkdtempSync,
  openSync,
  closeSync,
  readSync,
  unlinkSync,
  rmdirSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as fsp from 'node:fs/promises';
import { resolve as resolvePath, isAbsolute, join, sep, relative } from 'node:path';

import {
    MAX_OUTPUT_CHARS,
    DEFAULT_BASH_TIMEOUT_MS,
    MAX_GLOB_RESULTS,
    MAX_GREP_MATCHES,
    DEFAULT_READ_LINES,
    OUTPUT,
    hashText,
    resolveWorkdir,
    resolveSessionCwd,
} from './lib/common.mjs';
import { createSpillStore, buildResultTool } from './lib/output-spill.mjs';
import { createReadDedup } from './lib/read-dedup.mjs';
import { buildWriteTools } from './lib/write-tools.mjs';
import { buildGitTools } from './lib/git-tools.mjs';
import { createSettingsStore } from './lib/settings-store.mjs';
import { createSettingsRoute } from './lib/settings-route.mjs';

const readFile = fsp.readFile;
const fsGlob = typeof fsp.glob === 'function' ? fsp.glob.bind(fsp) : null;

export const name = 'myops';
export const inject = ['tools'];

// Bash 采集上限：比模型可见上限大得多，好让大输出落盘（spill）后仍能通过
// ops_result 完整翻页；模型看到的是 store.present 的预览 + id。
const BASH_CAPTURE_MAX_CHARS = 2_000_000;

/* ------------------------------------------------------------------ */
/* bash discovery                                                     */
/* ------------------------------------------------------------------ */

function bashCandidates() {
  const list = [];
  const push = (p) => { if (p && !list.includes(p)) list.push(p); };
  push(process.env.MYOPS_BASH);
  push(process.env.DSH_OPS_BASH);
  if (process.platform === 'win32') {
    push('C:\\Program Files\\Git\\bin\\bash.exe');
    push('C:\\Program Files (x86)\\Git\\bin\\bash.exe');
    if (process.env.LOCALAPPDATA) {
      push(join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));
    }
    push('C:\\Program Files\\Git\\usr\\bin\\bash.exe');
  } else {
    push('/bin/bash');
    push('/usr/bin/bash');
    push('/usr/local/bin/bash');
  }
  return list;
}

let cachedBash;
function resolveBash() {
  if (cachedBash) return cachedBash;
  for (const candidate of bashCandidates()) {
    try {
      if (candidate === 'bash' || existsSync(candidate)) {
        cachedBash = candidate;
        return candidate;
      }
    } catch { /* ignore */ }
  }
  cachedBash = 'bash';
  return cachedBash;
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function capText(text, limit = MAX_OUTPUT_CHARS) {
  if (typeof text !== 'string') text = String(text ?? '');
  if (text.length <= limit) return { text, truncated: false, bytes: text.length };
  return { text: text.slice(0, limit), truncated: true, bytes: text.length };
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

function toPosix(p) {
  return sep === '\\' ? p.split('\\').join('/') : p;
}

function shellEnv(extra) {
  return {
    ...process.env,
    NO_COLOR: '1',
    TERM: 'dumb',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    ...(extra ?? {}),
  };
}

/**
 * bash 参数（不含可执行文件）：默认 `-c`（快）；`login: true` 时 `-lc`，会 source
 * /etc/profile 与用户 profile，每次多付 ~140 ms，但部分脚本依赖 profile 里的环境变量。
 */
function bashArgs(command, opts = {}) {
  return [opts.login === true ? '-lc' : '-c', command];
}

/* ------------------------------------------------------------------ */
/* bash execution                                                     */
/* ------------------------------------------------------------------ */

function emptyBashResult(extra = {}) {
  return {
    status: 'failed',
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 0,
    bash: resolveBash(),
    ...extra,
  };
}

async function runBashViaService(ctx, command, opts = {}) {
  const subprocess = ctx?.get?.('subprocess');
  if (!subprocess || typeof subprocess.spawn !== 'function') return null;

  const bash = resolveBash();
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? Math.min(opts.timeoutMs, 2_147_483_647)
    : DEFAULT_BASH_TIMEOUT_MS;
  const cwd = resolveWorkdir(opts.workdir);
  const startedAt = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort(opts.signal?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) onCallerAbort();
    else opts.signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`command timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();

  try {
    const handle = subprocess.spawn({
      // `-c` only: a login shell (`-lc`) re-sources /etc/profile and the user
      // profile on every call, costing ~135 ms per invocation here, and Git Bash
      // already puts mingw64/bin and /usr/bin on PATH without `-l`.
      argv: [bash, ...bashArgs(command, opts)],
      cwd,
      stdio: {
        stdin: { data: '' },
        stdout: { maxBytes: BASH_CAPTURE_MAX_CHARS },
        stderr: { maxBytes: BASH_CAPTURE_MAX_CHARS },
      },
      graceMs: 3000,
      signal: controller.signal,
      env: shellEnv(opts.env),
    });
    const outcome = await handle.done;
    const readStream = (stream) => {
      try {
        const read = handle.collected?.[stream]?.readFrom?.(0);
        if (read && typeof read.text === 'string') {
          return { text: read.text, truncated: read.lossy === true };
        }
      } catch { /* ignore */ }
      return { text: '', truncated: false };
    };
    const out = readStream('stdout');
    const err = readStream('stderr');
    return {
      status: outcome?.exitCode === 0 && !timedOut && !controller.signal.aborted ? 'completed' : 'failed',
      exitCode: outcome?.exitCode ?? null,
      signal: outcome?.signal ?? null,
      stdout: stripAnsi(out.text),
      stderr: stripAnsi(err.text),
      stdoutTruncated: out.truncated,
      stderrTruncated: err.truncated,
      timedOut,
      timeoutMs,
      durationMs: Date.now() - startedAt,
      bash,
    };
  } finally {
    clearTimeout(timer);
    if (opts.signal) {
      try { opts.signal.removeEventListener('abort', onCallerAbort); } catch { /* ignore */ }
    }
  }
}

/**
 * 终止 bash 及其子进程树。
 *
 * Windows 上 `child.kill('SIGKILL')` 只会杀掉 bash.exe，`sleep` 等子进程仍持有
 * 继承来的 stdout/stderr 管道，`close` 事件必须等它们自己结束——于是 timeoutMs
 * 看起来“生效”（timedOut=true），实际却要等命令跑完才返回。
 *
 * 两条路径并行：
 *   1. `taskkill /PID <pid> /T /F` 终止 Windows 进程树（bin/bash.exe 启动器等）；
 *   2. MSYS2 的 fork 会让孙进程的 Windows ParentProcessId 指向一个已退出的
 *      fork 辅助进程，`taskkill /T` 因此追不到 sleep 之类的孙进程。启动命令时
 *      注入一个随机环境变量 `DSH_MYOPS_RUN_ID`，超时时用一个*不带该变量*的
 *      辅助 bash 扫 `/proc/<pid>/environ`，把所有继承了该变量的 cygwin 进程
 *      一次性 kill 掉（实测 80–120 ms 完成）。
 */
function terminateProcessTree(child, runToken) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && Number.isInteger(child.pid)) {
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      });
    } catch {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
    if (runToken) killMsysDescendants(runToken);
    return;
  }
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
}

/**
 * 用唯一 token 在 MSYS2 的 /proc 中定位并杀死仍持有它的进程。
 * 辅助 bash 本身不能带 token（否则会把自己 kill 掉）。
 */
function killMsysDescendants(runToken) {
  const script = 'token="$1"; '
    + 'pids=""; '
    + 'for d in /proc/[0-9]*; do '
    + '  if grep -qa -- "$token" "$d/environ" 2>/dev/null; then pids="$pids ${d#/proc/}"; fi; '
    + 'done; '
    + '[ -n "$pids" ] && kill -9 $pids 2>/dev/null; true';
  const env = { ...process.env };
  delete env.DSH_MYOPS_RUN_ID;
  try {
    const helper = spawn(resolveBash(), ['-c', script, 'myops-kill-tree', runToken], {
      windowsHide: true,
      stdio: 'ignore',
      env,
    });
    helper.on('error', () => { /* best effort */ });
  } catch { /* best effort */ }
}

/**
 * 从捕获文件读取前缀（最多 maxBytes 字节）；文件不存在时返回空文本。
 * 直接 spawn 回退路径不再用管道收集输出：MSYS2 子进程会继承管道句柄，
 * 即使进程被 taskkill 杀掉，Node 的 close 事件也可能被延迟数秒。
 */
function readPrefix(filePath, maxBytes) {
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(maxBytes);
    const bytes = readSync(fd, buf, 0, maxBytes, 0);
    return { text: buf.subarray(0, bytes).toString('utf8'), bytes };
  } catch {
    return { text: '', bytes: 0 };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

function runBashDirect(command, opts = {}) {
  const bash = resolveBash();
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? Math.min(opts.timeoutMs, 2_147_483_647)
    : DEFAULT_BASH_TIMEOUT_MS;
  const cwd = resolveWorkdir(opts.workdir);

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let captureDir;
    try {
      captureDir = mkdtempSync(join(tmpdir(), 'dsh-myops-bash-'));
    } catch (error) {
      resolve(emptyBashResult({
        error: `failed to create capture directory: ${error?.message ?? error}`,
        durationMs: Date.now() - startedAt,
      }));
      return;
    }
    const outPath = join(captureDir, 'stdout.txt');
    const errPath = join(captureDir, 'stderr.txt');

    const cleanup = () => {
      try { unlinkSync(outPath); } catch { /* ignore */ }
      try { unlinkSync(errPath); } catch { /* ignore */ }
      try { rmdirSync(captureDir); } catch { /* ignore */ }
    };

    let child;
    const runToken = process.platform === 'win32'
      ? `dshMyops${randomBytes(8).toString('hex')}`
      : '';
    try {
      const outFd = openSync(outPath, 'w');
      const errFd = openSync(errPath, 'w');
      try {
        child = spawn(bash, bashArgs(command, opts), {
          cwd,
          env: runToken ? { ...shellEnv(opts.env), DSH_MYOPS_RUN_ID: runToken } : shellEnv(opts.env),
          windowsHide: true,
          stdio: ['ignore', outFd, errFd],
        });
      } finally {
        closeSync(outFd);
        closeSync(errFd);
      }
    } catch (error) {
      cleanup();
      resolve(emptyBashResult({
        error: `failed to spawn bash (${bash}): ${error?.message ?? error}`,
        durationMs: Date.now() - startedAt,
      }));
      return;
    }

    let timedOut = false;
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { opts.signal?.removeEventListener?.('abort', onAbort); } catch { /* ignore */ }
      const rawOut = readPrefix(outPath, BASH_CAPTURE_MAX_CHARS * 4);
      const rawErr = readPrefix(errPath, BASH_CAPTURE_MAX_CHARS * 4);
      const out = capText(stripAnsi(rawOut.text), BASH_CAPTURE_MAX_CHARS);
      const err = capText(stripAnsi(rawErr.text), BASH_CAPTURE_MAX_CHARS);
      cleanup();
      resolve({
        ...value,
        stdout: out.text,
        stderr: err.text,
        stdoutTruncated: out.truncated || rawOut.text.length >= BASH_CAPTURE_MAX_CHARS,
        stderrTruncated: err.truncated || rawErr.text.length >= BASH_CAPTURE_MAX_CHARS,
        durationMs: Date.now() - startedAt,
        timeoutMs,
        bash,
      });
    };

    const onAbort = () => {
      terminateProcessTree(child, runToken);
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, runToken);
    }, timeoutMs);

    child.on('error', (error) => {
      finish({ status: 'failed', exitCode: null, signal: null, error: String(error?.message ?? error), timedOut });
    });
    child.on('close', (code, signal) => {
      finish({
        status: code === 0 && !timedOut ? 'completed' : 'failed',
        exitCode: code,
        signal: signal || null,
        timedOut,
      });
    });
  });
}

async function runBash(ctx, command, opts = {}) {
  const mode = opts.mode === 'direct' || opts.mode === 'service' ? opts.mode : 'auto';
  if (mode !== 'direct') {
    try {
      const viaService = await runBashViaService(ctx, command, opts);
      if (viaService) return viaService;
      if (mode === 'service') {
        return { ...emptyBashResult({ durationMs: 0 }), mode, error: 'subprocess service unavailable (mode=service; no fallback attempted)' };
      }
    } catch (error) {
      if (mode === 'service') {
        return { ...emptyBashResult({ durationMs: 0 }), mode, error: `subprocess service failed: ${error?.message ?? error}` };
      }
      // Auto mode falls through to a direct spawn; the service may be absent or reject the call.
      if (process.env.MYOPS_DEBUG) {
        ctx?.logger?.warn?.(`dsh-myops: subprocess service failed: ${error?.message ?? error}`);
      }
    }
  }
  const result = await runBashDirect(command, opts);
  return { ...result, mode: mode === 'direct' ? 'direct' : 'direct-fallback' };
}

function renderBash(value) {
  const lines = [];
  if (value.stdout && value.stdout.length) {
    lines.push(value.stdout.replace(/\s+$/, ''));
  }
  if (value.stderr && value.stderr.length) {
    lines.push('--- stderr ---');
    lines.push(value.stderr.replace(/\s+$/, ''));
  }
  const meta = [];
  const failed = value.exitCode !== null && value.exitCode !== undefined && value.exitCode !== 0;
  if (failed) meta.push(`exit code: ${value.exitCode}`);
  if (value.signal) meta.push(`signal: ${value.signal}`);
  if (value.timedOut) {
    meta.push(Number.isFinite(value.timeoutMs) ? `timed out after ${value.timeoutMs}ms` : 'timed out');
  } else if (value.mode === 'direct') {
    meta.push('mode: direct');
  }
  if (value.stdoutTruncated || value.stderrTruncated) meta.push('output truncated');
  if (value.error) meta.push(`error: ${value.error}`);
  // 耗时只在慢调用/失败时输出：普通成功调用默认保持静默，省 token。
  if (Number.isFinite(value.durationMs) && (failed || value.timedOut || value.durationMs >= 2000)) {
    meta.push(`${value.durationMs}ms`);
  }
  if (meta.length) lines.push(`[${meta.join(', ')}]`);
  if (value.timedOut) {
    lines.push('[timeout] the command was killed; the output above is partial. ' +
      'Child processes were terminated on a best-effort basis — a few may survive briefly in fallback mode.');
  }
  let text = lines.join('\n');
  if (!text) text = failed ? `[exit code: ${value.exitCode}]` : '[ok]';
  return text;
}

/* ------------------------------------------------------------------ */
/* file helpers                                                       */
/* ------------------------------------------------------------------ */

async function readOneFile(filePath, offset, limit, base = process.cwd()) {
  const abs = isAbsolute(filePath) ? filePath : resolvePath(base, filePath);
  const buffer = await readFile(abs);
  const totalBytes = buffer.length;
  const fullText = buffer.toString('utf8');
  // Empty file is 0 lines (matches ops_stat); a trailing newline yields a final
  // empty element that is not a real line, so drop it the same way.
  const lines = fullText === '' ? [] : fullText.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const start = Math.max(1, Number.isFinite(offset) ? Math.floor(offset) : 1);
  const requested = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_READ_LINES;
  const end = Math.min(lines.length, start + requested - 1);
  const slice = lines.slice(start - 1, end);
  const revision = hashText(fullText);
  const width = String(Math.max(end, 1)).length;
  const numbered = slice
    .map((line, i) => `${String(start + i).padStart(Math.max(4, width))}| ${line}`)
    .join('\n');
  const windowed = start > 1 || end < lines.length;
  const header = `File: ${toPosix(abs)} (${lines.length} lines, ${totalBytes} bytes, rev ${revision.slice(0, 8)})` +
    (windowed ? `, showing ${start}-${end}` : '');
  const hint = windowed && end < lines.length
    ? `\n[truncated: pass offset=${end + 1} to continue]`
    : '';
  return {
    abs: toPosix(abs),
    text: `${header}\n${numbered}${hint}`,
    fullText,
    revision,
    isFullText: start === 1 && end === lines.length,
  };
}

function globToRegExp(pattern) {
  const raw = toPosix(pattern);
  let out = '^';
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (c === '*') {
      if (raw[i + 1] === '*') {
        i += 1;
        if (raw[i + 1] === '/') {
          i += 1;
          out += '(?:[^/]+/)*';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('.+^$(){}[]|\\'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  out += '$';
  return new RegExp(out);
}

async function walkFiles(cwd, max = 5000) {
  const files = [];
  const stack = [cwd];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch { continue; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        stack.push(full);
      } else if (entry.isFile()) {
        files.push(toPosix(relative(cwd, full)));
        if (files.length >= max) return files;
      }
    }
  }
  return files;
}

async function expandPatterns(patterns, cwd) {
  const results = new Set();
  for (const pattern of patterns) {
    if (fsGlob) {
      try {
        for await (const entry of fsGlob(pattern, {
          cwd,
          exclude: (p) => p.includes(`${sep}.git${sep}`) || p.includes(`${sep}node_modules${sep}`),
        })) {
          results.add(toPosix(entry));
          if (results.size >= MAX_GLOB_RESULTS) break;
        }
        continue;
      } catch { /* fall back to the walker */ }
    }
    let regex;
    try { regex = globToRegExp(pattern); } catch { continue; }
    const all = await walkFiles(cwd, MAX_GLOB_RESULTS * 20);
    for (const rel of all) {
      if (regex.test(rel)) results.add(rel);
      if (results.size >= MAX_GLOB_RESULTS) break;
    }
    if (results.size >= MAX_GLOB_RESULTS) break;
  }
  return [...results].sort();
}

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.pdf', '.zip', '.gz',
  '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm', '.mp3', '.mp4',
  '.mov', '.avi', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.class', '.jar', '.pyc',
]);

function looksBinary(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return BINARY_EXT.has(name.slice(dot).toLowerCase());
}

async function collectFiles(cwd, includePattern) {
  const files = [];
  const patterns = includePattern && includePattern !== '**/*' ? [includePattern] : ['**/*'];
  for (const pattern of patterns) {
    if (fsGlob) {
      try {
        for await (const entry of fsGlob(pattern, {
          cwd,
          exclude: (p) => p.includes(`${sep}.git${sep}`) || p.includes(`${sep}node_modules${sep}`),
        })) {
          files.push(toPosix(entry));
          if (files.length >= 5000) break;
        }
        continue;
      } catch { /* fall back to the walker */ }
    }
    let regex;
    try { regex = globToRegExp(pattern); } catch { continue; }
    const all = await walkFiles(cwd, 5000 * 4);
    for (const rel of all) {
      if (regex.test(rel)) files.push(rel);
      if (files.length >= 5000) break;
    }
    if (files.length >= 5000) break;
  }
  return files;
}

async function grepFiles(root, pattern, opts = {}) {
  const cwd = root;
  const files = await collectFiles(cwd, opts.include);
  const flags = opts.caseInsensitive ? 'gi' : 'g';
  let regex;
  try {
    regex = new RegExp(pattern, flags);
  } catch (error) {
    throw new Error(`invalid regular expression: ${error?.message ?? error}`);
  }
  const matches = [];
  let scanned = 0;
  let excludeRegex = null;
  if (opts.exclude) {
    try {
      excludeRegex = new RegExp(opts.exclude, flags);
    } catch (error) {
      throw new Error(`invalid exclude regular expression: ${error?.message ?? error}`);
    }
  }
  for (const rel of files) {
    if (looksBinary(rel)) continue;
    let text;
    try {
      const abs = join(cwd, rel);
      const st = statSync(abs);
      if (!st.isFile() || st.size > 5_000_000) continue;
      text = await readFile(abs, 'utf8');
    } catch { continue; }
    scanned += 1;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      regex.lastIndex = 0;
      if (!regex.test(line)) continue;
      if (excludeRegex) {
        excludeRegex.lastIndex = 0;
        if (excludeRegex.test(line)) continue;
      }
      matches.push(`${rel}:${i + 1}: ${line.trim().slice(0, 400)}`);
      if (matches.length >= MAX_GREP_MATCHES) break;
    }
    if (matches.length >= MAX_GREP_MATCHES) break;
  }
  return { matches, scanned, total: files.length };
}

/* ------------------------------------------------------------------ */
/* tool definitions                                                   */
/* ------------------------------------------------------------------ */

function buildTools(ctx, deps) {
  const { store } = deps;
  // 读去重状态必须按「会话/智能体」隔离：全局一份会让子智能体、队友或并行会话的
  // 读取把别人读过的文件误判为 "unchanged since last read"，导致本智能体拿到
  // 一行 "content omitted" 而根本没看过正文。最多保留 64 个 owner（LRU）。
  const MAX_DEDUP_OWNERS = 64;
  const dedups = new Map();
  const dedupFor = (exec) => {
    const agent = exec?.agent;
    const owner = String(agent?.session?.id ?? agent?.id ?? 'default');
    const cached = dedups.get(owner);
    if (cached) {
      dedups.delete(owner);
      dedups.set(owner, cached);
      return cached;
    }
    const state = createReadDedup({ maxEntries: 512 });
    dedups.set(owner, state);
    while (dedups.size > MAX_DEDUP_OWNERS) {
      const oldest = dedups.keys().next();
      if (oldest.done) break;
      dedups.delete(oldest.value);
    }
    return state;
  };
  const outputLimitNow = () => {
    const value = deps.settings?.read?.().maxOutputChars;
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : MAX_OUTPUT_CHARS;
  };
  const bashDefaultTimeoutNow = () => {
    const value = deps.settings?.read?.().bashTimeoutMs;
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_BASH_TIMEOUT_MS;
  };
  const bashTool = {
    name: 'ops_bash',
    description:
      'Run a shell command with Git Bash. Returns stdout, stderr and the exit code; full user privileges, not sandboxed. ' +
      'On timeout the output is partial and the process tree is terminated.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Bash command.' },
        workdir: { type: 'string', description: 'Defaults to the session working directory.' },
        timeoutMs: { type: 'number', description: 'Default 120000.' },
        mode: { type: 'string', enum: ['auto', 'direct', 'service'], description: 'auto: service then direct; direct: force fallback; service: require service.' },
        login: { type: 'boolean', description: 'Use bash -lc (sources profile). Default false (bash -c, faster).' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const command = String(args?.command ?? '').trim();
      if (!command) throw new Error('command is required');
      const sessionDir = await resolveSessionCwd(exec, ctx);
      const result = await runBash(ctx, command, {
        workdir: resolveWorkdir(args?.workdir, sessionDir),
        timeoutMs: args?.timeoutMs ?? bashDefaultTimeoutNow(),
        mode: args?.mode,
        login: args?.login === true,
        signal: exec?.signal,
      });
      return store.present(renderBash(result), { limit: outputLimitNow(), label: 'ops_bash' });
    },
  };

  const readTool = {
    name: 'ops_read',
    description:
      'Read a text file with line numbers. Whole-file reads are de-duplicated (pass force=true to reprint); ' +
      `windowed reads always print. Defaults to the first ${DEFAULT_READ_LINES} lines.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or session-relative path.' },
        offset: { type: 'number', description: '1-based start line.' },
        limit: { type: 'number', description: `Max lines (default ${DEFAULT_READ_LINES}).` },
        force: { type: 'boolean', description: 'Re-print even if unchanged.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const path = String(args?.path ?? '');
      if (!path) throw new Error('path is required');
      const base = await resolveSessionCwd(exec, ctx);
      const info = await readOneFile(path, args?.offset, args?.limit, base);
      // Only a whole-file read is worth de-duplicating: a windowed read is an
      // explicit request for that slice.
      if (info.isFullText && args?.force !== true) {
        const seen = dedupFor(exec).observe(info.abs, info.fullText);
        if (seen.unchanged) {
          return `File: ${info.abs} (unchanged since last read, rev ${seen.revision}, read #${seen.readCount})\n` +
            '[content omitted; pass force=true to print it]';
        }
      }
      return store.present(info.text, { limit: outputLimitNow(), label: 'ops_read' });
    },
  };

  const globTool = {
    name: 'ops_glob',
    description:
      'Find files by glob pattern. Returns relative paths; skips .git/node_modules; symlinks not followed.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern.' },
        path: { type: 'string', description: 'Defaults to session working directory.' },
        stat: { type: 'boolean', description: 'Add size and mtime per match.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const pattern = String(args?.pattern ?? '');
      if (!pattern) throw new Error('pattern is required');
      const sessionDir = await resolveSessionCwd(exec, ctx);
      const cwd = resolveWorkdir(args?.path, sessionDir);
      const results = await expandPatterns([pattern], cwd);
      let body;
      if (!results.length) {
        body = `No files matched ${pattern}`;
      } else if (args?.stat === true) {
        body = (await Promise.all(results.map(async (rel) => {
          try {
            const st = await fsp.stat(join(cwd, rel));
            return `${rel} (${st.size} bytes, ${st.mtime.toISOString()})`;
          } catch {
            return `${rel} (stat failed)`;
          }
        }))).join('\n');
      } else {
        body = results.join('\n');
      }
      return store.present(body, { limit: outputLimitNow(), label: 'ops_glob' });
    },
  };

  const grepTool = {
    name: 'ops_grep',
    description:
      'Search file contents with a regex. Returns file:line: text. Skips .git/node_modules, binaries and >5 MB files.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression.' },
        path: { type: 'string', description: 'Defaults to session working directory.' },
        include: { type: 'string', description: 'Glob filter; not recursive unless `**/` is used.' },
        exclude: { type: 'string', description: 'Regex; matching lines are omitted.' },
        caseInsensitive: { type: 'boolean', description: 'Case-insensitive.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const pattern = String(args?.pattern ?? '');
      if (!pattern) throw new Error('pattern is required');
      const sessionDir = await resolveSessionCwd(exec, ctx);
      const cwd = resolveWorkdir(args?.path, sessionDir);
      const { matches, scanned, total } = await grepFiles(cwd, pattern, {
        include: args?.include,
        exclude: args?.exclude,
        caseInsensitive: args?.caseInsensitive,
      });
      if (!matches.length) return `No matches for /${pattern}/ (scanned ${scanned}/${total} files)`;
      return store.present(
        `Matches for /${pattern}/ (scanned ${scanned}/${total} files)\n${matches.join('\n')}`,
        { limit: outputLimitNow(), label: 'ops_grep' },
      );
    },
  };

  return [bashTool, readTool, globTool, grepTool];
}

/* ------------------------------------------------------------------ */
/* optional official-tool hiding                                      */
/* ------------------------------------------------------------------ */

function mountHiding(ctx, names) {
  if (!Array.isArray(names) || names.length === 0) return;
  const deny = new Set(names.map(String));
  const lifts = new Map();

  const liftFor = (agent) => {
    try {
      const tools = agent?.ctx?.tools ?? ctx?.tools;
      if (tools && typeof tools.restrict === 'function') return tools.restrict({ deny: [...deny] });
    } catch (error) {
      ctx?.logger?.warn?.(`dsh-myops: could not restrict official tools: ${error?.message ?? error}`);
    }
    return undefined;
  };

  const hide = (agent) => {
    if (!agent || lifts.has(agent)) return;
    const lift = liftFor(agent);
    if (lift) lifts.set(agent, lift);
  };

  try {
    ctx.on?.('agent/created', ({ agent }) => hide(agent));
    ctx.on?.('agent/disposed', ({ agent }) => {
      const lift = lifts.get(agent);
      lifts.delete(agent);
      try { lift?.(); } catch { /* ignore */ }
    });
    for (const agent of ctx.get?.('agents')?.list?.() ?? []) hide(agent);
  } catch { /* keep tools usable if hiding is unavailable */ }

  try {
    ctx.on?.('tools/pre-execute', async (exec, next) => {
      const toolName = String(exec?.name ?? '');
      if (deny.has(toolName)) {
        return {
          kind: 'deny',
          reason: `${toolName} is replaced by dsh-myops. Use the ops_* tools instead (e.g. ops_bash / ops_read / ops_glob / ops_grep).`,
        };
      }
      return next();
    });
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* plugin entry                                                       */
/* ------------------------------------------------------------------ */

const PKG = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  } catch {
    return { version: '0.0.0' };
  }
})();

export function apply(ctx, config = {}) {
  const configuredMax = Number.isFinite(config?.maxOutputChars) && config.maxOutputChars > 0
    ? Math.floor(config.maxOutputChars)
    : MAX_OUTPUT_CHARS;
  const configuredTimeout = Number.isFinite(config?.bashTimeoutMs) && config.bashTimeoutMs > 0
    ? Math.floor(config.bashTimeoutMs)
    : DEFAULT_BASH_TIMEOUT_MS;
  const configuredHide = Array.isArray(config?.hideOfficial) ? config.hideOfficial.map(String) : [];
  const settings = createSettingsStore({
    file: typeof config?.settingsPath === 'string' ? config.settingsPath : undefined,
    defaults: {
      maxOutputChars: configuredMax,
      bashTimeoutMs: configuredTimeout,
      hideOfficial: configuredHide,
    },
  });
  const store = createSpillStore({ maxEntries: 200 });
  const deps = { store, settings };

  const definitions = [
    ...buildTools(ctx, deps),
    ...buildWriteTools({ ...deps, ctx }),
    ...buildResultTool(store),
    ...buildGitTools({ ...deps, ctx }),
  ];

  const registered = [];
  const failed = [];
  for (const def of definitions) {
    try {
      const dispose = ctx.tools.register(def);
      registered.push(def.name);
      if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
        ctx.effect(() => () => { try { dispose(); } catch { /* ignore */ } });
      }
    } catch (error) {
      failed.push(`${def.name}: ${error?.message ?? error}`);
    }
  }
  ctx.logger?.info?.(`dsh-myops: registered ${registered.join(', ')}` +
    (failed.length ? `; failed: ${failed.join(' | ')}` : ''));

  mountSettingsRoute(ctx, createSettingsRoute({
    store: settings,
    version: PKG.version,
    tools: registered.slice(),
  }));

  mountHiding(ctx, settings.read().hideOfficial);
}

/** Register the settings HTTP route when the host exposes a webServer service. */
function mountSettingsRoute(ctx, route) {
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (owner) => {
        owner.effect(() => owner.webServer.register(route));
      });
      return;
    }
  } catch (error) {
    ctx.logger?.warn?.(`dsh-myops: webServer injection failed: ${error?.message ?? error}`);
    return;
  }
  try {
    const webServer = ctx.get?.('webServer');
    if (webServer && typeof webServer.register === 'function' && typeof ctx.effect === 'function') {
      ctx.effect(() => webServer.register(route));
    }
  } catch (error) {
    ctx.logger?.warn?.(`dsh-myops: could not register settings route: ${error?.message ?? error}`);
  }
}

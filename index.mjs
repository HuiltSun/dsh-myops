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
 *   - ops_read_table : CSV / TSV
 *   - ops_read_docx  : DOCX paragraphs
 *   - ops_read_pdf   : PDF text layer (best effort, never returns mojibake)
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
import { existsSync, statSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { resolve as resolvePath, isAbsolute, join, sep, relative } from 'node:path';

import {
    MAX_OUTPUT_CHARS,
    DEFAULT_BASH_TIMEOUT_MS,
    MAX_GLOB_RESULTS,
    MAX_GREP_MATCHES,
    DEFAULT_READ_LINES,
    OUTPUT,
} from './lib/common.mjs';
import { createSpillStore, buildResultTool } from './lib/output-spill.mjs';
import { createReadDedup } from './lib/read-dedup.mjs';
import { buildWriteTools } from './lib/write-tools.mjs';
import { buildDocTools } from './lib/doc-tools.mjs';

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

function resolveWorkdir(workdir) {
  if (!workdir) return process.cwd();
  return isAbsolute(workdir) ? workdir : resolvePath(process.cwd(), workdir);
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
      argv: [bash, '-c', command],
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

function runBashDirect(command, opts = {}) {
  const bash = resolveBash();
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? Math.min(opts.timeoutMs, 2_147_483_647)
    : DEFAULT_BASH_TIMEOUT_MS;
  const cwd = resolveWorkdir(opts.workdir);

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(bash, ['-c', command], {
        cwd,
        env: shellEnv(opts.env),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve(emptyBashResult({
        error: `failed to spawn bash (${bash}): ${error?.message ?? error}`,
        durationMs: Date.now() - startedAt,
      }));
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { opts.signal?.removeEventListener?.('abort', onAbort); } catch { /* ignore */ }
      const out = capText(stripAnsi(stdout), BASH_CAPTURE_MAX_CHARS);
      const err = capText(stripAnsi(stderr), BASH_CAPTURE_MAX_CHARS);
      resolve({
        ...value,
        stdout: out.text,
        stderr: err.text,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        durationMs: Date.now() - startedAt,
        bash,
      });
    };

    const onAbort = () => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < BASH_CAPTURE_MAX_CHARS) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < BASH_CAPTURE_MAX_CHARS) stderr += chunk.toString('utf8');
    });
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
  try {
    const viaService = await runBashViaService(ctx, command, opts);
    if (viaService) return viaService;
  } catch (error) {
    // Fall through to a direct spawn; the service may be absent or reject the call.
    if (process.env.MYOPS_DEBUG) {
      ctx?.logger?.warn?.(`dsh-myops: subprocess service failed: ${error?.message ?? error}`);
    }
  }
  return runBashDirect(command, opts);
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
  if (value.exitCode !== null && value.exitCode !== undefined) meta.push(`exit code: ${value.exitCode}`);
  if (value.signal) meta.push(`signal: ${value.signal}`);
  if (value.timedOut) meta.push('timed out');
  if (value.stdoutTruncated || value.stderrTruncated) meta.push('output truncated');
  if (value.error) meta.push(`error: ${value.error}`);
  if (value.durationMs != null) meta.push(`${value.durationMs}ms`);
  if (meta.length) lines.push(`[${meta.join(', ')}]`);
  let text = lines.join('\n');
  if (!text) text = `[exit code: ${value.exitCode ?? 0}]`;
  return text;
}

/* ------------------------------------------------------------------ */
/* file helpers                                                       */
/* ------------------------------------------------------------------ */

async function readOneFile(filePath, offset, limit) {
  const abs = isAbsolute(filePath) ? filePath : resolvePath(process.cwd(), filePath);
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
  const width = String(Math.max(end, 1)).length;
  const numbered = slice
    .map((line, i) => `${String(start + i).padStart(Math.max(4, width))}| ${line}`)
    .join('\n');
  const windowed = start > 1 || end < lines.length;
  const header = `File: ${toPosix(abs)} (${lines.length} lines, ${totalBytes} bytes)` +
    (windowed ? `, showing ${start}-${end}` : '');
  const hint = windowed && end < lines.length
    ? `\n[truncated: pass offset=${end + 1} to continue]`
    : '';
  return {
    abs: toPosix(abs),
    text: `${header}\n${numbered}${hint}`,
    fullText,
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
  const { store, dedup } = deps;
  const bashTool = {
    name: 'ops_bash',
    description:
      'Run a shell command with Git Bash (the Bash shell). Use this instead of PowerShell. ' +
      'Supports pipes, redirection and normal Unix tooling. Returns stdout, stderr and the exit code. ' +
      'Commands run with full user-level privileges (not confined to the workspace).',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to run.' },
        description: { type: 'string', description: 'Short human-readable description of what the command does.' },
        workdir: { type: 'string', description: 'Working directory. Defaults to the current directory.' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds. Defaults to 120000.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const command = String(args?.command ?? '').trim();
      if (!command) throw new Error('command is required');
      const result = await runBash(ctx, command, {
        workdir: args?.workdir,
        timeoutMs: args?.timeoutMs,
        signal: exec?.signal,
      });
      return store.present(renderBash(result), { limit: MAX_OUTPUT_CHARS, label: 'ops_bash' });
    },
  };

  const readTool = {
    name: 'ops_read',
    description:
      'Read a text file and return it with line numbers. Use offset/limit to page through large files. ' +
      `Defaults to the first ${DEFAULT_READ_LINES} lines and reports how to continue. ` +
      'Reading a file whose content is unchanged since the previous read returns a short notice ' +
      'instead of the body; pass force=true to print it again. ' +
      'Compact output: `File: <path> (N lines)` then `<line>| <content>`.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (absolute or relative to the current directory).' },
        offset: { type: 'number', description: '1-based line to start from. Defaults to 1.' },
        limit: { type: 'number', description: `Maximum number of lines to return. Defaults to ${DEFAULT_READ_LINES}.` },
        force: { type: 'boolean', description: 'Print the body even if the content is unchanged since the last read.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args) {
      const path = String(args?.path ?? '');
      if (!path) throw new Error('path is required');
      const info = await readOneFile(path, args?.offset, args?.limit);
      // Only a whole-file read is worth de-duplicating: a windowed read is an
      // explicit request for that slice.
      if (info.isFullText && args?.force !== true) {
        const seen = dedup.observe(info.abs, info.fullText);
        if (seen.unchanged) {
          return `File: ${info.abs} (unchanged since last read, rev ${seen.revision}, read #${seen.readCount})\n` +
            '[content omitted; pass force=true to print it]';
        }
      }
      return store.present(info.text, { limit: MAX_OUTPUT_CHARS, label: 'ops_read' });
    },
  };

  const globTool = {
    name: 'ops_glob',
    description:
      'Find files by glob pattern (e.g. `**/*.ts`, `src/**/*.json`). Returns relative paths, one per line. ' +
      'Skips .git and node_modules.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern.' },
        path: { type: 'string', description: 'Directory to search. Defaults to the current directory.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args) {
      const pattern = String(args?.pattern ?? '');
      if (!pattern) throw new Error('pattern is required');
      const cwd = resolveWorkdir(args?.path);
      const results = await expandPatterns([pattern], cwd);
      return store.present(
        results.length ? results.join('\n') : `No files matched ${pattern}`,
        { limit: MAX_OUTPUT_CHARS, label: 'ops_glob' },
      );
    },
  };

  const grepTool = {
    name: 'ops_grep',
    description:
      'Search file contents with a regular expression. Returns `file:line: text` matches. ' +
      'Skips .git and node_modules.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for.' },
        path: { type: 'string', description: 'Directory to search. Defaults to the current directory.' },
        include: { type: 'string', description: 'Glob restricting which files are searched (e.g. `**/*.js`).' },
        caseInsensitive: { type: 'boolean', description: 'Case-insensitive matching.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args) {
      const pattern = String(args?.pattern ?? '');
      if (!pattern) throw new Error('pattern is required');
      const cwd = resolveWorkdir(args?.path);
      const { matches, scanned, total } = await grepFiles(cwd, pattern, {
        include: args?.include,
        caseInsensitive: args?.caseInsensitive,
      });
      if (!matches.length) return `No matches for /${pattern}/ (scanned ${scanned}/${total} files)`;
      return store.present(
        `Matches for /${pattern}/ (scanned ${scanned}/${total} files)\n${matches.join('\n')}`,
        { limit: MAX_OUTPUT_CHARS, label: 'ops_grep' },
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

export function apply(ctx, config = {}) {
  const store = createSpillStore({ maxEntries: 200 });
  const dedup = createReadDedup({ maxEntries: 512 });
  const deps = { store, dedup };

  const definitions = [
    ...buildTools(ctx, deps),
    ...buildWriteTools(deps),
    ...buildResultTool(store),
    ...buildDocTools(deps),
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

  const hideOfficial = Array.isArray(config?.hideOfficial) ? config.hideOfficial : [];
  mountHiding(ctx, hideOfficial);
}

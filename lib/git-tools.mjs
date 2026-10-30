/**
 * lib/git-tools.mjs — one compact `ops_git` tool.
 *
 * Actions:
 *   status  : branch + ahead/behind + staged/unstaged/untracked summary (files capped)
 *   diff    : --stat by default, or a capped patch with stat=false; optional --staged
 *   log     : one-line log (decorated), capped
 *   show    : one commit as --stat (or capped patch with full=true)
 *   branch  : local branches with upstream and current marker
 *   add     : stage explicit paths
 *   commit  : commit with a required message (optionally staging `paths` first)
 *
 * Push, merge, rebase, reset and other history-changing commands are intentionally
 * NOT exposed: run them through `ops_bash` where the user can see the exact command.
 * No network access is made by this module.
 *
 * Only node: builtins are used. Output is compact and trimmed for model use.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
    OUTPUT,
    MAX_OUTPUT_CHARS,
    requireString,
    capText,
    toPosix,
    resolveWorkdir,
    resolveSessionCwd,
} from './common.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_LISTED_FILES = 40;
const DEFAULT_DIFF_LINES = 200;
const DEFAULT_LOG_LIMIT = 20;

/* ------------------------------------------------------------------ */
/* git discovery                                                      */
/* ------------------------------------------------------------------ */

function gitCandidates() {
    const list = [];
    const push = (p) => { if (p && !list.includes(p)) list.push(p); };
    push(process.env.MYOPS_GIT);
    if (process.platform === 'win32') {
        push('C:\\Program Files\\Git\\cmd\\git.exe');
        push('C:\\Program Files (x86)\\Git\\cmd\\git.exe');
        if (process.env.LOCALAPPDATA) {
            push(join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe'));
        }
        push('C:\\Program Files\\Git\\bin\\git.exe');
    }
    push('git');
    return list;
}

let cachedGit;
function resolveGit() {
    if (cachedGit) return cachedGit;
    for (const candidate of gitCandidates()) {
        try {
            if (candidate === 'git' || existsSync(candidate)) {
                cachedGit = candidate;
                return candidate;
            }
        } catch { /* ignore */ }
    }
    cachedGit = 'git';
    return cachedGit;
}

function gitEnv() {
    return {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
        NO_COLOR: '1',
    };
}

/** Run git in `cwd`; never throws — returns {code, stdout, stderr, timedOut}. */
async function runGit(args, cwd) {
    const git = resolveGit();
    const argv = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args];
    try {
        const { stdout, stderr } = await execFileAsync(git, argv, {
            cwd,
            timeout: DEFAULT_TIMEOUT_MS,
            maxBuffer: MAX_BUFFER,
            windowsHide: true,
            env: gitEnv(),
        });
        return { code: 0, stdout, stderr, timedOut: false };
    } catch (error) {
        const timedOut = error?.killed === true || error?.signal === 'SIGTERM';
        return {
            code: typeof error?.code === 'number' ? error.code : null,
            stdout: String(error?.stdout ?? ''),
            stderr: String(error?.stderr ?? error?.message ?? error),
            timedOut,
        };
    }
}

function failText(action, result) {
    const detail = String(result.stderr || '').trim();
    const head = result.timedOut
        ? `git ${action} timed out after ${DEFAULT_TIMEOUT_MS} ms`
        : `git ${action} failed (exit ${result.code ?? 'unknown'})`;
    return detail ? `${head}\n${detail}` : head;
}

function repoDir(inputPath, base) {
    return inputPath ? resolveWorkdir(inputPath, base) : base;
}

function clipLines(text, max) {
    const lines = String(text).split(/\r?\n/);
    const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
    if (!limit || lines.length <= limit) return { text: lines.join('\n'), clipped: false };
    return {
        text: `${lines.slice(0, limit).join('\n')}\n[truncated: showing ${limit} of ${lines.length} lines]`,
        clipped: true,
    };
}

/* ------------------------------------------------------------------ */
/* status                                                             */
/* ------------------------------------------------------------------ */

function summarizeStatus(out) {
    const lines = String(out).split(/\r?\n/).filter(Boolean);
    const branchRaw = lines.filter((line) => line.startsWith('## ')).map((line) => line.slice(3));
    const entries = [];
    for (const line of lines) {
        if (line.startsWith('## ')) continue;
        const xy = line.slice(0, 2);
        const rawPath = line.slice(3);
        const filePath = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() : rawPath;
        entries.push({ xy, path: filePath });
    }
    const staged = [];
    const unstaged = [];
    const untracked = [];
    const conflicts = [];
    for (const entry of entries) {
        const [x, y] = [entry.xy[0], entry.xy[1]];
        if (x === '?' && y === '?') { untracked.push(entry.path); continue; }
        if (/[AUUD]/.test(x + y) && (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D'))) {
            conflicts.push(entry.path);
        }
        if (x !== ' ' && x !== '?') staged.push(entry.path);
        if (y !== ' ' && y !== '?') unstaged.push(entry.path);
    }
    return { branchRaw, staged, unstaged, untracked, conflicts, total: entries.length };
}

function listFiles(label, files) {
    if (!files.length) return `${label}: (none)`;
    const shown = files.slice(0, MAX_LISTED_FILES);
    const more = files.length > shown.length ? ` (+${files.length - shown.length} more)` : '';
    return `${label}: ${shown.join(', ')}${more}`;
}

async function actionStatus(repo) {
    const result = await runGit(['status', '--porcelain=v1', '-b'], repo);
    if (result.code !== 0) return failText('status', result);
    const { branchRaw, staged, unstaged, untracked, conflicts } = summarizeStatus(result.stdout);
    const head = [
        `Repo: ${toPosix(repo)}`,
        `Branch: ${branchRaw.length ? branchRaw.join(' | ') : '(detached / unknown)'}`,
    ];
    if (!staged.length && !unstaged.length && !untracked.length && !conflicts.length) {
        head.push('Working tree clean.');
        return head.join('\n');
    }
    head.push(
        `Changes: ${staged.length} staged, ${unstaged.length} unstaged, ${untracked.length} untracked` +
        (conflicts.length ? `, ${conflicts.length} conflicts` : ''),
    );
    head.push(listFiles('staged', staged));
    head.push(listFiles('unstaged', unstaged));
    head.push(listFiles('untracked', untracked));
    if (conflicts.length) head.push(listFiles('conflicts', conflicts));
    return head.join('\n');
}

/* ------------------------------------------------------------------ */
/* diff / log / show / branch                                         */
/* ------------------------------------------------------------------ */

async function actionDiff(repo, args) {
    const stat = args?.stat !== false;
    const maxLines = Number.isFinite(args?.maxLines) && args.maxLines > 0
        ? Math.floor(args.maxLines)
        : DEFAULT_DIFF_LINES;
    const gitArgs = ['diff'];
    if (args?.staged === true) gitArgs.push('--staged');
    if (stat) gitArgs.push('--stat');
    const file = typeof args?.file === 'string' ? args.file.trim() : '';
    if (file) gitArgs.push('--', file);
    const result = await runGit(gitArgs, repo);
    if (result.code !== 0) return failText('diff', result);
    const body = String(result.stdout).trim();
    if (!body) return args?.staged === true ? 'No staged changes.' : 'No unstaged changes.';
    if (stat) return body;
    const clipped = clipLines(body, maxLines);
    return clipped.clipped ? clipped.text : body;
}

async function actionLog(repo, args) {
    const limit = Number.isFinite(args?.limit) && args.limit > 0
        ? Math.min(Math.floor(args.limit), 200)
        : DEFAULT_LOG_LIMIT;
    const gitArgs = ['log', '--oneline', '--decorate', '-n', String(limit)];
    const file = typeof args?.file === 'string' ? args.file.trim() : '';
    if (file) gitArgs.push('--', file);
    const result = await runGit(gitArgs, repo);
    if (result.code !== 0) return failText('log', result);
    const body = String(result.stdout).trim();
    return body || '(no commits yet)';
}

async function actionShow(repo, args) {
    const ref = requireString(args?.ref, 'ref');
    const maxLines = Number.isFinite(args?.maxLines) && args.maxLines > 0
        ? Math.floor(args.maxLines)
        : DEFAULT_DIFF_LINES;
    const full = args?.full === true;
    const gitArgs = full ? ['show', ref] : ['show', '--stat', '--oneline', ref];
    const result = await runGit(gitArgs, repo);
    if (result.code !== 0) return failText('show', result);
    const body = String(result.stdout).trim();
    if (!body) return `(nothing to show for ${ref})`;
    return full ? clipLines(body, maxLines).text : body;
}

async function actionBranch(repo) {
    const result = await runGit(['branch', '-vv'], repo);
    if (result.code !== 0) return failText('branch', result);
    const body = String(result.stdout).trim();
    return body || '(no local branches)';
}

/* ------------------------------------------------------------------ */
/* add / commit                                                       */
/* ------------------------------------------------------------------ */

function collectPaths(value) {
    const list = Array.isArray(value)
        ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
        : [];
    return list;
}

async function actionAdd(repo, args) {
    const paths = collectPaths(args?.paths);
    if (!paths.length) throw new Error('add requires paths (array of strings)');
    const result = await runGit(['add', '--', ...paths], repo);
    if (result.code !== 0) return failText('add', result);
    return `Staged ${paths.length} path(s): ${paths.join(', ')}\n${await actionStatus(repo)}`;
}

async function actionCommit(repo, args) {
    const message = requireString(args?.message, 'message');
    const paths = collectPaths(args?.paths);
    if (paths.length) {
        const staged = await runGit(['add', '--', ...paths], repo);
        if (staged.code !== 0) return failText('add', staged);
    }
    const commitArgs = ['commit', '-m', message];
    if (paths.length) commitArgs.push('--', ...paths);
    const result = await runGit(commitArgs, repo);
    if (result.code !== 0) {
        return `${failText('commit', result)}\n${await actionStatus(repo)}`;
    }
    const head = await runGit(['log', '-1', '--oneline'], repo);
    const summary = String(head.stdout).trim();
    return `Committed ${summary}\n${await actionStatus(repo)}`;
}

/* ------------------------------------------------------------------ */
/* tool definition                                                    */
/* ------------------------------------------------------------------ */

export function buildGitTools(deps = {}) {
    const outputLimit = Number.isFinite(deps.maxOutputChars) && deps.maxOutputChars > 0
        ? Math.floor(deps.maxOutputChars)
        : MAX_OUTPUT_CHARS;

    const tool = {
        name: 'ops_git',
        description:
            'Compact Git operations on the session workspace (or an explicit repo path). ' +
            'Actions: status (branch + staged/unstaged/untracked summary), diff (--stat by default, or a capped patch), ' +
            'log (one-line), show (one commit), branch, add (stage explicit paths), commit (message required). ' +
            'Push/merge/rebase/reset are deliberately not exposed — use ops_bash for history-changing commands.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['status', 'diff', 'log', 'show', 'branch', 'add', 'commit'],
                    description: 'Git action to run.',
                },
                path: {
                    type: 'string',
                    description: 'Repository directory (absolute, or relative to the session working directory). Defaults to the session working directory.',
                },
                file: {
                    type: 'string',
                    description: 'diff/log: limit output to this path or glob (passed after `--`).',
                },
                staged: { type: 'boolean', description: 'diff: show staged changes (--staged).' },
                stat: { type: 'boolean', description: 'diff: show --stat summary. Default true; set false for the full patch.' },
                full: { type: 'boolean', description: 'show: print the full patch instead of --stat.' },
                maxLines: { type: 'number', description: `diff/show: cap output lines (default ${DEFAULT_DIFF_LINES}).` },
                limit: { type: 'number', description: `log: number of commits to show (default ${DEFAULT_LOG_LIMIT}).` },
                ref: { type: 'string', description: 'show: commit/ref to show (required for show).' },
                paths: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'add/commit: paths to stage (also restricts the commit to these paths).',
                },
                message: { type: 'string', description: 'commit: commit message (required for commit).' },
            },
            required: ['action'],
            additionalProperties: false,
        },
        output: OUTPUT,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const action = String(args?.action ?? '').trim();
            if (!action) throw new Error('action is required');
            const base = await resolveSessionCwd(exec, deps.ctx);
            const repo = repoDir(args?.path, base);
            let text;
            switch (action) {
                case 'status': text = await actionStatus(repo); break;
                case 'diff': text = await actionDiff(repo, args); break;
                case 'log': text = await actionLog(repo, args); break;
                case 'show': text = await actionShow(repo, args); break;
                case 'branch': text = await actionBranch(repo); break;
                case 'add': text = await actionAdd(repo, args); break;
                case 'commit': text = await actionCommit(repo, args); break;
                default: throw new Error(`unknown action: ${action} (expected status|diff|log|show|branch|add|commit)`);
            }
            return capText(text, outputLimit).text;
        },
    };
    return [tool];
}

export const __internals = { resolveGit, summarizeStatus, clipLines };

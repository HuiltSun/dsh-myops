/**
 * scripts/apply-preset.mjs — apply one dsh-myops config preset.
 *
 * Usage:
 *   node scripts/apply-preset.mjs list            # list presets
 *   node scripts/apply-preset.mjs balanced        # apply preset
 *   node scripts/apply-preset.mjs balanced --dry-run
 *
 * Writes `$DSH_HOME/myops-settings.json` (default ~/.dsh/myops-settings.json),
 * backing up the current file first. `maxOutputChars`/`bashTimeoutMs` take effect
 * on the next tool call; `hideOfficial` needs a DSH desktop restart.
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PRESETS_FILE = join(ROOT, 'configs', 'myops-presets.json');
const TARGET = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'myops-settings.json');
const HIDEABLE = new Set(['pwsh', 'read', 'glob', 'grep', 'write', 'edit']);

const presets = JSON.parse(readFileSync(PRESETS_FILE, 'utf8')).presets;
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const name = args.find((arg) => !arg.startsWith('-'));

function showList() {
    console.log(`presets (${Object.keys(presets).length}) — target: ${TARGET}\n`);
    for (const [key, preset] of Object.entries(presets)) {
        const s = preset.settings;
        console.log(
            `${key.padEnd(14)} ${preset.label}\n` +
            `  maxOutputChars=${s.maxOutputChars}  bashTimeoutMs=${s.bashTimeoutMs}  ` +
            `hideOfficial=[${s.hideOfficial.join(',') || 'none'}]\n` +
            `  ${preset.description}`,
        );
    }
    console.log('\nusage: node scripts/apply-preset.mjs <name> [--dry-run]');
}

function validate(settings) {
    const errors = [];
    const max = Number(settings.maxOutputChars);
    const timeout = Number(settings.bashTimeoutMs);
    if (!Number.isSafeInteger(max) || max < 1000 || max > 2000000) errors.push('maxOutputChars must be 1000..2000000');
    if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 2147483647) errors.push('bashTimeoutMs must be 1000..2147483647');
    if (!Array.isArray(settings.hideOfficial) || settings.hideOfficial.some((item) => !HIDEABLE.has(item))) {
        errors.push('hideOfficial must be an array of pwsh/read/glob/grep/write/edit');
    }
    if (errors.length) throw new Error(errors.join('; '));
    return { maxOutputChars: max, bashTimeoutMs: timeout, hideOfficial: [...new Set(settings.hideOfficial)] };
}

if (!name || name === 'list') {
    showList();
    process.exit(0);
}

const preset = presets[name];
if (!preset) {
    console.error(`unknown preset: ${name}`);
    showList();
    process.exit(1);
}

const next = validate(preset.settings);
let previous = null;
if (existsSync(TARGET)) {
    try { previous = JSON.parse(readFileSync(TARGET, 'utf8')); } catch { previous = null; }
}

console.log(`preset : ${name} (${preset.label})`);
console.log(`target : ${TARGET}`);
console.log(`next   : ${JSON.stringify(next)}`);
if (previous) console.log(`current: ${JSON.stringify(previous)}`);

if (dryRun) {
    console.log('\n[dry-run] nothing written.');
    process.exit(0);
}

mkdirSync(dirname(TARGET), { recursive: true });
if (existsSync(TARGET)) {
    const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    const backup = `${TARGET}.bak-${stamp}`;
    copyFileSync(TARGET, backup);
    console.log(`backup : ${backup}`);
}
writeFileSync(TARGET, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
console.log('applied.');

const hideChanged = JSON.stringify(previous?.hideOfficial ?? null) !== JSON.stringify(next.hideOfficial);
if (hideChanged) console.log('\nhideOfficial changed — restart the DSH desktop app for it to take effect.');
else console.log('\noutput cap / bash timeout apply on the next tool call.');

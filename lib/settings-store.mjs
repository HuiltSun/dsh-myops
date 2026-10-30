/**
 * lib/settings-store.mjs — persisted runtime settings for dsh-myops.
 *
 * One JSON file (default: `$DSH_HOME/myops-settings.json`, override with the
 * plugin's `settingsPath` config) holds the values the Desktop settings page edits:
 *
 *   {
 *     "maxOutputChars": 60000,     // model-visible output cap for bash/read/glob/grep/git
 *     "bashTimeoutMs": 120000,     // default ops_bash timeout when timeoutMs is omitted
 *     "hideOfficial": ["pwsh"]     // official tools hidden by the plugin (needs restart)
 *   }
 *
 * `read()` is cached by file mtime+size, so tools can call it on every execute
 * without an fs stat storm: a settings-page save is visible on the next call.
 * `update()` validates and writes atomically (temp file + rename).
 */

import { readFileSync, statSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const HIDEABLE_TOOLS = ['pwsh', 'read', 'glob', 'grep', 'write', 'edit'];

const MIN_OUTPUT_CHARS = 1_000;
const MAX_OUTPUT_CHARS_LIMIT = 2_000_000;
const MIN_BASH_TIMEOUT_MS = 1_000;
const MAX_BASH_TIMEOUT_MS = 2_147_483_647;

export const SETTINGS_DEFAULTS = {
    maxOutputChars: 24_000,
    bashTimeoutMs: 120_000,
    hideOfficial: [],
};

function defaultSettingsPath() {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh');
    return join(home, 'myops-settings.json');
}

function intInRange(value, fallback, min, max) {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) return fallback;
    return number;
}

/** Validate and normalize a raw settings object over `defaults`. */
export function normalizeSettings(raw, defaults = SETTINGS_DEFAULTS) {
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const hideOfficial = Array.isArray(input.hideOfficial)
        ? [...new Set(input.hideOfficial.filter((name) => typeof name === 'string' && HIDEABLE_TOOLS.includes(name)))]
        : defaults.hideOfficial;
    return {
        maxOutputChars: intInRange(input.maxOutputChars, defaults.maxOutputChars, MIN_OUTPUT_CHARS, MAX_OUTPUT_CHARS_LIMIT),
        bashTimeoutMs: intInRange(input.bashTimeoutMs, defaults.bashTimeoutMs, MIN_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS),
        hideOfficial,
    };
}

/**
 * @param {{ file?: string, defaults?: Partial<typeof SETTINGS_DEFAULTS> }} options
 */
export function createSettingsStore(options = {}) {
    const file = typeof options.file === 'string' && options.file.trim()
        ? options.file.trim()
        : defaultSettingsPath();
    const defaults = normalizeSettings(options.defaults ?? {}, SETTINGS_DEFAULTS);
    let cache = null;
    let cachedMtimeMs = -1;
    let cachedSize = -1;

    const remember = (value) => {
        cache = value;
        try {
            const stat = statSync(file);
            cachedMtimeMs = stat.mtimeMs;
            cachedSize = stat.size;
        } catch {
            cachedMtimeMs = -1;
            cachedSize = -1;
        }
        return value;
    };

    /** Read current settings; a missing/corrupt file yields the configured defaults. */
    function read() {
        let stat;
        try {
            stat = statSync(file);
        } catch {
            return cache ?? (cache = { ...defaults, hideOfficial: [...defaults.hideOfficial] });
        }
        if (cache && stat.mtimeMs === cachedMtimeMs && stat.size === cachedSize) return cache;
        try {
            return remember(normalizeSettings(JSON.parse(readFileSync(file, 'utf8')), defaults));
        } catch {
            return remember({ ...defaults, hideOfficial: [...defaults.hideOfficial] });
        }
    }

    /** Merge a patch over current settings, validate, and persist atomically. */
    function update(patch) {
        const current = read();
        const next = normalizeSettings({ ...current, ...(patch ?? {}) }, defaults);
        mkdirSync(dirname(file), { recursive: true });
        const temp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
        writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
        renameSync(temp, file);
        return remember(next);
    }

    return { path: file, defaults, read, update };
}

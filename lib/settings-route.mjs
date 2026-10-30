/**
 * lib/settings-route.mjs — host-side HTTP API for the Desktop settings page.
 *
 * Route (registered on the DSH `webServer` service):
 *   GET  /api/myops-settings/state      → plugin metadata + current settings
 *   POST /api/myops-settings/configure  → { maxOutputChars?, bashTimeoutMs?, hideOfficial? }
 *
 * The page is served from the same origin (Web GUI or the desktop shell), so the
 * route only accepts localhost Host headers, same-origin requests and JSON bodies.
 * No credentials are stored or returned.
 */

const MAX_BODY_BYTES = 64 * 1024;
const LOCAL_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;

function sendJson(res, status, body) {
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify(body));
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(Object.assign(new Error('request body too large'), { status: 413 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                const text = Buffer.concat(chunks).toString('utf8');
                const value = text ? JSON.parse(text) : {};
                if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('body must be a JSON object');
                resolve(value);
            } catch (error) {
                reject(Object.assign(new Error(`invalid JSON body: ${error.message}`), { status: 400 }));
            }
        });
        req.on('error', (error) => reject(Object.assign(error, { status: 400 })));
    });
}

function sameOriginAllowed(req) {
    const host = req.headers.host;
    if (!host || !LOCAL_HOST_RE.test(host)) return false;
    const origin = req.headers.origin;
    if (origin) {
        try {
            const parsed = new URL(origin);
            if (parsed.host !== host) return false;
        } catch {
            return false;
        }
    }
    const site = req.headers['sec-fetch-site'];
    if (site === 'cross-site') return false;
    return true;
}

/**
 * @param {{ store: { path: string, read(): object, update(patch: object): object }, version: string, tools: string[], platform?: string }} options
 */
export function createSettingsRoute({ store, version, tools, platform = process.platform }) {
    const prefix = '/api/myops-settings';

    return {
        kind: 'prefix',
        path: prefix,
        async handler(req, res) {
            if (!sameOriginAllowed(req)) {
                sendJson(res, 403, { error: 'settings page only accepts same-origin localhost requests' });
                return;
            }
            const path = String(req.url || '').split('?')[0];

            if (req.method === 'GET' && path === `${prefix}/state`) {
                sendJson(res, 200, {
                    version,
                    platform,
                    tools,
                    settings: store.read(),
                    settingsPath: store.path,
                    restartRequiredFor: ['hideOfficial'],
                });
                return;
            }

            if (req.method === 'POST' && path === `${prefix}/configure`) {
                if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
                    sendJson(res, 415, { error: 'content-type must be application/json' });
                    return;
                }
                try {
                    const patch = await readJsonBody(req);
                    const settings = store.update(patch);
                    sendJson(res, 200, {
                        ok: true,
                        settings,
                        restartRequiredFor: ['hideOfficial'],
                    });
                } catch (error) {
                    sendJson(res, error?.status ?? 400, { error: String(error?.message ?? error) });
                }
                return;
            }

            sendJson(res, 404, { error: 'not found' });
        },
    };
}

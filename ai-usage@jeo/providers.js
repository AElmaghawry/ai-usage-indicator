/* exported newSession, fetchClaude, fetchCodex, fetchTokens */
'use strict';

// Each fetch* resolves (never rejects) to:
//   { ok, source: 'live'|'local', plan, session: {pct, resetsAt}, weekly: {pct, resetsAt},
//     fetchedAt, error: null|'auth'|'offline' }
// fetchTokens() then adds tokens: {fresh, cached} to each window, from the local session logs.
// Times are unix seconds. Tokens are read from disk on every call and never written.

const { Gio, GLib, Soup } = imports.gi;
const ByteArray = imports.byteArray;

const HOME = GLib.get_home_dir();
const CLAUDE_CREDS = `${HOME}/.claude/.credentials.json`;
const CLAUDE_CACHE = `${GLib.get_user_cache_dir()}/ai-usage/claude.json`;
const CLAUDE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_AUTH = `${HOME}/.codex/auth.json`;
const CODEX_SESSIONS = `${HOME}/.codex/sessions`;
const CODEX_URL = 'https://chatgpt.com/backend-api/wham/usage';

const ROLLOUT_TAIL_BYTES = 512 * 1024;
const SESSION_SECONDS = 5 * 3600;
const WEEK_SECONDS = 7 * 86400;

function newSession() {
    return new Soup.Session({ timeout: 10, user_agent: 'ai-usage-indicator' });
}

function now() {
    return Math.floor(Date.now() / 1000);
}

function readText(path) {
    return new Promise((resolve, reject) => {
        Gio.File.new_for_path(path).load_contents_async(null, (file, res) => {
            try {
                const [, bytes] = file.load_contents_finish(res);
                resolve(ByteArray.toString(bytes));
            } catch (e) {
                reject(e);
            }
        });
    });
}

async function readJson(path) {
    return JSON.parse(await readText(path));
}

function mtime(path) {
    try {
        const info = Gio.File.new_for_path(path).query_info('time::modified', 0, null);
        return info.get_attribute_uint64('time::modified');
    } catch (e) {
        return null;
    }
}

function getJson(session, url, headers) {
    return new Promise((resolve, reject) => {
        const msg = Soup.Message.new('GET', url);
        msg.request_headers.append('Accept', 'application/json');
        for (const name in headers)
            msg.request_headers.append(name, headers[name]);
        session.queue_message(msg, (s, m) => {
            if (m.status_code !== 200) {
                const err = new Error(`HTTP ${m.status_code}`);
                err.status = m.status_code;
                reject(err);
                return;
            }
            try {
                resolve(JSON.parse(m.response_body.data));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function errorKind(e) {
    return e && (e.status === 401 || e.status === 403) ? 'auth' : 'offline';
}

// Accepts unix seconds, unix milliseconds or an ISO string.
function toEpoch(v) {
    if (typeof v === 'number' && isFinite(v))
        return Math.floor(v > 1e11 ? v / 1000 : v);
    if (typeof v === 'string') {
        const ms = Date.parse(v);
        if (!isNaN(ms))
            return Math.floor(ms / 1000);
    }
    return null;
}

function win(pct, resetsAt) {
    const p = Number(pct);
    if (pct === null || pct === undefined || !isFinite(p))
        return { pct: null, resetsAt: null };
    const t = toEpoch(resetsAt);
    // A window whose reset time has passed has started over.
    if (t !== null && t <= now())
        return { pct: 0, resetsAt: null };
    return { pct: Math.max(0, Math.min(100, p)), resetsAt: t };
}

function planName(s) {
    if (typeof s !== 'string' || !s)
        return null;
    return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function result(source, plan, session, weekly, fetchedAt, error) {
    return {
        ok: session.pct !== null || weekly.pct !== null,
        source, plan, session, weekly, fetchedAt,
        error: error || null,
    };
}

function empty(plan, error) {
    return result('local', plan, win(null), win(null), null, error);
}

// --- Claude ---

async function claudeLocal(plan, error) {
    try {
        const d = await readJson(CLAUDE_CACHE);
        const five = d.five_hour || {};
        const week = d.seven_day || {};
        return result('local', plan,
            win(five.used_percentage, five.resets_at),
            win(week.used_percentage, week.resets_at),
            mtime(CLAUDE_CACHE), error);
    } catch (e) {
        return empty(plan, error);
    }
}

async function fetchClaude(session) {
    let plan = null;
    try {
        const oauth = (await readJson(CLAUDE_CREDS)).claudeAiOauth || {};
        plan = planName(oauth.subscriptionType);
        if (!oauth.accessToken)
            return await claudeLocal(plan, 'auth');
        const d = await getJson(session, CLAUDE_URL, {
            'Authorization': `Bearer ${oauth.accessToken}`,
            'anthropic-beta': 'oauth-2025-04-20',
        });
        const five = d.five_hour || {};
        const week = d.seven_day || {};
        return result('live', plan,
            win(five.utilization, five.resets_at),
            win(week.utilization, week.resets_at),
            now(), null);
    } catch (e) {
        return claudeLocal(plan, errorKind(e));
    }
}

// --- Codex ---

function findKey(obj, key) {
    if (!obj || typeof obj !== 'object')
        return null;
    if (obj[key] && typeof obj[key] === 'object')
        return obj[key];
    for (const k in obj) {
        const found = findKey(obj[k], key);
        if (found)
            return found;
    }
    return null;
}

function listSortedDesc(dir) {
    const names = [];
    try {
        const en = Gio.File.new_for_path(dir).enumerate_children('standard::name', 0, null);
        let info;
        while ((info = en.next_file(null)))
            names.push(info.get_name());
        en.close(null);
    } catch (e) {
        // missing directory: nothing to list
    }
    return names.sort().reverse();
}

// Rollouts live in sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl, so name order is time order.
function newestRollouts(limit) {
    const out = [];
    for (const y of listSortedDesc(CODEX_SESSIONS)) {
        for (const m of listSortedDesc(`${CODEX_SESSIONS}/${y}`)) {
            for (const d of listSortedDesc(`${CODEX_SESSIONS}/${y}/${m}`)) {
                const dir = `${CODEX_SESSIONS}/${y}/${m}/${d}`;
                for (const f of listSortedDesc(dir)) {
                    if (f.endsWith('.jsonl'))
                        out.push(`${dir}/${f}`);
                    if (out.length >= limit)
                        return out;
                }
            }
        }
    }
    return out;
}

function readTail(path, maxBytes) {
    const file = Gio.File.new_for_path(path);
    const size = file.query_info('standard::size', 0, null).get_size();
    const stream = file.read(null);
    try {
        if (size > maxBytes)
            stream.seek(size - maxBytes, GLib.SeekType.SET, null);
        const bytes = stream.read_bytes(maxBytes, null);
        return ByteArray.toString(bytes.toArray());
    } finally {
        stream.close(null);
    }
}

function lastRateLimits(path) {
    const lines = readTail(path, ROLLOUT_TAIL_BYTES).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].indexOf('"rate_limits"') < 0)
            continue;
        try {
            const rl = findKey(JSON.parse(lines[i]), 'rate_limits');
            if (rl && (rl.primary || rl.secondary))
                return rl;
        } catch (e) {
            // first line of the tail may be cut mid-record
        }
    }
    return null;
}

function codexLocal(plan, error) {
    try {
        for (const path of newestRollouts(3)) {
            const rl = lastRateLimits(path);
            if (!rl)
                continue;
            const p = rl.primary || {};
            const s = rl.secondary || {};
            return result('local', plan,
                win(p.used_percent, p.resets_at),
                win(s.used_percent, s.resets_at),
                mtime(path), error);
        }
    } catch (e) {
        // fall through to empty
    }
    return empty(plan, error);
}

async function fetchCodex(session) {
    try {
        const tokens = (await readJson(CODEX_AUTH)).tokens || {};
        if (!tokens.access_token)
            return codexLocal(null, 'auth');
        const headers = { 'Authorization': `Bearer ${tokens.access_token}` };
        if (tokens.account_id)
            headers['chatgpt-account-id'] = tokens.account_id;
        const d = await getJson(session, CODEX_URL, headers);
        const rl = d.rate_limit || {};
        const p = rl.primary_window || {};
        const s = rl.secondary_window || {};
        return result('live', planName(d.plan_type),
            win(p.used_percent, p.reset_at),
            win(s.used_percent, s.reset_at),
            now(), null);
    } catch (e) {
        return codexLocal(null, errorKind(e));
    }
}

// --- Token counts ---

// When the limit window began. A window at 0% with no reset time has not begun.
function windowStart(win, length) {
    if (win.resetsAt !== null)
        return win.resetsAt - length;
    return win.pct === 0 ? now() : now() - length;
}

// Fills in data.<provider>.<window>.tokens in place; leaves them unset if the counter fails.
function fetchTokens(scriptDir, data) {
    return new Promise(resolve => {
        try {
            const argv = ['python3', `${scriptDir}/tokens.py`];
            for (const id of ['claude', 'codex']) {
                argv.push(String(windowStart(data[id].session, SESSION_SECONDS)));
                argv.push(String(windowStart(data[id].weekly, WEEK_SECONDS)));
            }
            const proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, stdout] = p.communicate_utf8_finish(res);
                    const counts = JSON.parse(stdout);
                    for (const id of ['claude', 'codex']) {
                        data[id].session.tokens = counts[id].session;
                        data[id].weekly.tokens = counts[id].weekly;
                    }
                } catch (e) {
                    // no counts this round
                }
                resolve();
            });
        } catch (e) {
            resolve();
        }
    });
}

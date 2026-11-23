// The 세계관 설정집 (Lumiverse, `anon_world_lv`) link — the memory library's side of docs/memory-library-interop.md of that extension.
// Lumiverse gives every extension its own backend worker, so the original's same-process `globalThis.__marinaraWorldArchive.api` and its
// /api/world-archive HTTP cannot be shared directly. The only channel between extensions is the rpcPool, where read(endpoint) has no
// arguments and no user: a request is a two-step handshake (the requester publishes `<its id>.<channel>`, then reads the peer's endpoint;
// the peer reads that channel and answers with the nonce echoed). Same shape as reference.js. Three parts:
//   1. a mirror of the archive's synchronous `api` (roomEntities / roomRelations / names ...) filled from the archive per user and room, so
//      the pinned service.cjs keeps reading `globalThis.__marinaraWorldArchive?.api` unchanged;
//   2. the screen's `/api/world-archive/*` requests (the 세계관 tab), passed on as op 'http';
//   3. the reverse endpoint `anon_memory_lv.world-room` the archive asks for the room's memory state (enabled, story date, memory language).
// Without the archive (not installed, refused, no rpcPool, no answer) every part behaves as before: the tab is hidden (404), no link, nothing thrown.
import { running, ownerUser } from './dispatch.js';

export const ARCHIVE_ID = 'anon_world_lv';
export const API_ENDPOINT = `${ARCHIVE_ID}.api`;
export const REQUEST_CHANNEL = 'wa-req';
export const ROOM_ENDPOINT = 'world-room';
export const ARCHIVE_ROOM_REQUEST = `${ARCHIVE_ID}.mem-req`;
export const REQUIRES = ['chats', 'chat_mutation'];
export const TTL_MS = 60_000;          // how long a room's mirrored answer is used before it is asked again
export const STALE_MS = 10 * 60_000;   // an answer this old is no answer
export const ABSENT_MS = 30_000;       // after a failed read the archive is not asked again for this long

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const squash = s => String(s ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const uidDefault = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const withTimeout = (p, ms, what) => new Promise((resolve, reject) => { const t = setTimeout(() => reject(Object.assign(new Error(`${what} timed out`), { timeout: true })), ms); p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); }); });

export function createWorldLink({ api, host, log = () => {}, now = () => Date.now(), uid = uidDefault, callTimeoutMs = 10_000, httpTimeoutMs = 120_000 }) {
    const pool = api?.rpcPool;
    const usable = !!(pool?.read && pool?.sync);
    let tail = Promise.resolve();
    let absentUntil = 0;
    /** `${userId}\0${chatId}` -> { at, entities, relations, names } (an empty answer is kept too, so a room without a world is not asked every time) */
    const cache = new Map();
    const inflight = new Map();
    let installed = null;

    /** One request to the archive, one at a time (the request channel holds a single value). Resolves with the answer envelope, rejects when there is none. */
    function call(req, timeoutMs = callTimeoutMs) {
        if (!usable) return Promise.reject(Object.assign(new Error('no rpcPool'), { absent: true }));
        if (now() < absentUntil) return Promise.reject(Object.assign(new Error('archive absent'), { absent: true }));
        const run = tail.then(async () => {
            const nonce = uid();
            try {
                const r = await withTimeout((async () => {
                    pool.sync(REQUEST_CHANNEL, { v: 1, nonce, ...req }, { requires: [] });
                    return pool.read(API_ENDPOINT);
                })(), timeoutMs, 'world archive');
                if (!isObject(r) || r.v !== 1 || r.nonce !== nonce) throw new Error('mismatched answer');
                return r;
            } catch (e) {
                if (!e?.timeout) absentUntil = now() + ABSENT_MS;   // not installed, refused or broken: do not ask again at once
                throw Object.assign(e instanceof Error ? e : new Error(String(e)), { absent: !e?.timeout });
            }
        });
        tail = run.catch(() => {});
        return run;
    }

    // ---- 1. the mirror ----
    const keyOf = (userId, chatId) => `${userId}\u0000${chatId}`;
    async function refresh(userId, chatId) {
        const k = keyOf(userId, chatId);
        const ask = op => call({ userId, chatId, op });
        try {
            const e = await ask('roomEntities');
            if (!e.ok || !isObject(e.data)) { cache.set(k, { at: now(), entities: { worldId: null, entities: [] }, relations: { worldId: null, relations: [] }, names: { names: [] } }); return; }
            let relations = { worldId: null, relations: [] }, names = { names: [] };
            if (e.data.worldId) {
                const r = await ask('roomRelations'); if (r.ok && isObject(r.data)) relations = r.data;
                const n = await ask('names'); if (n.ok && isObject(n.data)) names = n.data;
            }
            cache.set(k, { at: now(), entities: e.data, relations, names });
            install();
        } catch (e) { if (!e?.absent && !e?.timeout) log(`world archive mirror: ${e?.message || e}`); cache.delete(k); }
    }
    /** Brings the room's mirror up to date when it is older than a minute; never throws and never waits longer than waitMs. */
    async function ensure(userId, chatId, waitMs = 1500) {
        try {
            if (!usable || typeof userId !== 'string' || typeof chatId !== 'string' || !chatId) return;
            const k = keyOf(userId, chatId);
            const hit = cache.get(k);
            if (hit && now() - hit.at < TTL_MS) return;
            if (now() < absentUntil) return;
            if (hit && inflight.has(k)) return;   // an older answer is there and a refresh is already running: no waiting behind it
            let p = inflight.get(k);
            if (!p) { p = refresh(userId, chatId).finally(() => inflight.delete(k)); inflight.set(k, p); }
            await Promise.race([p, new Promise(r => setTimeout(r, waitMs))]);
        } catch { /* never an error for the caller */ }
    }
    const mine = () => { const owner = running.getStore(); const userId = owner && ownerUser.get(owner); return userId || null; };
    const entry = chatId => {
        const userId = mine();
        const hit = userId && cache.get(keyOf(userId, chatId));
        return hit && now() - hit.at < STALE_MS ? hit : null;
    };
    const mirror = {
        version: 1, contract: 2,
        roomEntities: chatId => entry(chatId)?.entities ?? { worldId: null, entities: [] },
        roomRelations: chatId => entry(chatId)?.relations ?? { worldId: null, relations: [] },
        names: chatId => entry(chatId)?.names ?? { names: [] },
        lookup(chatId, name) { const q = squash(name); if (!q) return null; return (entry(chatId)?.entities?.entities || []).find(x => [x.name, ...(x.aliases || [])].some(a => squash(a) === q)) || null; },
        entity(chatId, entityId) { return (entry(chatId)?.entities?.entities || []).find(x => x.entityId === entityId) || null; },
        suggest() { return { written: false, reason: 'automatic updates off', changes: [] }; },   // the memory library does not write to the archive (the contract's v1 reader)
    };
    /** Made only once an archive has answered, so without one `globalThis.__marinaraWorldArchive` does not exist at all (the original without the archive). */
    function install() {
        if (installed || globalThis.__marinaraWorldArchive?.api) return;
        installed = { api: mirror };
        globalThis.__marinaraWorldArchive = installed;
    }

    // ---- 2. the screen's /api/world-archive/* ----
    /** The path read the way both routers read it: the query cut off, empty parts dropped (`rooms//id`, a trailing slash), every part decoded once
     *  for the checks while the sent path keeps the parts as they came, so the archive routes exactly what was checked. A part that decodes to `.`/`..`
     *  or does not decode is refused, and so is a `rooms` part with no id after it: a room path that cannot be checked is not passed on. */
    function readPath(path) {
        const bad = (status, msg) => Object.assign(new Error(msg), { status });
        const segs = String(path || '').split('?')[0].split('/').filter(Boolean);
        const dec = segs.map(x => { try { return decodeURIComponent(x); } catch { throw bad(400, 'bad chat id'); } });
        if (dec.some(x => x === '.' || x === '..')) throw bad(404, '채팅을 찾지 못했습니다.');
        const i = dec.indexOf('rooms');
        if (i < 0) return { sent: segs.join('/'), chatId: undefined };
        if (i + 1 >= dec.length || !dec[i + 1]) throw bad(404, '채팅을 찾지 못했습니다.');
        return { sent: segs.join('/'), chatId: dec[i + 1] };
    }
    /** The frame the screen sent (router fallback). 404 when the archive is not there, so the tab stays hidden. */
    async function http(userId, { method, path, query, body }) {
        const gone = () => Object.assign(new Error('세계관 설정집이 없습니다.'), { status: 404 });
        const { sent, chatId } = readPath(path);
        if (chatId) await host.rawChat(userId, chatId);   // a chat that is not this user's is refused here, whatever the archive would say
        const qs = query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : '';
        let r;
        try { r = await call({ userId, ...(chatId ? { chatId } : {}), op: 'http', http: { method, path: `/api/${sent}${qs}`, ...(body !== undefined && method !== 'GET' ? { body } : {}) } }, httpTimeoutMs); } catch { throw gone(); }
        if (!r.ok) throw Object.assign(new Error(String(r.error || '요청을 처리하지 못했습니다.')), { status: r.status || 400 });
        return r.data;
    }

    function dispose() {
        if (installed && globalThis.__marinaraWorldArchive === installed) delete globalThis.__marinaraWorldArchive;
        installed = null; cache.clear(); inflight.clear();
    }
    return { call, ensure, http, mirror, dispose, state: () => ({ cached: cache.size, absent: now() < absentUntil, installed: !!installed }) };
}

/**
 * The reverse endpoint `anon_memory_lv.world-room`: the archive publishes `anon_world_lv.mem-req` = { v:1, nonce, userId, chatId } and reads this;
 * the answer echoes the nonce, user and chat and carries what the original's GET /api/memory-module/chats/:id gave it.
 */
export function createWorldRoom({ api, manager, host, log = () => {} }) {
    const pool = api?.rpcPool;
    let registered = false;
    async function answer(ctx) {
        if (ctx?.requesterExtensionId !== ARCHIVE_ID) throw new Error('not allowed');
        const req = await pool.read(ARCHIVE_ROOM_REQUEST);
        if (!isObject(req) || req.v !== 1 || typeof req.nonce !== 'string' || typeof req.userId !== 'string' || !req.userId || typeof req.chatId !== 'string' || !req.chatId) throw new Error('bad request');
        const base = { v: 1, nonce: req.nonce, userId: req.userId, chatId: req.chatId };
        await host.rawChat(req.userId, req.chatId);       // throws (404) unless the chat belongs to that user
        const um = manager.forUser(req.userId);
        await um.ready();
        if (um.settings().moduleMemory === false) return { ...base, enabled: false, storyDate: null, memoryLanguage: null };
        await um.preloadRoom(req.chatId);
        if (!um.chatEnabled(req.chatId)) return { ...base, enabled: false, storyDate: null, memoryLanguage: null };
        const room = await um.handle({ method: 'GET', path: `memory-module/chats/${encodeURIComponent(req.chatId)}` });
        return { ...base, enabled: true, storyDate: room?.storyDate ?? null, memoryLanguage: room?.memoryLanguage ?? null };
    }
    function publish() {
        if (registered || !pool?.handle) return registered;
        try { pool.handle(ROOM_ENDPOINT, async ctx => { try { return await answer(ctx); } catch (e) { log(`world-room endpoint: ${e?.message || e}`); throw e; } }, { requires: [...REQUIRES] }); registered = true; } catch (e) { log(`world-room endpoint: ${e?.message || e}`); }
        return registered;
    }
    function dispose() { try { if (registered) pool?.unregister?.(ROOM_ENDPOINT); } catch { /* shutting down */ } registered = false; }
    return { publish, dispose, answer };
}

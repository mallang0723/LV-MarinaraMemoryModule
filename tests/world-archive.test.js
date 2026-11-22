// 1.5.0-lv.2: the link to the 세계관 설정집 (anon_world_lv) over the rpcPool — with a fake archive that speaks the protocol of its
// docs/memory-library-interop.md. Mirror of the synchronous api, the screen's /api/world-archive/* , the reverse `world-room` endpoint.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, story, U } from './env.js';
import { fake } from './fake.js';
import { start } from '../src/backend.js';
import { createRouter } from '../src/common/router.js';
import { createWorldRoom, ROOM_ENDPOINT, REQUIRES } from '../src/adapter/world-archive.js';
import { patchMemory } from '../src/memory/ui/patch.mjs';
import { readFileSync } from 'node:fs';

afterEach(() => { delete globalThis.__marinaraWorldArchive; });

const ENTITIES = { worldId: 'w1', entities: [{ entityId: 'e1', type: 'person', name: '하루', aliases: ['Haru'], fields: {} }, { entityId: 'e2', type: 'person', name: '서아', aliases: [], fields: {} }] };
const RELATIONS = { worldId: 'w1', relations: [{ from: 'e1', to: 'e2', fromName: '하루', toName: '서아', type: '친구', note: '오랜 친구' }] };

/** A fake 세계관 설정집: answers `anon_world_lv.api` from the request the memory library published; refuses chats of other users. */
function archive(f, { present = true, owners = { 'chat-a': U } } = {}) {
    const a = { reads: 0, requests: [], present };
    const real = f.api.rpcPool.read;
    f.api.rpcPool.read = async endpoint => {
        if (endpoint !== 'anon_world_lv.api') return real(endpoint);
        a.reads++;
        if (!a.present) throw new Error('Shared RPC endpoint "anon_world_lv.api" not found');
        const req = f.rpcPool.synced.get('wa-req');
        a.requests.push(req);
        const base = { v: 1, nonce: a.badNonce ? 'other' : req.nonce };
        if (req.chatId && owners[req.chatId] !== req.userId) return { ...base, ok: false, error: '채팅을 찾지 못했습니다.', status: 404 };
        const data = { roomEntities: ENTITIES, roomRelations: RELATIONS, names: { names: [{ original: 'Haru', translation: '하루' }] }, status: { version: '0.8.3-beta-lv.1', contract: 2 }, http: { echo: req.http } }[req.op];
        return { ...base, ok: true, data };
    };
    return a;
}
const linked = (e, chat = 'chat-a') => e.rpc('GET', `chats/${chat}`).then(r => r.worldLink);

test('mirror: the room is linked through the archive, the sync api answers for the running user, and a room without a world is not', async () => {
    const e = makeEnv();
    story(e.f, 'chat-a', 3);
    const a = archive(e.f);
    assert.equal(globalThis.__marinaraWorldArchive, undefined, 'nothing exists before an archive has answered');
    const wl = await linked(e);
    assert.equal(wl.linked, true);
    const api = globalThis.__marinaraWorldArchive.api;
    assert.equal(api.contract, 2);
    assert.deepEqual(await e.um.u.run(() => api.roomEntities('chat-a')), ENTITIES);
    assert.deepEqual(await e.um.u.run(() => api.roomRelations('chat-a')), RELATIONS);
    assert.equal((await e.um.u.run(() => api.names('chat-a'))).names[0].translation, '하루');
    assert.equal((await e.um.u.run(() => api.lookup('chat-a', ' haru '))).entityId, 'e1');
    assert.equal(api.roomEntities('chat-a').worldId, null, 'outside any user\'s run there is no answer');
    assert.deepEqual(a.requests.map(r => r.op), ['roomEntities', 'roomRelations', 'names']);
    assert.ok(a.requests.every(r => r.v === 1 && r.userId === U && r.chatId === 'chat-a' && typeof r.nonce === 'string'));
    assert.deepEqual(e.f.rpcPool.policies.get('wa-req'), { requires: [] });
    // cached for a minute: no new request
    await linked(e);
    assert.equal(a.requests.length, 3);
    // another room of the same user: the archive says no world
    e.f.chats.set('chat-b', { id: 'chat-b', name: 'b', metadata: {} });
    story(e.f, 'chat-b', 3);
    const original = a.requests.length;
    e.f.api.rpcPool.read = (read => async ep => (ep === 'anon_world_lv.api' && e.f.rpcPool.synced.get('wa-req').chatId === 'chat-b' ? { v: 1, nonce: e.f.rpcPool.synced.get('wa-req').nonce, ok: true, data: { worldId: null, entities: [] } } : read(ep)))(e.f.api.rpcPool.read);
    assert.equal((await linked(e, 'chat-b')).linked, false);
    assert.ok(a.requests.length >= original);
});

test('no archive: no link, no global, nothing thrown, and the archive is not asked again at once', async () => {
    const e = makeEnv();
    story(e.f, 'chat-a', 3);
    const a = archive(e.f, { present: false });
    assert.equal((await linked(e)).linked, false);
    assert.equal(globalThis.__marinaraWorldArchive, undefined);
    await linked(e); await linked(e);
    assert.equal(a.reads, 1, 'a failed read is remembered for a while');
    const router = createRouter(); e.manager.mount(router);
    await assert.rejects(router.handle({ method: 'GET', path: '/api/world-archive/status' }, U), e => e.status === 404);
});

test('no rpcPool at all, a wrong nonce, a broken answer: the same as no archive', async () => {
    const f = fake({ noRpcPool: true });
    const stop = start(f.api, { afterReplyMs: 5, store: { debounceMs: 0 } });
    story(f, 'chat-a', 3);
    assert.equal((await f.rpc('GET', 'memory-module/chats/chat-a')).data.worldLink.linked, false);
    const r = await f.rpc('GET', 'world-archive/status');
    assert.equal(r.ok, false); assert.equal(r.status, 404);
    await stop();
    const e = makeEnv(); story(e.f, 'chat-a', 3);
    archive(e.f).badNonce = true;
    assert.equal((await linked(e)).linked, false);
    assert.equal(globalThis.__marinaraWorldArchive, undefined);
});

test('the screen\'s /api/world-archive/* goes to the archive as op "http" with the user, the chat and the query', async () => {
    const e = makeEnv();
    story(e.f, 'chat-a', 3);
    const a = archive(e.f);
    const router = createRouter(); e.manager.mount(router);
    const st = await router.handle({ method: 'GET', path: '/api/world-archive/status' }, U);
    assert.equal(st.version, undefined);
    assert.deepEqual(st, { echo: { method: 'GET', path: '/api/world-archive/status' } });
    const put = await router.handle({ method: 'PUT', path: '/api/world-archive/rooms/chat-a', body: { worldId: 'w1' } }, U);
    assert.deepEqual(put.echo, { method: 'PUT', path: '/api/world-archive/rooms/chat-a', body: { worldId: 'w1' } });
    assert.equal(a.requests.at(-1).chatId, 'chat-a');
    const search = await router.handle({ method: 'GET', path: '/api/world-archive/worlds/w1/search?q=%ED%95%98%EB%A3%A8&limit=5' }, U);
    assert.equal(search.echo.path, '/api/world-archive/worlds/w1/search?q=%ED%95%98%EB%A3%A8&limit=5');
    assert.equal(a.requests.at(-1).op, 'http');
    assert.ok(!('chatId' in a.requests.at(-1)), 'a path with no chat carries none');
});

test('a chat of another user is refused on both sides (the screen path), and no request leaves for it', async () => {
    const e = makeEnv();
    story(e.f, 'chat-a', 3);
    e.f.chats.set('chat-x', { id: 'chat-x', name: '남의 방', metadata: {} });
    const get = e.f.api.chats.get;
    e.f.api.chats.get = async (id, user) => (id === 'chat-x' && user !== 'u2' ? null : get(id, user));
    const a = archive(e.f, { owners: { 'chat-a': U, 'chat-x': 'u2' } });
    const router = createRouter(); e.manager.mount(router);
    await assert.rejects(router.handle({ method: 'GET', path: '/api/world-archive/rooms/chat-x' }, U), e => e.status === 404);
    await assert.rejects(router.handle({ method: 'PUT', path: '/api/world-archive/rooms/chat-x', body: { worldId: 'w1' } }, U), e => e.status === 404);
    assert.equal(a.reads, 0);
    // and if our own check were skipped, the archive refuses too (its envelope carries chatId)
    const r = await e.manager.worldLink.call({ userId: U, chatId: 'chat-x', op: 'roomEntities' });
    assert.equal(r.ok, false); assert.equal(r.status, 404);
    // the mirror never answers for a user that does not own the room
    assert.equal((await e.manager.worldLink.ensure(U, 'chat-x'), e.manager.worldLink.mirror.roomEntities('chat-x').worldId), null);
});

test('world-room: answers enabled / storyDate / memoryLanguage with user and chat echoed; refuses others', async () => {
    const f = fake();
    const stop = start(f.api, { afterReplyMs: 5, store: { debounceMs: 0 } });
    const h = f.rpcPool.handlers.get(ROOM_ENDPOINT);
    assert.deepEqual(h.policy, { requires: REQUIRES });
    story(f, 'chat-a', 3);
    const ask = (over = {}, requester = 'anon_world_lv') => { f.rpcPool.peers.set('anon_world_lv.mem-req', { v: 1, nonce: 'n1', userId: 'u1', chatId: 'chat-a', ...over }); return h.fn({ endpoint: 'anon_memory_lv.world-room', requesterExtensionId: requester, effectivePermissions: REQUIRES }); };
    const off = await ask();
    assert.deepEqual([off.v, off.nonce, off.userId, off.chatId, off.enabled, off.storyDate], [1, 'n1', 'u1', 'chat-a', false, null]);
    await f.rpc('POST', 'memory-module/chats/chat-a/enable', {});
    const on = await ask();
    assert.equal(on.enabled, true);
    const room = (await f.rpc('GET', 'memory-module/chats/chat-a')).data;
    assert.deepEqual([on.storyDate, on.memoryLanguage], [room.storyDate ?? null, room.memoryLanguage ?? null]);
    assert.equal(typeof on.memoryLanguage, 'string');
    await assert.rejects(ask({}, 'someone_else'), /not allowed/);
    await assert.rejects(ask({ v: 2 }), /bad request/);
    await assert.rejects(ask({ chatId: 'chat-nope' }), /채팅을 찾지 못했습니다/);
    await f.rpc('POST', 'ext/settings', { moduleMemory: false });
    assert.equal((await ask()).enabled, false);
    await stop();
    assert.ok(!f.rpcPool.handlers.has(ROOM_ENDPOINT));
});

test('world-room on a host without rpcPool.handle: no endpoint, no error', () => {
    const w = createWorldRoom({ api: fake({ noRpcPool: true }).api, manager: null, host: null });
    assert.equal(w.publish(), false);
});

test('the host route GET chats/:id gives the room name to the 세계관 tab (own chats only)', async () => {
    const f = fake();
    const stop = start(f.api, { afterReplyMs: 5, store: { debounceMs: 0 } });
    assert.equal((await f.rpc('GET', 'chats/chat-a')).data.name, '하루방');
    const get = f.api.chats.get;
    f.api.chats.get = async (id, user) => (id === 'chat-a' && user !== 'u1' ? null : get(id, user));
    assert.equal((await f.rpc('GET', 'chats/chat-a', undefined)).ok, true);
    await stop();
});

test('the world panel reads the open chat from the host (localStorage key shadowed in the wrapper, the panel bytes untouched)', () => {
    const read = f => readFileSync(new URL('../src/memory/ui/' + f, import.meta.url), 'utf8');
    const src = patchMemory({ runtime: read('runtime.orig.js'), uiCss: '', themeCss: '', version: 't', worldPanel: read('world-panel.orig.js') });
    assert.ok(src.includes(read('world-panel.orig.js')));
    const line = src.split('\n').find(l => l.startsWith('    const localStorage = '));
    assert.ok(line, 'wrapper shadows localStorage');
    const store = new Map([['theme', 'dark']]);
    const LV = { activeChatId: () => 'chat-live' };
    const globalThisFake = { localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) } };
    const ls = new Function('LV', 'globalThis', `${line}\nreturn localStorage;`)(LV, globalThisFake);
    assert.equal(ls.getItem('marinara-active-chat-id'), 'chat-live');
    assert.equal(ls.getItem('theme'), 'dark');
    ls.setItem('marinara-active-chat-id', 'x'); ls.setItem('theme', 'light');
    assert.equal(store.get('theme'), 'light'); assert.ok(!store.has('marinara-active-chat-id'));
    assert.equal(new Function('LV', 'globalThis', `${line}\nreturn localStorage.getItem('marinara-active-chat-id');`)({ activeChatId: () => '' }, globalThisFake), null);
});

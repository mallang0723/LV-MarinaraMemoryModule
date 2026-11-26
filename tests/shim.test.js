import test from 'node:test';
import assert from 'node:assert/strict';
import { uid, responseLike, createLink, createFetch, createMarinara } from '../src/shim/marinara.js';
import { fake } from './fake.js';
import { start } from '../src/backend.js';

function bridge() {
    const f = fake({ onSend: (m) => setTimeout(() => toFrontend?.(m), 1) });
    let toFrontend = null;
    start({ ...f.api, log: { info() {} } }, { store: { debounceMs: 0 }, afterReplyMs: 5 });
    const ctx = { sendToBackend: m => setTimeout(() => f.frontendHandler(JSON.parse(JSON.stringify(m)), 'u1', 'sess'), 1), onBackendMessage: fn => { toFrontend = fn; return () => { toFrontend = null; }; } };
    return { f, ctx };
}

test('uid prefers the host UUID API and preserves its receiver', () => {
    const uuid = { v4() { assert.equal(this, uuid); return '00000000-0000-4000-8000-000000000001'; } };
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    try {
        Object.defineProperty(globalThis, 'crypto', { get() { throw Error('browser crypto must not be read'); }, configurable: true });
        assert.equal(uid({ uuid }), '00000000-0000-4000-8000-000000000001');
    } finally {
        if (original) Object.defineProperty(globalThis, 'crypto', original);
        else delete globalThis.crypto;
    }
});

test('uid uses getRandomValues on old hosts over HTTP and sets v4 and variant bits', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    let calls = 0;
    const crypto = {
        get randomUUID() { throw Error('blocked browser API must not be read'); },
        getRandomValues(bytes) {
            assert.equal(this, crypto);
            assert.ok(bytes instanceof Uint8Array);
            assert.equal(bytes.length, 16);
            bytes.fill(255);
            bytes[0] = calls++;
            return bytes;
        },
    };
    try {
        Object.defineProperty(globalThis, 'crypto', { value: crypto, configurable: true });
        assert.equal(uid(), '00ffffff-ffff-4fff-bfff-ffffffffffff');
        assert.equal(uid({}), '01ffffff-ffff-4fff-bfff-ffffffffffff');
        assert.equal(uid({ uuid: { v4: null } }), '02ffffff-ffff-4fff-bfff-ffffffffffff');
        assert.equal(calls, 3);
    } finally {
        if (original) Object.defineProperty(globalThis, 'crypto', original);
        else delete globalThis.crypto;
    }
});

test('uid produces distinct RFC 4122 v4 IDs with the platform random source', () => {
    const ids = new Set(Array.from({ length: 100 }, () => uid({})));
    assert.equal(ids.size, 100);
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('uid propagates host lifecycle errors', () => {
    assert.throws(() => uid({ uuid: { v4() { throw Error('Extension unloaded'); } } }), /Extension unloaded/);
});

test('each link captures its own host UUID context for request IDs', async () => {
    function makeLink(id) {
        let receive;
        const ctx = {
            uuid: { v4: () => id },
            onBackendMessage(fn) { receive = fn; return () => {}; },
            sendToBackend(frame) { receive({ requestId: frame.requestId, ok: true, data: frame.requestId }); },
        };
        return createLink(ctx, { now: () => 123 });
    }
    const first = makeLink('00000000-0000-4000-8000-000000000001');
    const second = makeLink('00000000-0000-4000-8000-000000000002');
    try {
        assert.equal(await first.call('GET', 'status'), '00000000-0000-4000-8000-000000000001:123');
        assert.equal(await second.call('GET', 'status'), '00000000-0000-4000-8000-000000000002:123');
        assert.equal(await first.call('GET', 'status'), '00000000-0000-4000-8000-000000000001:123');
    } finally { first.dispose(); second.dispose(); }
});

test('apiFetch: ok replies, errors with status, permission -> 403, never throws for backend errors', async () => {
    const { ctx } = bridge();
    const { marinara } = createMarinara(createLink(ctx));
    const ok = await marinara.apiFetch('connections', { method: 'GET' });
    assert.equal(ok.ok, true);
    assert.equal((await ok.json()).length, 2);
    const nf = await marinara.apiFetch('nope/at/all');
    assert.equal(nf.status, 404);
    assert.match((await nf.json()).error, /길을 찾지 못했습니다/);
    const post = await marinara.apiFetch('memory-module/chats/chat-a/enable', { method: 'POST', body: '{}' });
    assert.deepEqual(await post.json(), { enabled: true });
});

test('apiFetch for a denied permission is a 403 with code permission; the fallback fetch is closed', async () => {
    const { ctx, f } = bridge();
    f.state.denied.push('generation');
    const { marinara } = createMarinara(createLink(ctx));
    const r = await marinara.apiFetch('connections');
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, 'permission');
    await assert.rejects(() => marinara.fetch('/api/connections'), /network disabled/);
});

test('a timeout rejects the request and a dead channel rejects pending ones', async () => {
    const ctx = { sendToBackend() {}, onBackendMessage: () => () => {} };
    const link = createLink(ctx, { timeoutMs: 20 });
    await assert.rejects(() => link.request('GET', 'x'), e => e.timeout);
    const link2 = createLink(ctx, { timeoutMs: 10_000 });
    const p = link2.request('GET', 'x');
    link2.dispose();
    await assert.rejects(p, /종료/);
    const r = await createFetch(createLink(ctx, { timeoutMs: 10 }))('x');
    assert.equal(r.status, 503);
});

test('abort signal ends a pending request with AbortError', async () => {
    const ctx = { sendToBackend() {}, onBackendMessage: () => () => {} };
    const link = createLink(ctx);
    const ctl = new AbortController();
    const p = createFetch(link)('generate/raw', { method: 'POST', body: '{}', signal: ctl.signal });
    ctl.abort();
    await assert.rejects(p, e => e.name === 'AbortError');
});

test('events (no requestId) go to listeners, replies only to their request', async () => {
    let push;
    const ctx = { sendToBackend() {}, onBackendMessage: fn => { push = fn; return () => {}; } };
    const link = createLink(ctx);
    const got = [];
    link.onEvent(m => got.push(m));
    push({ event: 'command', id: 'open-memory' });
    push({ requestId: 'unknown', ok: true });
    assert.deepEqual(got, [{ event: 'command', id: 'open-memory' }]);
});

test('responseLike clone/json/text', async () => {
    const r = responseLike(200, { a: 1 });
    assert.deepEqual(await r.clone().json(), { a: 1 });
    assert.equal(await r.text(), '{"a":1}');
    assert.equal(responseLike(204).status, 204);
});

// 세계관 칸 (World Archive's screen, 원작 0.37+): Lumiverse has no World Archive, so the tab must stay hidden without any request leaving
// the page, while the original's own code (worldlink.cjs, world-panel.js) is all there and byte-pinned.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { patchMemory } from '../src/memory/ui/patch.mjs';
import { createFetch } from '../src/shim/marinara.js';
import { createRouter } from '../src/common/router.js';

const read = f => readFileSync(new URL('../src/memory/ui/' + f, import.meta.url), 'utf8');
const build = () => patchMemory({ runtime: read('runtime.orig.js'), uiCss: '', themeCss: '', version: 'test', worldPanel: read('world-panel.orig.js') });

test('the three direct fetches of the 세계관 tab go through the shim; none is left bare', () => {
    const src = build();
    assert.ok(!/(?<!LV\.)\bfetch\(\s*[`"']\/api\/world-archive/.test(src));
    for (const part of ["await LV.fetch('/api/world-archive/status'", 'const get = async (p) => { const r = await LV.fetch(p,', 'const send = async (method, p, body) => { const r = await LV.fetch(p,']) assert.ok(src.includes(part), part);
});

test("the original's world panel is embedded byte for byte, wrapped like the original build, and its fetch is the shim's", () => {
    const src = build();
    const panel = read('world-panel.orig.js');
    assert.ok(src.includes(panel));
    assert.ok(src.includes('const __WORLD_ARCHIVE_EMBEDDED__ = true;'));
    assert.ok(src.includes('const fetch = (input, init) => LV.fetch(input, init);'));
    assert.doesNotThrow(() => new vm.Script(src.replace('export function mountMemory', 'function mountMemory')));
});

test('a changed world panel is refused', () => {
    assert.throws(() => patchMemory({ runtime: read('runtime.orig.js'), uiCss: '', themeCss: '', version: 'test', worldPanel: read('world-panel.orig.js') + '\n' }), /world panel original changed/);
});

test('without World Archive the status request is a 404 (the tab is hidden), not a network call', async () => {
    const router = createRouter();
    const requests = [];
    const link = { request: async (method, path, body, o) => { requests.push(path); try { await router.handle({ method, path }, 'u'); return { ok: true }; } catch (e) { return { ok: false, status: e.status, error: e.message }; } } };
    const res = await createFetch(link)('/api/world-archive/status', { credentials: 'same-origin' });
    assert.equal(res.ok, false);
    assert.equal(res.status, 404);
    assert.deepEqual(requests, ['/api/world-archive/status']);
});

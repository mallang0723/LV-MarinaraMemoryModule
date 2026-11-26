// Check every shipped frontend bundle for HTTP/LAN compatibility, including guarded accesses and comments.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const file = new URL('../dist/frontend.js', import.meta.url);
const src = existsSync(file) ? readFileSync(file, 'utf8') : '';

test('dist/frontend.js exists and carries the memory screen', () => {
    assert.ok(src.length > 150_000, `dist/frontend.js is ${src.length} bytes (run npm run build)`);
    assert.ok(src.includes('mountMemory'));
    assert.ok(!/mountAnon|acm-root|anonymousCommunity|anon\/rp-material/.test(src), 'no anon community code in the bundle');
});

test('built frontend bundles contain no blocked UUID access, including aliases and comments', () => {
    const dist = new URL('../dist/', import.meta.url);
    const files = readdirSync(dist).filter(name => /^frontend.*\.js$/.test(name));
    assert.ok(files.length > 0, 'run npm run build');
    // Match host access forms regardless of receiver, so crypto and global aliases also fail.
    const accesses = [
        /(?:\?\.|\.)\s*randomUUID\b/,
        /(?:\?\.)?\[\s*["'`]randomUUID["'`]\s*\]/,
        /\{[^}]*\brandomUUID\b[^}]*\}\s*=/,
    ];
    for (const name of files) {
        const bundle = readFileSync(new URL(name, dist), 'utf8');
        for (const re of accesses) assert.ok(!re.test(bundle), `${name}: blocked UUID access ${re}`);
        // This bundle has no legitimate textual mentions either; guard those as well.
        assert.ok(!/randomUUID/.test(bundle), `${name}: unexpected blocked API name`);
    }
});

test('release versions agree with the built frontend and backend', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const manifest = JSON.parse(readFileSync(new URL('../spindle.json', import.meta.url), 'utf8'));
    assert.equal(manifest.version, pkg.version);
    for (const entry of ['frontend', 'backend']) {
        const bundle = readFileSync(new URL(`../dist/${entry}.js`, import.meta.url), 'utf8');
        assert.ok(bundle.includes(`"${pkg.version}"`), `${entry} release version is stale`);
    }
});

test('no crypto.subtle, navigator.clipboard, navigator.share, execCommand copy in the shipped frontend', () => {
    for (const re of [/crypto\.subtle/, /navigator\.clipboard/, /navigator\.share/, /execCommand\(/, /showSaveFilePicker/]) assert.ok(!re.test(src), String(re));
});

test('no fetch to the network from the shipped screens except through the shim (no bare /api/ URL strings)', () => {
    // the originals' strings "api/..." paths are request paths for the shim; a literal fetch(`/api/` must not remain
    assert.ok(!/(?<!LV\.)\bfetch\(\s*[`"']\/api\//.test(src));   // `LV.fetch('/api/...')` is the shim (the 세계관 tab's status check, patch.mjs)
    assert.ok(!/window\.fetch\s*=/.test(src), 'the original window.fetch hook is gone');
});

test('the generated screens carry the override sheets after the originals', () => {
    assert.ok(src.includes('LV.css') || src.includes('${LV.css}') || /\+\s*LV\.css/.test(src));
    assert.ok(src.includes('max(15px,1em)'), 'override sheet is in the bundle');
});

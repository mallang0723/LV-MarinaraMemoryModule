import test from 'node:test';
import assert from 'node:assert/strict';
import { addEntries } from '../src/adapter/entries.js';
import { createShell } from '../src/shell.js';
import { setLauncherVisible } from '../src/adapter/launcher.js';

function element(tag) {
    const listeners = new Map();
    return {
        tag, nodeType: 1, style: {
            setProperty(key, value, priority) { this[key] = value; this[`${key}Priority`] = priority; },
            removeProperty(key) { delete this[key]; delete this[`${key}Priority`]; },
        }, children: [],
        setAttribute() {},
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = children; },
        addEventListener(name, fn) { listeners.set(name, fn); },
        removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
        click() { listeners.get('click')?.(); },
        change() { return listeners.get('change')?.(); },
    };
}
const doc = { createElement: element, createTextNode: text => ({ nodeType: 3, textContent: text }) };
function host() {
    const calls = { tabs: [], actions: [], destroyed: [], off: 0 };
    const root = element('root');
    let click;
    const ui = {
        registerDrawerTab(options) {
            calls.tabs.push(options);
            return { root, destroy() { calls.destroyed.push('tab'); } };
        },
        registerInputBarAction(options) {
            calls.actions.push(options);
            return {
                onClick(fn) { click = fn; return () => { calls.off++; }; },
                destroy() { calls.destroyed.push('action'); },
            };
        },
    };
    return { ctx: { ui }, calls, root, click: () => click?.() };
}
function buttons(node) {
    return [node, ...(node.children || []).flatMap(buttons)].filter(n => n.tag === 'button');
}

test('addEntries registers one drawer tab and menu entry with memory labels and icon', () => {
    const h = host();
    const dispose = addEntries({ ctx: h.ctx, doc, open() {} });
    assert.equal(h.calls.tabs.length, 1);
    assert.equal(h.calls.actions.length, 1);
    const tab = h.calls.tabs[0], action = h.calls.actions[0];
    assert.equal(tab.id, 'memory-library');
    assert.notEqual(tab.id, 'world-archive');
    assert.equal(tab.title, '기억 서재');
    assert.equal(tab.headerTitle, '기억 서재');
    assert.equal(tab.shortName, '기억');
    assert.match(tab.description, /장면.*Memory library/);
    assert.ok(['기억', '서재', 'memory', 'library'].every(k => tab.keywords.includes(k)));
    assert.equal(action.label, '기억 서재');
    assert.equal(action.id, 'memory-open');
    assert.equal(action.iconSvg, tab.iconSvg);
    assert.match(tab.iconSvg, /<svg/);
    assert.equal(buttons(h.root)[0].textContent, '기억 서재 열기');
    dispose();
});

function floatingSwitch(node) {
    if (node.tag === 'label' && node.children.some(n => n.textContent === '떠다니는 버튼 표시')) return node.children[0];
    for (const child of node.children || []) { const found = floatingSwitch(child); if (found) return found; }
}

function settingsShell(link) {
    const h = host(), launcher = element('button');
    let opened = false, opens = 0;
    const shell = createShell(h.ctx, { link, doc, getChatId: () => '',
        isOpen: () => opened, openMemory: () => { opened = true; opens++; },
        setFloatingButtonVisible: visible => setLauncherVisible(launcher, visible),
    });
    return { ...h, shell, launcher, toggle: () => floatingSwitch(h.root),
        close: () => { opened = false; }, opens: () => opens,
    };
}

test('floating button defaults on, hides immediately, reloads off and leaves both entries usable', async () => {
    let saved = {}, finishSave;
    const link = {
        onEvent: () => () => {},
        call: async (method, path, body) => {
            if (path !== 'ext/settings') return {};
            if (method === 'GET') return { ...saved };
            await new Promise(resolve => { finishSave = resolve; });
            saved = { ...saved, ...body };
            return { settings: { ...saved } };
        },
    };
    const first = settingsShell(link);
    await first.shell.refresh();
    assert.equal(first.launcher.hidden, false);
    assert.equal(first.launcher.style.display, undefined);
    assert.equal(first.toggle().checked, true);
    first.toggle().checked = false;
    const save = first.toggle().change();
    assert.equal(first.launcher.hidden, true, 'hide before the backend acknowledges the write');
    assert.equal(first.launcher.style.display, 'none');
    assert.equal(first.launcher.style.displayPriority, 'important', 'override the original display:grid');
    await first.shell.refresh();
    assert.equal(first.launcher.hidden, true, 'stale settings cannot undo a pending toggle');
    first.click();
    assert.equal(first.opens(), 1);
    first.close();
    buttons(first.root).find(n => n.textContent === '기억 서재 열기').click();
    first.click();
    assert.equal(first.opens(), 2, 'both entries still open only when closed');
    finishSave(); await save;
    first.shell.dispose();

    const reloaded = settingsShell(link);
    await reloaded.shell.refresh();
    assert.equal(reloaded.launcher.hidden, true);
    assert.equal(reloaded.toggle().checked, false);
    reloaded.click();
    assert.equal(reloaded.opens(), 1);
    reloaded.toggle().checked = true;
    const show = reloaded.toggle().change();
    assert.equal(reloaded.launcher.hidden, false);
    assert.equal(reloaded.launcher.style.display, undefined);
    await reloaded.shell.refresh();
    finishSave(); await show;
    assert.equal(saved.floatingButton, true);
    reloaded.shell.dispose();
});

test('floating button restores the stored setting if a save is rejected', async () => {
    const link = { onEvent: () => () => {}, call: async method => {
        if (method === 'POST') throw new Error('save rejected');
        return { floatingButton: true };
    } };
    const h = settingsShell(link);
    await h.shell.refresh();
    h.toggle().checked = false;
    await h.toggle().change();
    assert.equal(h.launcher.hidden, false);
    assert.equal(h.toggle().checked, true);
    h.shell.dispose();
});

test('rapid floating-button toggles keep their write order and latest visibility', async () => {
    let saved = {}, finishSave;
    const writes = [];
    const link = { onEvent: () => () => {}, call: async (method, path, body) => {
        if (path !== 'ext/settings') return {};
        if (method === 'GET') return { ...saved };
        writes.push(body.floatingButton);
        if (writes.length === 1) await new Promise(resolve => { finishSave = resolve; });
        saved = { ...saved, ...body };
        return { settings: { ...saved } };
    } };
    const h = settingsShell(link);
    await h.shell.refresh();
    h.toggle().checked = false;
    const off = h.toggle().change();
    h.toggle().checked = true;
    const on = h.toggle().change();
    assert.equal(h.launcher.hidden, false);
    await h.shell.refresh();
    assert.deepEqual(writes, [false]);
    finishSave();
    await Promise.all([off, on]);
    assert.deepEqual(writes, [false, true]);
    assert.equal(saved.floatingButton, true);
    assert.equal(h.launcher.hidden, false);
    h.shell.dispose();
});

for (const surface of ['drawer', 'menu']) {
    test(`addEntries ${surface} opens only when closed without a floating launcher`, () => {
        const h = host();
        let opened = false, opens = 0;
        const dispose = addEntries({ ctx: h.ctx, doc,
            isOpen: () => opened, open: () => { opens++; opened = true; },
        });
        const press = surface === 'drawer' ? () => buttons(h.root)[0].click() : h.click;
        press(); press();
        assert.equal(opens, 1);
        assert.equal(opened, true);
        opened = false;
        press();
        assert.equal(opens, 2);
        dispose();
        opened = false;
        press();
        assert.equal(opens, 2, 'disposed entries no longer open');
        dispose();
        assert.equal(h.calls.off, 1);
        assert.deepEqual(h.calls.destroyed, ['tab', 'action']);
    });
}

test('addEntries survives absent or non-function APIs', () => {
    for (const ctx of [undefined, {}, { ui: {} }, { ui: { registerDrawerTab: true, registerInputBarAction: null } }]) {
        assert.doesNotThrow(() => addEntries({ ctx, doc, open() { assert.fail('must not open on registration'); } })());
    }
});

for (const unavailable of ['registerDrawerTab', 'registerInputBarAction']) {
    for (const mode of ['missing', 'throws']) {
        test(`addEntries keeps the other entry when ${unavailable} ${mode}`, () => {
            const h = host();
            h.ctx.ui[unavailable] = mode === 'missing' ? undefined : () => { throw new Error('unsupported'); };
            let opens = 0;
            const dispose = addEntries({ ctx: h.ctx, doc, open: () => opens++ });
            if (unavailable === 'registerDrawerTab') h.click();
            else buttons(h.root)[0].click();
            assert.equal(opens, 1);
            assert.doesNotThrow(dispose);
            assert.equal(h.calls.destroyed.length, 1);
        });
    }
}

test('addEntries swallows unmounted window failures from both entries', () => {
    for (const failing of ['isOpen', 'open']) {
        const h = host();
        const dispose = addEntries({ ctx: h.ctx, doc, open() {},
            [failing]: () => { throw new Error('not mounted'); },
        });
        assert.doesNotThrow(h.click);
        assert.doesNotThrow(() => buttons(h.root)[0].click());
        dispose();
    }
});

test('addEntries cleans partial registrations and continues after cleanup errors', () => {
    const h = host();
    const destroyed = [];
    h.ctx.ui.registerDrawerTab = () => ({
        root: h.root, destroy() { destroyed.push('tab'); throw new Error('already removed'); },
    });
    h.ctx.ui.registerInputBarAction = () => ({
        onClick() { return () => { throw new Error('already removed'); }; },
        destroy() { destroyed.push('action'); },
    });
    const dispose = addEntries({ ctx: h.ctx, doc, open() {}, mountTab() { throw new Error('unavailable root'); } });
    assert.doesNotThrow(dispose);
    assert.deepEqual(destroyed, ['tab', 'action']);
});

test('shell wires addEntries once, preserves its settings card and disposes tab activation', async () => {
    const h = host();
    let opened = false, opens = 0, activationOff = 0, eventOff = 0;
    const registerTab = h.ctx.ui.registerDrawerTab;
    h.ctx.ui.registerDrawerTab = options => ({
        ...registerTab(options), onActivate() { return () => activationOff++; },
    });
    const link = { call: async () => ({}), onEvent: () => () => eventOff++ };
    const shell = createShell(h.ctx, { link, getChatId: () => '', doc,
        isOpen: () => opened, openMemory: () => { opens++; opened = true; },
    });
    await shell.refresh();
    assert.equal(h.calls.tabs.length, 1);
    assert.equal(h.calls.actions.length, 1);
    assert.equal(h.root.children[0].className, 'am-drawer');
    const card = h.root.children[0].children[1];
    assert.ok(card.children.some(n => n.children?.[0]?.textContent === '설정'));
    const openButton = buttons(h.root).find(n => n.textContent === '기억 서재 열기');
    openButton.click(); h.click(); openButton.click();
    assert.equal(opens, 1);
    opened = false;
    h.click(); openButton.click();
    assert.equal(opens, 2);
    shell.dispose();
    assert.equal(activationOff, 1);
    assert.equal(eventOff, 1);
    assert.equal(h.calls.off, 1);
    assert.deepEqual(h.calls.destroyed, ['tab', 'action']);
});

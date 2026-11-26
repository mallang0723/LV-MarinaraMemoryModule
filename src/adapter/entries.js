// Our own entry points, independent of the original floating launcher.
export const ENTRY_LABEL = '기억 서재';
export const TAB_TITLE = '기억';
const ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11M9 8h6"/></svg>';

/** Register optional host surfaces. mountTab can preserve the shell's settings card and return its cleanup. */
export function addEntries({ ctx, open, isOpen = () => false, doc = globalThis.document, mountTab }) {
    const handles = [], offs = [];
    let alive = true;
    const press = () => { try { if (alive && !isOpen()) open(); } catch { /* not mounted */ } };
    try {
        if (typeof ctx?.ui?.registerDrawerTab === 'function') {
            const tab = ctx.ui.registerDrawerTab({
                id: 'memory-library', title: ENTRY_LABEL, shortName: TAB_TITLE, headerTitle: ENTRY_LABEL,
                description: '장면·사실·미해결 장부를 보고 고치기 · Memory library: scenes, facts and ledger',
                keywords: ['기억', '서재', '장면', '사실', '장부', 'memory', 'library', 'scenes', 'facts', 'ledger'], iconSvg: ICON,
            });
            handles.push(tab);
            if (mountTab) {
                offs.push(mountTab(tab, press));
            } else {
                const card = doc.createElement('div');
                card.style.cssText = 'padding:12px;display:flex;flex-direction:column;gap:10px';
                const note = doc.createElement('p');
                note.textContent = '롤플레이를 읽어 정리한 기억 서재를 엽니다.';
                note.style.cssText = 'margin:0;font-size:13px;opacity:.8';
                const btn = doc.createElement('button');
                btn.type = 'button';
                btn.textContent = `${ENTRY_LABEL} 열기`;
                btn.style.cssText = 'padding:8px 12px;border-radius:8px;cursor:pointer';
                btn.addEventListener('click', press);
                offs.push(() => btn.removeEventListener('click', press));
                card.append(note, btn);
                tab.root.replaceChildren(card);
            }
        }
    } catch { /* no drawer on this host */ }
    try {
        if (typeof ctx?.ui?.registerInputBarAction === 'function') {
            const action = ctx.ui.registerInputBarAction({ id: 'memory-open', label: ENTRY_LABEL, iconSvg: ICON });
            handles.push(action);
            offs.push(action.onClick(press));
        }
    } catch { /* no input bar menu on this host */ }
    return () => {
        if (!alive) return;
        alive = false;
        for (const off of offs) { try { if (typeof off === 'function') off(); } catch { /* ignore */ } }
        for (const handle of handles) { try { handle?.destroy?.(); } catch { /* ignore */ } }
    };
}

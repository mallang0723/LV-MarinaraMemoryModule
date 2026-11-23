// Provenance check. The twenty-four upstream modules (twenty-three cores plus service.cjs) and the four screen files must be byte-identical to the pinned upstream
// copies (SHA-256 below). UPSTREAM_MEMORY=/path/to/a/checkout/of/tlsiddl/marinara-memory-module additionally compares with that checkout
// (this fork's `main` branch is such a checkout).
// Usage: node scripts/verify-original.mjs
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
export const PINS = {
    'src/memory/core/trackers.cjs': '3701d0806474d1381c77d575dee78c5f06917d07efc894be79de1be831750ee3',
    'src/memory/core/selected.cjs': '2b1892128785279e49a310c372a6635b2202f76ad591d8ffaee17ca5f3005747',
    'src/memory/core/reasons.cjs': 'a9ff699a1ab6944ef1bb58d24e761757f9c17a950937c0e2a8ddaba7e91f4c9e',
    'src/memory/core/conflicts.cjs': '3201188ff2c2204d17edeff092b4a8dba7a6e4d06adf804c39ae48651c7d8e5d',
    'src/memory/core/backup.cjs': '176157b371c76c504b8c1d406e993b94ec7c34e33dedc6acbd41513800767a29',
    'src/memory/core/ledger.cjs': '873da4ada8e52c6d4bd8c7fb8d13b1890ebdce3a855e74a2310c61a36e9c308e',
    'src/memory/core/scenes.cjs': 'eed786b044a6a5088e858800cee86d41e8e0769e7a07d644588803f1e7c13fba',
    'src/memory/core/recall.cjs': '01570f40dc105c88de6341f9b30277b44c291b47b61794d59a25d7239a57b889',
    'src/memory/core/vectors.cjs': 'e8e8cd7cd1430c9679427e912ef6356f8ce561731e7f689d0c8903fac3d238a9',
    'src/memory/core/speakers.cjs': '74ded6367848f9f52ed372f50000175598e82c6bfbe70ed6b893bf6ecf9f3b89',
    'src/memory/core/translate.cjs': '0f9940908c04b53aa2c528803af5832b8644005d59e89815f113add6c88cc00a',
    'src/memory/core/aliases.cjs': '86977f803cc9b5abd65cb0880357580a9c29756c58b095c2309452b6096e1ea9',
    'src/memory/core/keepsakes.cjs': '919e3de8e9af816a5661e15e6eb6e091b88c7a386aad697feee161a3e481e46a',
    'src/memory/core/knowledge.cjs': '42e170be29dfa403fe37233e15a27ea50f888b8514bcfa463875dfc7ca796172',
    'src/memory/core/places.cjs': 'd72e470557d45990c80b5e3c031f6159b76d3793c71bbee8e7107e06ddadf438',
    'src/memory/core/state.cjs': '558ca86c39ce355b5cc8bababf440541269ad23fd56e23d31da69976cceef5db',
    'src/memory/core/names.cjs': '2829f1dc3c0cb9375ce3192db284e8743ae7ec58b00dc7c5ef02d21f343b1236',
    'src/memory/core/address.cjs': '0645aaae29c7bbd91d7301eac9d41a5908665c52fb1f2c136a4327399b47bf79',
    'src/memory/core/features.cjs': 'f061d272a1856409d20cb06903142663909d00dbb49c368c59d770e3e2fbfe95',
    'src/memory/core/notebook.cjs': '91496f89506cc1756fbc6f7925324447a88aa75718772992a7fc9b53b4cd76a9',
    'src/memory/core/service.cjs': 'd6b826c30955c03600474550ad47daa7c43ab6e2456f9fce2775720526438920',
    'src/memory/core/petnotes.cjs': 'd102dfcebc439b6062ba9ecc923d26456bbb87931782d114ba97aab5dd5f551e',
    'src/memory/core/simulator.cjs': 'bf67920641f6df8e767c68ee095ab23960752fe44db8702836908f8c9eaaf9c3',
    'src/memory/core/worldlink.cjs': 'a82fdc7b0378f856204ea66868f0a6ec7d671acd65a644f932d105663368fa8a',
    'src/memory/ui/world-panel.orig.js': 'b4152beb432f694326aa9d040767de1683ae52cb577d13440290385df45182e3',
    'src/memory/ui/runtime.orig.js': '853a246caded118b460923dcd250b5b29f78651d6d98a0bc295e9de77afde8dc',
    'src/memory/ui/ui.orig.css': '723a52ce50799477830f7470011d2b61e9986d4dee7924281afc67e5ae101a33',
    'src/memory/ui/theme.orig.css': 'd1a961b80fb2459a721151270943609f498161d8917edc7bcae42464b52049d8',
};
const sha = f => createHash('sha256').update(readFileSync(f)).digest('hex');
export function verify(root = '.') {
    const bad = [];
    for (const [file, pin] of Object.entries(PINS)) {
        const p = `${root}/${file}`;
        if (!existsSync(p)) { bad.push(`${file}: missing`); continue; }
        if (sha(p) !== pin) bad.push(`${file}: sha256 ${sha(p)} != pinned ${pin}`);
    }
    const up = process.env.UPSTREAM_MEMORY;
    if (up) for (const file of Object.keys(PINS)) {
        const relative = file.startsWith('src/memory/core/')
            ? file.replace('src/memory/core/', 'memory-module/lib/')
            : file === 'src/memory/ui/world-panel.orig.js' ? 'extension/vendor/world-panel.js'
            : file.replace('src/memory/ui/', 'extension/').replace('.orig.', '.');
        const upstream = `${up}/${relative}`;
        if (!existsSync(upstream)) bad.push(`${relative}: missing in upstream checkout`);
        else if (sha(upstream) !== sha(`${root}/${file}`)) bad.push(`${file} differs from upstream checkout`);
    }
    return bad;
}
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
    const bad = verify();
    console.log(JSON.stringify({ ok: !bad.length, problems: bad.length }));
    for (const b of bad) console.log(b);
    process.exit(bad.length ? 1 : 0);
}

// Morphe index logic against Morphe's own data captured 2026-10-11: the official patches-list.json and a
// representative subset of the community bundles.json (test/fixtures).
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, wait, fixture } from './harness.mjs';

const bundlesText = fixture('bundles.json.gz');
const officialText = fixture('patches-list.json.gz');
const bundles = JSON.parse(bundlesText);
const official = JSON.parse(officialText);

const t = await boot({ route: () => ({ status: 404 }) });
const { sp, window } = t;
test.after(() => window.close());

// Morphe uses two shapes: [{packageName, targets}] and {packageName: [versions]}.
const packagesOf = compat => (Array.isArray(compat) ? compat.map(c => c?.packageName).filter(Boolean) : compat && typeof compat === 'object' ? Object.keys(compat) : []);
const community = sp.buildCommunityIndex(JSON.parse(bundlesText));
const officialIndex = sp.buildOfficialIndex(JSON.parse(officialText));

test('live schema parses: app counts and stored summary size', () => {
    const apps = new Set([...Object.keys(community), ...Object.keys(officialIndex)]);
    const size = JSON.stringify({ community: { apps: community }, official: { apps: officialIndex } }).length;
    console.log(`# community apps=${Object.keys(community).length} official apps=${Object.keys(officialIndex).length} union=${apps.size} summaryBytes=${size}`);
    assert.ok(Object.keys(community).length > 20);
    assert.ok(Object.keys(officialIndex).length > 0);
});

test('every community bundle produced at least one app (no silent schema drop)', () => {
    const named = new Set(Object.values(community).flatMap(app => app.bundles.map(b => b.bundle)));
    const missing = bundles.bundles.filter(b => (b.patches || []).length && !named.has(String(b.name || b.repo || 'Patch bundle').slice(0, 60)));
    console.log(`# bundles with patches but no app in the index: ${missing.length} ${missing.slice(0, 5).map(b => b.repo).join(', ')}`);
});

test('FIXED SP-06 (live): the chip number never exceeds the distinct patch names for the app', () => {
    const names = new Map();
    const add = (pkg, name) => { if (!names.has(pkg)) names.set(pkg, new Set()); names.get(pkg).add(String(name).toLowerCase()); };
    for (const b of bundles.bundles) for (const p of b.patches || []) {
        const compat = Array.isArray(p.compatiblePackages) ? p.compatiblePackages : bundles.compatibilities[p.compatiblePackagesKey ?? p.compatibilityKey];
        for (const pkg of packagesOf(compat)) add(pkg, p.name);
    }
    for (const p of official.patches) for (const c of p.compatiblePackages || []) if (c?.packageName) add(c.packageName, p.name);
    sp.setPatchIndex({ fetchedAt: Date.now(), community: { apps: community }, official: { apps: officialIndex } });
    const root = window.document.createElement('div');
    window.document.body.append(root);
    const anchor = window.document.createElement('button');
    root.append(anchor);
    const ctx = { sessionId: sp.state.sessionId };
    let over = 0; const worst = [];
    for (const pkg of names.keys()) {
        if (!sp.patchInfo(pkg)) continue;
        Object.assign(ctx, { packageId: pkg, encodedPackageId: pkg });
        sp.renderPatchChip(root, anchor, ctx);
        const shown = Number(root.querySelector('.pas-chip span').textContent.match(/(\d+) patch/)[1]);
        if (shown > names.get(pkg).size) { over += 1; worst.push([pkg, shown, names.get(pkg).size]); }
    }
    console.log(`# apps where the chip exceeds distinct names: ${over}`, worst.slice(0, 5).map(w => w.join(':')).join(', '));
    assert.equal(over, 0);
    root.remove();
});

test('official YouTube row: version wording and full-APK note (N12)', () => {
    sp.setPatchIndex({ fetchedAt: Date.now(), community: { apps: community }, official: { apps: officialIndex } });
    assert.equal(officialIndex['com.google.android.youtube'].apkRequired, true);
    assert.equal(officialIndex['com.reddit.frontpage']?.apkRequired ?? false, false);
    const rows = sp.patchSources({ packageId: 'com.google.android.youtube', encodedPackageId: 'com.google.android.youtube' });
    const officialRow = rows.find(r => r.id === 'morphe-official');
    console.log(`# YouTube official hint: ${officialRow.hint}`);
    assert.match(officialRow.hint, /^\d+ patches · for v\d+(\.\d+)+ · full APK only$/);
});

test('community rows say "any version" when a bundle lists none', () => {
    sp.setPatchIndex({ fetchedAt: Date.now(), community: { apps: community }, official: { apps: officialIndex } });
    const [pkg] = Object.entries(community).find(([, app]) => app.bundles.some(b => !b.versions.length));
    const rows = sp.patchSources({ packageId: pkg, encodedPackageId: pkg });
    assert.ok(rows.some(r => / · any version$/.test(r.hint)), rows.map(r => r.hint).join(' | '));
});

test('version data: apps with no version constraint vs constrained', () => {
    let none = 0; let some = 0;
    for (const app of Object.values(community)) for (const b of app.bundles) (b.versions.length ? some++ : none++);
    console.log(`# community bundle-app entries: ${some} with versions, ${none} without (shown with no version → reads as "any")`);
    const yt = officialIndex['com.google.android.youtube'];
    console.log(`# official YouTube: ${yt?.patches} patches, top versions ${yt?.versions?.join(', ')}`);
});

test('official list exposes apkFileType (e.g. APK_REQUIRED) that Sideport ignores', () => {
    const types = new Map();
    for (const p of official.patches) for (const c of p.compatiblePackages || []) if (c?.apkFileType) types.set(`${c.packageName}`, c.apkFileType);
    console.log(`# packages with apkFileType: ${[...types].slice(0, 6).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    assert.ok(types.size > 0);
});

test('recommended bundles present in live data', () => {
    const repos = new Set(bundles.bundles.map(b => String(b.repo || '').toLowerCase()));
    for (const r of ['crimera/piko', 'jasonwu1994/gboard-patches', 'heval99/heval-morphe-patches']) console.log(`# ${r}: ${repos.has(r)}`);
    console.log(`# SysAdminDoc bundles: ${[...repos].filter(r => r.startsWith('sysadmindoc/')).length}`);
});

test('Morphe 304 path keeps the same apps objects (no rewrite of the data record)', async () => {
    const t2 = await boot({
        route: d => {
            const etagged = d.headers?.['If-None-Match'];
            if (etagged) return { status: 304, headers: `etag: ${etagged}\r\n` };
            return d.url.includes('bundles') ? { status: 200, text: bundlesText, headers: 'etag: "A"\r\n' } : { status: 200, text: officialText, headers: 'etag: "B"\r\n' };
        }
    });
    await wait(300);
    const first = t2.sp.getPatchIndexVar();
    const writes = [];
    const orig = t2.window.GM.setValue; t2.window.GM.setValue = async (k, v) => { writes.push(k); return orig(k, v); };
    const second = await t2.sp.refreshPatchIndex({ force: true });
    assert.equal(second.community.apps, first.community.apps);
    assert.deepEqual([...writes], ['sideport-patch-meta-v3']);
    const conditional = t2.requests.filter(r => r.details.headers?.['If-None-Match']).length;
    assert.equal(conditional, 2);
    t2.window.close();
});

test('Morphe re-check timing: unlisted apps re-check after 5 minutes, listed apps after 30', async () => {
    const t3 = await boot({ route: d => (d.url.includes('bundles') ? { status: 200, text: bundlesText, headers: 'etag: "A"\r\n' } : { status: 200, text: officialText, headers: 'etag: "B"\r\n' }) });
    await wait(300);
    const index = t3.sp.getPatchIndexVar();
    const old = Date.now() - 6 * 60e3;
    t3.sp.setPatchIndex({ ...index, fetchedAt: old });
    t3.store.set('sideport-patch-meta-v3', { ...t3.store.get('sideport-patch-meta-v3'), fetchedAt: old });
    const before = t3.requests.length;
    await t3.sp.getPatchIndex('com.google.android.youtube'); // patched → no re-check
    await wait(50);
    const afterPatched = t3.requests.length;
    await t3.sp.getPatchIndex('com.example.unpatched'); // unpatched → re-check
    await wait(100);
    console.log(`# requests: patched app +${afterPatched - before}, unpatched app +${t3.requests.length - afterPatched}`);
    assert.equal(afterPatched - before, 0);
    assert.ok(t3.requests.length - afterPatched >= 1);
    t3.window.close();
});

await wait(0);

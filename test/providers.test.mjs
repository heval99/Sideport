// Runs Sideport's real probe code against responses captured from each source on 2026-10-11 (test/fixtures,
// trimmed to the parts Sideport reads). Proves parsing and classification of those captures only — not that the
// services still answer the same way today.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, wait, fixture } from './harness.mjs';

const live = fixture;
let reply = () => ({ status: 404 });
const t = await boot({ route: d => (/morphe|patches-list/.test(d.url) ? { status: 200, text: '{}' } : reply(d)) });
const { sp, window } = t;
test.after(() => window.close());

const ctx = pkg => ({ packageId: pkg, encodedPackageId: encodeURIComponent(pkg), sessionId: sp.state.sessionId, appName: pkg, searchName: pkg, isFree: true });
const probe = async (id, pkg) => {
    try { return { ok: true, value: await sp.SOURCE_BY_ID.get(id).probe(ctx(pkg)) }; } catch (error) { return { ok: false, error: `${error.name}:${error.message}` }; }
};

test('F-Droid: picks suggestedVersionCode (1.23.2), not the newest 2.0.1 build', async () => {
    reply = () => ({ status: 200, text: live('fd_org.fdroid.fdroid.json') });
    const r = await probe('fdroid', 'org.fdroid.fdroid');
    assert.equal(r.value.version, '1.23.2');
    assert.equal(r.value.data.files[0].url, 'https://f-droid.org/repo/org.fdroid.fdroid_1023052.apk');
});

test('F-Droid: 404 → Not found', async () => {
    reply = () => ({ status: 404, text: live('fd_com.nonexistent.sideportaudit.json') });
    assert.equal((await probe('fdroid', 'com.nonexistent.sideportaudit')).error, 'NotListed:Not found');
});

test('Izzy API: string versionCode values ("14") are accepted', async () => {
    reply = () => ({ status: 200, text: live('iz_in.sunilpaulmathew.izzyondroid.json') });
    const r = await probe('izzy', 'in.sunilpaulmathew.izzyondroid');
    assert.equal(r.value.version, 'v0.14');
    assert.equal(r.value.data.files[0].url, 'https://apt.izzysoft.de/fdroid/repo/in.sunilpaulmathew.izzyondroid_14.apk');
});

test('Guardian: Orbot resolves to orbot-latest.apk on raw.githubusercontent.com', async () => {
    reply = () => ({ status: 200, text: live('izr_guardian_org.torproject.android.html'), finalUrl: 'https://apt.izzysoft.de/fdroid/index/apk/org.torproject.android?repo=guardian' });
    const r = await probe('guardian', 'org.torproject.android');
    const url = r.value.data.files[0].url;
    assert.equal(url, 'https://raw.githubusercontent.com/guardianproject/fdroid-repo/master/fdroid/repo/orbot-latest.apk');
    // The first audit's SP-03 fix (require "<pkg>_<code>.apk") would reject this real file:
    assert.equal(/\/org\.torproject\.android_\d+\.apk$/.test(url), false);
    console.log('# guardian orbot version cell:', JSON.stringify(r.value.version));
});

test('Guardian: Ripple resolves to guardianproject.gitlab.io', async () => {
    reply = () => ({ status: 200, text: live('izr_guardian_info.guardianproject.ripple.html'), finalUrl: 'https://apt.izzysoft.de/fdroid/index/apk/info.guardianproject.ripple?repo=guardian' });
    const r = await probe('guardian', 'info.guardianproject.ripple');
    assert.match(r.value.data.files[0].url, /^https:\/\/guardianproject\.gitlab\.io\//);
    console.log('# guardian ripple version cell:', JSON.stringify(r.value.version));
});

test('FIXED N8: a Guardian (Orbot) download starts instead of the "unrecognised host" warning', async () => {
    reply = d => (d.url.includes('repo=guardian')
        ? { status: 200, text: live('izr_guardian_org.torproject.android.html'), finalUrl: d.url }
        : { status: 404 });
    t.harness.opened.length = 0;
    window.history.pushState({}, '', '/store/apps/details?id=org.torproject.android');
    window.document.querySelector('h1').textContent = 'Orbot';
    window.document.querySelector('[data-item-id]').setAttribute('data-item-id', '%.@."org.torproject.android",7]');
    sp.renderForCurrentPage();
    await wait(50);
    sp.openMenu('sources', false);
    await sp.startDownload(sp.SOURCE_BY_ID.get('guardian'), sp.state.mount.ctx);
    const row = window.document.querySelector('.pas-item[data-id="guardian"] .pas-row-sub').textContent;
    assert.match(row, /^Download started/);
    assert.ok(t.harness.opened.includes('https://raw.githubusercontent.com/guardianproject/fdroid-repo/master/fdroid/repo/orbot-latest.apk'));
});

test('N8 guard: Guardian trust covers its GitLab and GitHub files only', () => {
    const hosts = sp.SOURCE_BY_ID.get('guardian').hosts;
    const ok = url => sp.isAllowedHost(url, hosts);
    assert.equal(ok('https://raw.githubusercontent.com/guardianproject/fdroid-repo/master/fdroid/repo/orbot-latest.apk'), true);
    assert.equal(ok('https://guardianproject.gitlab.io/fdroid-repo/fdroid/repo/info.guardianproject.ripple_168.apk'), true);
    assert.equal(ok('https://guardianproject.info/fdroid/repo/x.apk'), true);
    assert.equal(ok('https://raw.githubusercontent.com/evil/repo/master/orbot.apk'), false);
    assert.equal(ok('https://raw.githubusercontent.com/guardianprojectevil/x.apk'), false);
    assert.equal(ok('https://raw.githubusercontent.com/guardianproject/../evil/x.apk'), false);
    assert.equal(ok('https://raw.githubusercontent.com/guardianproject/%2e%2e/evil/x.apk'), false);
    assert.equal(ok('https://guardianproject.gitlab.io.evil.com/x.apk'), false);
    assert.equal(ok('https://evilguardianproject.gitlab.io/x.apk'), false);
    assert.equal(ok('not a url'), false);
});

test('host check unchanged for plain domain entries', () => {
    assert.equal(sp.isAllowedHost('https://www.f-droid.org/repo/a.apk', ['f-droid.org']), true);
    assert.equal(sp.isAllowedHost('https://cdn.f-droid.org/repo/a.apk', ['f-droid.org']), true);
    assert.equal(sp.isAllowedHost('https://evilf-droid.org/a.apk', ['f-droid.org']), false);
    assert.equal(sp.isAllowedHost('https://pool.apk.aptoide.com/a.apk', ['aptoide.com']), true);
    assert.equal(sp.isAllowedHost('https://anything.example/a.apk', undefined), true);
});

test('Guardian/archive: package missing from the repo answers 404 → Not found (SP-03 trigger not observed)', async () => {
    reply = () => ({ status: 404, text: live('izr_guardian_com.nonexistent.sideportaudit.html') });
    assert.equal((await probe('guardian', 'com.nonexistent.sideportaudit')).error, 'NotListed:Not found');
});

test('F-Droid archive: first link is the newest archived build of the right package', async () => {
    reply = () => ({ status: 200, text: live('izr_archive_org.fdroid.fdroid.html'), finalUrl: 'https://apt.izzysoft.de/fdroid/index/apk/org.fdroid.fdroid?repo=archive' });
    const r = await probe('fdroid-archive', 'org.fdroid.fdroid');
    assert.equal(r.value.data.files[0].url, 'https://f-droid.org/archive/org.fdroid.fdroid_1023051.apk');
    console.log('# archive version cell:', JSON.stringify(r.value.version));
});

test('Aptoide: live search has one exact listing, store "aptoide-web", malware.rank TRUSTED', async () => {
    reply = () => ({ status: 200, text: live('apt_whatsapp.json') });
    const r = await probe('aptoide', 'com.whatsapp');
    assert.equal(r.value.version, '2.26.40.7');
    assert.match(r.value.data.files[0].url, /^https:\/\/url-provider\.aptoide\.com\//);
    const listing = JSON.parse(live('apt_whatsapp.json')).datalist.list.find(e => e.package === 'com.whatsapp');
    assert.equal(listing.file.malware.rank, 'TRUSTED');
});

test('Aptoide: HTML (e.g. a block page) instead of JSON → "Unexpected response"', async () => {
    reply = () => ({ status: 200, text: '<html>blocked</html>' });
    assert.equal((await probe('aptoide', 'com.whatsapp')).error, 'SourceFailure:Unexpected response');
});

for (const [pkg, expected] of [
    ['com.whatsapp', 'https://whatsapp-messenger.en.uptodown.com/android/download'],
    ['org.fdroid.fdroid', 'https://f-droid.en.uptodown.com/android/download'],
    ['com.spotify.music', 'https://spotify.en.uptodown.com/android/download'],
    ['com.whatsapp.w4b', 'https://whatsapp-business.en.uptodown.com/android/download'],
    ['com.nonexistent.sideportaudit', 'NotListed'],
    ['com.example.whatsapp', 'NotListed']
]) {
    test(`Uptodown live page: ${pkg}`, async () => {
        reply = () => ({ status: 200, text: live(`up_${pkg}.html`) });
        const r = await probe('uptodown', pkg);
        assert.equal(r.ok ? r.value.pageUrl : r.error.split(':')[0], expected);
    });
}

test('Known limit: Uptodown search can return a related listing (org.telegram.messenger.web → Telegram)', async () => {
    reply = () => ({ status: 200, text: live('up_org.telegram.messenger.web.html') });
    const r = await probe('uptodown', 'org.telegram.messenger.web');
    // Uptodown's "telegram" listing is org.telegram.messenger; the probe cannot tell the two apart.
    assert.equal(r.value.pageUrl, 'https://telegram.en.uptodown.com/android/download');
});

// Live redirects captured 2026-10-11 (HEAD -L d.apkpure.com/b/{APK,XAPK}/<pkg>).
const WINUDF = {
    fdroidApk: 'https://data.winudf.com/APK/b3JnLmZkcm9pZC5mZHJvaWRfMTAyMzA1Ml9mZTNiNjMzNA?_p=b3JnLmZkcm9pZC5mZHJvaWQ%3D&filename=F-Droid_1.23.2_APKPure.apk&full_size=12426276',
    whatsappXapk: 'https://data.winudf.com/XAPK/Y29tLndoYXRzYXBwXzI2MzkwNzkwMF84MGI3NThmOQ?_p=Y29tLndoYXRzYXBw&filename=WhatsApp+Messenger_2.26.39.79_APKPure.xapk&full_size=95741792'
};
const disposition = name => `content-type: application/octet-stream
content-disposition: attachment; filename="${name}"
`;

test('FIXED N10: XAPK row is "Not found" when APKPure redirects the XAPK link to a plain APK', async () => {
    reply = () => ({ status: 200, finalUrl: WINUDF.fdroidApk, headers: disposition('F-Droid_1.23.2_APKPure.apk') });
    assert.equal((await probe('apkpure-xapk', 'org.fdroid.fdroid')).error, 'NotListed:Not found');
});

test('N10 guard: a real XAPK redirect is still available, with its version', async () => {
    reply = () => ({ status: 200, finalUrl: WINUDF.whatsappXapk, headers: disposition('WhatsApp Messenger_2.26.39.79_APKPure.xapk') });
    const r = await probe('apkpure-xapk', 'com.whatsapp');
    assert.equal(r.ok, true);
    assert.equal(r.value.version, '2.26.39.79');
});

test('N10 guard: the APK row accepts the same /APK/ redirect', async () => {
    reply = () => ({ status: 200, finalUrl: WINUDF.fdroidApk, headers: disposition('F-Droid_1.23.2_APKPure.apk') });
    const r = await probe('apkpure', 'org.fdroid.fdroid');
    assert.equal(r.ok, true);
    assert.equal(r.value.version, '1.23.2');
});

test('FIXED N5: an error status at the end of the winudf redirect is not "available"', async () => {
    reply = () => ({ status: 403, finalUrl: 'https://data.winudf.com/APK/x?filename=A_1.0_APKPure.apk', headers: '' });
    assert.equal((await probe('apkpure', 'com.a.b')).error, 'SourceFailure:HTTP 403');
    reply = () => ({ status: 404, finalUrl: 'https://data.winudf.com/APK/x?filename=A_1.0_APKPure.apk', headers: '' });
    assert.equal((await probe('apkpure', 'com.a.b')).error, 'NotListed:Not found');
});

test('FIXED N13: without Content-Disposition the version comes from the ?filename= query', async () => {
    reply = () => ({ status: 200, finalUrl: 'https://data.winudf.com/APK/abc?filename=F-Droid_1.23.2_APKPure.apk', headers: '' });
    assert.equal((await probe('apkpure', 'org.fdroid.fdroid')).value.version, '1.23.2');
    reply = () => ({ status: 200, finalUrl: WINUDF.whatsappXapk, headers: '' });
    assert.equal((await probe('apkpure-xapk', 'com.whatsapp')).value.version, '2.26.39.79');
});

test('APKPure: no redirect to winudf → "No download redirect"; 404 → Not found', async () => {
    reply = () => ({ status: 200, finalUrl: 'https://apkpure.com/some-page', headers: '' });
    assert.equal((await probe('apkpure', 'com.a.b')).error, 'SourceFailure:No download redirect');
    reply = () => ({ status: 404, finalUrl: 'https://d.apkpure.com/b/APK/com.a.b?version=latest', headers: '' });
    assert.equal((await probe('apkpure', 'com.a.b')).error, 'NotListed:Not found');
});

await wait(0);
const aptoideDownload = async listings => {
    reply = d => (d.url.includes('web-api.aptoide.com') ? { status: 200, text: JSON.stringify({ datalist: { list: listings } }) } : { status: 404 });
    t.harness.opened.length = 0;
    sp.probeCache.clear();
    sp.state.menu?.actions.clear();
    sp.openMenu('sources', false);
    await sp.startDownload(sp.SOURCE_BY_ID.get('aptoide'), sp.state.mount.ctx);
    return {
        row: window.document.querySelector('.pas-item[data-id="aptoide"] .pas-row-sub').textContent,
        opened: t.harness.opened.filter(Boolean)
    };
};
const listing = (store, rank, path) => ({ package: sp.state.mount.ctx.packageId, store: { name: store }, file: { vername: '1.0', path, ...(rank ? { malware: { rank } } : {}) } });

test('FIXED SP-02: a TRUSTED Aptoide listing downloads directly (live shape)', async () => {
    const r = await aptoideDownload([listing('aptoide-web', 'TRUSTED', 'https://pool.apk.aptoide.com/a/trusted.apk')]);
    assert.match(r.row, /^Download started/);
    assert.ok(r.opened.includes('https://pool.apk.aptoide.com/a/trusted.apk'));
});

test('FIXED SP-02: a TRUSTED listing is preferred over an earlier unverified one', async () => {
    const r = await aptoideDownload([listing('somestore', 'WARNING', 'https://pool.apk.aptoide.com/a/repack.apk'), listing('apps', 'TRUSTED', 'https://pool.apk.aptoide.com/a/official.apk')]);
    assert.ok(r.opened.includes('https://pool.apk.aptoide.com/a/official.apk'));
    assert.ok(!r.opened.includes('https://pool.apk.aptoide.com/a/repack.apk'));
});

test('FIXED SP-02: an unverified-only listing is not opened; the row explains why', async () => {
    const r = await aptoideDownload([listing('somestore', 'WARNING', 'https://pool.apk.aptoide.com/a/repack.apk')]);
    assert.equal(r.row, "Aptoide's malware check says WARNING — check before opening");
    assert.equal(r.opened.includes('https://pool.apk.aptoide.com/a/repack.apk'), false);
    assert.ok(window.document.querySelector('.pas-item[data-id="aptoide"] .pas-file'), 'the file is still offered as a link');
    const r2 = await aptoideDownload([listing('somestore', null, 'https://pool.apk.aptoide.com/a/unranked.apk')]);
    assert.equal(r2.row, 'Aptoide hasn’t checked this file — check before opening');
});

test('SP-02 guard: other sources still use the plain host warning', async () => {
    reply = d => (d.url.includes('f-droid.org/api') ? { status: 200, text: JSON.stringify({ packageName: 'x', suggestedVersionCode: 1, packages: [{ versionName: '1', versionCode: 1 }] }) } : { status: 404 });
    sp.probeCache.clear();
    const files = (await sp.SOURCE_BY_ID.get('fdroid').probe({ ...sp.state.mount.ctx })).data.files;
    assert.equal(files[0].warning, undefined);
});

test('PF-05: the text scan and the DOM parse agree on every captured repo page', () => {
    for (const [file, base] of [
        ['izr_archive_org.fdroid.fdroid.html', 'https://apt.izzysoft.de/fdroid/index/apk/org.fdroid.fdroid?repo=archive'],
        ['izr_guardian_org.torproject.android.html', 'https://apt.izzysoft.de/fdroid/index/apk/org.torproject.android?repo=guardian'],
        ['izr_guardian_info.guardianproject.ripple.html', 'https://apt.izzysoft.de/fdroid/index/apk/info.guardianproject.ripple?repo=guardian'],
        ['izr_guardian_org.thoughtcrime.securesms.html', 'https://apt.izzysoft.de/fdroid/index/apk/org.thoughtcrime.securesms?repo=guardian']
    ]) {
        const html = live(file);
        const scan = sp.scanRepoPage(html, base);
        const dom = sp.parseRepoPage(html, base);
        assert.equal(scan?.apk.href, dom?.apk.href, file);
        assert.equal(scan?.version, dom?.version, file);
    }
});

test('PF-05: the scan skips http and non-APK links, decodes &amp;, and falls back when it finds nothing', () => {
    const html = `<a href="https://x.org/page">p</a><a href='http://x.org/old.apk'>o</a><a href="https://x.org/get.apk?a=1&amp;b=2">n</a>
        <tr><td><b>Version:</b></td><td> 2.0 <small>(20)</small></td></tr>`;
    const scan = sp.scanRepoPage(html, 'https://apt.izzysoft.de/');
    assert.equal(scan.apk.href, 'https://x.org/get.apk?a=1&b=2');
    assert.equal(scan.version, '2.0 (20)');
    assert.equal(sp.scanRepoPage('<p>nothing here</p>', 'https://apt.izzysoft.de/'), null);
});

test('PF-05: the archive page is read without building a DOM (speed)', () => {
    const rows = Array.from({ length: 4000 }, (_, i) => `<tr><td><a href='https://f-droid.org/archive/org.fdroid.fdroid_${1000000 + i}.apk'>APK</a></td><td>${i}</td></tr>`).join('\n');
    const html = `<html><body><table><tr><td><b>LastVersion:</b></td><td>1.23.1</td></tr>${rows}</table></body></html>`; // shape of the ~1 MB archive page
    const base = 'https://apt.izzysoft.de/fdroid/index/apk/org.fdroid.fdroid?repo=archive';
    const t0 = performance.now(); for (let i = 0; i < 5; i += 1) sp.scanRepoPage(html, base); const scanMs = (performance.now() - t0) / 5;
    const t1 = performance.now(); sp.parseRepoPage(html, base); const domMs = performance.now() - t1;
    console.log(`# archive page: scan ${scanMs.toFixed(2)} ms vs DOM ${domMs.toFixed(0)} ms (jsdom)`);
    assert.ok(scanMs * 20 < domMs);
});


// Security findings from SIDEPORT_SECURITY_AUDIT.md. Timing tests use crafted 100 KB inputs that took seconds
// (or never finished) with the 1.2.0-pre patterns; the budget is generous so slow CI machines don't flake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boot, SCRIPT_PATH } from './harness.mjs';

const SOURCE = readFileSync(SCRIPT_PATH, 'utf8');
const t = await boot({ route: d => (/morphe|patches-list/.test(d.url) ? { status: 200, text: '{"bundles":[],"patches":[]}' } : { status: 404 }) });
const { sp, window } = t;
test.after(() => window.close());

const BUDGET_MS = 200;
const timed = fn => { const start = performance.now(); const value = fn(); return { value, ms: performance.now() - start }; };

test('SEC-04: ETag header read in linear time (was >20 s on 100 KB)', () => {
    const { value, ms } = timed(() => sp.headerValue(`etag: a${' '.repeat(100000)}b`, 'etag'));
    assert.ok(ms < BUDGET_MS, `${ms} ms`);
    assert.equal(value.startsWith('a') && value.endsWith('b'), true);
    assert.doesNotMatch(SOURCE, /headers\.match\(\/\^etag/, 'fetchIndexPart no longer regex-scans the header block');
});

test('SEC-04: headerValue reads the right header, case-insensitively', () => {
    const headers = 'Content-Type: text/plain\r\nETag: W/"abc"\r\ncontent-disposition: attachment; filename="A_1.2_APKPure.apk"\r\n';
    assert.equal(sp.headerValue(headers, 'etag'), 'W/"abc"');
    assert.equal(sp.headerValue(headers, 'Content-Disposition'), 'attachment; filename="A_1.2_APKPure.apk"');
    assert.equal(sp.headerValue(headers, 'x-missing'), null);
    assert.equal(sp.headerValue('', 'etag'), null);
});

test('SEC-04: Content-Disposition file name read in linear time (was 123 ms at 100 KB, growing quadratically)', () => {
    const { ms } = timed(() => sp.fileNameFromHeaders(`content-disposition: ${'content-disposition:'.repeat(5000)}`));
    assert.ok(ms < BUDGET_MS, `${ms} ms`);
    assert.equal(sp.fileNameFromHeaders('content-disposition: attachment; filename="F-Droid_1.23.2_APKPure.apk"\r\n'), 'F-Droid_1.23.2_APKPure.apk');
    assert.equal(sp.fileNameFromHeaders("Content-Disposition: attachment; filename*=UTF-8''App%20Name_2.0_APKPure.xapk\r\n"), 'App Name_2.0_APKPure.xapk');
});

test('SEC-04: version from a crafted 100 KB file name stays fast (was 2.2 s)', () => {
    const { ms } = timed(() => sp.versionFromFileName(`_${'1.'.repeat(50000)}`));
    assert.ok(ms < BUDGET_MS, `${ms} ms`);
    assert.equal(sp.versionFromFileName('WhatsApp Messenger_2.26.39.79_APKPure.apk'), '2.26.39.79');
});

test('SEC-04: repo page version row found in linear time on a crafted 100 KB page (was 1.7 s)', () => {
    const page = `<a href="https://f-droid.org/archive/x_1.apk">x</a>${'<td>'.repeat(25000)}`;
    const { value, ms } = timed(() => sp.scanRepoPage(page, 'https://apt.izzysoft.de/'));
    assert.ok(ms < BUDGET_MS, `${ms} ms`);
    assert.equal(value.version, null);
    const real = '<a href="https://f-droid.org/archive/x_1.apk">x</a><tr><td><b>LastVersion:</b></td><td>1.23.1</td></tr>';
    assert.equal(sp.scanRepoPage(real, 'https://apt.izzysoft.de/').version, '1.23.1');
});

test('SEC-04: the version row is still found when it comes after other "Version" text', () => {
    const page = `<p>Android Version: 8+</p>${'x'.repeat(5000)}<a href="https://f-droid.org/a_1.apk">a</a><tr><td>Version:</td><td>2.0</td></tr>`;
    assert.equal(sp.scanRepoPage(page, 'https://apt.izzysoft.de/').version, '2.0');
});

test('SEC-05: an oversized source answer is refused before parsing', async () => {
    const big = await boot({ route: d => (/morphe|patches-list/.test(d.url) ? { status: 200, text: '{}' } : { status: 200, text: 'x'.repeat(6 * 1024 * 1024) }) });
    const result = await big.sp.getProbe(big.sp.state.mount.ctx, big.sp.SOURCE_BY_ID.get('uptodown'));
    assert.deepEqual([result.state, result.message], ['unknown', 'Response too large']);
    big.window.close();
});

test('SEC-06: R2 storage is trusted only through APKCombo\'s own /r2 link; the Oracle host is gone', () => {
    const page = `<ul class="file-list">
        <li><a href="/r2?u=https%3A%2F%2Fbucket.r2.cloudflarestorage.com%2Fa.apk">APK 1.0</a></li>
        <li><a href="https://other.r2.cloudflarestorage.com/b.apk">APK 1.0 direct</a></li></ul>`;
    const files = sp.listApkComboVariants(page, 'https://apkcombo.com/app/download/apk');
    const [wrapped, direct] = files;
    assert.equal(wrapped.viaSource, true);
    assert.equal(direct.viaSource, false);
    const hosts = sp.SOURCE_BY_ID.get('apkcombo').hosts;
    assert.equal(sp.isAllowedHost(direct.url, hosts), false, 'a bare R2 URL is not trusted');
    assert.equal(sp.isAllowedHost('https://x.objectstorage.eu-amsterdam-1.oraclecloud.com/a.apk', sp.SOURCE_BY_ID.get('guardian').hosts), false);
});

test('SEC-10: Copy diagnostics keeps only the app id from the Play URL, and no search words', async () => {
    const d = await boot({ url: 'https://play.google.com/store/apps/details?id=com.example.app&hl=de&gl=AT&referrer=utm_source%3Dx', route: () => ({ status: 404 }) });
    const info = d.sp.collectDiagnostics();
    assert.equal(info.url, 'https://play.google.com/store/apps/details?id=com.example.app');
    d.window.close();
    const s = await boot({ url: 'https://play.google.com/store/search?q=my+private+search&c=apps', html: '<!doctype html><html><body><main></main></body></html>', route: () => ({ status: 404 }) });
    const searchInfo = s.sp.collectDiagnostics();
    assert.equal(searchInfo.url, 'https://play.google.com/store/search');
    assert.equal(searchInfo.route, 'search');
    s.window.close();
});

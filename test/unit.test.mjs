// Pure-function checks. FIXED tests assert the corrected behaviour; guards protect what must not change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, wait } from './harness.mjs';

const t = await boot({ route: () => ({ status: 404 }) });
const { sp, window } = t;
test.after(() => window.close());

test('toPackageId: accepts/rejects', () => {
    const cases = { 'com.example': true, 'com.1bad': true, 'a._b': true, 'com..x': false, 'com.example-app': false,
        __proto__x: false, 'constructor.x': true, 'com.ex ample': false, '': false, [`a.${'b'.repeat(199)}`]: false, ' com.x ': true };
    for (const [input, ok] of Object.entries(cases)) assert.equal(Boolean(sp.toPackageId(input)), ok, input);
});

test('expectSuccess: classification table', () => {
    const cls = (status, text = '', headers = '') => {
        try { sp.expectSuccess({ status, text, headers }); return 'ok'; } catch (error) { return `${error.name}:${error.message}`; }
    };
    assert.equal(cls(200), 'ok');
    assert.equal(cls(204), 'ok');
    assert.equal(cls(404), 'NotListed:Not found');
    assert.equal(cls(410), 'NotListed:Not found');
    assert.equal(cls(403, '<title>Just a moment...</title>'), 'SourceFailure:Cloudflare check — open the site');
    assert.equal(cls(503, '', 'cf-mitigated: challenge'), 'SourceFailure:Cloudflare check — open the site');
    assert.equal(cls(403, 'Forbidden'), 'SourceFailure:HTTP 403');
    assert.equal(cls(429), 'SourceFailure:HTTP 429');
    assert.equal(cls(500), 'SourceFailure:HTTP 500');
    assert.equal(cls(502), 'SourceFailure:HTTP 502');
    // 3xx that the manager did not follow (e.g. redirect loop cut off) is reported as an HTTP error, not "Not found".
    assert.equal(cls(302), 'SourceFailure:HTTP 302');
});

test('FIXED SP-05: a failed ("unknown") check is never reused', () => {
    const entry = { result: { state: 'unknown' }, sessionId: 0, settledAt: Date.now() - 1000 };
    assert.equal(sp.isReusable(entry, { sessionId: 99 }), false);
});

test('FIXED SP-13: "available" expires after 30 minutes; a download wants it under 10', () => {
    const at = minutes => ({ result: { state: 'ok' }, sessionId: 0, settledAt: Date.now() - minutes * 60e3 });
    assert.equal(sp.isReusable(at(5), { sessionId: 99 }), true);
    assert.equal(sp.isReusable(at(29), { sessionId: 99 }), true);
    assert.equal(sp.isReusable(at(31), { sessionId: 99 }), false);
    assert.equal(sp.isReusable(at(5), { sessionId: 99 }, { maxOkAge: 10 * 60e3 }), true);
    assert.equal(sp.isReusable(at(11), { sessionId: 99 }, { maxOkAge: 10 * 60e3 }), false);
});

test('missing results expire after 10 minutes', () => {
    const fresh = { result: { state: 'missing' }, settledAt: Date.now() - 60e3 };
    const old = { result: { state: 'missing' }, settledAt: Date.now() - 11 * 60e3 };
    assert.equal(sp.isReusable(fresh, {}), true);
    assert.equal(sp.isReusable(old, {}), false);
});

test('loading entries belong to their session', () => {
    const entry = { result: { state: 'loading' }, sessionId: 3 };
    assert.equal(sp.isReusable(entry, { sessionId: 3 }), true);
    assert.equal(sp.isReusable(entry, { sessionId: 4 }), false);
});

test('latestVersions: ordering edge cases', () => {
    assert.deepEqual([...sp.latestVersions(new Set(['1.2', '1.10', '1.9.9']))], ['1.10', '1.9.9', '1.2']);
    assert.deepEqual([...sp.latestVersions(new Set(['1.0', '1.0.0']))], ['1.0', '1.0.0']); // equal numerically; order kept
    // Non-numeric and "v"-prefixed versions sort as 0 → last.
    assert.deepEqual([...sp.latestVersions(new Set(['v20.1', '19.0']))], ['19.0', 'v20.1']);
});

test('FIXED N7: latestVersions ranks a release above its pre-release', () => {
    assert.deepEqual([...sp.latestVersions(new Set(['2.0-beta', '2.0']))], ['2.0', '2.0-beta']);
    assert.deepEqual([...sp.latestVersions(new Set(['19.16.39-beta.1', '19.16.39']))], ['19.16.39', '19.16.39-beta.1']);
    assert.deepEqual([...sp.latestVersions(new Set(['1.9', '2.0-rc1', '1.10']))], ['2.0-rc1', '1.10', '1.9']);
});

test('FIXED SP-06: one patch listing the same package twice counts once', () => {
    const perApp = sp.countPatchesByPackage([{ compatiblePackages: [{ packageName: 'com.a.b', versions: ['1'] }, { packageName: 'com.a.b', versions: ['2'] }] }], p => p.compatiblePackages);
    assert.equal(perApp.get('com.a.b').count, 1);
    assert.deepEqual([...perApp.get('com.a.b').versions].sort(), ['1', '2']);
});

test('countPatchesByPackage: both schema shapes, invalid keys dropped', () => {
    const perApp = sp.countPatchesByPackage([
        { compatiblePackages: { 'com.x.y': ['1.0', '2.0'], '__proto__': ['9'], 'bad': null } },
        { compatiblePackages: [{ packageName: 'com.x.y', targets: [{ version: '3.0' }] }] },
        null, 'junk', { compatiblePackages: null }
    ], p => p.compatiblePackages);
    assert.deepEqual([...perApp.keys()], ['com.x.y']);
    assert.equal(perApp.get('com.x.y').count, 2);
    assert.deepEqual([...perApp.get('com.x.y').versions].sort(), ['1.0', '2.0', '3.0']);
    assert.equal(Object.prototype.polluted, undefined);
});

test('versionFromFileName: live APKPure file names', () => {
    assert.equal(sp.versionFromFileName('WhatsApp Messenger_2.26.39.79_APKPure.apk'), '2.26.39.79');
    assert.equal(sp.versionFromFileName('F-Droid_1.23.2_APKPure.apk'), '1.23.2');
    assert.equal(sp.versionFromFileName('Some App_123_APKPure.apk'), null);
});

test('FIXED SP-29: el() never turns an on* string into an inline handler attribute; functions still become listeners', () => {
    assert.equal(sp.el('a', { onclick: 'alert(1)' }).getAttribute('onclick'), null);
    assert.equal(sp.el('a', { OnMouseOver: 'alert(1)' }).getAttribute('onmouseover'), null);
    let clicked = 0;
    const button = sp.el('button', { onClick: () => { clicked += 1; } });
    button.click();
    assert.equal(clicked, 1);
});

test('FIXED N6: a price inside an ld+json @graph or top-level array counts', () => {
    const doc = window.document;
    const add = text => { const s = doc.createElement('script'); s.type = 'application/ld+json'; s.textContent = text; doc.head.append(s); return s; };
    const graph = add('{"@graph":[{"@type":"SoftwareApplication","offers":{"price":"4.99"}}]}');
    assert.equal(sp.isPaidApp(null, 'com.example.app'), true);
    graph.remove();
    const list = add('[{"@type":"SoftwareApplication","offers":{"price":"2.99"}}]');
    assert.equal(sp.isPaidApp(null, 'com.example.app'), true);
    list.remove();
});

test('N2 rules: structured data about another app is ignored; about this app it decides over <meta>', () => {
    const doc = window.document;
    const add = text => { const s = doc.createElement('script'); s.type = 'application/ld+json'; s.textContent = text; doc.head.append(s); return s; };
    const meta = () => { const m = doc.createElement('meta'); m.setAttribute('itemprop', 'price'); m.content = '$6.99'; doc.head.append(m); return m; };
    const other = add('{"url":"https://play.google.com/store/apps/details?id=com.other.app","offers":{"price":"4.99"}}');
    assert.equal(sp.isPaidApp(null, 'com.example.app'), false, 'other app price ignored');
    const mine = add('{"url":"https://play.google.com/store/apps/details?id=com.example.app&hl=en","offers":{"price":"0"}}');
    const m = meta();
    assert.equal(sp.isPaidApp(null, 'com.example.app'), false, 'explicit free for this app beats a leftover <meta> price');
    mine.remove();
    assert.equal(sp.isPaidApp(null, 'com.example.app'), true, 'no data about this app: <meta> still counts');
    m.remove();
    other.remove();
    const noUrl = add('{"offers":{"price":"1.99"}}');
    assert.equal(sp.isPaidApp(null, 'com.example.app'), true, 'entry without url still counts (fail closed)');
    noUrl.remove();
    const free = add('{"url":"/store/apps/details?id=com.example.app","offers":{"price":"0"}}');
    const w = doc.createElement('div');
    w.innerHTML = '<button>€4.99</button>';
    assert.equal(sp.isPaidApp(w, 'com.example.app'), true, 'a price on the button still means paid');
    free.remove();
});

test('FIXED N4: community-only apps without a store page link to the community index', () => {
    assert.equal(sp.morpheAppUrl({ encodedPackageId: 'com.x.y' }, { inStore: false, community: [{ bundle: 'B' }], official: null }), 'https://morphe-patches.software/#apps');
    assert.equal(sp.morpheAppUrl({ encodedPackageId: 'com.x.y' }, { inStore: true, community: [{ bundle: 'B' }], official: null }), 'https://morphe-patches.software/?app=com.x.y#apps');
    assert.equal(sp.morpheAppUrl({ encodedPackageId: 'com.x.y' }, { inStore: false, community: [], official: { patches: 1 } }), 'https://morphe.software/');
});

test('isPaidApp: button label heuristics', () => {
    const doc = window.document;
    const w = label => { const d = doc.createElement('div'); d.innerHTML = `<button>${label}</button>`; return d; };
    assert.equal(sp.isPaidApp(w('Install')), false);
    assert.equal(sp.isPaidApp(w('€4.99')), true);
    assert.equal(sp.isPaidApp(w('Install on 2 more devices')), false);
    assert.equal(sp.isPaidApp(w('Update (12 MB)')), false);
    // "SDK 34" style text inside a widget would read as a paid price (ISO-like 3 capitals before a digit).
    assert.equal(sp.isPaidApp(w('Install · API 34')), true);
});

await wait(0);

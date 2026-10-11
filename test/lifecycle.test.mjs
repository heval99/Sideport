// Lifecycle, navigation stress and state tests in jsdom. jsdom has no layout, so visibility-based mount
// escalation (hasLayout() === false) is not exercised here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, wait, navigate, detailsPage, widgetHtml, createStore, json, SCRIPT_PATH } from './harness.mjs';
import { readFileSync } from 'node:fs';
const t0css = () => readFileSync(SCRIPT_PATH, 'utf8');

const isMorphe = url => /morphe|patches-list/.test(url);
const emptyMorphe = { status: 200, text: '{"bundles":[],"patches":[]}', headers: 'etag: "E"\r\n' };
const fdroidOk = pkg => json({ packageName: pkg, suggestedVersionCode: 3, packages: [{ versionName: '1.0', versionCode: 3 }] });

function counters(window) {
    const count = { add: 0, remove: 0, observers: 0 };
    for (const target of [window, window.document]) {
        const add = target.addEventListener.bind(target);
        const remove = target.removeEventListener.bind(target);
        target.addEventListener = (...args) => { count.add += 1; return add(...args); };
        target.removeEventListener = (...args) => { count.remove += 1; return remove(...args); };
    }
    const MO = window.MutationObserver;
    window.MutationObserver = class extends MO { constructor(cb) { super(cb); count.observers += 1; } };
    return count;
}

test('navigation stress: 50 app switches with checks pending → 1 mount, 1 menu, nothing in flight, listeners flat', async () => {
    let count;
    const t = await boot({ route: d => (isMorphe(d.url) ? emptyMorphe : 'hang'), beforeEval: w => { count = counters(w); } });
    await wait(300);
    const baseline = { ...count };
    for (let i = 0; i < 50; i += 1) {
        navigate(t.window, `com.app.n${i}`, `App ${i}`);
        await wait(170);
        t.sp.openMenu('sources', false);
        await wait(5);
    }
    const doc = t.document;
    const result = {
        mounts: doc.querySelectorAll('.pas-mount').length, menus: doc.querySelectorAll('.pas-menu').length,
        inflight: t.sp.inflightRequests.size, queue: t.sp.probeQueue.length, active: t.sp.activeProbes(),
        loadingOld: [...t.sp.probeCache].filter(([k, e]) => !k.startsWith('com.app.n49|') && e.result.state === 'loading').length,
        abortedRequests: t.requests.filter(r => r.aborted).length, totalRequests: t.requests.length,
        netListeners: (count.add - count.remove) - (baseline.add - baseline.remove), observers: count.observers
    };
    console.log('#', JSON.stringify(result));
    assert.equal(result.mounts, 1);
    assert.equal(result.menus, 1);
    assert.equal(result.loadingOld, 0);
    assert.equal(result.observers, 2); // page changes + theme attributes; constant, created once
    assert.ok(result.netListeners <= 2, `listener growth ${result.netListeners}`); // the open menu's scroll+resize
    assert.ok(result.inflight <= 8 && result.active <= 8);
    t.window.close();
});

test('out-of-order: a late reply for app A (manager without abort) never reaches app B', async () => {
    const t = await boot({
        url: 'https://play.google.com/store/apps/details?id=com.app.a', html: detailsPage('com.app.a', 'A'),
        route: d => {
            if (isMorphe(d.url)) return emptyMorphe;
            if (d.url.includes('f-droid.org/api') && d.url.includes('com.app.a')) return { ...fdroidOk('com.app.a'), delay: 400, ignoreAbort: true };
            if (d.url.includes('f-droid.org/api')) return { status: 404 };
            return { status: 404 };
        }
    });
    await wait(100);
    t.sp.openMenu('sources', false);
    await wait(20);
    navigate(t.window, 'com.app.b', 'B');
    await wait(200);
    t.sp.openMenu('sources', false);
    await wait(500);
    const row = t.document.querySelector('.pas-item[data-id="fdroid"] .pas-row-sub').textContent;
    const aEntry = t.sp.probeCache.get('com.app.a|fdroid');
    console.log('# B fdroid row:', row, '| A cache entry:', JSON.stringify(aEntry?.result || null));
    assert.equal(row, 'Not found on this source');
    assert.equal(t.document.querySelector('.pas-title').textContent, 'B');
    t.window.close();
});

test('back/forward: returning to A reuses A\'s finished results without new requests', async () => {
    const t = await boot({
        url: 'https://play.google.com/store/apps/details?id=com.app.a', html: detailsPage('com.app.a', 'A'),
        route: d => (isMorphe(d.url) ? emptyMorphe : d.url.includes('f-droid.org/api') ? fdroidOk('com.app.a') : { status: 404 })
    });
    await wait(100);
    t.sp.openMenu('sources', false);
    await wait(300);
    navigate(t.window, 'com.app.b', 'B');
    await wait(400);
    const before = t.requests.length;
    navigate(t.window, 'com.app.a', 'A'); // return to A (jsdom's async history.back() races pushState, so the return is simulated)
    await wait(500);
    t.sp.openMenu('sources', false);
    await wait(100);
    const fdroidRequests = t.requests.slice(before).filter(r => r.details.url.includes('f-droid.org/api/v1/packages/com.app.a')).length;
    assert.equal(fdroidRequests, 0);
    assert.match(t.document.querySelector('.pas-item[data-id="fdroid"] .pas-row-sub').textContent, /^Available/);
    t.window.close();
});

test('FIXED SP-20: running the script twice in one page still gives one button', async () => {
    const t = await boot({ route: d => (isMorphe(d.url) ? emptyMorphe : { status: 404 }) });
    t.window.eval(t.harness.code);
    await wait(400);
    assert.equal(t.document.querySelectorAll('.pas-main').length, 1);
    assert.equal(t.document.querySelectorAll('.pas-mount').length, 1);
    navigate(t.window, 'com.other.app', 'Other');
    await wait(400);
    assert.equal(t.document.querySelectorAll('.pas-main').length, 1, 'still one after navigation');
    t.window.close();
});

test('FIXED SP-09: a late install widget moves the button inline and its price is used', async () => {
    const t = await boot({ replace: [['const SETTLE_MS = 2500;', 'const SETTLE_MS = 200;']], html: detailsPage('com.example.app', 'Paid App', { widget: false }), route: d => (isMorphe(d.url) ? emptyMorphe : { status: 404 }) });
    await wait(1200);
    assert.match(t.document.querySelector('.pas-mount').className, /pas-after-heading/);
    t.document.querySelector('.row').innerHTML = widgetHtml('com.example.app', '€4.99');
    await wait(400);
    const mounts = t.document.querySelectorAll('.pas-mount');
    assert.equal(mounts.length, 1);
    assert.match(mounts[0].className, /pas-inline/);
    t.sp.openMenu('sources', false);
    const paidNote = [...t.document.querySelectorAll('.pas-note')].some(n => /paid app/.test(n.textContent));
    assert.equal(paidNote, true);
    assert.equal(Boolean(t.document.querySelector('.pas-item[data-id="apkpure"]')), false);
    t.window.close();
});

test('SP-09 guard: no move while the menu is open; it moves once after the menu closes', async () => {
    const t = await boot({ replace: [['const SETTLE_MS = 2500;', 'const SETTLE_MS = 200;']], html: detailsPage('com.example.app', 'App', { widget: false }), route: d => (isMorphe(d.url) ? emptyMorphe : { status: 404 }) });
    await wait(1200);
    t.sp.openMenu('sources', false);
    t.document.querySelector('.row').innerHTML = widgetHtml('com.example.app');
    await wait(400);
    assert.match(t.document.querySelector('.pas-mount').className, /pas-after-heading/);
    assert.equal(t.sp.state.menu.open, true);
    t.sp.closeMenu(false);
    t.document.body.append(t.document.createElement('span')); // any DOM change triggers a render
    await wait(400);
    assert.match(t.document.querySelector('.pas-mount').className, /pas-inline/);
    assert.equal(t.sp.state.upgradedFallback, true);
    t.window.close();
});

test('SP-09 guard: a late paid widget is seen on menu open even when the move is used up', async () => {
    const t = await boot({ replace: [['const SETTLE_MS = 2500;', 'const SETTLE_MS = 200;']], html: detailsPage('com.example.app', 'Paid', { widget: false }), route: d => (isMorphe(d.url) ? emptyMorphe : { status: 404 }) });
    await wait(1200);
    t.sp.state.upgradedFallback = true;
    t.document.querySelector('.row').innerHTML = widgetHtml('com.example.app', '€4.99');
    t.sp.openMenu('sources', false);
    assert.equal(t.sp.state.mount.ctx.isFree, false);
    t.window.close();
});

test('control: with the widget present at load, the same €4.99 button is detected as paid', async () => {
    const t = await boot({ html: detailsPage('com.example.app', 'Paid App').replace('>Install<', '>€4.99<'), route: d => (isMorphe(d.url) ? emptyMorphe : { status: 404 }) });
    await wait(100);
    t.sp.openMenu('sources', false);
    assert.equal(Boolean(t.document.querySelector('.pas-item[data-id="apkpure"]')), false);
    t.window.close();
});

test('FIXED SP-15: after dismissing the banner, "Open APK sources" brings it back and opens the menu', async () => {
    const html = '<!doctype html><html><head><title>X</title></head><body><main></main></body></html>';
    const t = await boot({ fast: true, html, route: d => (isMorphe(d.url) ? emptyMorphe : { status: 404 }) });
    await wait(1200);
    assert.ok(t.document.querySelector('.pas-banner'));
    t.document.querySelector('.pas-banner .pas-icon-btn').click();
    assert.equal(t.document.querySelector('.pas-banner'), null);
    await wait(300);
    assert.equal(t.document.querySelector('.pas-banner'), null, 'stays dismissed on its own');
    t.commands.get('Open APK sources')();
    assert.ok(t.document.querySelector('.pas-banner'));
    assert.equal(t.sp.state.menu.open, true);
    t.window.close();
});

test('SP-15 guard: "Copy package ID" still works after dismissing the banner', async () => {
    const html = '<!doctype html><html><head><title>X</title></head><body><main></main></body></html>';
    const t = await boot({ fast: true, html, route: d => (isMorphe(d.url) ? emptyMorphe : { status: 404 }) });
    await wait(1200);
    t.document.querySelector('.pas-banner .pas-icon-btn').click();
    let copied = null;
    t.window.GM.setClipboard = async text => { copied = text; };
    await t.commands.get('Copy package ID')();
    assert.equal(copied, 'com.example.app');
    t.window.close();
});

test('FIXED N1: "Open APK sources" while the button is scrolled away scrolls it into view and stays open', async () => {
    const t = await boot({ route: d => (isMorphe(d.url) ? emptyMorphe : { status: 404 }) });
    const anchor = t.sp.state.mount.anchor;
    let scrolled = false;
    anchor.scrollIntoView = () => { scrolled = true; };
    anchor.getBoundingClientRect = () => (scrolled
        ? { top: 300, bottom: 336, left: 20, right: 140, width: 120, height: 36 }
        : { top: -300, bottom: -264, left: 20, right: 140, width: 120, height: 36 });
    t.commands.get('Open APK sources')();
    assert.equal(scrolled, true);
    assert.equal(t.sp.state.menu.open, true);
    t.window.close();
});

test('N1 guard: opening with the button on screen does not scroll the page', async () => {
    const t = await boot({ route: d => (isMorphe(d.url) ? emptyMorphe : { status: 404 }) });
    const anchor = t.sp.state.mount.anchor;
    let scrolled = false;
    anchor.scrollIntoView = () => { scrolled = true; };
    anchor.getBoundingClientRect = () => ({ top: 300, bottom: 336, left: 20, right: 140, width: 120, height: 36 });
    anchor.click();
    assert.equal(scrolled, false);
    assert.equal(t.sp.state.menu.open, true);
    t.window.close();
});

test('FIXED SP-21: a search page with no top result stops scanning after giving up, until the route changes', async () => {
    let scans = 0;
    const html = '<!doctype html><html><head><title>q</title></head><body><main><div id="list"></div></main></body></html>';
    const t = await boot({
        fast: true, url: 'https://play.google.com/store/search?q=maps&c=apps', html, route: d => (isMorphe(d.url) ? emptyMorphe : { status: 404 }),
        beforeEval: w => { const qsa = w.document.querySelectorAll.bind(w.document); w.document.querySelectorAll = sel => { if (String(sel).includes('%.@.')) scans += 1; return qsa(sel); }; }
    });
    await wait(900);
    const before = scans;
    for (let i = 0; i < 10; i += 1) { t.document.getElementById('list').append(t.document.createElement('div')); await wait(200); }
    assert.ok(scans - before <= 1, `${scans - before} scans`); // only the tick that decides to give up
    // A new search (route change) looks again and finds its top result.
    t.window.history.pushState({}, '', '/store/search?q=spotify&c=apps');
    t.document.getElementById('list').innerHTML = widgetHtml('com.spotify.music');
    await wait(400);
    assert.equal(t.document.querySelectorAll('.pas-mount').length, 1);
    t.window.close();
});

test('FIXED SP-11: settings changed in two tabs are both kept', async () => {
    const store = createStore();
    const a = await boot({ store, route: d => (isMorphe(d.url) ? emptyMorphe : { status: 404 }) });
    const b = await boot({ store, route: d => (isMorphe(d.url) ? emptyMorphe : { status: 404 }) });
    a.sp.saveSettings(s => { s.sources.apkpure = false; });
    await wait(20);
    b.sp.saveSettings(s => { s.showMods = true; });
    await wait(20);
    const saved = store.get('sideport-settings-v1');
    assert.equal(saved.sources.apkpure, false);
    assert.equal(saved.showMods, true);
    assert.equal(a.sp.getSettings().sources.apkpure, false, 'tab A sees its own change at once');
    a.window.close(); b.window.close();
});

test('SP-11 guard: quick toggles in one tab are all saved, and Reset writes the defaults', async () => {
    const store = createStore();
    const t = await boot({ store, route: d => (isMorphe(d.url) ? emptyMorphe : { status: 404 }) });
    t.sp.saveSettings(s => { s.showMods = true; });
    t.sp.saveSettings(s => { s.autoCheck = false; });
    t.sp.saveSettings(s => { s.sources.uptodown = false; });
    await wait(50);
    let saved = store.get('sideport-settings-v1');
    assert.deepEqual([saved.showMods, saved.autoCheck, saved.sources.uptodown], [true, false, false]);
    t.sp.setSettings(JSON.parse(JSON.stringify(saved)));
    t.sp.openMenu('settings', false);
    [...t.document.querySelectorAll('.pas-footer .pas-text-btn')].find(b => b.textContent === 'Reset').click();
    await wait(50);
    saved = store.get('sideport-settings-v1');
    assert.deepEqual([saved.showMods, saved.autoCheck, saved.sources.uptodown], [false, true, true]);
    t.window.close();
});

test('settings switches in the menu save through the merge path', async () => {
    const store = createStore();
    const t = await boot({ store, route: d => (isMorphe(d.url) ? emptyMorphe : { status: 404 }) });
    store.set('sideport-settings-v1', { ...t.sp.getSettings(), showPatches: false }); // another tab turned patches off
    t.sp.openMenu('settings', false);
    const modsSwitch = [...t.document.querySelectorAll('.pas-switch')].find(l => l.textContent.startsWith('Show modded APK sites')).querySelector('input');
    modsSwitch.click();
    await wait(50);
    const saved = store.get('sideport-settings-v1');
    assert.equal(saved.showMods, true);
    assert.equal(saved.showPatches, false, "the other tab's change survives");
    t.window.close();
});

test('FIXED SP-12: without a GM object the script still starts and mounts, with no unhandled error', async () => {
    const { execFileSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const out = execFileSync(process.execPath, [fileURLToPath(new URL('./helpers/no-gm.mjs', import.meta.url))], { encoding: 'utf8' });
    const result = JSON.parse(out.trim().split(/\r?\n/).pop());
    console.log('#', JSON.stringify(result));
    assert.deepEqual(result.rejections, []);
    assert.equal(result.mounts, 1);
});

test('FIXED SP-14: crossing 400 cache entries drops old answers, never a running check', async () => {
    const t = await boot({ route: d => (isMorphe(d.url) ? emptyMorphe : 'hang') });
    for (let i = 0; i < 400; i += 1) t.sp.probeCache.set(`com.old.p${i}|x`, { result: { state: 'ok' }, sessionId: 0, settledAt: Date.now() });
    t.sp.openMenu('sources', false);
    await wait(20);
    const ctx = t.sp.state.mount.ctx;
    assert.equal(t.sp.probeCache.has('com.example.app|apkpure'), true);
    assert.ok(t.sp.probeCache.size <= 400, `size ${t.sp.probeCache.size}`);
    assert.equal(t.sp.probeCache.has('com.old.p0|x'), false, 'oldest answer dropped');
    const queuedBefore = t.sp.probeQueue.length;
    t.sp.getProbe(ctx, t.sp.SOURCE_BY_ID.get('apkpure')).catch(() => {});
    assert.equal(t.sp.probeQueue.length, queuedBefore, 'no second check for the same source');
    t.window.close();
});

test('SP-14 guard: a cache full of running checks may grow past the limit rather than drop one', async () => {
    const t = await boot({ route: d => (isMorphe(d.url) ? emptyMorphe : 'hang') });
    for (let i = 0; i < 400; i += 1) t.sp.probeCache.set(`com.old.p${i}|x`, { result: { state: 'loading' }, sessionId: t.sp.state.sessionId, settledAt: 0 });
    t.sp.openMenu('sources', false);
    await wait(20);
    assert.ok(t.sp.probeCache.size > 400);
    assert.equal(t.sp.probeCache.has('com.old.p0|x'), true);
    t.window.close();
});

test('FIXED SP-05: after the site recovers, reopening the menu re-checks (no Re-check needed)', async () => {
    let blocked = true;
    const t = await boot({
        route: d => {
            if (isMorphe(d.url)) return emptyMorphe;
            if (d.url.includes('f-droid.org/api')) return blocked ? { status: 403, text: '<title>Just a moment...</title>' } : fdroidOk('com.example.app');
            return { status: 404 };
        }
    });
    t.sp.openMenu('sources', false);
    await wait(100);
    const first = t.document.querySelector('.pas-item[data-id="fdroid"] .pas-row-sub').textContent;
    blocked = false;
    t.sp.closeMenu(false);
    t.sp.openMenu('sources', false);
    await wait(100);
    const second = t.document.querySelector('.pas-item[data-id="fdroid"] .pas-row-sub').textContent;
    assert.match(first, /Cloudflare/);
    assert.match(second, /^Available/);
    t.window.close();
});

test('SP-05 guard: reopening does not re-request results that are still valid', async () => {
    const t = await boot({ route: d => (isMorphe(d.url) ? emptyMorphe : d.url.includes('f-droid.org/api') ? fdroidOk('com.example.app') : { status: 404 }) });
    t.sp.openMenu('sources', false);
    await wait(150);
    t.sp.closeMenu(false);
    const before = t.requests.length;
    t.sp.openMenu('sources', false);
    await wait(150);
    assert.equal(t.requests.length - before, 0);
    t.window.close();
});

test('FIXED N3: a download re-fetches file links older than 10 minutes', async () => {
    let path = 'https://pool.apk.aptoide.com/x/first-signed-url.apk';
    const t = await boot({
        route: d => {
            if (isMorphe(d.url)) return emptyMorphe;
            if (d.url.includes('web-api.aptoide.com')) return json({ datalist: { list: [{ package: 'com.example.app', file: { vername: '1.0', path, malware: { rank: 'TRUSTED' } } }] } });
            return { status: 404 };
        }
    });
    t.sp.openMenu('sources', false);
    await wait(100);
    path = 'https://pool.apk.aptoide.com/x/fresh-signed-url.apk';
    t.sp.probeCache.get('com.example.app|aptoide').settledAt -= 11 * 60e3;
    await t.sp.startDownload(t.sp.SOURCE_BY_ID.get('aptoide'), t.sp.state.mount.ctx);
    assert.ok(t.harness.opened.includes('https://pool.apk.aptoide.com/x/fresh-signed-url.apk'));
    assert.ok(!t.harness.opened.includes('https://pool.apk.aptoide.com/x/first-signed-url.apk'));
    t.window.close();
});

test('N3 guard: a download right after the check reuses it (no extra request)', async () => {
    const t = await boot({
        route: d => (isMorphe(d.url) ? emptyMorphe
            : d.url.includes('web-api.aptoide.com') ? json({ datalist: { list: [{ package: 'com.example.app', file: { vername: '1.0', path: 'https://pool.apk.aptoide.com/x/a.apk', malware: { rank: 'TRUSTED' } } }] } })
            : { status: 404 })
    });
    t.sp.openMenu('sources', false);
    await wait(100);
    const before = t.requests.length;
    await t.sp.startDownload(t.sp.SOURCE_BY_ID.get('aptoide'), t.sp.state.mount.ctx);
    assert.equal(t.requests.length - before, 0);
    assert.ok(t.harness.opened.includes('https://pool.apk.aptoide.com/x/a.apk'));
    t.window.close();
});

test('FIXED N2: price data left in <head> by the previous app no longer marks the next app as paid', async () => {
    const html = detailsPage('com.paid.app', 'Paid', { price: '4.99' });
    const t = await boot({ url: 'https://play.google.com/store/apps/details?id=com.paid.app', html, route: d => (isMorphe(d.url) ? emptyMorphe : { status: 404 }) });
    await wait(100);
    t.sp.openMenu('sources', false);
    assert.equal(t.sp.state.mount.ctx.isFree, false, 'the paid app itself is still paid');
    t.sp.closeMenu(false);
    navigate(t.window, 'com.free.app', 'Free'); // replaces <main> only; the paid app's ld+json stays in <head>
    await wait(300);
    t.sp.openMenu('sources', false);
    const paidNote = [...t.document.querySelectorAll('.pas-note')].some(n => /paid app/.test(n.textContent));
    assert.equal(paidNote, false);
    assert.equal(t.sp.state.mount.ctx.isFree, true);
    t.window.close();
});

test('N2 guard: leftover structured data without a url still fails closed (treated as paid)', async () => {
    const html = detailsPage('com.paid.app', 'Paid', { price: '4.99', ldUrl: false });
    const t = await boot({ url: 'https://play.google.com/store/apps/details?id=com.paid.app', html, route: d => (isMorphe(d.url) ? emptyMorphe : { status: 404 }) });
    await wait(100);
    navigate(t.window, 'com.free.app', 'Free');
    await wait(300);
    t.sp.openMenu('sources', false);
    assert.equal(t.sp.state.mount.ctx.isFree, false);
    t.window.close();
});

test('SP-23: after the checks finish, one screen-reader summary is announced', async () => {
    const t = await boot({ route: d => (isMorphe(d.url) ? emptyMorphe : d.url.includes('f-droid.org/api') ? fdroidOk('com.example.app') : d.url.includes('apkpure') ? { status: 500 } : { status: 404 }) });
    t.sp.openMenu('sources', false);
    await wait(200);
    const live = t.document.querySelector('.pas-menu [role="status"]');
    assert.equal(live.textContent, 'Availability checked: 1 available, 5 not found, 2 couldn’t be checked.');
    t.window.close();
});

test('SP-23 guard: no announcement when the menu closed before the checks finished', async () => {
    const t = await boot({ route: d => (isMorphe(d.url) ? emptyMorphe : { status: 404, delay: 100 }) });
    t.sp.openMenu('sources', false);
    t.sp.closeMenu(false);
    await wait(300);
    assert.equal(t.document.querySelector('.pas-menu [role="status"]').textContent, '');
    t.window.close();
});

test('SP-25: on a right-to-left page the menu lines up with the button\'s right edge', async () => {
    const t = await boot({ html: detailsPage('com.example.app', 'App').replace('<html>', '<html dir="rtl">'), route: d => (isMorphe(d.url) ? emptyMorphe : { status: 404 }) });
    t.sp.state.mount.anchor.getBoundingClientRect = () => ({ top: 100, bottom: 136, left: 600, right: 720, width: 120, height: 36 });
    Object.defineProperty(t.document.documentElement, 'clientWidth', { value: 1000, configurable: true });
    t.sp.openMenu('sources', false);
    assert.equal(t.sp.state.menu.rtl, true);
    assert.equal(t.sp.state.menu.root.style.left, '360px'); // right edge 720 - menu width 360
    t.window.close();
});

test('SP-22: Morphe chip and badge use the darker teal behind white text', () => {
    const css = t0css();
    assert.ok(css.includes('#007F7E'));
    assert.ok(!/pas-item\.is-missing \.pas-row-label[^}]*opacity/.test(css), 'missing rows no longer fade their text');
});

test('menu open/close 50 times leaves no listeners behind', async () => {
    let count;
    const t = await boot({ route: d => (isMorphe(d.url) ? emptyMorphe : { status: 404 }), beforeEval: w => { count = counters(w); } });
    await wait(100);
    const base = count.add - count.remove;
    for (let i = 0; i < 50; i += 1) { t.sp.state.mount.anchor.click(); t.sp.state.mount.anchor.click(); }
    assert.equal(count.add - count.remove, base);
    assert.equal(t.document.querySelectorAll('.pas-menu').length, 1);
    t.window.close();
});

await wait(0);

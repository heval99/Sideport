// UI behaviour found in the real-browser audit (SIDEPORT_UX_ACCESSIBILITY_AUDIT.md). jsdom has no layout, so a small
// stub makes elements inside [data-hidden] report no boxes, the way Play's kept-but-hidden previous page does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boot, wait, SCRIPT_PATH } from './harness.mjs';

const isMorphe = url => /morphe|patches-list/.test(url);
const route = d => (isMorphe(d.url) ? { status: 200, text: '{"bundles":[],"patches":[]}' } : { status: 404 });
const CSS = readFileSync(SCRIPT_PATH, 'utf8');

function withLayout(window) {
    window.Element.prototype.getClientRects = function () { return this.closest('[data-hidden]') ? [] : [{ width: 10, height: 10 }]; };
    window.document.documentElement.getBoundingClientRect = () => ({ top: 0, left: 0, right: 1200, bottom: 800, width: 1200, height: 800 });
}

test('UX-01: the button reset has zero specificity, so component styles win', () => {
    assert.match(CSS, /:where\(\.pas-root\) button, :where\(\.pas-root\) input \{ font: inherit; color: inherit; \}/);
    assert.doesNotMatch(CSS, /^\s*\.pas-root button, \.pas-root input/m);
});

test('UX-01: buttons cancel Play\'s global button { min-height: 40px }', () => {
    for (const selector of ['.pas-main {', '.pas-chip {', '.pas-icon-btn {', '.pas-text-btn {']) {
        const start = CSS.indexOf(`            ${selector}`);
        const rule = CSS.slice(start, CSS.indexOf('}', start));
        assert.match(rule, /min-height: 0/, selector);
    }
});

test('UX-02: after in-app navigation the menu names the shown app, not Play\'s hidden previous page', async () => {
    const html = `<!doctype html><html><head><title>Minecraft Education - Apps on Google Play</title></head><body>
        <div data-hidden><h1>Minecraft: Dream it, Build it!</h1><div data-item-id='%.@."com.mojang.minecraftpe",7]'><button>59,00 kr. Buy</button></div></div>
        <div><h1>Minecraft Education</h1><div class="row"><div data-item-id='%.@."com.mojang.minecraftedu",7]'><button>Install</button></div></div></div>
        <main></main></body></html>`;
    const t = await boot({ url: 'https://play.google.com/store/apps/details?id=com.mojang.minecraftedu', html, route, beforeEval: withLayout });
    t.sp.openMenu('sources', false);
    assert.equal(t.document.querySelector('.pas-title').textContent, 'Minecraft Education');
    assert.equal(t.sp.state.mount.ctx.isFree, true, 'the hidden paid widget of the previous app is ignored');
    t.window.close();
});

test('UX-02: on a search page the menu names the top result, not the search query', async () => {
    const html = `<!doctype html><html><head><title>spotify - Android Apps on Google Play</title></head><body><main><section><div>
        <div><div>Spotify: Music and Podcasts</div><div>Spotify AB</div></div>
        <c-wiz><div data-item-id='%.@."com.spotify.music",7]'><button>Install</button></div></c-wiz>
        </div></section></main></body></html>`;
    const t = await boot({ url: 'https://play.google.com/store/search?q=spotify&c=apps', html, route, beforeEval: withLayout });
    t.sp.openMenu('sources', false);
    assert.equal(t.document.querySelector('.pas-title').textContent, 'Spotify: Music and Podcasts');
    assert.equal(t.document.querySelector('.pas-pkg').textContent, 'com.spotify.music');
    t.window.close();
});

test('UX-02: a details page with no heading yet falls back to the page title, then the package', async () => {
    const html = `<!doctype html><html><head><title>Some App - Apps on Google Play</title></head><body><main><div class="row">
        <div data-item-id='%.@."com.some.app",7]'><button>Install</button></div></div></main></body></html>`;
    const t = await boot({ url: 'https://play.google.com/store/apps/details?id=com.some.app', html, route, beforeEval: withLayout });
    t.sp.openMenu('sources', false);
    assert.equal(t.document.querySelector('.pas-title').textContent, 'Some App');
    t.window.close();
});

test('UX-06: the heading fallback attaches to the shown <h1>, never the hidden previous one', async () => {
    const html = `<!doctype html><html><head><title>B - Apps on Google Play</title></head><body>
        <div data-hidden><h1 id="old">A</h1></div><div><h1 id="current">B</h1></div><main></main></body></html>`;
    const t = await boot({
        url: 'https://play.google.com/store/apps/details?id=com.b.app', html, route, beforeEval: withLayout,
        replace: [['const SETTLE_MS = 2500;', 'const SETTLE_MS = 200;']]
    });
    await wait(1200);
    const mount = t.document.querySelector('.pas-mount');
    assert.match(mount.className, /pas-after-heading/);
    assert.equal(mount.previousElementSibling.id, 'current');
    t.window.close();
});

const json = (value, status = 200) => ({ status, text: JSON.stringify(value) });
const fdroidOk = { status: 200, text: JSON.stringify({ packageName: 'com.example.app', suggestedVersionCode: 3, packages: [{ versionName: '1.0', versionCode: 3 }] }) };

test('UX-03: row status can wrap to two lines and the full text is in the row tooltip', async () => {
    assert.match(CSS, /\.pas-row \.pas-row-sub \{[^}]*-webkit-line-clamp: 2[^}]*white-space: normal/);
    const t = await boot({ route: d => (isMorphe(d.url) ? route(d) : d.url.includes('apt.izzysoft.de/fdroid/api') ? { status: 503, text: '<title>Just a moment...</title>' } : { status: 404 }) });
    t.sp.openMenu('sources', false);
    await wait(100);
    assert.equal(t.document.querySelector('.pas-item[data-id="izzy"] .pas-row').title, 'IzzyOnDroid · Couldn’t check · Cloudflare check — open the site');
    assert.match(t.document.querySelector('.pas-item[data-id="apkmirror"] .pas-row').title, /^APKMirror · /);
    t.window.close();
});

test('UX-04: the filter ignores case, spaces and punctuation ("fdroid" finds F-Droid)', async () => {
    const t = await boot({ route });
    t.sp.openMenu('sources', false);
    const filter = t.document.querySelector('.pas-filter');
    const visible = () => [...t.document.querySelectorAll('.pas-menu .pas-item')].filter(i => !i.hidden && !i.closest('[hidden]')).map(i => i.dataset.id);
    for (const [query, expected] of [['fdroid', 'fdroid'], ['F-DROID', 'fdroid'], ['apk pure', 'apkpure'], ['izzy on droid', 'izzy']]) {
        filter.value = query;
        filter.dispatchEvent(new t.window.Event('input'));
        assert.ok(visible().includes(expected), `${query} → ${visible()}`);
    }
    t.window.close();
});

test('UX-04: the filter result is announced once typing pauses', async () => {
    const t = await boot({ route });
    t.sp.openMenu('sources', false);
    const filter = t.document.querySelector('.pas-filter');
    const live = t.document.querySelector('.pas-menu [role="status"]');
    filter.value = 'zzz';
    filter.dispatchEvent(new t.window.Event('input'));
    await wait(700);
    assert.equal(live.textContent, 'No sources match your filter.');
    filter.value = 'apkpure';
    filter.dispatchEvent(new t.window.Event('input'));
    await wait(700);
    assert.equal(live.textContent, '2 sources match your filter.');
    t.window.close();
});

test('UX-05: badges are hidden from screen readers; "not found" rows have no Download badge', async () => {
    const t = await boot({ route: d => (isMorphe(d.url) ? route(d) : d.url.includes('f-droid.org/api') ? fdroidOk : { status: 404 }) });
    t.sp.openMenu('sources', false);
    await wait(150);
    for (const badge of t.document.querySelectorAll('.pas-menu .pas-badge')) assert.equal(badge.getAttribute('aria-hidden'), 'true');
    assert.equal(t.document.querySelector('.pas-item[data-id="fdroid"] .pas-badge')?.textContent, 'Download');
    assert.equal(t.document.querySelector('.pas-item[data-id="izzy"] .pas-badge'), null, 'missing row has no badge');
    t.window.close();
});

test('UX-07: Reset asks first; a single click changes nothing and the question times out', async () => {
    const t = await boot({ route, replace: [['const RESET_CONFIRM_MS = 4000;', 'const RESET_CONFIRM_MS = 300;']] });
    t.sp.saveSettings(s => { s.showMods = true; });
    t.sp.openMenu('settings', false);
    const reset = () => [...t.document.querySelectorAll('.pas-footer .pas-text-btn')].find(b => /^Reset/.test(b.textContent));
    reset().click();
    assert.equal(reset().textContent, 'Reset all settings?');
    await wait(50);
    assert.equal(t.sp.getSettings().showMods, true, 'one click resets nothing');
    await wait(400);
    assert.equal(reset().textContent, 'Reset', 'the question times out');
    reset().click();
    reset().click();
    await wait(50);
    assert.equal(t.sp.getSettings().showMods, false);
    t.window.close();
});

test('UX-08: the banner says "doesn\'t list" on Play\'s Not Found page, "isn\'t available here" otherwise', async () => {
    for (const [title, expected] of [['Not Found', 'Google Play doesn’t list this app. You can still look for its APK.'], ['X', 'This app isn’t available on Google Play here. You can still look for the APK.']]) {
        const html = `<!doctype html><html><head><title>${title}</title></head><body><main></main></body></html>`;
        const t = await boot({ fast: true, html, route });
        await wait(1200);
        assert.equal(t.document.querySelector('.pas-banner-text')?.textContent, expected, title);
        t.window.close();
    }
});

test('copy: Re-check tooltip contains its visible label; parse failures read plainly', async () => {
    const t = await boot({ route });
    t.sp.openMenu('sources', false);
    const recheck = [...t.document.querySelectorAll('.pas-footer .pas-text-btn')].find(b => b.textContent === 'Re-check');
    assert.ok(recheck.title.includes('Re-check'));
    assert.doesNotMatch(CSS, /Unrecognised page/);
    t.window.close();
});

test('UX-09: direct rows announce the → shortcut to their "Open … website" link', async () => {
    const t = await boot({ route });
    t.sp.openMenu('sources', false);
    const row = t.document.querySelector('.pas-item[data-id="apkpure"] .pas-row');
    assert.equal(row.getAttribute('aria-keyshortcuts'), 'ArrowRight');
    t.window.close();
});

test('UX-10: left-to-right pages are not shifted by the scrollbar correction', async () => {
    const t = await boot({ route });
    t.sp.state.mount.anchor.getBoundingClientRect = () => ({ top: 100, bottom: 136, left: 300, right: 420, width: 120, height: 36 });
    Object.defineProperty(t.document.documentElement, 'clientWidth', { value: 1000, configurable: true });
    Object.defineProperty(t.window, 'innerWidth', { value: 1015, configurable: true });
    t.sp.openMenu('sources', false);
    assert.equal(t.sp.state.menu.root.style.left, '300px');
    t.window.close();
});

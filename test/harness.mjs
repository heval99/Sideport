// Test harness: loads an instrumented in-memory copy of sideport.user.js into jsdom with a mocked GM API.
// The script file is only read, never written; the copy gets one extra line that exposes internals as window.__sp.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

export const SCRIPT_PATH = fileURLToPath(new URL('../sideport.user.js', import.meta.url));
const SOURCE = readFileSync(SCRIPT_PATH, 'utf8');

const EXPOSE = `state, probeCache, probeQueue, inflightRequests, recentFailures, getProbe, isReusable, runProbes, startDownload,
    openMenu, closeMenu, renderForCurrentPage, tryMount, teardown, gmFetch, expectSuccess, toPackageId, latestVersions,
    countPatchesByPackage, buildCommunityIndex, buildOfficialIndex, getPatchIndex, refreshPatchIndex, patchInfo, patchSources,
    isPaidApp, readAppName, listApkComboVariants, versionFromFileName, positionMenu, SOURCES, SOURCE_BY_ID, getCachedProbe,
    recheckSources, el, morpheAppUrl, renderSourcesView, saveSettings, loadSettings, fetchPatchIndex, probeApkPure,
    getSettings: () => settings, setSettings: value => { settings = value; }, getPatchIndexVar: () => patchIndex,
    setPatchIndex: value => { patchIndex = value; }, activeProbes: () => activeProbes, findActionWidget, applyTheme,
    isAllowedHost, renderPatchChip, scanRepoPage, parseRepoPage, updateRow, ensureMenu, attachPatchChip, readCachedPatchIndex, fetchIndexPart, patchStatusText, onPatchIndexUpdated`;

function instrument(source, { fast = false, exportHook = true, count = [], replace = [] } = {}) {
    let code = source;
    for (const [from, to] of replace) { if (!code.includes(from)) throw new Error(`replace target missing: ${from}`); code = code.replace(from, to); }
    for (const name of count) {
        const before = code;
        code = code.replace(new RegExp(String.raw`(function ${name}\([^)]*\)\s*\{)`), `$1 window.__perf.${name} = (window.__perf.${name} || 0) + 1;`);
        if (code === before) throw new Error(`counter injection failed for ${name}`);
    }
    if (fast) {
        code = code.replace('const SETTLE_MS = 2500;', 'const SETTLE_MS = 200;')
            .replace('const GIVE_UP_MS = 20000;', 'const GIVE_UP_MS = 600;');
    }
    if (exportHook) {
        const end = code.lastIndexOf('})();');
        code = `${code.slice(0, end)}    window.__sp = { ${EXPOSE} };\n${code.slice(end)}`;
    }
    return code;
}

export function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** In-memory GM storage shared between "tabs" when the same store object is passed. */
export function createStore() {
    return new Map();
}

/**
 * Creates a fake Play page and runs Sideport in it.
 * route(details) → { status, headers, text, finalUrl, delay } | { error } | { timeout } | 'hang'
 */
export async function boot({ url = 'https://play.google.com/store/apps/details?id=com.example.app', html, store = createStore(),
    route = () => ({ status: 404, text: '' }), fast = false, withGM = true, exportHook = true, settle = 300, beforeEval = null, count = [], replace = [] } = {}) {
    const dom = new JSDOM(html ?? detailsPage('com.example.app', 'Example App'), { url, runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    window.Element.prototype.scrollIntoView = function () {};
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    const requests = [];
    const errors = [];
    window.addEventListener('error', event => errors.push(event.error || event.message));
    window.addEventListener('unhandledrejection', event => errors.push(event.reason));
    const commands = new Map();
    const harness = { route, store };
    if (withGM) {
        window.GM = {
            info: { script: { version: 'test' }, scriptHandler: 'Harness', version: '1' },
            getValue: async (key, fallback) => (store.has(key) ? structuredClone(store.get(key)) : fallback),
            setValue: async (key, value) => { store.set(key, structuredClone(value)); },
            registerMenuCommand: (name, fn) => { commands.set(name, fn); return name; },
            setClipboard: async () => {},
            xmlHttpRequest(details) {
                const entry = { details, aborted: false, settled: false };
                requests.push(entry);
                const reply = harness.route(details, entry);
                const control = { abort() { if (reply?.ignoreAbort) return; entry.aborted = true; details.onabort?.(); } };
                if (reply === 'hang') return control;
                const deliver = () => {
                    if (entry.aborted) return;
                    entry.settled = true;
                    if (reply?.error) details.onerror?.({ error: reply.error });
                    else if (reply?.timeout) details.ontimeout?.();
                    else details.onload?.({ status: reply.status, finalUrl: reply.finalUrl || details.url, responseHeaders: reply.headers || '', responseText: reply.text || '' });
                };
                if (reply?.delay) setTimeout(deliver, reply.delay); else queueMicrotask(deliver);
                return control;
            }
        };
    }
    harness.opened = [];
    window.open = (url) => { const tab = { closed: false, close() { this.closed = true; }, opener: 1, document: window.document.implementation.createHTMLDocument(''), location: { replace(u) { harness.opened.push(u); } } }; if (url) harness.opened.push(url); return tab; };
    window.__perf = {};
    harness.code = instrument(SOURCE, { fast, exportHook, count, replace });
    if (beforeEval) beforeEval(window);
    try {
        window.eval(harness.code);
    } catch (error) {
        errors.push(error);
    }
    await wait(settle);
    return { perf: window.__perf, dom, window, document: window.document, sp: window.__sp, requests, errors, commands, harness, store };
}

export function detailsPage(pkg, name, { price = null, widget = true, extra = '', ldUrl = true } = {}) {
    const url = ldUrl ? `"url":"https://play.google.com/store/apps/details?id=${pkg}",` : '';
    const ld = price === null ? '' : `<script type="application/ld+json">{"@type":"SoftwareApplication",${url}"offers":[{"@type":"Offer","price":"${price}"}]}</script>`;
    return `<!doctype html><html><head><title>${name} - Apps on Google Play</title>${ld}</head><body><main>
        <h1>${name}</h1>
        <div class="row">${widget ? widgetHtml(pkg, price ? `€${price}` : 'Install') : ''}</div>${extra}
    </main></body></html>`;
}

export function widgetHtml(pkg, label = 'Install') {
    return `<div data-item-id='%.@."${pkg}",7]'><button>${label}</button></div>`;
}

/** Simulates Play's SPA navigation: pushState + swap main content (a DOM mutation). */
export function navigate(window, pkg, name, opts) {
    window.history.pushState({}, '', `/store/apps/details?id=${pkg}`);
    const fresh = new window.DOMParser().parseFromString(detailsPage(pkg, name, opts), 'text/html');
    window.document.querySelector('main').replaceWith(window.document.importNode(fresh.querySelector('main'), true));
}

export const json = (value, status = 200) => ({ status, text: JSON.stringify(value), headers: 'content-type: application/json\r\n' });

/** A captured response from test/fixtures (trimmed excerpts; *.gz files are gunzipped). */
export function fixture(name) {
    const file = new URL(`./fixtures/${name}`, import.meta.url);
    return name.endsWith('.gz') ? gunzipSync(readFileSync(file)).toString('utf8') : readFileSync(file, 'utf8');
}

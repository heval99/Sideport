// ==UserScript==
// @name         Sideport
// @namespace    https://github.com/heval99/sideport
// @version      1.1.2
// @description  Get any Google Play app as an APK: direct downloads from 6 sources, APK stores, Morphe patches, open-source alternatives and opt-in mod sites — one button on every app page.
// @author       heval99
// @license      PolyForm-Noncommercial-1.0.0
// @homepageURL  https://github.com/heval99/sideport
// @supportURL   https://github.com/heval99/sideport/issues
// @contributionURL https://ko-fi.com/heval99
// @updateURL    https://raw.githubusercontent.com/heval99/sideport/main/sideport.user.js
// @downloadURL  https://raw.githubusercontent.com/heval99/sideport/main/sideport.user.js
// @icon         data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230b57d0'/%3E%3Cpath d='M32 13v25M21 28l11 11 11-11' fill='none' stroke='%23fff' stroke-width='6' stroke-linecap='round' stroke-linejoin='round'/%3E%3Crect x='16' y='45' width='32' height='6' rx='3' fill='%23fff'/%3E%3C/svg%3E
// @match        https://play.google.com/*
// @run-at       document-idle
// @noframes
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.registerMenuCommand
// @grant        GM.setClipboard
// @grant        GM.info
// @connect      apkpure.com
// @connect      winudf.com
// @connect      apkcombo.com
// @connect      web-api.aptoide.com
// @connect      f-droid.org
// @connect      apt.izzysoft.de
// @connect      en.uptodown.com
// @connect      morphe-patches.software
// @connect      raw.githubusercontent.com
// ==/UserScript==

// Sideport by heval99 — https://github.com/heval99/sideport
// Credits: the Google Play install-button detection and the price-tag check are adapted from
// "Direct download from Google Play" by StephenP (https://greasyfork.org/scripts/33005).

(function () {
    'use strict';

    const LOG_PREFIX = '[Sideport]';
    const REQUEST_TIMEOUT_MS = 12000;
    const RENDER_THROTTLE_MS = 150;
    const RETRY_DELAY_MS = 400;
    const SETTLE_MS = 2500;        // how long to wait for Play's install button before using a fallback anchor
    const GIVE_UP_MS = 20000;
    const MOUNT_STRATEGIES = ['inline', 'row', 'heading', 'banner'];
    const CHURN_LIMIT = 5;              // removals within CHURN_WINDOW_MS before trying the next mount spot
    const CHURN_WINDOW_MS = 10000;
    const THROTTLE_AFTER_REMOUNTS = 30; // after this many removals on one page, remount at most once a second
    const PROBE_CONCURRENCY = 4;
    const MISSING_RESULT_TTL_MS = 10 * 60 * 1000;   // "not found" answers are re-checked after this
    const SETTINGS_KEY = 'sideport-settings-v1';
    const PATCH_META_KEY = 'sideport-patch-meta-v3';   // { fetchedAt, communityEtag, officialEtag }: rewritten on every check
    const PATCH_DATA_KEY = 'sideport-patch-data-v3';   // { community, official }: rewritten only when Morphe changed
    // Checking is cheap: Morphe answers "304 Not Modified" (no body) when its list hasn't changed since our ETag.
    const PATCH_INDEX_TTL_MS = 30 * 60 * 1000;
    const PATCH_INDEX_MISSING_RECHECK_MS = 5 * 60 * 1000;   // apps not in the list yet are re-checked sooner
    const PATCH_INDEX_RETRY_MS = 5 * 60 * 1000;             // back-off after a failed download
    const PATCH_INDEX_TIMEOUT_MS = 45000;
    const MORPHE_BUNDLES_URL = 'https://morphe-patches.software/data/bundles.json';
    const MORPHE_OFFICIAL_URL = 'https://raw.githubusercontent.com/MorpheApp/morphe-patches/main/patches-list.json';
    const MORPHE_OFFICIAL_PAGE = 'https://morphe.software/';
    // Morphe brand colours (from morphe.software's stylesheet): a blue → teal gradient.
    const MORPHE_BLUE = '#1E5AA8';
    const MORPHE_TEAL = '#00AFAE';
    const DONATE_URL = 'https://ko-fi.com/heval99';
    // Morphe community bundles Sideport recommends: shown first in the Patches section, linked to their repo.
    // Entries are GitHub "owner/repo" (case-insensitive) or "owner/*" for all of an author's bundles.
    const RECOMMENDED_BUNDLES = ['crimera/piko', 'SysAdminDoc/*', 'jasonwu1994/Gboard-patches', 'heval99/Heval-Morphe-Patches'];
    const AUTHOR_PATCHES_URL = 'https://github.com/heval99/Heval-Morphe-Patches';
    const SVG_NS = 'http://www.w3.org/2000/svg';
    // A dotted version, but not a file size ("60.2 MB") or a minimum Android version ("Android 5.0+").
    const VERSION_RE = /(?<!Android\s?)(?<![\d.])\d+(?:\.\d+){1,4}(?![\d.])(?!\s*(?:[KMG]i?B|%|\+))/i;

    const GROUPS = {
        direct: { label: 'Direct download' },
        stores: { label: 'Stores & mirrors' },
        patches: { label: 'Morphe patches' },
        alternatives: { label: 'Open-source alternatives' },
        mods: {
            label: 'Modded APKs',
            warning: 'Unverified, repackaged files. Several of these sites are flagged for adware or malware — scan anything before installing.'
        }
    };

    const SOURCES = [
        // Direct: fetched in the background, then the file itself is opened.
        {
            id: 'apkpure', group: 'direct', label: 'APKPure', color: '#24cd77', hint: 'Latest APK',
            hosts: ['apkpure.com', 'winudf.com'],
            page: ctx => `https://apkpure.com/search?q=${ctx.encodedPackageId}`,
            probe: ctx => probeApkPure(ctx, 'APK'),
            resolve: async ctx => ({ files: [{ url: apkPureDirectUrl(ctx, 'APK'), label: 'APK · latest' }] })
        },
        {
            id: 'apkpure-xapk', group: 'direct', label: 'APKPure XAPK', color: '#1fa463', hint: 'Split bundle · needs an XAPK installer',
            hosts: ['apkpure.com', 'winudf.com'],
            page: ctx => `https://apkpure.com/search?q=${ctx.encodedPackageId}`,
            probe: ctx => probeApkPure(ctx, 'XAPK'),
            resolve: async ctx => ({ files: [{ url: apkPureDirectUrl(ctx, 'XAPK'), label: 'XAPK · latest' }] })
        },
        {
            id: 'apkcombo', group: 'direct', label: 'APKCombo', color: '#00875f', hint: 'APK & XAPK variants',
            hosts: ['apkcombo.com', 'apkcombo.app', 'r2.cloudflarestorage.com'], offersVariants: true,
            page: ctx => `https://apkcombo.com/genericApp/${ctx.encodedPackageId}/download/apk`,
            probe: probeApkCombo,
            resolve: resolveApkCombo
        },
        {
            id: 'aptoide', group: 'direct', label: 'Aptoide', color: '#fe6446', hint: 'APK, splits & OBB',
            hosts: ['aptoide.com'],
            page: ctx => `https://en.aptoide.com/search?query=${ctx.encodedPackageId}&type=apps`,
            probe: probeAptoide,
            resolve: async (ctx, data) => ({ files: (data || (await probeAptoide(ctx)).data).files, kind: 'parts' })
        },
        fdroidRepoSource({
            id: 'fdroid', label: 'F-Droid', color: '#1976d2',
            apiBase: 'https://f-droid.org/api/v1/packages',
            repoBase: 'https://f-droid.org/repo',
            page: ctx => `https://f-droid.org/en/packages/${ctx.encodedPackageId}/`,
            hosts: ['f-droid.org']
        }),
        fdroidRepoSource({
            id: 'izzy', label: 'IzzyOnDroid', color: '#d84315',
            apiBase: 'https://apt.izzysoft.de/fdroid/api/v1/packages',
            repoBase: 'https://apt.izzysoft.de/fdroid/repo',
            page: ctx => `https://apt.izzysoft.de/fdroid/index/apk/${ctx.encodedPackageId}`,
            hosts: ['izzysoft.de']
        }),
        izzyRepoSource({
            id: 'guardian', label: 'Guardian Project', color: '#6a3d9a', repo: 'guardian',
            hint: 'Official builds of privacy apps (Signal, Orbot\u2026)',
            hosts: ['guardianproject.info', 'objectstorage.eu-amsterdam-1.oraclecloud.com']
        }),
        izzyRepoSource({
            id: 'fdroid-archive', label: 'F-Droid archive', color: '#5c6bc0', repo: 'archive',
            hint: 'Older F-Droid builds', hosts: ['f-droid.org'], defaultOn: false
        }),

        // Stores & mirrors: plain links to the site's own page.
        { id: 'apkmirror', group: 'stores', label: 'APKMirror', color: '#ff8b14', hint: 'Search by package ID', url: ctx => `https://www.apkmirror.com/?post_type=app_release&searchtype=apk&s=${ctx.encodedPackageId}` },
        {
            id: 'uptodown', group: 'stores', label: 'Uptodown', color: '#4a6cf7', hint: 'Original APKs',
            url: ctx => `https://en.uptodown.com/android/search?query=${ctx.encodedPackageId}`,
            probe: probeUptodown
        },
        { id: 'evozi', group: 'stores', label: 'Evozi APK Downloader', color: '#009688', hint: 'Generates a download from Google Play', url: ctx => `https://apps.evozi.com/apk-downloader/?packagename=${ctx.encodedPackageId}` },
        { id: 'apkfab', group: 'stores', label: 'APKFab', color: '#1a73e8', hint: 'Search by package ID', url: ctx => `https://apkfab.com/search?q=${ctx.encodedPackageId}` },
        { id: 'github', group: 'stores', label: 'GitHub', color: '#6e7681', hint: 'Repositories mentioning the package', defaultOn: false, url: ctx => `https://github.com/search?q=${ctx.encodedPackageId}&type=repositories` },

        // Mods: opt-in, search links only — nothing is fetched or downloaded from these sites.
        { id: 'liteapks', group: 'mods', label: 'LiteAPKs', color: '#9b1c1c', hint: searchHint, url: ctx => `https://liteapks.com/?s=${encodeURIComponent(ctx.searchName)}` },
        { id: 'modyolo', group: 'mods', label: 'ModYolo', color: '#e65100', hint: searchHint, url: ctx => `https://modyolo.com/?s=${encodeURIComponent(ctx.searchName)}` },
        { id: 'an1', group: 'mods', label: 'AN1', color: '#2e7d32', hint: searchHint, url: ctx => `https://an1.com/?do=search&subaction=search&story=${encodeURIComponent(ctx.searchName)}` },
        { id: 'moddroid', group: 'mods', label: 'MODDROID', color: '#6a1b9a', hint: searchHint, url: ctx => `https://moddroid.com/?s=${encodeURIComponent(ctx.searchName)}` },
        { id: 'apkdone', group: 'mods', label: 'APKDone', color: '#00838f', hint: searchHint, url: ctx => `https://apkdone.com/search/?q=${encodeURIComponent(ctx.searchName)}` },
        { id: 'getmodsapk', group: 'mods', label: 'GetModsAPK', color: '#ad1457', hint: searchHint, url: ctx => `https://getmodsapk.com/search?query=${encodeURIComponent(ctx.searchName)}` },
        { id: '5play', group: 'mods', label: '5Play', color: '#283593', hint: searchHint, url: ctx => `https://5play.org/index.php?do=search&subaction=search&story=${encodeURIComponent(ctx.searchName)}` },
        { id: 'apkvision', group: 'mods', label: 'ApkVision', color: '#5d4037', hint: searchHint, defaultOn: false, url: ctx => `https://apkvision.org/?s=${encodeURIComponent(ctx.searchName)}` }
    ];
    const SOURCE_BY_ID = new Map(SOURCES.map(source => [source.id, source]));

    // Safer open-source options for specific apps. Only add entries that have been verified.
    const ALTERNATIVES = {
        'com.google.android.youtube': [
            { id: 'alt-newpipe', label: 'NewPipe', color: '#cd201f', hint: 'Lightweight open-source client', url: 'https://newpipe.net/' }
        ]
    };

    const ICONS = {
        download: 'M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z',
        chevron: 'M7 10l5 5 5-5z',
        open: 'M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7zM19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7z',
        copy: 'M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z',
        close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
        settings: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
        refresh: 'M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
        warning: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
        back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
        extension: 'M20.5 11H19V7a2 2 0 0 0-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4a2 2 0 0 0-1.99 2v3.8H3.5a2.7 2.7 0 0 1 0 5.4H2V20a2 2 0 0 0 2 2h3.8v-1.5a2.7 2.7 0 0 1 5.4 0V22H17a2 2 0 0 0 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z',
        heart: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z'
    };

    /** A source could not deliver; `message` is short enough to show in a menu row. */
    class SourceFailure extends Error {
        get name() { return 'SourceFailure'; }
    }

    /** The source answered, but doesn't carry this app. */
    class NotListed extends SourceFailure {
        constructor() { super('Not found'); }
        get name() { return 'NotListed'; }
    }

    /** The user navigated away while a request was running; its result must be discarded. */
    class PageChanged extends Error {
        get name() { return 'PageChanged'; }
    }

    const state = {
        routeKey: '',
        routeStart: 0,
        sessionId: 0,
        remounts: 0,
        removals: [],  // timestamps of recent removals by Play, for churn detection
        strategy: 0,   // index into MOUNT_STRATEGIES
        lastMountAt: 0,
        hiddenPlacements: 0, // placements skipped because Play's widget was hidden
        dismissedRoute: '',
        mount: null,   // { root, anchor, ctx, widget }
        menu: null,    // persistent menu for the current route
        renderTimer: null,
        retryTimer: null,
        positionFrame: 0
    };
    const probeCache = new Map();
    const probeQueue = [];
    const inflightRequests = new Set();   // page-bound requests that teardown() cancels
    const recentFailures = [];            // last few source errors, for "Copy diagnostics"
    let activeProbes = 0;
    let settings = defaultSettings();
    let toastTimer = null;
    let patchIndex = null;          // last loaded Morphe index, for synchronous lookups while rendering
    let patchIndexStoragePromise = null;
    let patchRefreshPromise = null;
    let patchIndexFailedAt = 0;

    start();

    // ---------------------------------------------------------------- lifecycle

    async function start() {
        settings = await loadSettings();
        injectStyles();
        document.addEventListener('pointerdown', handleOutsidePointer, true);
        window.addEventListener('popstate', () => scheduleRender());
        window.navigation?.addEventListener?.('navigatesuccess', () => scheduleRender());
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', refreshTheme);
        new MutationObserver(() => scheduleRender()).observe(document.documentElement, { childList: true, subtree: true });
        registerMenuCommands();
        scheduleRender();
    }

    // Throttled rather than debounced: Play mutates the DOM constantly, which would starve a debounce.
    function scheduleRender(delay = RENDER_THROTTLE_MS) {
        if (state.renderTimer) return;
        state.renderTimer = window.setTimeout(() => {
            state.renderTimer = null;
            renderForCurrentPage();
        }, delay);
    }

    function scheduleRetry(delay = RETRY_DELAY_MS) {
        window.clearTimeout(state.retryTimer);
        state.retryTimer = window.setTimeout(() => scheduleRender(), delay);
    }

    function renderForCurrentPage() {
        const route = getRoute();
        const key = route?.key || '';
        if (key !== state.routeKey) {
            teardown();
            state.routeKey = key;
            state.routeStart = Date.now();
            state.remounts = 0;
            state.removals = [];
            state.strategy = 0;
            state.hiddenPlacements = 0;
        }
        if (!route || state.dismissedRoute === key) return;

        if (state.mount) {
            if (state.mount.root.isConnected) return;
            closeMenu(false);
            state.mount = null;
            noteRemoval();
        }
        // Under heavy churn, remount at most once a second instead of on every DOM mutation.
        const sinceLastMount = Date.now() - state.lastMountAt;
        if (state.remounts > THROTTLE_AFTER_REMOUNTS && sinceLastMount < 1000) {
            scheduleRetry(1000 - sinceLastMount);
            return;
        }
        tryMount(route);
    }

    // Play re-renders some pages' action rows (e.g. signed-in pages of apps installed on the user's devices),
    // which removes our button. Repeated removals move it to a calmer spot instead of giving up.
    function noteRemoval() {
        const now = Date.now();
        state.remounts += 1;
        state.removals = state.removals.filter(time => now - time < CHURN_WINDOW_MS).concat(now);
        if (state.removals.length > CHURN_LIMIT && state.strategy < MOUNT_STRATEGIES.length - 1) {
            state.strategy += 1;
            state.removals = [];
        }
    }

    function teardown() {
        state.sessionId += 1; // invalidates in-flight requests for the previous page
        for (const ticket of [...inflightRequests]) {
            if (ticket.sessionId !== state.sessionId) ticket.cancel();
        }
        window.clearTimeout(state.retryTimer);
        closeMenu(false);
        state.menu?.root.remove();
        state.menu = null;
        state.mount?.root.remove();
        state.mount = null;
        document.querySelectorAll('.pas-mount').forEach(node => node.remove());
    }

    function getRoute() {
        const url = new URL(location.href);
        if (url.pathname.endsWith('/apps/details')) {
            const packageId = toPackageId(url.searchParams.get('id'));
            return packageId ? { key: `details:${packageId}`, packageId, isDetails: true } : null;
        }
        if (url.pathname.endsWith('/search') && url.searchParams.get('q')) {
            return { key: `search:${url.search}`, packageId: null, isDetails: false };
        }
        return null;
    }

    function tryMount(route) {
        // App pages know the package from the URL; search pages take it from the top result's widget.
        const widget = findActionWidget(route.packageId);
        const packageId = route.packageId || packageFromWidget(widget);
        const strategy = MOUNT_STRATEGIES[state.strategy];
        const elapsed = Date.now() - state.routeStart;
        state.lastMountAt = Date.now();

        if (widget && packageId && (strategy === 'inline' || strategy === 'row')) {
            mountNearWidget(widget, createContext(packageId, widget), strategy);
            return;
        }
        // Without a widget, give Play time to render it before falling back (not needed once escalated).
        const escalated = strategy === 'heading' || strategy === 'banner';
        if (!escalated && (elapsed < SETTLE_MS || (!packageId && elapsed < GIVE_UP_MS))) {
            scheduleRetry();
            return;
        }
        if (!packageId || (!route.isDetails && !widget)) return;

        const ctx = createContext(packageId, widget);
        const heading = route.isDetails && (document.querySelector('main h1') || document.querySelector('h1'));
        if (heading && strategy !== 'banner') {
            mountAfterHeading(heading, ctx);
        } else {
            mountBanner(ctx, escalated && widget ? `Sideport for ${ctx.appName}` : null);
        }
    }

    // 'inline' sits directly after Play's install/buy widget, in the same row. 'row' sits after that whole
    // row, outside the part of the page Play keeps re-rendering.
    function mountNearWidget(widget, ctx, strategy) {
        const target = strategy === 'row' ? widget.parentElement : widget;
        if (!target?.parentElement) {
            scheduleRetry();
            return;
        }
        const anchor = createMainButton();
        const root = el('div', { className: `pas-root pas-mount ${strategy === 'row' ? 'pas-after-row' : 'pas-inline'}` }, anchor);
        target.after(root);
        setMount(root, anchor, ctx, widget);
        // If Play rendered this widget inside a hidden container, our button is invisible too: move on to the
        // next placement (after the row, then next to the title) instead of staying hidden.
        window.requestAnimationFrame(() => {
            if (state.mount?.root !== root || !root.isConnected || !hasLayout() || isRendered(root)) return;
            state.strategy = Math.max(state.strategy, MOUNT_STRATEGIES.indexOf(strategy) + 1);
            state.hiddenPlacements += 1;
            closeMenu(false);
            root.remove();
            state.mount = null;
            scheduleRender();
        });
    }

    function mountAfterHeading(heading, ctx) {
        const anchor = createMainButton();
        const root = el('div', { className: 'pas-root pas-mount pas-after-heading' }, anchor);
        heading.insertAdjacentElement('afterend', root);
        setMount(root, anchor, ctx, null);
    }

    function mountBanner(ctx, message = null) {
        const anchor = createMainButton();
        const dismiss = el('button', {
            type: 'button', className: 'pas-icon-btn', 'aria-label': 'Dismiss', title: 'Dismiss',
            onClick: () => {
                state.dismissedRoute = state.routeKey;
                closeMenu(false);
                root.remove();
            }
        }, icon('close'));
        const root = el('div', { className: 'pas-root pas-mount pas-banner', role: 'region', 'aria-label': 'APK sources' },
            el('p', { className: 'pas-banner-text', text: message || 'This app isn’t available on Google Play here. You can still look for the APK.' }),
            anchor,
            dismiss);
        document.body.append(root);
        setMount(root, anchor, ctx, null);
    }

    function setMount(root, anchor, ctx, widget) {
        applyTheme(root);
        anchor.addEventListener('click', toggleMenu);
        state.mount = { root, anchor, ctx, widget };
        attachPatchChip(root, anchor, ctx);
    }

    function createMainButton() {
        const chevron = icon('chevron');
        chevron.classList.add('pas-chevron');
        return el('button', {
            type: 'button', className: 'pas-main', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
            title: 'Find this app’s APK on other sources'
        }, icon('download'), el('span', { text: 'Get APK' }), chevron);
    }

    function registerMenuCommands() {
        if (typeof GM?.registerMenuCommand !== 'function') return;
        const requireApp = action => () => (state.mount ? action() : showToast('Open an app page on Google Play first'));
        GM.registerMenuCommand('Open APK sources', requireApp(() => openMenu('sources', true)));
        GM.registerMenuCommand('APK source settings', requireApp(() => openMenu('settings', true)));
        GM.registerMenuCommand('Copy package ID', copyPackageId);
        GM.registerMenuCommand('Copy diagnostics (for bug reports)', copyDiagnostics);
        GM.registerMenuCommand('♥ Support Sideport on Ko-fi', () => window.open(DONATE_URL, '_blank', 'noopener'));
    }

    // ---------------------------------------------------------------- settings

    function defaultSettings() {
        return {
            showMods: false,
            showPatches: true,
            autoCheck: true,
            openInNewTab: true,
            sources: Object.fromEntries(SOURCES.map(source => [source.id, source.defaultOn !== false]))
        };
    }

    async function loadSettings() {
        const defaults = defaultSettings();
        try {
            const saved = await GM.getValue(SETTINGS_KEY, null);
            if (!saved || typeof saved !== 'object') return defaults;
            const sources = { ...defaults.sources };
            for (const id of Object.keys(sources)) {
                if (typeof saved.sources?.[id] === 'boolean') sources[id] = saved.sources[id];
            }
            return {
                showMods: typeof saved.showMods === 'boolean' ? saved.showMods : defaults.showMods,
                showPatches: typeof saved.showPatches === 'boolean' ? saved.showPatches : defaults.showPatches,
                autoCheck: typeof saved.autoCheck === 'boolean' ? saved.autoCheck : defaults.autoCheck,
                openInNewTab: typeof saved.openInNewTab === 'boolean' ? saved.openInNewTab : defaults.openInNewTab,
                sources
            };
        } catch (error) {
            console.warn(`${LOG_PREFIX} Could not load settings`, error);
            return defaults;
        }
    }

    function saveSettings() {
        Promise.resolve(GM.setValue(SETTINGS_KEY, settings)).catch(error => {
            console.warn(`${LOG_PREFIX} Could not save settings`, error);
            showToast('Could not save settings');
        });
    }

    function enabledSources(group) {
        return SOURCES.filter(source => source.group === group && settings.sources[source.id] !== false);
    }

    // ---------------------------------------------------------------- page data

    function createContext(packageId, widget) {
        const ctx = { packageId, encodedPackageId: encodeURIComponent(packageId), sessionId: state.sessionId };
        refreshContext(ctx, widget);
        return ctx;
    }

    // App name and price can render after the button is mounted, so re-read them whenever the menu opens.
    function refreshContext(ctx, widget) {
        ctx.appName = readAppName() || ctx.appName || ctx.packageId;
        ctx.searchName = modSearchName(ctx.appName, ctx.packageId);
        ctx.isFree = !isPaidApp(widget);
    }

    // Mod sites are English and search by name. Play shows translated names on other languages' pages, so a
    // non-Latin name falls back to a readable part of the package id (com.spotify.music -> "spotify").
    function modSearchName(appName, packageId) {
        const shortName = appName.split(/\s[-–—|:]\s|:\s/)[0].trim() || appName;
        if (/^[\p{Script=Latin}\p{N}\p{P}\p{Zs}+&']+$/u.test(shortName)) return shortName;
        // The last meaningful segment names the app (com.google.android.apps.maps -> "maps").
        const generic = new Set(['android', 'app', 'apps', 'mobile', 'client', 'free', 'pro', 'lite', 'main', 'messenger', 'music', 'results']);
        const parts = packageId.split('.').slice(1).filter(part => !generic.has(part.toLowerCase()));
        return parts[parts.length - 1] || shortName;
    }

    const PACKAGE_ID_PATTERN =/^[A-Za-z]\w*(?:\.\w+)+$/;

    function toPackageId(value) {
        const candidate = typeof value === 'string' ? value.trim() : '';
        return candidate.length <= 200 && PACKAGE_ID_PATTERN.test(candidate) ? candidate : null;
    }

    // Install/buy widget detection is adapted from "Direct download from Google Play" by StephenP
    // (https://greasyfork.org/scripts/33005): Play renders the widget as an element whose data-item-id is
    // `%.@."<package>",7]`. Checked against live Play pages (2026-10): exactly one such element per app page,
    // and on search pages it belongs to the top result.
    const WIDGET_SELECTOR = "[data-item-id^='%.@.']";

    function findActionWidget(packageId) {
        const widgets = [...document.querySelectorAll(WIDGET_SELECTOR)];
        // Signed in, Play can keep a hidden Install widget next to the visible "Install on more devices" one,
        // so prefer a widget that is actually on screen.
        const pick = candidates => candidates.find(isRendered) || candidates[0] || null;
        if (!packageId) return pick(widgets);
        const exact = pick(widgets.filter(widget => packageFromWidget(widget) === packageId));
        if (exact) return exact;
        // Safety net in case Play changes the "%.@." prefix: any data-item-id carrying the quoted package
        // that wraps a button.
        const quoted = `"${packageId}"`;
        return pick([...document.querySelectorAll('[data-item-id]')].filter(element =>
            element.getAttribute('data-item-id').includes(quoted) && element.querySelector('button, [role="button"]')
            && !element.closest('.pas-root')));
    }

    // True when the browser actually lays the element out (false inside display:none / hidden containers).
    function isRendered(node) {
        return node.getClientRects().length > 0;
    }

    // jsdom-like environments have no layout at all; visibility checks only mean something with a real one.
    function hasLayout() {
        return document.documentElement.getBoundingClientRect().height > 0;
    }

    function packageFromWidget(widget) {
        const match = /^%\.@\."([^"]+)"/.exec(widget?.getAttribute('data-item-id') || '');
        return match ? toPackageId(match[1]) : null;
    }

    function readAppName() {
        const heading = cleanText(document.querySelector('h1')?.textContent);
        if (heading) return heading;
        // Page titles look like "<App name> - <store name>"; keep the part before the last separator.
        const title = cleanText(document.title);
        const separator = title.lastIndexOf(' - ');
        return separator > 0 ? title.slice(0, separator).trim() : null;
    }

    function isPaidApp(widget) {
        if (structuredDataPrice() > 0 || microdataPrice() > 0) return true;
        const label = cleanText(`${widget?.textContent || ''} ${widget?.getAttribute?.('aria-label') || ''}`);
        // A price on the button: a currency symbol ("€4.99", "4,99 €"), an ISO code before or after the amount
        // ("USD 4.99", "4.99 PLN"), or a common local abbreviation ("4,99 zł", "25 kr", "99 Kč").
        return /\d/.test(label)
            && /\p{Sc}|\b[A-Z]{3}\s?\d|\d\s?[A-Z]{3}\b|\d\s?(?:zł|kr|Kč|Ft|lei|лв|грн|руб|R\$|Rs)/u.test(label);
    }

    // Fallback price signal, also from StephenP's script: Play's <meta itemprop="price">. Play writes it with the
    // currency symbol ("$6.99"), so strip everything but the number before parsing.
    function microdataPrice() {
        const raw = document.querySelector('meta[itemprop="price"]')?.content || '';
        return Number.parseFloat(raw.replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
    }

    // Play embeds schema.org data for the app; a positive offer price means it's a paid app.
    function structuredDataPrice() {
        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
            let data;
            try {
                data = JSON.parse(script.textContent);
            } catch {
                continue;
            }
            for (const offer of [].concat(data?.offers || [])) {
                const price = Number.parseFloat(String(offer?.price ?? '').replace(',', '.'));
                if (price > 0) return price;
            }
        }
        return 0;
    }

    function searchHint(ctx) {
        return `Search “${ctx.searchName}”`;
    }

    // ---------------------------------------------------------------- menu

    function ensureMenu() {
        if (state.menu) return state.menu;

        const title = el('div', { className: 'pas-title' });
        const pkg = el('code', { className: 'pas-pkg' });
        const filter = el('input', {
            type: 'search', className: 'pas-filter', placeholder: 'Filter sources…',
            'aria-label': 'Filter sources', autocomplete: 'off', spellcheck: 'false'
        });
        const filterWrap = el('div', { className: 'pas-filter-wrap' }, filter);
        const body = el('div', { className: 'pas-body' });
        const footer = el('div', { className: 'pas-footer' });
        const root = el('div', { className: 'pas-root pas-menu', role: 'dialog', 'aria-label': 'APK sources', tabindex: '-1', hidden: true },
            el('div', { className: 'pas-header' },
                el('div', { className: 'pas-heading' },
                    title,
                    el('div', { className: 'pas-pkg-row' },
                        pkg,
                        el('button', { type: 'button', className: 'pas-icon-btn', 'aria-label': 'Copy package ID', title: 'Copy package ID', onClick: copyPackageId }, icon('copy')))),
                el('button', { type: 'button', className: 'pas-icon-btn', 'aria-label': 'Close', title: 'Close', onClick: () => closeMenu(true) }, icon('close'))),
            filterWrap,
            body,
            footer);

        filter.addEventListener('input', applyFilter);
        root.addEventListener('keydown', handleMenuKeydown);
        // Keep Play's own click handlers away from our links and buttons.
        root.addEventListener('click', event => event.stopPropagation());
        document.body.append(root);

        state.menu = { root, title, pkg, filter, filterWrap, body, footer, view: 'sources', rows: new Map(), actions: new Map(), anchor: null, open: false };
        return state.menu;
    }

    function toggleMenu(event) {
        event.preventDefault();
        event.stopPropagation();
        if (state.menu?.open) {
            closeMenu(false);
        } else {
            openMenu('sources', event.detail === 0);
        }
    }

    function openMenu(view, viaKeyboard) {
        const mount = state.mount;
        if (!mount?.anchor.isConnected) return;
        refreshContext(mount.ctx, mount.widget);

        const menu = ensureMenu();
        menu.anchor = mount.anchor;
        // On search pages the top result (and so the package) can change without a route change.
        if (menu.packageId !== mount.ctx.packageId) {
            menu.actions.clear();
            menu.packageId = mount.ctx.packageId;
        }
        applyTheme(menu.root, mount.root);
        menu.title.textContent = mount.ctx.appName;
        menu.pkg.textContent = mount.ctx.packageId;
        if (view === 'settings') renderSettingsView(); else renderSourcesView();

        menu.root.hidden = false;
        menu.open = true;
        mount.anchor.setAttribute('aria-expanded', 'true');
        positionMenu();
        window.addEventListener('scroll', onViewportChange, true);
        window.addEventListener('resize', onViewportChange);

        if (view === 'settings') {
            menu.body.querySelector('input')?.focus();
        } else if (viaKeyboard) {
            focusFirstRow();
        } else {
            menu.root.focus({ preventScroll: true });
        }
        if (view !== 'settings' && settings.autoCheck) runProbes(mount.ctx);
        if (settings.showPatches) getPatchIndex(mount.ctx.packageId); // revalidates if due; updates arrive via onPatchIndexUpdated
    }

    function closeMenu(returnFocus) {
        const menu = state.menu;
        if (!menu?.open) return;
        menu.open = false;
        menu.root.hidden = true;
        menu.anchor?.setAttribute('aria-expanded', 'false');
        window.removeEventListener('scroll', onViewportChange, true);
        window.removeEventListener('resize', onViewportChange);
        if (returnFocus && menu.anchor?.isConnected) menu.anchor.focus();
    }

    function handleOutsidePointer(event) {
        const menu = state.menu;
        if (!menu?.open) return;
        const path = event.composedPath();
        if (path.includes(menu.root) || (menu.anchor && path.includes(menu.anchor))) return;
        closeMenu(false);
    }

    function onViewportChange(event) {
        if (event?.type === 'scroll' && state.menu?.root.contains(event.target)) return;
        if (state.positionFrame) return;
        state.positionFrame = window.requestAnimationFrame(() => {
            state.positionFrame = 0;
            positionMenu();
        });
    }

    function positionMenu() {
        const menu = state.menu;
        if (!menu?.open || !menu.anchor) return;
        if (!menu.anchor.isConnected) {
            closeMenu(false);
            return;
        }
        const rect = menu.anchor.getBoundingClientRect();
        const viewportWidth = document.documentElement.clientWidth;
        const viewportHeight = window.innerHeight;
        // The button scrolled out of view: close instead of leaving the menu stranded at the screen edge.
        if (rect.bottom < 0 || rect.top > viewportHeight) {
            closeMenu(false);
            return;
        }
        const gap = 6;
        const margin = 8;
        const width = Math.min(360, viewportWidth - margin * 2);
        const spaceBelow = viewportHeight - rect.bottom - gap - margin;
        const spaceAbove = rect.top - gap - margin;
        const placeBelow = spaceBelow >= 320 || spaceBelow >= spaceAbove;

        menu.root.style.width = `${width}px`;
        // Never taller than the space on the chosen side, so an upward menu can't cover its own button.
        menu.root.style.maxHeight = `${Math.max(120, Math.min(600, placeBelow ? spaceBelow : spaceAbove))}px`;
        const top = placeBelow ? rect.bottom + gap : rect.top - gap - menu.root.offsetHeight;
        const left = Math.min(Math.max(margin, rect.left), viewportWidth - width - margin);
        menu.root.style.top = `${Math.max(margin, top)}px`;
        menu.root.style.left = `${Math.max(margin, left)}px`;
    }

    function renderSourcesView() {
        const menu = state.menu;
        const ctx = state.mount.ctx;
        menu.view = 'sources';
        menu.root.setAttribute('aria-label', 'APK sources');
        menu.filterWrap.hidden = false;
        menu.rows = new Map();

        const sections = [];
        if (!ctx.isFree) {
            sections.push(buildSection('direct', [], 'This is a paid app, so direct downloads and mod sites are hidden.'));
        } else {
            const direct = enabledSources('direct')
                .map(source => ({ source, missing: getCachedProbe(ctx, source)?.state === 'missing' }))
                .sort((a, b) => a.missing - b.missing)
                .map(({ source }) => buildDirectRow(source, ctx));
            if (direct.length) sections.push(buildSection('direct', direct));
        }

        const stores = enabledSources('stores').map(source => buildLinkRow(source, ctx)).filter(Boolean);
        if (stores.length) sections.push(buildSection('stores', stores));

        const patchRows = settings.showPatches ? patchSources(ctx).map(item => buildLinkRow(item, ctx)).filter(Boolean) : [];
        if (patchRows.length) sections.push(buildSection('patches', patchRows));

        const alternatives = (ALTERNATIVES[ctx.packageId] || []).map(item => buildLinkRow(item, ctx)).filter(Boolean);
        if (alternatives.length) sections.push(buildSection('alternatives', alternatives));

        if (settings.showMods && ctx.isFree) {
            const mods = enabledSources('mods').map(source => buildLinkRow(source, ctx)).filter(Boolean);
            if (mods.length) sections.push(buildSection('mods', mods));
        }

        const hasRows = sections.some(section => section.querySelector('.pas-item'));
        const empty = hasRows ? null : el('p', { className: 'pas-empty', text: 'All sources are turned off. Open Settings to turn some on.' });
        const noMatch = el('p', { className: 'pas-empty pas-no-match', hidden: true, text: 'No sources match your filter.' });
        menu.body.replaceChildren(...sections, empty || '', noMatch);

        const hasProbes = [...(ctx.isFree ? enabledSources('direct') : []), ...enabledSources('stores')].some(source => source.probe);
        menu.footer.replaceChildren(
            el('div', { className: 'pas-footer-group' },
                el('button', { type: 'button', className: 'pas-text-btn', onClick: () => renderSettingsView(true) }, icon('settings'), 'Settings'),
                hasProbes ? el('button', { type: 'button', className: 'pas-text-btn', title: 'Check availability again', onClick: recheckSources }, icon('refresh'), 'Re-check') : null),
            supportLink('Support'));
        applyFilter();
    }

    function buildSection(groupId, rows, note) {
        const group = GROUPS[groupId];
        return el('section', { className: 'pas-section', 'aria-label': group.label, dataset: { group: groupId } },
            el('h3', { className: 'pas-section-title', text: group.label }),
            group.warning ? el('p', { className: 'pas-warning', role: 'note' }, icon('warning'), el('span', { text: group.warning })) : null,
            note ? el('p', { className: 'pas-note', text: note }) : null,
            rows.length ? el('ul', { className: 'pas-list', role: 'list' }, rows) : null);
    }

    // Link rows open the source's site. Sources with a probe (e.g. Uptodown) also show availability and, once
    // found, link straight to the app's page instead of a search.
    function buildLinkRow(source, ctx) {
        const probe = source.probe ? getCachedProbe(ctx, source) : null;
        const url = safeHttpsUrl(probe?.state === 'ok' && probe.pageUrl)
            || safeHttpsUrl(typeof source.url === 'function' ? source.url(ctx) : source.url);
        if (!url) return null;
        const hint = typeof source.hint === 'function' ? source.hint(ctx) : source.hint;
        const badge = source.badge || (source.group === 'mods' ? 'Mod' : 'Link');
        let sub = hint || safeHost(url);
        let tone = '';
        if (probe?.state === 'ok') {
            sub = probe.version ? `Available \u00b7 v${probe.version}` : 'Available \u00b7 opens the app page';
            tone = 'ok';
        } else if (probe?.state === 'missing') {
            sub = 'Not found on this source';
        } else if (probe?.state === 'loading') {
            sub = 'Checking\u2026';
        } else if (probe?.state === 'unknown') {
            sub = 'Couldn\u2019t check \u00b7 opens search';
        }
        const link = el('a', {
            className: 'pas-row', href: url, target: '_blank', rel: 'noopener noreferrer', tabindex: '-1',
            'aria-busy': probe?.state === 'loading' ? 'true' : null,
            onClick: () => closeMenu(false)
        },
        dot(source.color),
        el('span', { className: 'pas-row-text' },
            el('span', { className: 'pas-row-label', text: source.label }),
            el('span', { className: 'pas-row-sub', text: sub, dataset: tone ? { tone } : {} })),
        el('span', { className: `pas-badge${source.badgeClass ? ` ${source.badgeClass}` : ''}`, text: badge }),
        icon('open'));
        const item = el('li', {
            className: `pas-item${probe?.state === 'missing' ? ' is-missing' : ''}`,
            dataset: { id: source.id, filter: `${source.label} ${hint || ''} ${safeHost(url)}`.toLowerCase() }
        }, link);
        if (source.probe && state.menu) state.menu.rows.set(source.id, item);
        return item;
    }

    function buildDirectRow(source, ctx) {
        const probe = getCachedProbe(ctx, source);
        const action = state.menu.actions.get(source.id);
        const busy = Boolean(action?.busy || probe?.state === 'loading');
        let sub = source.hint;
        let tone = '';
        if (probe?.state === 'ok') {
            sub = probe.version ? `Available · v${probe.version}` : 'Available';
            tone = 'ok';
        } else if (probe?.state === 'missing') {
            sub = 'Not found on this source';
        } else if (probe?.state === 'unknown') {
            sub = `Couldn’t check · ${probe.message}`;
        } else if (probe?.state === 'loading') {
            sub = 'Checking…';
        }
        if (action?.text) {
            sub = action.text;
            tone = action.tone || '';
        }

        const pageUrl = safeHttpsUrl(probe?.pageUrl) || toHttpsUrl(source.page(ctx));
        const primary = el('button', { type: 'button', className: 'pas-row', tabindex: '-1', 'aria-busy': busy ? 'true' : null },
            dot(source.color),
            el('span', { className: 'pas-row-text' },
                el('span', { className: 'pas-row-label', text: source.label }),
                el('span', { className: 'pas-row-sub', text: sub, dataset: tone ? { tone } : {} })),
            busy ? el('span', { className: 'pas-spinner', 'aria-hidden': 'true' }) : el('span', { className: 'pas-badge', text: 'Download' }));
        primary.addEventListener('click', () => startDownload(source, ctx));

        const side = el('a', {
            className: 'pas-row-side', href: pageUrl, target: '_blank', rel: 'noopener noreferrer', tabindex: '-1',
            title: `Open ${source.label} website`, 'aria-label': `Open ${source.label} website`
        }, icon('open'));

        const item = el('li', {
            className: `pas-item${probe?.state === 'missing' ? ' is-missing' : ''}`,
            dataset: { id: source.id, filter: `${source.label} ${source.hint} ${safeHost(pageUrl)}`.toLowerCase() }
        },
        el('div', { className: 'pas-row-wrap' }, primary, side),
        action?.files?.length ? buildFileList(action) : null);
        state.menu.rows.set(source.id, item);
        return item;
    }

    function buildFileList(action) {
        return el('div', { className: 'pas-files' },
            action.filesIntro ? el('p', { className: 'pas-files-intro', text: action.filesIntro }) : null,
            el('ul', { className: 'pas-list', role: 'list' }, action.files.map(file => el('li', {},
                el('a', {
                    className: 'pas-file', href: file.url, target: settings.openInNewTab ? '_blank' : null,
                    rel: 'noopener noreferrer', title: file.url
                },
                el('span', { className: 'pas-file-label', text: file.label }),
                el('span', { className: `pas-file-host${file.trusted === false ? ' is-untrusted' : ''}`, text: file.trusted === false ? `⚠ ${safeHost(file.url)}` : safeHost(file.url) }))))));
    }

    function updateRow(sourceId) {
        const menu = state.menu;
        const item = menu?.rows.get(sourceId);
        const ctx = state.mount?.ctx;
        if (!ctx || !item?.isConnected || menu.view !== 'sources') return;

        const active = document.activeElement;
        const focusSelector = item.contains(active)
            ? (active.classList.contains('pas-row-side') ? '.pas-row-side' : active.classList.contains('pas-row') ? '.pas-row' : null)
            : null;
        const wasCurrent = item.querySelector('.pas-row')?.tabIndex === 0;
        const source = SOURCE_BY_ID.get(sourceId);
        const fresh = source.group === 'direct' ? buildDirectRow(source, ctx) : buildLinkRow(source, ctx);
        if (!fresh) return;
        fresh.hidden = item.hidden;
        item.replaceWith(fresh);
        if (wasCurrent) fresh.querySelector('.pas-row').tabIndex = 0;
        if (focusSelector) fresh.querySelector(focusSelector)?.focus({ preventScroll: true });
    }

    function applyFilter() {
        const menu = state.menu;
        if (!menu || menu.view !== 'sources') return;
        const query = menu.filter.value.trim().toLowerCase();
        let visibleTotal = 0;
        menu.body.querySelectorAll('.pas-section').forEach(section => {
            let visible = 0;
            section.querySelectorAll(':scope > .pas-list > .pas-item').forEach(item => {
                const show = !query || item.dataset.filter.includes(query);
                item.hidden = !show;
                if (show) visible += 1;
            });
            section.hidden = Boolean(query) && visible === 0;
            visibleTotal += visible;
        });
        const noMatch = menu.body.querySelector('.pas-no-match');
        if (noMatch) noMatch.hidden = !query || visibleTotal > 0;
        syncRoving();
    }

    function recheckSources() {
        const ctx = state.mount?.ctx;
        if (!ctx) return;
        // Forget finished checks and results, but leave running checks and downloads alone (a cleared "busy"
        // flag would let a second click start a duplicate download).
        for (const [key, entry] of [...probeCache]) {
            if (key.startsWith(`${ctx.packageId}|`) && entry.result.state !== 'loading') probeCache.delete(key);
        }
        for (const [sourceId, action] of [...state.menu.actions]) {
            if (!action.busy) state.menu.actions.delete(sourceId);
        }
        renderSourcesView();
        runProbes(ctx);
    }

    // ---------------------------------------------------------------- settings view

    function renderSettingsView(focus = false) {
        const menu = state.menu;
        const ctx = state.mount.ctx;
        menu.view = 'settings';
        menu.root.setAttribute('aria-label', 'APK source settings');
        menu.filterWrap.hidden = true;

        const update = (apply) => value => {
            apply(value);
            saveSettings();
        };
        const general = el('section', { className: 'pas-section', 'aria-label': 'General' },
            el('h3', { className: 'pas-section-title', text: 'General' }),
            switchRow('Show modded APK sites', 'Unverified repackaged apps. Off by default.', settings.showMods, update(v => { settings.showMods = v; })),
            switchRow('Show Morphe patches', 'Badge and menu section when patches exist for the app.', settings.showPatches, update(v => {
                settings.showPatches = v;
                syncPatchChip();
            })),
            el('p', { className: 'pas-note pas-patch-status', role: 'status', text: patchStatusText() }),
            switchRow('Check availability automatically', 'Asks direct-download sources in the background when the menu opens.', settings.autoCheck, update(v => { settings.autoCheck = v; })),
            switchRow('Open downloads in a new tab', 'When off, downloads start from this tab.', settings.openInNewTab, update(v => { settings.openInNewTab = v; })));

        const groups = ['direct', 'stores', 'mods'].map(groupId => el('section', { className: 'pas-section', 'aria-label': GROUPS[groupId].label },
            el('h3', { className: 'pas-section-title', text: GROUPS[groupId].label }),
            SOURCES.filter(source => source.group === groupId).map(source => switchRow(
                source.label,
                safeHost(source.page ? source.page(ctx) : source.url(ctx)),
                settings.sources[source.id] !== false,
                update(v => { settings.sources[source.id] = v; })))));

        const support = el('section', { className: 'pas-section', 'aria-label': 'Support Sideport' },
            el('div', { className: 'pas-support-card' },
                el('span', { className: 'pas-row-text' },
                    el('span', { className: 'pas-row-label', text: 'Enjoying Sideport?' }),
                    el('span', { className: 'pas-row-sub pas-wrap', text: 'It’s free, with no ads or tracking. A coffee on Ko-fi keeps it maintained.' }),
                    el('a', {
                        className: 'pas-more-link', href: AUTHOR_PATCHES_URL, target: '_blank', rel: 'noopener noreferrer',
                        title: 'Morphe patches by heval99 on GitHub'
                    }, icon('extension'), 'Check out my Morphe patches →')),
                supportLink('Ko-fi', 'pas-support-filled')));

        menu.body.replaceChildren(general, support, ...groups);
        menu.footer.replaceChildren(
            el('button', { type: 'button', className: 'pas-text-btn', onClick: backToSources }, icon('back'), 'Back'),
            el('button', { type: 'button', className: 'pas-text-btn', title: 'Download the latest Morphe patch list', onClick: refreshPatchList }, icon('refresh'), 'Patch list'),
            el('button', {
                type: 'button', className: 'pas-text-btn',
                onClick: () => {
                    settings = defaultSettings();
                    saveSettings();
                    syncPatchChip();
                    renderSettingsView(true);
                    showToast('Settings reset to defaults');
                }
            }, 'Reset'));
        positionMenu();
        if (focus) menu.body.querySelector('input')?.focus();
    }

    function backToSources() {
        renderSourcesView();
        positionMenu();
        focusFirstRow();
        if (settings.autoCheck) runProbes(state.mount.ctx);
    }

    function supportLink(text, extraClass = '') {
        return el('a', {
            className: `pas-text-btn pas-support ${extraClass}`.trim(), href: DONATE_URL, target: '_blank', rel: 'noopener noreferrer',
            title: 'Support Sideport on Ko-fi', 'aria-label': 'Support Sideport on Ko-fi (opens in a new tab)'
        }, icon('heart'), text);
    }

    function switchRow(label, description, checked, onChange) {
        const input = el('input', { type: 'checkbox', role: 'switch', checked });
        input.addEventListener('change', () => onChange(input.checked));
        return el('label', { className: 'pas-switch' },
            el('span', { className: 'pas-row-text' },
                el('span', { className: 'pas-row-label', text: label }),
                description ? el('span', { className: 'pas-row-sub pas-wrap', text: description }) : null),
            input);
    }

    // ---------------------------------------------------------------- keyboard

    function rowElements() {
        return [...state.menu.body.querySelectorAll('.pas-item:not([hidden]) .pas-row')].filter(row => !row.closest('[hidden]'));
    }

    function syncRoving(active) {
        const rows = rowElements();
        const current = active
            || rows.find(row => row === document.activeElement)
            || rows.find(row => row.tabIndex === 0)
            || rows[0];
        state.menu.body.querySelectorAll('.pas-row').forEach(row => { row.tabIndex = row === current ? 0 : -1; });
    }

    function focusRow(row) {
        if (!row) return;
        syncRoving(row);
        row.focus();
        row.scrollIntoView({ block: 'nearest' });
    }

    function focusFirstRow() {
        const first = rowElements()[0];
        if (first) focusRow(first); else state.menu.filter.focus();
    }

    function handleMenuKeydown(event) {
        const menu = state.menu;
        event.stopPropagation(); // keep Play's keyboard shortcuts out of the filter box

        if (event.key === 'Escape') {
            event.preventDefault();
            if (menu.view === 'settings') backToSources(); else closeMenu(true);
            return;
        }
        if (event.key === 'Tab') {
            trapFocus(event);
            return;
        }
        if (menu.view !== 'sources') return;

        const rows = rowElements();
        const target = event.target;
        const row = target.classList?.contains('pas-row')
            ? target
            : target.classList?.contains('pas-row-side') ? target.parentElement.querySelector('.pas-row') : null;
        const index = row ? rows.indexOf(row) : -1;

        switch (event.key) {
            case 'ArrowDown':
                if (target === menu.filter || target === menu.root) focusRow(rows[0]);
                else if (index >= 0) focusRow(rows[Math.min(index + 1, rows.length - 1)]);
                else return;
                break;
            case 'ArrowUp':
                if (index === 0) menu.filter.focus();
                else if (index > 0) focusRow(rows[index - 1]);
                else return;
                break;
            case 'Home':
                if (index < 0) return;
                focusRow(rows[0]);
                break;
            case 'End':
                if (index < 0) return;
                focusRow(rows[rows.length - 1]);
                break;
            case 'ArrowRight': {
                const side = target === row && row.parentElement.querySelector('.pas-row-side');
                if (!side) return;
                side.focus();
                break;
            }
            case 'ArrowLeft':
                if (!target.classList?.contains('pas-row-side')) return;
                row.focus();
                break;
            case ' ':
                if (target.tagName !== 'A') return;
                target.click();
                break;
            default:
                return;
        }
        event.preventDefault();
    }

    function trapFocus(event) {
        const focusables = [...state.menu.root.querySelectorAll('button, a[href], input')]
            .filter(node => node.tabIndex >= 0 && !node.disabled && !node.closest('[hidden]'));
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && (active === first || active === state.menu.root)) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
        }
    }

    // ---------------------------------------------------------------- downloads

    async function startDownload(source, ctx) {
        if (state.menu?.actions.get(source.id)?.busy) return;
        const cached = source.probe ? probeCache.get(probeKey(ctx, source)) : null;
        if (cached?.result.state === 'missing' && isReusable(cached, ctx, false)) {
            setAction(source.id, { text: 'Not found here — try the site ↗', tone: 'error' });
            return;
        }

        // Open the tab now, while we still have the user's click; popup blockers reject window.open after awaits.
        // Skipped when the source is already known to offer several variants, since the user picks from a list.
        const expectChoice = source.offersVariants && (cached?.result.data?.files?.length || 0) > 1;
        const pendingTab = settings.openInNewTab && !expectChoice ? openPendingTab(source.label) : null;
        setAction(source.id, { busy: true, text: 'Finding the download…' });
        try {
            const probe = source.probe ? await getProbe(ctx, source, { refreshUnknown: true }) : null;
            if (probe?.state === 'missing') throw new NotListed();
            const result = await source.resolve(ctx, probe?.state === 'ok' ? probe.data : null);
            assertCurrent(ctx);

            // Drop anything that isn't a valid https link, and mark files outside the source's own domains.
            const files = (result.files || [])
                .map(file => ({ ...file, url: safeHttpsUrl(file.url) }))
                .filter(file => file.url)
                .map(file => ({ ...file, trusted: isAllowedHost(file.url, source.hosts) }));
            if (!files.length) throw new SourceFailure('No download found');
            const allTrusted = files.every(file => file.trusted);

            if (!allTrusted || (result.kind === 'choice' && files.length > 1)) {
                pendingTab?.close();
                setAction(source.id, allTrusted
                    ? { text: `${files.length} files — pick one below`, files, filesIntro: 'Variants (APK / XAPK / architecture):' }
                    : { text: 'Unrecognised download host — check before opening', tone: 'warn', files });
                return;
            }

            if (!navigateTo(files[0].url, pendingTab)) {
                setAction(source.id, { text: 'Popup blocked — use the link below', tone: 'warn', files });
                return;
            }
            const version = probe?.version ? ` · v${probe.version}` : '';
            setAction(source.id, files.length > 1
                ? { text: `Started ${files[0].label} — ${files.length - 1} more below`, tone: 'ok', files, filesIntro: 'All parts are needed to install (use a split-APK installer):' }
                : { text: `Download started${version}`, tone: 'ok' });
        } catch (error) {
            pendingTab?.close();
            if (error instanceof PageChanged) {
                // A request from an earlier visit was cancelled; if this visit is still current, let the user retry.
                if (ctx.sessionId === state.sessionId) setAction(source.id, { text: 'Interrupted — click to retry', tone: 'warn' });
                return;
            }
            if (!(error instanceof NotListed)) {
                console.warn(`${LOG_PREFIX} ${source.label} failed`, error);
                rememberFailure(source.label, error);
            }
            setAction(source.id, {
                text: error instanceof NotListed ? 'Not found here — try the site ↗' : `${failureText(error)} — retry or open the site ↗`,
                tone: 'error'
            });
        }
    }

    function setAction(sourceId, action) {
        if (!state.menu) return;
        state.menu.actions.set(sourceId, { busy: false, ...action });
        updateRow(sourceId);
    }

    function openPendingTab(label) {
        const tab = window.open('', '_blank');
        if (!tab) return null;
        try {
            tab.opener = null;
            tab.document.title = `Preparing ${label} download…`;
            const message = tab.document.createElement('p');
            message.textContent = `Preparing the ${label} download… It will start in a moment. You can close this tab afterwards.`;
            message.style.font = '16px system-ui, sans-serif';
            message.style.margin = '48px auto';
            message.style.maxWidth = '36em';
            tab.document.body.append(message);
        } catch {
            // The tab is still usable as a navigation target.
        }
        return tab;
    }

    function navigateTo(url, tab) {
        if (!settings.openInNewTab) {
            window.location.assign(url);
            return true;
        }
        if (tab && !tab.closed) {
            tab.location.replace(url);
            return true;
        }
        const opened = window.open(url, '_blank');
        if (!opened) return false;
        try {
            opened.opener = null;
        } catch {
            // Cross-origin already; nothing to detach.
        }
        return true;
    }

    // ---------------------------------------------------------------- probes

    function probeKey(ctx, source) {
        return `${ctx.packageId}|${source.id}`;
    }

    function getCachedProbe(ctx, source) {
        return probeCache.get(probeKey(ctx, source))?.result;
    }

    // Finished results are shared across visits to the same app; an unfinished one belongs to the visit that
    // started it (navigation cancels it), so a later visit starts its own.
    function isReusable(entry, ctx, refreshUnknown) {
        if (!entry) return false;
        const { state: status } = entry.result;
        if (status === 'loading') return entry.sessionId === ctx.sessionId;
        if (status === 'unknown') return !refreshUnknown;
        if (status === 'missing') return Date.now() - entry.settledAt < MISSING_RESULT_TTL_MS;
        return true;
    }

    function getProbe(ctx, source, { refreshUnknown = false } = {}) {
        const key = probeKey(ctx, source);
        const entry = probeCache.get(key);
        if (isReusable(entry, ctx, refreshUnknown)) return entry.promise;

        if (probeCache.size > 400) probeCache.clear();
        const fresh = { result: { state: 'loading' }, sessionId: ctx.sessionId, settledAt: 0 };
        fresh.promise = withProbeSlot(() => source.probe(ctx))
            .then(
                result => ({ state: 'ok', ...result }),
                error => {
                    if (error instanceof PageChanged) throw error;
                    if (error instanceof NotListed) return { state: 'missing' };
                    rememberFailure(`${source.label} (check)`, error);
                    return { state: 'unknown', message: failureText(error) };
                })
            .then(result => {
                fresh.result = result;
                fresh.settledAt = Date.now();
                updateRow(source.id);
                return result;
            }, error => {
                if (probeCache.get(key) === fresh) probeCache.delete(key);
                throw error;
            });
        probeCache.set(key, fresh);
        updateRow(source.id);
        return fresh.promise;
    }

    // Store lookups are harmless for paid apps too; direct-download checks only run for free apps.
    function runProbes(ctx) {
        [...(ctx.isFree ? enabledSources('direct') : []), ...enabledSources('stores')]
            .filter(source => source.probe)
            .forEach(source => getProbe(ctx, source).catch(() => {}));
    }

    function withProbeSlot(task) {
        return new Promise((resolve, reject) => {
            const run = () => {
                activeProbes += 1;
                Promise.resolve()
                    .then(task)
                    .then(resolve, reject)
                    .finally(() => {
                        activeProbes -= 1;
                        probeQueue.shift()?.();
                    });
            };
            if (activeProbes < PROBE_CONCURRENCY) run(); else probeQueue.push(run);
        });
    }

    // ---------------------------------------------------------------- sources

    function apkPureDirectUrl(ctx, variant) {
        return `https://d.apkpure.com/b/${variant}/${ctx.encodedPackageId}?version=latest`;
    }

    // HEAD follows the redirect to winudf.com without downloading the file.
    async function probeApkPure(ctx, variant) {
        const result = await gmFetch(apkPureDirectUrl(ctx, variant), ctx, { method: 'HEAD' });
        if (hostMatches(safeHost(result.finalUrl), ['winudf.com'])) {
            const fileName = fileNameFromHeaders(result.headers) || safeDecode(new URL(result.finalUrl).pathname);
            return { version: versionFromFileName(fileName) };
        }
        expectSuccess(result);
        throw new SourceFailure('No download redirect');
    }

    // APKCombo's download page lists every variant (APK/XAPK, per architecture). Each entry is either a signed
    // storage link wrapped in /r2?u=… or a site link that needs the visitor's check-in token appended.
    async function probeApkCombo(ctx) {
        const url = `https://apkcombo.com/genericApp/${ctx.encodedPackageId}/download/apk`;
        const page = await fetchText(url, ctx);
        const pageUrl = page.finalUrl || url;
        const files = listApkComboVariants(page.text, pageUrl);
        if (!files.length) throw new SourceFailure('No files listed');
        const version = files.map(file => VERSION_RE.exec(file.label)?.[0]).find(Boolean) || null;
        return { version, pageUrl, data: { files, pageUrl } };
    }

    function listApkComboVariants(markup, pageUrl) {
        const variants = new Map();
        for (const anchor of parseMarkup(markup).querySelectorAll('.file-list a[href]')) {
            const link = tryParseUrl(anchor.getAttribute('href'), pageUrl);
            if (!link) continue;
            const wrapped = link.pathname === '/r2' ? tryParseUrl(link.searchParams.get('u')) : null;
            const target = wrapped || link;
            if (target.protocol !== 'https:' || variants.has(target.href)) continue;
            variants.set(target.href, {
                url: target.href,
                label: cleanText(anchor.textContent).slice(0, 80) || `Variant ${variants.size + 1}`,
                needsToken: !wrapped
            });
        }
        return [...variants.values()];
    }

    async function resolveApkCombo(ctx, data) {
        const { files, pageUrl } = data || (await probeApkCombo(ctx)).data;
        if (!files.some(file => file.needsToken)) return { files, kind: 'choice' };

        const token = await fetchText('https://apkcombo.com/checkin', ctx, {
            method: 'POST',
            headers: { Referer: pageUrl, Origin: 'https://apkcombo.com' }
        }).then(result => result.text.trim().replace(/^&+/, ''), () => '');
        const usable = /^[\w.~%=&-]{1,999}$/.test(token);
        return {
            files: files.map(file => (file.needsToken && usable ? { ...file, url: appendQuery(file.url, token) } : file)),
            kind: 'choice'
        };
    }

    async function probeAptoide(ctx) {
        const result = await fetchJson(`https://web-api.aptoide.com/search?query=${ctx.encodedPackageId}`, ctx);
        const listing = (result.json?.datalist?.list || []).find(entry => entry?.package === ctx.packageId);
        const files = listing ? aptoideParts(listing) : [];
        if (!files.length) throw new NotListed();
        return { version: listing.file?.vername || null, data: { files } };
    }

    // Base APK first, then any split APKs and expansion (OBB) files that must be installed with it.
    function aptoideParts(listing) {
        const parts = [];
        const add = (path, label) => {
            if (typeof path === 'string' && path) parts.push({ url: path.replace(/^http:\/\//i, 'https://'), label });
        };
        add(listing.file?.path, 'Base APK');
        (listing.aab?.splits || []).forEach((split, position) => add(split?.path, split?.name ? `Split · ${split.name}` : `Split ${position + 1}`));
        Object.entries(listing.obb || {}).forEach(([kind, entry]) => add(entry?.path, `OBB · ${kind}`));
        return parts;
    }

    // Uptodown's search, queried with a package id, returns exactly that app, or an "empty-search" list
    // followed by unrelated suggestions, so the empty marker must be checked first.
    async function probeUptodown(ctx) {
        const page = await fetchText(`https://en.uptodown.com/android/search?query=${ctx.encodedPackageId}`, ctx);
        if (page.text.includes('data-list-name="empty-search"')) throw new NotListed();
        const appPage = /https:\/\/[a-z0-9-]+\.en\.uptodown\.com\/android/.exec(page.text)?.[0];
        if (!appPage) throw new NotListed();
        return { version: null, pageUrl: `${appPage}/download` };
    }

    // Other F-Droid-format repos, read through IzzyOnDroid's multi-repo browser. The page lists direct APK
    // links (newest first) and a "Version:" row; it answers 404 when the repo doesn't carry the app.
    function izzyRepoSource({ id, label, color, repo, hint, hosts, defaultOn }) {
        const page = ctx => `https://apt.izzysoft.de/fdroid/index/apk/${ctx.encodedPackageId}?repo=${repo}`;
        const probe = async ctx => {
            const result = await fetchText(page(ctx), ctx);
            const doc = parseMarkup(result.text);
            const apk = [...doc.querySelectorAll('a[href]')]
                .map(anchor => tryParseUrl(anchor.getAttribute('href'), result.finalUrl))
                .find(url => url?.protocol === 'https:' && /\.apk$/i.test(url.pathname));
            if (!apk) throw new NotListed();
            // The row is labelled "Version:" or "Last Version:" depending on the page.
            const versionCell = [...doc.querySelectorAll('td')].find(cell => /^(?:Last\s*)?Version:$/i.test(cleanText(cell.textContent)));
            const version = cleanText(versionCell?.nextElementSibling?.textContent) || null;
            return { version, data: { files: [{ url: apk.href, label: `APK${version ? ` \u00b7 v${version}` : ''}` }] } };
        };
        return {
            id, group: 'direct', label, color, hint, hosts, page, probe, defaultOn,
            resolve: async (ctx, data) => ({ files: (data || (await probe(ctx)).data).files })
        };
    }

    function fdroidRepoSource({ id, label, color, apiBase, repoBase, page, hosts }) {
        const probe = ctx => probeFdroidRepo(ctx, apiBase, repoBase);
        return {
            id, group: 'direct', label, color, hint: 'Open-source build', hosts, page, probe,
            resolve: async (ctx, data) => ({ files: (data || (await probe(ctx)).data).files })
        };
    }

    async function probeFdroidRepo(ctx, apiBase, repoBase) {
        const info = (await fetchJson(`${apiBase}/${ctx.encodedPackageId}`, ctx)).json;
        const builds = (Array.isArray(info?.packages) ? info.packages : [])
            .filter(build => Number.isSafeInteger(Number(build?.versionCode)));
        if (!builds.length) throw new SourceFailure('No builds listed');

        // Prefer the suggested version, but only if the repo actually has a build for it; otherwise the newest
        // build. The file name must use the version code of the build we pick, or the link 404s.
        const suggested = String(info?.suggestedVersionCode ?? '');
        const build = builds.find(candidate => String(candidate.versionCode) === suggested)
            || builds.reduce((newest, candidate) => (Number(candidate.versionCode) > Number(newest.versionCode) ? candidate : newest));
        const versionCode = Number(build.versionCode);
        const versionName = build.versionName || String(versionCode);
        return {
            version: versionName,
            data: { files: [{ url: `${repoBase}/${ctx.encodedPackageId}_${versionCode}.apk`, label: `APK · v${versionName}` }] }
        };
    }

    // ---------------------------------------------------------------- Morphe patches

    // Returns the index right away (stale-while-revalidate). Checks Morphe for changes when the index is older
    // than PATCH_INDEX_TTL_MS, or sooner when the app being viewed isn't in it yet. Changes reach the open page
    // through onPatchIndexUpdated(). Only the very first load, with nothing cached, waits for the network.
    // The index has two independently revalidated parts, each { etag, apps }:
    //   community: { pkg: { name, inStore, bundles: [{ bundle, author, patches, versions }] } }  (bundles.json)
    //   official:  { pkg: { name, patches, versions } }                                          (patches-list.json)
    // Storage is split the same way: a small meta record (fetchedAt + ETags) that is rewritten on every check,
    // and the data record, which is only rewritten when Morphe actually changed something.
    async function getPatchIndex(packageId) {
        patchIndexStoragePromise ||= readCachedPatchIndex().then(cached => {
            if (cached && (!patchIndex || cached.fetchedAt > patchIndex.fetchedAt)) patchIndex = cached;
        });
        await patchIndexStoragePromise;

        const age = patchIndex ? Date.now() - patchIndex.fetchedAt : Infinity;
        const missingApp = Boolean(packageId) && !patchInfo(packageId);
        if (age >= PATCH_INDEX_TTL_MS || (missingApp && age >= PATCH_INDEX_MISSING_RECHECK_MS)) {
            const refresh = refreshPatchIndex();
            if (!patchIndex) return refresh;
        }
        return patchIndex;
    }

    function refreshPatchIndex({ force = false } = {}) {
        if (patchRefreshPromise) return patchRefreshPromise;
        if (!force && Date.now() - patchIndexFailedAt < PATCH_INDEX_RETRY_MS) return Promise.resolve(patchIndex);

        const previous = patchIndex;
        patchRefreshPromise = (async () => {
            const base = await newestKnownIndex(previous);
            // Another tab checked moments ago: use its result instead of asking Morphe again.
            const index = !force && base && Date.now() - base.fetchedAt < PATCH_INDEX_MISSING_RECHECK_MS
                ? base
                : await fetchPatchIndex(base);
            patchIndex = index;
            patchIndexFailedAt = 0;
            // A 304 keeps the same apps objects, so only real changes redraw the page.
            if (!previous || index.community.apps !== previous.community.apps || index.official.apps !== previous.official.apps) {
                onPatchIndexUpdated();
            }
            return index;
        })()
            .catch(error => {
                console.warn(`${LOG_PREFIX} Could not load the Morphe patch list`, error);
                patchIndexFailedAt = Date.now();
                return patchIndex;
            })
            .finally(() => {
                patchRefreshPromise = null;
                updatePatchStatus();
            });
        return patchRefreshPromise;
    }

    function onPatchIndexUpdated() {
        const mount = state.mount;
        if (mount) renderPatchChip(mount.root, mount.anchor, mount.ctx);
        const menu = state.menu;
        if (menu?.open && menu.view === 'sources' && mount) {
            const hadFocus = menu.body.contains(document.activeElement);
            renderSourcesView();
            positionMenu();
            if (hadFocus) focusFirstRow();
        }
    }

    function patchAppCount(index) {
        return new Set([...Object.keys(index.community.apps), ...Object.keys(index.official.apps)]).size;
    }

    function patchStatusText() {
        if (!patchIndex) return patchRefreshPromise ? 'Downloading the Morphe patch list…' : 'Morphe patch list not downloaded yet';
        return `Morphe list: ${patchAppCount(patchIndex)} apps · checked ${relativeTime(patchIndex.fetchedAt)}`;
    }

    function updatePatchStatus() {
        const status = state.menu?.body.querySelector('.pas-patch-status');
        if (status) status.textContent = patchStatusText();
    }

    function relativeTime(timestamp) {
        const minutes = Math.round((Date.now() - timestamp) / 60000);
        if (minutes < 1) return 'just now';
        if (minutes < 60) return `${minutes} min ago`;
        const hours = Math.round(minutes / 60);
        return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
    }

    function isIndexPart(part) {
        return Boolean(part) && typeof part === 'object' && Boolean(part.apps) && typeof part.apps === 'object';
    }

    async function readPatchMeta() {
        try {
            const meta = await GM.getValue(PATCH_META_KEY, null);
            return meta && Number.isFinite(meta.fetchedAt) ? meta : null;
        } catch {
            return null;
        }
    }

    async function readCachedPatchIndex() {
        try {
            const [meta, data] = await Promise.all([readPatchMeta(), GM.getValue(PATCH_DATA_KEY, null)]);
            if (!meta || !isIndexPart(data?.community) || !isIndexPart(data?.official)) return null;
            return { fetchedAt: meta.fetchedAt, community: data.community, official: data.official };
        } catch {
            return null;
        }
    }

    // The newest index any tab has produced: the in-memory one, or a newer stored one. Only reads the
    // (large) data record when the stored ETags show its content differs from what this tab already has.
    async function newestKnownIndex(current) {
        const meta = await readPatchMeta();
        if (!meta || meta.fetchedAt <= (current?.fetchedAt || 0)) return current;
        if (current && meta.communityEtag === current.community.etag && meta.officialEtag === current.official.etag) {
            return { ...current, fetchedAt: meta.fetchedAt };
        }
        return (await readCachedPatchIndex()) || current;
    }

    async function fetchPatchIndex(base) {
        const [community, official] = await Promise.all([
            fetchIndexPart(MORPHE_BUNDLES_URL, base?.community, buildCommunityIndex),
            // The official list is optional: on failure keep what we had. With no ETag stored for it, the next
            // check downloads it in full again, so a failure can't get stuck behind a 304.
            fetchIndexPart(MORPHE_OFFICIAL_URL, base?.official, buildOfficialIndex).catch(error => {
                console.warn(`${LOG_PREFIX} Could not load official Morphe patches`, error);
                return base?.official ? { ...base.official, etag: null } : { etag: null, apps: {} };
            })
        ]);
        const index = { fetchedAt: Date.now(), community, official };
        const save = (key, value) => Promise.resolve(GM.setValue(key, value))
            .catch(error => console.warn(`${LOG_PREFIX} Could not cache the patch list`, error));
        if (community.apps !== base?.community.apps || official.apps !== base?.official.apps) {
            await save(PATCH_DATA_KEY, { community, official });
        }
        save(PATCH_META_KEY, { fetchedAt: index.fetchedAt, communityEtag: community.etag, officialEtag: official.etag });
        return index;
    }

    // Conditional GET: a 304 returns the previous part unchanged (same object), anything else is rebuilt.
    async function fetchIndexPart(url, previous, build) {
        const headers = previous?.etag ? { 'If-None-Match': previous.etag } : undefined;
        const reply = await gmFetch(url, null, { headers, timeout: PATCH_INDEX_TIMEOUT_MS });
        if (reply.status === 304 && previous) return previous;
        expectSuccess(reply);
        let json;
        try {
            json = JSON.parse(reply.text);
        } catch {
            throw new SourceFailure('Unexpected response');
        }
        const etag = reply.headers.match(/^etag:\s*(.+?)\s*$/im)?.[1] || null;
        const apps = build(json);
        // Same content without a 304 (e.g. the server sent no ETag): keep the old object so nothing redraws.
        if (previous && JSON.stringify(apps) === JSON.stringify(previous.apps)) return { etag, apps: previous.apps };
        return { etag, apps };
    }

    // Reduces the ~2 MB community catalog to the per-app summary the UI needs. Bundles are third-party data,
    // so one malformed bundle is skipped instead of failing the whole index.
    function buildCommunityIndex(data) {
        const apps = {};
        const store = data?.store && typeof data.store === 'object' ? data.store : {};
        const compatibilities = Array.isArray(data?.compatibilities) ? data.compatibilities : [];
        for (const bundle of Array.isArray(data?.bundles) ? data.bundles : []) {
            try {
                const perApp = countPatchesByPackage(bundle?.patches, patch => {
                    const key = patch.compatiblePackagesKey ?? patch.compatibilityKey;
                    return Array.isArray(patch.compatiblePackages) ? patch.compatiblePackages : compatibilities[key];
                });
                for (const [packageName, info] of perApp) {
                    apps[packageName] ||= { name: String(store[packageName]?.name || info.name || ''), inStore: Boolean(store[packageName]), bundles: [] };
                    apps[packageName].bundles.push({
                        bundle: String(bundle.name || bundle.repo || 'Patch bundle').slice(0, 60),
                        author: String(bundle.author || '').slice(0, 40),
                        repo: /^[\w.-]+\/[\w.-]+$/.test(bundle.repo || '') ? bundle.repo : null,
                        patches: info.count,
                        versions: latestVersions(info.versions)
                    });
                }
            } catch (error) {
                console.warn(`${LOG_PREFIX} Skipped a malformed Morphe bundle`, error);
            }
        }
        for (const app of Object.values(apps)) app.bundles.sort((a, b) => b.patches - a.patches);
        return apps;
    }

    function buildOfficialIndex(data) {
        const apps = {};
        for (const [packageName, info] of countPatchesByPackage(data?.patches, patch => patch.compatiblePackages)) {
            apps[packageName] = { name: String(info.name || ''), patches: info.count, versions: latestVersions(info.versions) };
        }
        return apps;
    }

    // Accepts both patch-list shapes: [{packageName, targets|versions}] and {packageName: [versions]}.
    function countPatchesByPackage(patches, getCompatible) {
        const list = value => (Array.isArray(value) ? value : []);
        const perApp = new Map();
        for (const patch of list(patches)) {
            if (!patch || typeof patch !== 'object') continue;
            const compatible = getCompatible(patch);
            const targets = Array.isArray(compatible)
                ? compatible.map(item => ({
                    packageName: item?.packageName,
                    name: item?.name,
                    versions: list(item?.targets).map(target => target?.version).concat(list(item?.versions))
                }))
                : compatible && typeof compatible === 'object'
                    ? Object.entries(compatible).map(([packageName, versions]) => ({ packageName, versions: list(versions) }))
                    : [];
            for (const target of targets) {
                if (!toPackageId(target.packageName)) continue;
                const info = perApp.get(target.packageName) || { count: 0, name: target.name, versions: new Set() };
                info.count += 1;
                target.versions.forEach(version => version && info.versions.add(String(version)));
                perApp.set(target.packageName, info);
            }
        }
        return perApp;
    }

    // Newest first. Only the leading dotted number counts ("1.2.3-beta4" → 1.2.3); on a tie, a plain release
    // ranks above a pre-release.
    function latestVersions(versions) {
        const numbers = version => (version.match(/^\d+(?:\.\d+)*/)?.[0] || '0').split('.').map(Number);
        const isPreRelease = version => /^\d+(?:\.\d+)*\D/.test(version);
        return [...versions]
            .sort((a, b) => {
                const left = numbers(a);
                const right = numbers(b);
                for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
                    if ((left[i] || 0) !== (right[i] || 0)) return (right[i] || 0) - (left[i] || 0);
                }
                return isPreRelease(a) - isPreRelease(b);
            })
            .slice(0, 3);
    }

    // Merged view of both index parts for one app, or null when Morphe has nothing for it.
    function patchInfo(packageId) {
        if (!patchIndex) return null;
        const community = patchIndex.community.apps[packageId];
        const official = patchIndex.official.apps[packageId];
        if (!community?.bundles.length && !official) return null;
        return {
            name: community?.name || official?.name || '',
            inStore: Boolean(community?.inStore),
            community: community?.bundles || [],
            official: official || null
        };
    }

    function pluralPatches(count) {
        return `${count} patch${count === 1 ? '' : 'es'}`;
    }

    function morpheAppUrl(ctx, app) {
        return app.inStore && app.community.length
            ? `https://morphe-patches.software/?app=${ctx.encodedPackageId}#apps`
            : MORPHE_OFFICIAL_PAGE;
    }

    function patchSources(ctx) {
        const app = patchInfo(ctx.packageId);
        if (!app) return [];
        const appUrl = morpheAppUrl(ctx, app);
        const describe = (patches, versions) => `${pluralPatches(patches)}${versions[0] ? ` · v${versions[0]}` : ''}`;
        const rows = [];
        if (app.official) {
            rows.push({ id: 'morphe-official', label: 'Morphe (official)', color: MORPHE_BLUE, badge: 'Patch', badgeClass: 'pas-badge-morphe', url: MORPHE_OFFICIAL_PAGE, hint: describe(app.official.patches, app.official.versions) });
        }
        const bundles = app.community.map(bundle => ({ ...bundle, recommended: isRecommendedBundle(bundle.repo) }));
        // Stable sort: recommended first, otherwise keep the patch-count order from the index.
        bundles.sort((a, b) => b.recommended - a.recommended);
        bundles.forEach((bundle, index) => rows.push({
            id: `morphe-${index}`, label: bundle.bundle, color: MORPHE_TEAL,
            badge: bundle.recommended ? 'Recommended' : 'Patch', badgeClass: 'pas-badge-morphe',
            url: bundle.recommended && bundle.repo ? `https://github.com/${bundle.repo}` : appUrl,
            hint: `${bundle.author ? `by ${bundle.author} · ` : ''}${describe(bundle.patches, bundle.versions)}`
        }));
        return rows;
    }

    function isRecommendedBundle(repo) {
        if (!repo) return false;
        const [owner, name] = repo.toLowerCase().split('/');
        return RECOMMENDED_BUNDLES.some(entry => {
            const [wantOwner, wantName] = entry.toLowerCase().split('/');
            return owner === wantOwner && (wantName === '*' || name === wantName);
        });
    }

    async function attachPatchChip(root, anchor, ctx) {
        if (!settings.showPatches) return;
        await getPatchIndex(ctx.packageId);
        renderPatchChip(root, anchor, ctx);
    }

    // Adds, replaces or removes the chip to match the current index.
    function renderPatchChip(root, anchor, ctx) {
        if (ctx.sessionId !== state.sessionId || !root.isConnected) return;
        const existing = root.querySelector('.pas-chip');
        const app = settings.showPatches ? patchInfo(ctx.packageId) : null;
        if (!app) {
            existing?.remove();
            return;
        }

        const total = app.community.reduce((sum, bundle) => sum + bundle.patches, 0) + (app.official?.patches || 0);
        const sources = app.community.length + (app.official ? 1 : 0);
        const details = [
            app.official ? `Morphe official — ${pluralPatches(app.official.patches)}` : null,
            ...app.community.map(bundle => `${bundle.bundle}${bundle.author ? ` (${bundle.author})` : ''} — ${pluralPatches(bundle.patches)}${bundle.versions.length ? `, v${bundle.versions.join(' / ')}` : ''}`)
        ].filter(Boolean);
        const chip = el('a', {
            className: 'pas-chip', href: morpheAppUrl(ctx, app), target: '_blank', rel: 'noopener noreferrer',
            title: `Morphe patches for this app:\n${details.join('\n')}`,
            'aria-label': `Morphe patches available: ${pluralPatches(total)} from ${sources} source${sources === 1 ? '' : 's'}`
        }, icon('extension'), el('span', { text: `Morphe · ${pluralPatches(total)}` }));
        chip.addEventListener('click', event => event.stopPropagation());
        if (existing) existing.replaceWith(chip); else anchor.after(chip);
    }

    function syncPatchChip() {
        const mount = state.mount;
        if (!mount) return;
        if (settings.showPatches) {
            attachPatchChip(mount.root, mount.anchor, mount.ctx);
        } else {
            mount.root.querySelector('.pas-chip')?.remove();
        }
    }

    async function refreshPatchList() {
        showToast('Checking Morphe for changes…');
        const previous = patchIndex;
        updatePatchStatus();
        const index = await refreshPatchIndex({ force: true });
        if (!index || patchIndexFailedAt) {
            showToast('Could not reach Morphe — try again later');
            return;
        }
        const unchanged = previous && index.community.apps === previous.community.apps && index.official.apps === previous.official.apps;
        showToast(unchanged
            ? `Already up to date · ${patchAppCount(index)} apps`
            : `Patch list updated · ${patchAppCount(index)} apps`);
    }

    // ---------------------------------------------------------------- network

    // Every request goes through the userscript manager, which bypasses CORS for hosts listed under @connect.
    // ctx ties a request to the current page; pass null for page-independent work (the Morphe index).
    // Resolves to { status, finalUrl, headers, text } for any HTTP status; rejects only when nothing came back.
    // Uses the callback form of GM.xmlHttpRequest: Greasemonkey 4 returns undefined instead of a promise, while
    // Tampermonkey and Violentmonkey support callbacks too. Page-bound requests are registered so teardown()
    // can cancel them when the user navigates away.
    function gmFetch(url, ctx, { method = 'GET', headers, body, timeout = REQUEST_TIMEOUT_MS } = {}) {
        if (ctx !== null) assertCurrent(ctx);
        return new Promise((resolve, reject) => {
            let settled = false;
            let ticket = null;
            const finish = (outcome, value) => {
                if (settled) return;
                settled = true;
                if (ticket) inflightRequests.delete(ticket);
                if (ctx !== null && ctx.sessionId !== state.sessionId) reject(new PageChanged());
                else if (outcome === 'ok') resolve(value);
                else reject(value);
            };
            let control;
            try {
                control = GM.xmlHttpRequest({
                    url, method, headers, data: body, timeout,
                    onload: reply => (reply?.status
                        ? finish('ok', { status: reply.status, finalUrl: reply.finalUrl || url, headers: reply.responseHeaders || '', text: reply.responseText || '' })
                        : finish('fail', new SourceFailure('Network error'))),
                    onerror: failure => finish('fail', new SourceFailure(networkFailureReason(failure))),
                    ontimeout: () => finish('fail', new SourceFailure('Timed out')),
                    onabort: () => finish('fail', new SourceFailure('Cancelled'))
                });
            } catch (failure) {
                finish('fail', new SourceFailure(networkFailureReason(failure)));
                return;
            }
            // Tampermonkey also returns a promise that rejects on errors the callbacks already handle.
            if (typeof control?.then === 'function') control.then(null, () => {});
            if (ctx !== null && !settled) {
                ticket = {
                    sessionId: ctx.sessionId,
                    cancel: () => {
                        try {
                            control?.abort?.();
                        } catch {
                            // Already finished.
                        }
                        finish('fail', new PageChanged()); // settle even if the manager never fires onabort
                    }
                };
                inflightRequests.add(ticket);
            }
        });
    }

    async function fetchText(url, ctx, options) {
        return expectSuccess(await gmFetch(url, ctx, options));
    }

    async function fetchJson(url, ctx, options) {
        const result = await fetchText(url, ctx, options);
        try {
            return { ...result, json: JSON.parse(result.text) };
        } catch {
            throw new SourceFailure('Unexpected response');
        }
    }

    function expectSuccess(result) {
        const { status } = result;
        if (status === 404 || status === 410) throw new NotListed();
        if (isBotCheck(result)) throw new SourceFailure('Cloudflare check — open the site');
        if (status >= 200 && status < 300) return result;
        throw new SourceFailure(`HTTP ${status}`);
    }

    // Cloudflare answers automated requests with a 403/503 interstitial instead of the page.
    function isBotCheck({ status, headers, text }) {
        return (status === 403 || status === 503)
            && /cf-mitigated|challenge-platform|just a moment/i.test(`${headers}\n${text.slice(0, 4000)}`);
    }

    function networkFailureReason(failure) {
        const detail = [failure, failure?.error, failure?.message, failure?.type].filter(part => typeof part === 'string').join(' ');
        if (/timeout/i.test(detail)) return 'Timed out';
        if (/not (?:permitted|allowed)|@connect|blacklist|denied/i.test(detail)) return 'Blocked by script manager';
        return 'Network error';
    }

    function failureText(error) {
        return error instanceof SourceFailure ? error.message : 'Unexpected error';
    }

    function assertCurrent(ctx) {
        if (!ctx || ctx.sessionId !== state.sessionId) throw new PageChanged();
    }

    // ---------------------------------------------------------------- helpers

    function el(tag, props = {}, ...children) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(props)) {
            if (value == null || value === false) continue;
            if (key === 'className') node.className = value;
            else if (key === 'text') node.textContent = value;
            else if (key === 'dataset') Object.assign(node.dataset, value);
            else if (key === 'checked') node.checked = Boolean(value);
            else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
            else node.setAttribute(key, value === true ? '' : String(value));
        }
        node.append(...children.flat().filter(child => child != null && child !== false && child !== ''));
        return node;
    }

    function icon(name) {
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        svg.classList.add('pas-icon');
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', ICONS[name]);
        svg.append(path);
        return svg;
    }

    function dot(color) {
        const node = el('span', { className: 'pas-dot', 'aria-hidden': 'true' });
        node.style.setProperty('--pas-dot', color);
        return node;
    }

    function parseColor(value) {
        const match = (value || '').match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?/);
        if (!match) return null;
        const [red, green, blue] = match.slice(1, 4).map(Number);
        return { luminance: 0.2126 * red + 0.7152 * green + 0.0722 * blue, alpha: match[4] === undefined ? 1 : Number(match[4]) };
    }

    // Follows Play's own theme: the first opaque page background wins, the OS setting is only a last resort.
    function detectDarkTheme() {
        for (const element of [document.body, document.documentElement]) {
            const background = element && parseColor(getComputedStyle(element).backgroundColor);
            if (background && background.alpha > 0.5) return background.luminance < 128;
        }
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    // Play shows some app headers on a dark banner inside an otherwise light page, so buttons placed in the
    // page follow the text colour around them: light text means a dark backdrop.
    function detectContextDark(element) {
        const text = element ? parseColor(getComputedStyle(element).color) : null;
        return text ? text.luminance > 150 : detectDarkTheme();
    }

    function applyTheme(...nodes) {
        const pageTheme = detectDarkTheme() ? 'dark' : 'light';
        nodes.forEach(node => {
            if (!node) return;
            const inPage = ['pas-inline', 'pas-after-row', 'pas-after-heading'].some(name => node.classList.contains(name));
            node.dataset.theme = inPage ? (detectContextDark(node.parentElement) ? 'dark' : 'light') : pageTheme;
        });
    }

    function refreshTheme() {
        // Play repaints its own background first; wait a frame before sampling it.
        window.requestAnimationFrame(() => applyTheme(state.mount?.root, state.menu?.root, document.querySelector('.pas-toast')));
    }

    function showToast(message) {
        let toast = document.querySelector('.pas-toast');
        if (!toast) {
            toast = el('div', { className: 'pas-root pas-toast', role: 'status', 'aria-live': 'polite' });
            document.body.append(toast);
        }
        applyTheme(toast);
        toast.textContent = message;
        toast.classList.add('is-visible');
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2600);
    }

    async function copyText(text) {
        if (typeof GM?.setClipboard === 'function') {
            await GM.setClipboard(text, 'text');
        } else {
            await navigator.clipboard.writeText(text);
        }
    }

    async function copyPackageId() {
        const packageId = state.mount?.ctx.packageId;
        if (!packageId) {
            showToast('Open an app page on Google Play first');
            return;
        }
        try {
            await copyText(packageId);
            showToast(`Copied ${packageId}`);
        } catch {
            showToast('Could not copy the package ID');
        }
    }

    function rememberFailure(sourceLabel, error) {
        recentFailures.push({ source: sourceLabel, error: failureText(error), at: new Date().toISOString() });
        if (recentFailures.length > 5) recentFailures.shift();
    }

    // Everything needed to debug "the button doesn't show up" or "a source fails" from a user report.
    function collectDiagnostics() {
        const info = typeof GM !== 'undefined' ? GM.info : null;
        const route = getRoute();
        const mount = state.mount;
        return {
            sideport: info?.script?.version || 'unknown',
            manager: info ? `${info.scriptHandler || 'unknown'} ${info.version || ''}`.trim() : 'unknown',
            url: location.href,
            pageLanguage: document.documentElement.lang || null,
            signedIn: Boolean(document.querySelector('[aria-label*="Google Account" i], [aria-label*="account menu" i] img, a[href*="SignOutOptions"]')),
            route: route?.key || null,
            widgets: [...document.querySelectorAll('[data-item-id]')]
                .filter(element => element.getAttribute('data-item-id').includes('"'))
                .slice(0, 5)
                .map(element => `${element.getAttribute('data-item-id')}${isRendered(element) ? '' : ' (hidden)'} [${cleanText(element.textContent).slice(0, 30)}]`),
            hiddenPlacementsSkipped: state.hiddenPlacements,
            mounted: Boolean(mount?.root.isConnected),
            mountStrategy: MOUNT_STRATEGIES[state.strategy],
            removalsByPlay: state.remounts,
            package: mount?.ctx.packageId || null,
            paid: mount ? !mount.ctx.isFree : null,
            theme: mount?.root.dataset.theme || null,
            morpheList: patchIndex ? { apps: patchAppCount(patchIndex), checked: new Date(patchIndex.fetchedAt).toISOString() } : null,
            recentFailures
        };
    }

    async function copyDiagnostics() {
        try {
            await copyText(JSON.stringify(collectDiagnostics(), null, 2));
            showToast('Diagnostics copied — paste them into your GitHub issue');
        } catch {
            showToast('Could not copy diagnostics');
        }
    }

    function tryParseUrl(value, base) {
        if (typeof value !== 'string' || !value) return null;
        try {
            return new URL(value, base);
        } catch {
            return null;
        }
    }

    // Everything Sideport links to or opens must be an absolute https:// URL.
    function toHttpsUrl(value) {
        const url = tryParseUrl(value, location.href);
        if (!url) throw new SourceFailure('Invalid link');
        if (url.protocol !== 'https:') throw new SourceFailure('Insecure link blocked');
        return url.toString();
    }

    // Non-throwing variant for rendering: an unusable link must not break the whole menu.
    function safeHttpsUrl(value) {
        try {
            return toHttpsUrl(value);
        } catch {
            return null;
        }
    }

    function safeHost(value) {
        try {
            return new URL(value).hostname.replace(/^www\./, '');
        } catch {
            return '';
        }
    }

    function hostMatches(host, domains) {
        return Boolean(host) && domains.some(domain => host === domain || host.endsWith(`.${domain}`));
    }

    function isAllowedHost(url, domains) {
        return !domains || hostMatches(safeHost(url), domains);
    }

    function appendQuery(url, query) {
        const parsed = new URL(url);
        parsed.search = parsed.search ? `${parsed.search}&${query}` : `?${query}`;
        return parsed.href;
    }

    function fileNameFromHeaders(headers) {
        const match = (headers || '').match(/content-disposition:[^\n]*?filename\*?=(?:UTF-8'')?"?([^";\r\n]+)/i);
        return match ? safeDecode(match[1]) : null;
    }

    function versionFromFileName(fileName) {
        return fileName?.match(/_v?(\d+(?:\.\d+)+[\w.-]*?)_/)?.[1] || null;
    }

    function safeDecode(value) {
        try {
            return decodeURIComponent(value);
        } catch {
            return value;
        }
    }

    function cleanText(value) {
        return (value || '').replace(/\s+/g, ' ').trim();
    }

    // Parses fetched markup into an inert document (scripts don't run, images don't load).
    // If the page enforces Trusted Types and the manager runs us in the page world, parseFromString needs a
    // TrustedHTML value. The policy only marks text that is parsed into an inert document, never inserted into Play.
    let markupPolicy;
    function parseMarkup(markup) {
        const parser = new DOMParser();
        try {
            return parser.parseFromString(markup, 'text/html');
        } catch (error) {
            if (!window.trustedTypes?.createPolicy) throw error;
            markupPolicy ||= window.trustedTypes.createPolicy('sideport-inert-parse', { createHTML: value => value });
            return parser.parseFromString(markupPolicy.createHTML(markup), 'text/html');
        }
    }

    // ---------------------------------------------------------------- styles

    function injectStyles() {
        if (document.getElementById('pas-styles')) return;
        const style = document.createElement('style');
        style.id = 'pas-styles';
        style.textContent = `
            .pas-root {
                --pas-surface: #fff; --pas-surface-2: #f0f4f9; --pas-on: #1f1f1f; --pas-muted: #5e5e5e;
                --pas-outline: #c4c7c5; --pas-divider: #e3e3e3; --pas-primary: #0b57d0;
                --pas-tonal: #d3e3fd; --pas-on-tonal: #041e49;
                --pas-hover: rgb(31 31 31 / .08); --pas-pressed: rgb(31 31 31 / .12);
                --pas-ok: #146c2e; --pas-warn: #8a5300; --pas-error: #b3261e;
                --pas-inverse: #303030; --pas-on-inverse: #f2f2f2;
                --pas-shadow: 0 2px 6px 2px rgb(0 0 0 / .15), 0 1px 2px rgb(0 0 0 / .3);
                font-family: "Google Sans", Roboto, Arial, sans-serif; color: var(--pas-on); box-sizing: border-box; color-scheme: light;
            }
            .pas-root[data-theme="dark"] {
                --pas-surface: #28292a; --pas-surface-2: #1e1f20; --pas-on: #e3e3e3; --pas-muted: #c4c7c5;
                --pas-outline: #5c5f61; --pas-divider: #3c3d3e; --pas-primary: #a8c7fa;
                --pas-tonal: #004a77; --pas-on-tonal: #c2e7ff;
                --pas-hover: rgb(227 227 227 / .08); --pas-pressed: rgb(227 227 227 / .12);
                --pas-ok: #6dd58c; --pas-warn: #ffb951; --pas-error: #f2b8b5;
                --pas-inverse: #e3e3e3; --pas-on-inverse: #303030;
                --pas-shadow: 0 4px 8px 3px rgb(0 0 0 / .3), 0 1px 3px rgb(0 0 0 / .5);
                color-scheme: dark;
            }
            .pas-root *, .pas-root *::before, .pas-root *::after { box-sizing: inherit; }
            .pas-root [hidden], .pas-root[hidden] { display: none !important; }
            .pas-root button, .pas-root input { font: inherit; color: inherit; }
            .pas-root :focus-visible { outline: 2px solid var(--pas-primary); outline-offset: 2px; }
            .pas-icon { width: 18px; height: 18px; fill: currentColor; flex: none; }

            .pas-inline { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-inline-start: 8px; vertical-align: middle; }
            .pas-after-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 12px 0; }
            .pas-after-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 8px 0; }
            /* Morphe brand gradient with white text: readable on Play's light pages and dark app banners alike. */
            .pas-chip {
                position: relative; display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 14px 0 10px;
                border: 0; border-radius: 8px; background: linear-gradient(135deg, ${MORPHE_BLUE} 0%, ${MORPHE_TEAL} 100%);
                box-shadow: 0 1px 2px rgb(0 0 0 / .25); color: #fff !important; text-decoration: none !important;
                font: 500 14px/20px "Google Sans", Roboto, Arial, sans-serif; white-space: nowrap; text-shadow: 0 1px 1px rgb(0 0 0 / .25);
            }
            .pas-chip::after { content: ""; position: absolute; inset: 0; border-radius: inherit; background: #fff; opacity: 0; transition: opacity .15s; }
            .pas-chip:hover::after { opacity: .12; }
            .pas-chip:active::after { opacity: .2; }
            .pas-chip .pas-icon { color: #fff; }
            .pas-badge.pas-badge-morphe { border-color: transparent; background: linear-gradient(135deg, ${MORPHE_BLUE} 0%, ${MORPHE_TEAL} 100%); color: #fff; }
            .pas-main {
                position: relative; display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 12px 0 14px;
                border: 0; border-radius: 8px; background: var(--pas-tonal); color: var(--pas-on-tonal);
                font: 500 14px/20px "Google Sans", Roboto, Arial, sans-serif; letter-spacing: .01em; white-space: nowrap; cursor: pointer;
            }
            .pas-main::after { content: ""; position: absolute; inset: 0; border-radius: inherit; background: currentColor; opacity: 0; transition: opacity .15s; }
            .pas-main:hover::after { opacity: .08; }
            .pas-main:active::after { opacity: .12; }
            .pas-chevron { margin-inline-start: -2px; transition: transform .15s; }
            .pas-main[aria-expanded="true"] .pas-chevron { transform: rotate(180deg); }

            .pas-menu {
                position: fixed; z-index: 2147483000; display: flex; flex-direction: column; width: 360px; max-height: 600px;
                overflow: hidden; background: var(--pas-surface); border-radius: 16px; box-shadow: var(--pas-shadow);
                font-size: 14px; line-height: 20px; text-align: left;
            }
            .pas-menu:focus { outline: none; }
            .pas-header { display: flex; align-items: flex-start; gap: 8px; padding: 14px 8px 6px 20px; }
            .pas-heading { flex: 1; min-width: 0; }
            .pas-title { font: 500 16px/24px "Google Sans", Roboto, Arial, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .pas-pkg-row { display: flex; align-items: center; gap: 2px; color: var(--pas-muted); }
            .pas-pkg { min-width: 0; padding: 0; background: none; color: inherit; font: 12px/16px "Roboto Mono", ui-monospace, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .pas-icon-btn { flex: none; display: inline-grid; place-items: center; width: 36px; height: 36px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--pas-muted); cursor: pointer; }
            .pas-icon-btn:hover { background: var(--pas-hover); }
            .pas-pkg-row .pas-icon-btn { width: 28px; height: 28px; }
            .pas-pkg-row .pas-icon { width: 15px; height: 15px; }
            .pas-filter-wrap { padding: 4px 16px 8px; }
            .pas-filter {
                width: 100%; height: 40px; padding: 0 16px; border: 1px solid var(--pas-outline); border-radius: 20px;
                background: var(--pas-surface-2); color: var(--pas-on); font: 14px Roboto, Arial, sans-serif; outline: none;
            }
            .pas-filter:focus { border-color: var(--pas-primary); box-shadow: inset 0 0 0 1px var(--pas-primary); }
            .pas-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0 8px 8px; scrollbar-width: thin; }
            .pas-section + .pas-section { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--pas-divider); }
            .pas-section-title { margin: 0; padding: 12px 12px 4px; color: var(--pas-muted); font: 500 12px/16px "Google Sans", Roboto, Arial, sans-serif; letter-spacing: .06em; text-transform: uppercase; }
            .pas-note { margin: 0 12px 8px; color: var(--pas-muted); font-size: 13px; }
            .pas-warning {
                display: flex; align-items: flex-start; gap: 8px; margin: 4px 4px 8px; padding: 8px 12px; border-radius: 12px;
                background: color-mix(in srgb, var(--pas-error) 12%, transparent); color: var(--pas-error); font-size: 12px; line-height: 16px;
            }
            .pas-warning .pas-icon { width: 16px; height: 16px; }
            .pas-list { list-style: none; margin: 0; padding: 0; }
            .pas-row-wrap { display: flex; align-items: center; gap: 2px; }
            .pas-row {
                flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 6px 12px;
                border: 0; border-radius: 12px; background: transparent; color: var(--pas-on); font: inherit;
                text-align: left; text-decoration: none; cursor: pointer;
            }
            .pas-row:hover, .pas-row-side:hover, .pas-switch:hover { background: var(--pas-hover); }
            .pas-row:active { background: var(--pas-pressed); }
            .pas-row[aria-busy="true"] { cursor: progress; }
            .pas-row > .pas-icon { width: 16px; height: 16px; color: var(--pas-muted); }
            .pas-row-side { flex: none; display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; color: var(--pas-muted); }
            .pas-dot { flex: none; width: 10px; height: 10px; border-radius: 50%; background: var(--pas-dot); box-shadow: 0 0 0 3px color-mix(in srgb, var(--pas-dot) 22%, transparent); }
            .pas-row-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
            .pas-row-label { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .pas-row-sub { color: var(--pas-muted); font: 12px/16px Roboto, Arial, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .pas-row-sub[data-tone="ok"] { color: var(--pas-ok); }
            .pas-row-sub[data-tone="warn"] { color: var(--pas-warn); }
            .pas-row-sub[data-tone="error"] { color: var(--pas-error); }
            .pas-badge { flex: none; padding: 1px 8px; border: 1px solid var(--pas-outline); border-radius: 8px; color: var(--pas-muted); font-size: 11px; font-weight: 500; line-height: 16px; }
            .pas-item.is-missing .pas-row-label, .pas-item.is-missing .pas-dot, .pas-item.is-missing .pas-badge { opacity: .5; }
            .pas-spinner { flex: none; width: 18px; height: 18px; border: 2px solid var(--pas-outline); border-top-color: var(--pas-primary); border-radius: 50%; animation: pas-spin .8s linear infinite; }
            @keyframes pas-spin { to { transform: rotate(360deg); } }
            .pas-files { margin: 0 8px 8px 34px; padding: 2px 0 2px 10px; border-inline-start: 2px solid var(--pas-divider); }
            .pas-files-intro { margin: 2px 8px; color: var(--pas-muted); font-size: 12px; line-height: 16px; }
            .pas-file { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 6px 8px; border-radius: 8px; color: var(--pas-primary); font-size: 13px; text-decoration: none; }
            .pas-file:hover { background: var(--pas-hover); }
            .pas-file-label { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .pas-file-host { flex: none; color: var(--pas-muted); font-size: 11px; }
            .pas-file-host.is-untrusted { color: var(--pas-warn); font-weight: 500; }
            .pas-empty { margin: 16px 12px; color: var(--pas-muted); text-align: center; }
            .pas-footer { display: flex; justify-content: space-between; gap: 8px; padding: 6px 8px; border-top: 1px solid var(--pas-divider); }
            .pas-text-btn {
                display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 12px; border: 0; border-radius: 18px;
                background: transparent; color: var(--pas-primary); font: 500 14px "Google Sans", Roboto, Arial, sans-serif; cursor: pointer;
            }
            .pas-text-btn:hover { background: color-mix(in srgb, var(--pas-primary) 10%, transparent); }
            .pas-footer-group { display: flex; gap: 4px; min-width: 0; }
            a.pas-text-btn { text-decoration: none; }
            .pas-support { color: var(--pas-on); }
            .pas-support .pas-icon { color: #ff5e5b; }
            .pas-support:hover { background: color-mix(in srgb, #ff5e5b 12%, transparent); }
            .pas-support-card {
                display: flex; align-items: center; gap: 12px; margin: 4px; padding: 12px 12px 12px 16px; border-radius: 12px;
                background: color-mix(in srgb, #ff5e5b 9%, var(--pas-surface));
            }
            .pas-wrap { white-space: normal; }
            .pas-more-link { display: inline-flex; align-items: center; gap: 4px; margin-top: 6px; color: var(--pas-primary); font: 500 12px/16px "Google Sans", Roboto, Arial, sans-serif; text-decoration: none; }
            .pas-more-link:hover { text-decoration: underline; }
            .pas-more-link .pas-icon { width: 14px; height: 14px; color: ${MORPHE_TEAL}; }
            .pas-support-filled { flex: none; background: #ff5e5b; color: #fff; }
            .pas-support-filled .pas-icon { color: #fff; }
            .pas-support-filled:hover { background: #e94e4b; }

            .pas-switch { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-radius: 12px; cursor: pointer; }
            .pas-switch input {
                appearance: none; position: relative; flex: none; width: 36px; height: 20px; margin: 0; border: 2px solid var(--pas-outline);
                border-radius: 10px; background: var(--pas-surface-2); cursor: pointer; transition: background .15s, border-color .15s;
            }
            .pas-switch input::before {
                content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%;
                background: var(--pas-outline); transition: transform .15s, background .15s;
            }
            .pas-switch input:checked { background: var(--pas-primary); border-color: var(--pas-primary); }
            .pas-switch input:checked::before { transform: translateX(16px); background: var(--pas-surface); }

            .pas-banner {
                position: fixed; right: 24px; bottom: 24px; z-index: 2147482000; display: flex; align-items: center; gap: 12px;
                max-width: min(460px, calc(100vw - 32px)); padding: 12px 8px 12px 16px; border-radius: 16px;
                background: var(--pas-surface); box-shadow: var(--pas-shadow); font-size: 14px; line-height: 20px;
            }
            .pas-banner-text { flex: 1; margin: 0; }
            @media (max-width: 600px) { .pas-banner { left: 16px; right: 16px; bottom: 16px; } }

            .pas-toast {
                position: fixed; left: 50%; bottom: 24px; z-index: 2147483001; max-width: calc(100vw - 32px); padding: 12px 16px;
                border-radius: 8px; background: var(--pas-inverse); color: var(--pas-on-inverse); box-shadow: var(--pas-shadow);
                font: 14px/20px Roboto, Arial, sans-serif; opacity: 0; pointer-events: none; transform: translate(-50%, 16px);
                transition: opacity .2s, transform .2s;
            }
            .pas-toast.is-visible { opacity: 1; transform: translate(-50%, 0); }

            @media (prefers-reduced-motion: reduce) {
                .pas-spinner { animation-duration: 2.4s; }
                .pas-main::after, .pas-chip::after, .pas-chevron, .pas-toast, .pas-switch input, .pas-switch input::before { transition: none; }
            }
        `;
        document.head.appendChild(style);
    }
})();

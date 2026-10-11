// Network chaos: every scenario × representative probes, classified through the real getProbe() path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, wait } from './harness.mjs';

let scenario = null;
const t = await boot({ route: d => (/morphe|patches-list/.test(d.url) ? { status: 200, text: '{}' } : scenario(d)) });
const { sp, window } = t;
await wait(300);
test.after(() => window.close());

const SCENARIOS = {
    '200 unexpected HTML': () => ({ status: 200, text: '<html><body>Maintenance</body></html>' }),
    '200 empty JSON {}': () => ({ status: 200, text: '{}' }),
    '200 empty list': () => ({ status: 200, text: '{"datalist":{"list":[]},"packages":[]}' }),
    '403 Cloudflare': () => ({ status: 403, text: '<title>Just a moment...</title>' }),
    '403 plain': () => ({ status: 403, text: 'Forbidden' }),
    '404': () => ({ status: 404 }),
    '429': () => ({ status: 429, text: 'Too Many Requests' }),
    '500': () => ({ status: 500 }),
    '502': () => ({ status: 502 }),
    '503 Cloudflare': () => ({ status: 503, headers: 'cf-mitigated: challenge\r\n' }),
    'invalid JSON': () => ({ status: 200, text: '{"packages":[' }),
    'network error': () => ({ error: 'net::ERR_NAME_NOT_RESOLVED' }),
    '@connect denied': () => ({ error: 'Refused to connect to "x": not part of the @connect list' }),
    'timeout': () => ({ timeout: true }),
    'redirect loop (3xx surfaced)': () => ({ status: 310 }),
    'status 0': () => ({ status: 0 })
};
const PROBES = ['apkpure', 'apkcombo', 'aptoide', 'fdroid', 'guardian', 'uptodown'];
const table = [];

for (const [name, reply] of Object.entries(SCENARIOS)) {
    test(`chaos: ${name}`, async () => {
        scenario = reply;
        const row = { scenario: name };
        for (const id of PROBES) {
            sp.probeCache.clear();
            const ctx = sp.state.mount.ctx;
            const result = await sp.getProbe(ctx, sp.SOURCE_BY_ID.get(id)).catch(e => ({ state: `threw ${e.name}` }));
            row[id] = result.state === 'unknown' ? `unknown: ${result.message}` : result.state;
            assert.ok(['ok', 'missing'].includes(result.state) || result.state === 'unknown', `${id} → ${result.state}`);
        }
        table.push(row);
    });
}

test('FIXED N11: an unrecognised 200 page is unknown (couldn-t check) for every source, never missing', async () => {
    for (const [name, reply] of [['200 unexpected HTML', SCENARIOS['200 unexpected HTML']], ['invalid JSON', SCENARIOS['invalid JSON']]]) {
        scenario = reply;
        for (const id of PROBES) {
            sp.probeCache.clear();
            const result = await sp.getProbe(sp.state.mount.ctx, sp.SOURCE_BY_ID.get(id));
            assert.equal(result.state, 'unknown', `${name} / ${id}`);
        }
    }
});

test('PF-01: slow responses: all 8 checks run at once (8 slots, one per site)', async () => {
    scenario = () => ({ status: 404, delay: 200 });
    sp.probeCache.clear();
    const start = Date.now();
    sp.runProbes(sp.state.mount.ctx);
    await wait(10);
    const active = sp.activeProbes(); const queued = sp.probeQueue.length;
    await wait(600);
    console.log(`# active=${active} queued=${queued} remaining=${sp.probeQueue.length} elapsed≈${Date.now() - start}ms`);
    assert.equal(active, 8);
    assert.equal(queued, 0);
    assert.equal(sp.probeQueue.length, 0);
});

test('never-responding request + navigation: teardown cancels, slots are released', async () => {
    scenario = () => 'hang';
    sp.probeCache.clear();
    sp.runProbes(sp.state.mount.ctx);
    await wait(10);
    sp.teardown();
    await wait(20);
    console.log(`# after teardown: inflight=${sp.inflightRequests.size} active=${sp.activeProbes()} queued=${sp.probeQueue.length} cache=${sp.probeCache.size}`);
    assert.equal(sp.activeProbes(), 0);
    assert.equal(sp.probeQueue.length, 0);
    assert.equal(sp.probeCache.size, 0);
});

test.after(() => {
    console.log('# CHAOS TABLE');
    for (const row of table) console.log(`# ${JSON.stringify(row)}`);
});

await wait(0);

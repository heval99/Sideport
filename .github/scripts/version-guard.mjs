// Fails when @version goes down, or when sideport.user.js changed without a version bump: userscript managers only
// install an update when the version goes up, so either mistake strands installed copies.
// Usage: node .github/scripts/version-guard.mjs <base git ref or commit>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const base = process.argv[2];
const versionOf = text => /^\/\/ @version\s+(\S+)/m.exec(text)?.[1];
const compare = (a, b) => {
    const [left, right] = [a, b].map(version => version.split('.').map(Number));
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
        if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) - (right[i] || 0);
    }
    return 0;
};
const fail = message => {
    console.error(`::error file=sideport.user.js::${message}`);
    process.exit(1);
};

if (!base || /^0+$/.test(base)) {
    console.log('No earlier commit to compare with; skipped.');
    process.exit(0);
}
let previous;
try {
    previous = execFileSync('git', ['show', `${base}:sideport.user.js`], { encoding: 'utf8' });
} catch {
    console.log(`sideport.user.js doesn't exist at ${base}; skipped.`);
    process.exit(0);
}
// Line endings can differ between the checkout and git's copy (core.autocrlf on Windows); they aren't a change.
const lf = text => text.replace(/\r\n/g, '\n');
previous = lf(previous);
const current = lf(readFileSync('sideport.user.js', 'utf8'));
const [was, now] = [versionOf(previous), versionOf(current)];
if (!now) fail('No // @version line found.');
const order = compare(now, was);
if (order < 0) fail(`@version went down (${was} → ${now}): installed copies would never update.`);
if (order === 0 && previous !== current) fail(`sideport.user.js changed but @version is still ${now}: bump it so installed copies get the change.`);
console.log(`@version ${was} → ${now}: ok`);

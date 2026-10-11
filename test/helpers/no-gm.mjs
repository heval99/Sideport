// Runs Sideport without a GM object, in its own process so an unhandled rejection can't leak into the test runner.
import { boot, wait } from '../harness.mjs';
const rejections = [];
process.on('unhandledRejection', reason => rejections.push(`${reason?.name}: ${reason?.message}`));
const t = await boot({ withGM: false, exportHook: false });
await wait(400);
console.log(JSON.stringify({ rejections, mounts: t.document.querySelectorAll('.pas-mount').length }));
t.window.close();

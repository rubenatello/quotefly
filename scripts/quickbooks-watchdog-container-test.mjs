// Local disposable Docker proof. Network disabled; no production/provider calls.
import { execFileSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

const image = process.argv[2];
if (!image || !/^quotefly-qbo-watchdog:local-[a-z0-9-]+$/.test(image)) throw new Error('Pass a locally built watchdog test image tag.');
const name = `quotefly-watchdog-test-${randomUUID()}`;
const volume = `${name}-state`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 40_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const inspect = () => JSON.parse(docker('exec', name, 'node', '-e', `const fs=require('fs'); const s=JSON.parse(fs.readFileSync('/state/state.json','utf8')); const p=fs.statSync('/state/process.lock'); process.stdout.write(JSON.stringify({ids:s.queue.map(n=>n.id),uid:p.uid,mode:p.mode&511}));`));
async function ready() {
  for (let n = 0; n < 35; n++) {
    try {
      if (docker('exec', name, 'node', '-e', `fetch('http://127.0.0.1:8080/health').then(r=>{process.stdout.write(String(r.status));}).catch(()=>process.exit(1));`) === '204') {
        const state = inspect();
        if (state.ids.length >= 2) return state;
      }
    } catch { /* startup only; raw command errors never printed */ }
    await delay(500);
  }
  throw new Error('WATCHDOG_CONTAINER_NOT_READY');
}
let created = false;
try {
  docker('volume', 'create', volume);
  // An empty Docker volume inherits the image /state uid/mode; assert this below.
  const vars = { WATCHDOG_ENVIRONMENT: 'staging', WATCHDOG_EMAIL_FROM: 'monitor@example.com', WATCHDOG_EMAIL_TO: 'owner@example.com' };
  for (const key of ['WATCHDOG_MONITOR_BEARER','WATCHDOG_API_SOURCE_TOKEN','WATCHDOG_WORKER_SOURCE_TOKEN','WATCHDOG_RESEND_API_KEY']) vars[key] = randomBytes(32).toString('hex');
  const args = Object.entries(vars).flatMap(([key,value]) => ['--env', `${key}=${value}`]);
  docker('run', '--detach', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--mount', `type=volume,source=${volume},target=/state`, ...args, image);
  created = true;
  const before = await ready();
  assert.equal(before.uid, 1000);
  assert.equal(before.mode, 0o600);
  assert.equal(docker('exec', name, 'node', '--version'), 'v22.23.2');
  assert.equal(docker('exec', name, 'test', '-x', '/usr/bin/flock'), '');
  assert.equal(docker('exec', name, 'sh', '-c', `for command_name in npm npx corepack yarn yarnpkg; do if command -v "$command_name" >/dev/null 2>&1; then exit 1; fi; done`), '');
  assert.equal(docker('exec', name, 'node', '-e', `const fs=require('fs'); const paths=['/usr/local/lib/node_modules','/opt/yarn-v1.22.22','/usr/local/bin/npm','/usr/local/bin/npx','/usr/local/bin/corepack','/usr/local/bin/yarn','/usr/local/bin/yarnpkg']; const present=path=>{try{fs.lstatSync(path);return true}catch(error){if(error.code==='ENOENT')return false;throw error}}; process.stdout.write(paths.filter(present).join(','));`), '');
  // Inspect the immutable image separately: the runtime drops DAC_OVERRIDE and
  // root correctly cannot traverse its node-owned private mounted state.
  assert.equal(docker('run', '--rm', '--network', 'none', '--read-only', '--user', '0', '--entrypoint', 'find', image, '/', '-xdev', '-perm', '/6000', '-type', 'f'), '');
  assert.equal(docker('exec', name, 'node', '-e', `process.stdout.write(String(require('fs').existsSync('/app/node_modules')));`), 'false');
  let secondExit = 0;
  try { docker('exec', name, 'node', 'watchdog/main.js'); } catch (error) { secondExit = error.status; }
  assert.equal(secondExit, 73, 'Same-volume concurrent writer must be refused.');
  docker('kill', '--signal', 'KILL', name);
  docker('start', name);
  const after = await ready();
  assert.deepEqual(after.ids, before.ids, 'SIGKILL restart must retain the same pending notifications.');
  docker('stop', '--time', '30', name);
  assert.equal(docker('inspect', '--format', '{{.State.ExitCode}}', name), '0');
  console.log('PASS: network-isolated Linux image; private mounted state; concurrent writer exit73; SIGKILL restart preserves outbox; graceful stop exit0.');
} catch {
  console.error('FAIL: watchdog container proof. Raw command/environment output suppressed.');
  process.exitCode = 1;
} finally {
  // Only the exact new disposable resources owned by this test are removed.
  if (created) { try { docker('rm', '--force', name); } catch { process.exitCode = 1; } }
  try { docker('volume', 'rm', volume); } catch { process.exitCode = 1; }
}

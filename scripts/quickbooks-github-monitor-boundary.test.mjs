import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  admission,
  githubClient,
  loadConfig,
  probe,
  runMonitor,
} from './quickbooks-github-monitor.mjs';

const bearer = 'qbo-monitor-bearer-' + 'a'.repeat(48);
const githubToken = 'github-token-' + 'b'.repeat(48);

function environment(overrides = {}) {
  return {
    GITHUB_REPOSITORY: 'rubenatello/quotefly',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF_PROTECTED: 'true',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_RUN_ID: '123456789',
    GITHUB_RUN_ATTEMPT: '1',
    QBO_MONITOR_ENABLED: 'true',
    QBO_MONITOR_APPROVED_REF: 'refs/heads/main',
    QBO_MONITOR_ENVIRONMENT: 'production',
    QBO_MONITOR_MINUTES: '1',
    QBO_MONITOR_CANARY: 'false',
    QBO_MONITOR_BEARER: bearer,
    GH_TOKEN: githubToken,
    ...overrides,
  };
}

const genericFailure = error => error instanceof Error && error.message === 'QBO_GITHUB_MONITOR_FAILED';
const rejected = async promise => assert.rejects(promise, genericFailure);
const rejectedSync = fn => assert.throws(fn, genericFailure);

function response(status, body = null) {
  return new Response(body, { status });
}

// Fetch normally rejects a body on HTTP 204. This deliberately models a malformed
// provider response so boundedText's zero-byte QBO endpoint guard is exercised.
function malformedNoContentResponse(body) {
  const bytes = new TextEncoder().encode(body);
  return {
    status: 204,
    body: new ReadableStream({
      start(controller) { controller.enqueue(bytes); controller.close(); },
    }),
  };
}

function healthyResponse(path) {
  if (path.endsWith('/v1/health')) return response(200, JSON.stringify({ service: 'quotefly-api', status: 'ok' }));
  if (path.endsWith('/v1/ready')) return response(200, JSON.stringify({ service: 'quotefly-api', status: 'ready' }));
  return response(204);
}

test('admission is strict about the dispatched protected repository and bounded duration', () => {
  assert.deepEqual(admission(environment()), {
    environment: 'production', minutes: 1, canary: false, runKey: '123456789:1', origin: 'https://api.quotefly.us',
  });
  assert.equal(admission(environment({ QBO_MONITOR_MINUTES: '240', QBO_MONITOR_CANARY: 'true' })).minutes, 240);
  assert.equal(admission(environment({
    QBO_MONITOR_ENVIRONMENT: 'staging', GITHUB_REF: 'refs/heads/staging/qbo', QBO_MONITOR_APPROVED_REF: 'refs/heads/staging/qbo',
  })).origin, 'https://api-staging.quotefly.us');

  for (const overrides of [
    { GITHUB_REPOSITORY: 'attacker/quotefly' },
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_REF_PROTECTED: 'false' },
    { GITHUB_REF: 'refs/heads/feature', QBO_MONITOR_APPROVED_REF: 'refs/heads/main' },
    { QBO_MONITOR_APPROVED_REF: 'main' },
    { QBO_MONITOR_ENVIRONMENT: 'preview' },
    { QBO_MONITOR_ENVIRONMENT: 'production', GITHUB_REF: 'refs/heads/release', QBO_MONITOR_APPROVED_REF: 'refs/heads/release' },
    { QBO_MONITOR_ENABLED: 'false' },
    { QBO_MONITOR_CANARY: 'maybe' },
    { QBO_MONITOR_MINUTES: '0' },
    { QBO_MONITOR_MINUTES: '001' },
    { QBO_MONITOR_MINUTES: '241' },
    { QBO_MONITOR_MINUTES: '1.0' },
  ]) rejectedSync(() => admission(environment(overrides)));
});

test('loadConfig requires a distinct bounded bearer, GitHub token, and numeric run identity', () => {
  const config = loadConfig(environment());
  assert.equal(config.bearer, bearer);
  assert.equal(config.githubToken, githubToken);
  for (const overrides of [
    { QBO_MONITOR_BEARER: 'short' },
    { QBO_MONITOR_BEARER: `${bearer} whitespace` },
    { GH_TOKEN: 'short' },
    { GH_TOKEN: `${githubToken}\nnewline` },
    { GH_TOKEN: bearer },
    { GITHUB_RUN_ID: '' },
    { GITHUB_RUN_ID: '0' },
    { GITHUB_RUN_ID: '12.5' },
    { GITHUB_RUN_ID: 'run-12' },
    { GITHUB_RUN_ATTEMPT: '' },
    { GITHUB_RUN_ATTEMPT: '0' },
    { GITHUB_RUN_ATTEMPT: '1.5' },
    { GITHUB_RUN_ATTEMPT: 'try-1' },
  ]) rejectedSync(() => loadConfig(environment(overrides)));
});

test('probe uses only the four fixed endpoints with bounded no-redirect requests', async () => {
  const calls = [];
  const timeouts = [];
  const config = loadConfig(environment());
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = milliseconds => {
    timeouts.push(milliseconds);
    return new AbortController().signal;
  };
  let result;
  try {
    result = await probe(config, async (url, init) => {
      calls.push({ url, init });
      return healthyResponse(url);
    });
  } finally { AbortSignal.timeout = originalTimeout; }
  assert.equal(result, 'healthy');
  assert.deepEqual(timeouts, [8000, 8000, 8000, 8000]);
  assert.deepEqual(calls.map(call => call.url), [
    'https://api.quotefly.us/v1/health',
    'https://api.quotefly.us/v1/ready',
    'https://api.quotefly.us/v1/internal/quickbooks/monitor/warning',
    'https://api.quotefly.us/v1/internal/quickbooks/monitor/critical',
  ]);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.redirect, 'error');
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.equal(call.init.signal.aborted, false);
    assert.deepEqual(call.init.headers, index < 2 ? {} : { authorization: `Bearer ${bearer}` });
  }
});

test('probe fails closed on malformed, unavailable, authenticated, redirected, and timeout-like observations', async () => {
  const config = loadConfig(environment());
  const cases = [
    ['invalid health JSON', '/v1/health', () => response(200, '{')],
    ['wrong health status', '/v1/health', () => response(503, JSON.stringify({ service: 'quotefly-api', status: 'ok' }))],
    ['empty health response', '/v1/health', () => response(204)],
    ['oversized health response', '/v1/health', () => response(200, JSON.stringify({ service: 'quotefly-api', status: 'ok', padding: 'x'.repeat(1025) }))],
    ['wrong ready body', '/v1/ready', () => response(200, JSON.stringify({ service: 'quotefly-api', status: 'ok' }))],
    ['empty ready response', '/v1/ready', () => response(204)],
    ['nonempty malformed warning response', '/warning', () => malformedNoContentResponse('unexpected')],
    ['nonempty warning failure response', '/warning', () => response(503, 'unexpected')],
    ['nonempty malformed critical response', '/critical', () => malformedNoContentResponse('unexpected')],
    ['nonempty critical failure response', '/critical', () => response(503, 'unexpected')],
    ['warning authentication failure', '/warning', () => response(401)],
    ['warning rate limit', '/warning', () => response(429)],
    ['network failure', '/v1/health', () => { throw new TypeError('network failure'); }],
    ['redirect failure', '/v1/ready', () => { throw new TypeError('unexpected redirect'); }],
    ['timeout failure', '/critical', () => { throw new DOMException('aborted', 'TimeoutError'); }],
  ];
  for (const [, suffix, replacement] of cases) {
    const calls = [];
    const result = await probe(config, async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith(suffix)) return replacement();
      return healthyResponse(url);
    });
    assert.equal(result, 'critical');
    assert.equal(calls.length, 4, 'one observation cycle must not retry a failed endpoint');
  }
});

test('probe reports warning only for an otherwise healthy explicit warning response', async () => {
  const config = loadConfig(environment());
  const result = await probe(config, async url => url.endsWith('/warning') ? response(503) : healthyResponse(url));
  assert.equal(result, 'warning');
});

test('githubClient has a fixed GitHub origin, bounded no-redirect request, and only issue or label paths', async () => {
  const calls = [];
  const timeouts = [];
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = milliseconds => {
    timeouts.push(milliseconds);
    return new AbortController().signal;
  };
  const client = githubClient(githubToken, async (url, init) => {
    calls.push({ url, init });
    return response(200, JSON.stringify({ name: 'qbo-monitor-production' }));
  });
  try { assert.deepEqual(await client('/labels/qbo-monitor-production'), { name: 'qbo-monitor-production' }); }
  finally { AbortSignal.timeout = originalTimeout; }
  assert.equal(calls.length, 1);
  assert.deepEqual(timeouts, [8000]);
  assert.equal(calls[0].url, 'https://api.github.com/repos/rubenatello/quotefly/labels/qbo-monitor-production');
  assert.equal(calls[0].init.redirect, 'error');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(calls[0].init.headers.authorization, `Bearer ${githubToken}`);
  assert.equal(calls[0].init.headers['x-github-api-version'], '2026-03-10');
  for (const path of ['/user', 'https://api.github.com/user', '/issues/../secrets', '/issues\nmalformed', '/pulls/1']) {
    await rejected(client(path));
  }
});

test('githubClient converts provider and malformed-response errors into a secret-free failure', async () => {
  const secret = `github-token-${'z'.repeat(48)}`;
  for (const fetcher of [
    async () => response(500, JSON.stringify({ message: secret })),
    async () => response(200, '{malformed'),
    async () => { throw new Error(`network ${secret}`); },
  ]) {
    const client = githubClient(secret, fetcher);
    await assert.rejects(client('/issues?state=all'), error => genericFailure(error) && !error.message.includes(secret));
  }
});

test('githubClient rejects JSON response bodies larger than one MiB before parsing', async () => {
  const client = githubClient(githubToken, async () => response(200, `"${'x'.repeat(1024 * 1024 + 1)}"`));
  await rejected(client('/issues?state=all'));
});

test('runMonitor runs immediate nonoverlapping cycles exactly once per configured minute', async () => {
  let monotonicNow = 1_000_000;
  const utcTimes = [9_000_000, 1, 8_500_000];
  let inProbe = false;
  const probeTimes = [];
  const recordTimes = [];
  const pauses = [];
  const config = { ...loadConfig(environment({ QBO_MONITOR_MINUTES: '3' })), minutes: 3 };
  const exit = await runMonitor(config, {
    clock: () => utcTimes[probeTimes.length],
    monotonic: () => monotonicNow,
    sleep: async milliseconds => { pauses.push(milliseconds); monotonicNow += milliseconds; },
    probe: async () => {
      assert.equal(inProbe, false, 'a new cycle may not overlap an in-progress probe');
      inProbe = true;
      probeTimes.push(monotonicNow);
      inProbe = false;
      return 'healthy';
    },
    record: async (level, at) => { recordTimes.push({ level, at }); return { level: 'healthy' }; },
  });
  assert.equal(exit, 0);
  assert.deepEqual(probeTimes, [1_000_000, 1_060_000, 1_120_000]);
  assert.deepEqual(pauses, [60_000, 60_000]);
  assert.deepEqual(recordTimes, [
    { level: 'healthy', at: 9_000_000 }, { level: 'healthy', at: 1 }, { level: 'healthy', at: 8_500_000 },
  ]);
});

test('runMonitor rechecks a one-millisecond-early timer wake before the next probe', async () => {
  let monotonicNow = 0;
  const pauses = [];
  const probeTimes = [];
  const config = { ...loadConfig(environment({ QBO_MONITOR_MINUTES: '2' })), minutes: 2 };
  assert.equal(await runMonitor(config, {
    clock: () => 123,
    monotonic: () => monotonicNow,
    sleep: async milliseconds => {
      pauses.push(milliseconds);
      monotonicNow += pauses.length === 1 ? milliseconds - 1 : milliseconds;
    },
    probe: async () => { probeTimes.push(monotonicNow); return 'healthy'; },
    record: async () => ({ level: 'healthy' }),
  }), 0);
  assert.deepEqual(pauses, [60_000, 1]);
  assert.deepEqual(probeTimes, [0, 60_000]);
  assert.ok(probeTimes[1] - probeTimes[0] >= 60_000);
});

test('runMonitor accepts exactly one and 240 immediate-first monotonic cycles without wall-clock delays', async () => {
  const config = loadConfig(environment());
  let minimumCycles = 0;
  assert.equal(await runMonitor({ ...config, minutes: 1 }, {
    clock: () => 7,
    monotonic: () => 0,
    probe: async () => 'healthy',
    record: async () => { minimumCycles++; return { level: 'healthy' }; },
  }), 0);
  assert.equal(minimumCycles, 1);

  let monotonicNow = 0;
  let maximumCycles = 0;
  const waits = [];
  assert.equal(await runMonitor({ ...config, minutes: 240 }, {
    clock: () => 99,
    monotonic: () => monotonicNow,
    sleep: async milliseconds => { waits.push(milliseconds); monotonicNow += milliseconds; },
    probe: async () => 'healthy',
    record: async () => { maximumCycles++; return { level: 'healthy' }; },
  }), 0);
  assert.equal(maximumCycles, 240);
  assert.equal(waits.length, 239);
  assert.ok(waits.every(milliseconds => milliseconds === 60_000));
});

test('runMonitor rejects a monotonic execution window that exceeds its fixed ceiling', async () => {
  const readings = [0, 0, 244 * 60_000 + 1];
  await rejected(runMonitor({ ...loadConfig(environment()), minutes: 1 }, {
    clock: () => 1,
    monotonic: () => readings.shift(),
    probe: async () => 'healthy',
    record: async () => ({ level: 'healthy' }),
  }));
});

test('runMonitor returns nonzero for unresolved health and rejects persistence errors', async () => {
  const config = { ...loadConfig(environment()), minutes: 1 };
  assert.equal(await runMonitor(config, {
    clock: () => 1_000_000,
    probe: async () => 'critical',
    record: async () => ({ level: 'critical' }),
  }), 1);
  await assert.rejects(runMonitor(config, {
    clock: () => 1_000_000,
    probe: async () => 'healthy',
    record: async () => { throw new Error('persistence unavailable'); },
  }), /persistence unavailable/);
});

test('runMonitor pins the first trusted issue number and cannot exit healthy after that pin is lost', async () => {
  let monotonicNow = 0;
  const expectedNumbers = [];
  let calls = 0;
  await rejected(runMonitor({ ...loadConfig(environment({ QBO_MONITOR_MINUTES: '2' })), minutes: 2 }, {
    clock: () => 1,
    monotonic: () => monotonicNow,
    sleep: async milliseconds => { monotonicNow += milliseconds; },
    probe: async () => 'healthy',
    record: async (_level, _at, _canary, _context, expectedIssueNumber) => {
      expectedNumbers.push(expectedIssueNumber);
      calls++;
      return calls === 1 ? { level: 'warning', issueNumber: 7 } : { level: 'healthy', issueNumber: null };
    },
  }));
  assert.deepEqual(expectedNumbers, [null, 7]);
});

test('the attended-monitor workflow is manual, pinned, bounded, and keeps its bearer step-scoped', async () => {
  const workflow = await readFile(new URL('../.github/workflows/quickbooks-attended-monitor.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^on:\r?\n  workflow_dispatch:/m);
  for (const automaticTrigger of ['schedule:', 'push:', 'pull_request:', 'workflow_run:']) {
    assert.equal(workflow.includes(automaticTrigger), false, `${automaticTrigger} must not enable the monitor`);
  }

  const uses = [...workflow.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)/gm)];
  assert.ok(uses.length >= 2, 'reviewed actions must be explicitly pinned');
  for (const [, ref] of uses) assert.match(ref, /^[0-9a-f]{40}$/);

  assert.match(workflow, /^permissions:\r?\n  contents: read$/m);
  assert.match(workflow, /^    permissions:\r?\n      contents: read\r?\n      issues: write$/m);
  assert.match(workflow, /^concurrency:\r?\n  group: qbo-attended-monitor-\$\{\{ inputs\.environment \}\}\r?\n  cancel-in-progress: false$/m);
  assert.match(workflow, /^    timeout-minutes: 245$/m);
  assert.match(workflow, /github\.repository == 'rubenatello\/quotefly'/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow, /github\.ref_type == 'branch' && github\.ref_protected/);
  assert.match(workflow, /^    environment: qbo-monitor-\$\{\{ inputs\.environment \}\}$/m);
  assert.equal((workflow.match(/^          QBO_MONITOR_APPROVED_REF: \$\{\{ vars\.QBO_MONITOR_APPROVED_REF \}\}$/gm) ?? []).length, 2);
  assert.equal((workflow.match(/^          QBO_MONITOR_ENABLED: \$\{\{ vars\.QBO_MONITOR_ENABLED \}\}$/gm) ?? []).length, 2);
  assert.equal(/^\s*GITHUB_REF_PROTECTED:/m.test(workflow), false, 'use the authoritative reserved runner default');
  assert.match(workflow, /^      - name: Check admission without monitor secret$/m);
  assert.match(workflow, /^      - name: Attended read-only probes and sanitized issue notifications\r?\n        env:\r?\n          QBO_MONITOR_BEARER: \$\{\{ secrets\.QBO_MONITOR_BEARER \}\}$/m);
  assert.equal((workflow.match(/^\s*QBO_MONITOR_BEARER:/gm) ?? []).length, 1, 'the bearer must appear only in its probe step');
  assert.match(workflow, /persist-credentials: false/);
});

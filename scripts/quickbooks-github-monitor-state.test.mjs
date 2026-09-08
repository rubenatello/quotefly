import assert from 'node:assert/strict';
import test from 'node:test';
import { initialState, stateBody, parseIssue, transition, notification, recordCycle, loadRecord, flushPending } from './quickbooks-github-monitor.mjs';

const key = 'synthetic-monitor-state-key-for-local-tests-only';
const at = Date.parse('2026-09-08T20:00:00Z');
const bot = { id: 41898282, login: 'github-actions[bot]', type: 'Bot' };
const context = (cycle, runKey = '123:1', elapsedMs = cycle * 60_000) => ({ cycle, runKey, elapsedMs });
const cleanPending = state => ({ ...state, pending: null });
const issueFor = state => ({ number: 7, user: bot, labels: [{ name: 'qbo-monitor-staging' }],
  state: 'open', locked: false, comments: 0, body: stateBody(state, key) });

function fixture() {
  const issues = [];
  const comments = [];
  let patchCount = 0;
  const faults = { commentAcceptedThenThrow: false, patchBefore: 0, patchAfter: 0 };
  const client = async (path, method = 'GET', body) => {
    if (path === '/labels/qbo-monitor-staging') return { name: 'qbo-monitor-staging' };
    if (path.startsWith('/issues?')) return structuredClone(issues);
    if (path === '/issues' && method === 'POST') {
      const issue = { ...issueFor(initialState('staging')), ...body, number: 7 + issues.length,
        labels: body.labels.map(name => ({ name })) };
      issues.push(issue); return structuredClone(issue);
    }
    const match = /^\/issues\/([0-9]+)(.*)$/.exec(path);
    assert.ok(match, 'only fixed issue paths');
    const issue = issues.find(i => i.number === Number(match[1]));
    assert.ok(issue);
    if (match[2].startsWith('/comments?')) {
      const page = Number(new URL('https://fixture.invalid' + path).searchParams.get('page'));
      return structuredClone(comments.filter(c => c.issue === issue.number).slice((page - 1) * 100, page * 100));
    }
    if (match[2] === '/comments' && method === 'POST') {
      const comment = { id: comments.length + 1, issue: issue.number, user: bot, body: body.body };
      comments.push(comment); issue.comments++;
      if (faults.commentAcceptedThenThrow) { faults.commentAcceptedThenThrow = false; throw new Error('synthetic transport uncertainty'); }
      return structuredClone(comment);
    }
    if (method === 'PATCH') {
      patchCount++;
      if (faults.patchBefore === patchCount) throw new Error('synthetic pre-write failure');
      Object.assign(issue, body);
      if (faults.patchAfter === patchCount) throw new Error('synthetic post-write uncertainty');
    }
    return structuredClone(issue);
  };
  const cycle = (level, n, runKey = '123:1', canary = false, expectedIssueNumber = null) =>
    recordCycle(client, 'staging', level, at + n * 60_000, canary, context(n, runKey), key, expectedIssueNumber);
  return { issues, comments, faults, client, cycle };
}

test('canonical state requires valid environment-bound MAC, exact bot and label, unlocked non-PR issue', () => {
  const issue = issueFor(initialState('staging'));
  assert.equal(parseIssue(issue, 'staging', key).state.level, 'healthy');
  assert.equal(parseIssue({ ...issue, user: { ...bot, id: 99 } }, 'staging', key), null);
  assert.equal(parseIssue({ ...issue, user: { ...bot, type: 'User' } }, 'staging', key), null);
  assert.equal(parseIssue({ ...issue, labels: [] }, 'staging', key), null);
  assert.equal(parseIssue({ ...issue, pull_request: {} }, 'staging', key), null);
  for (const changed of [
    { ...issue, locked: true }, { ...issue, body: issue.body.replace('"level":"healthy"', '"level":"critical"') },
    { ...issue, body: stateBody({ ...initialState('staging'), unknown: true }, key) },
    { ...issue, body: stateBody(initialState('production'), key) }, { ...issue, body: 'x'.repeat(4097) },
    { ...issue, body: issue.body + '\n' },
  ]) assert.throws(() => parseIssue(changed, 'staging', key), /QBO_GITHUB_MONITOR_FAILED/);
  assert.throws(() => parseIssue(issue, 'staging', key + '-rotated'), /QBO_GITHUB_MONITOR_FAILED/);
  assert.ok(!issue.body.includes(key));
});

test('two fresh same-run/attempt adjacent cycles are needed; elapsed monotonic time controls spacing', () => {
  const warning = cleanPending(transition(initialState('staging'), 'warning', at, 0, false, context(0)));
  const first = transition(warning, 'healthy', at + 60_000, 1, false, context(1));
  assert.equal(first.level, 'warning');
  const second = transition(first, 'healthy', at + 120_000, 1, false, context(2));
  assert.equal(second.level, 'healthy'); assert.equal(second.pending.kind, 'recovery');
  for (const c of [context(2, '124:1'), context(2, '123:2'), context(3), context(2, '123:1', 119_999), context(2, '123:1', 240_001)]) {
    assert.equal(transition(first, 'healthy', at + 120_000, 1, false, c).level, 'warning');
  }
  const bad = transition(first, 'critical', at + 120_000, 1, false, context(2));
  assert.equal(bad.firstClean, null);
  assert.equal(transition(cleanPending(bad), 'healthy', at + 180_000, 2, false, context(3)).level, 'critical');
  assert.throws(() => transition(first, 'healthy', at, 0, false, context(2)));
});

test('one authenticated state issue deduplicates warning/escalation and closes only after confirmed recovery comment', async () => {
  const f = fixture();
  assert.equal((await f.cycle('warning', 0)).level, 'warning');
  await f.cycle('warning', 1);
  assert.equal(f.issues.length, 1); assert.equal(f.comments.length, 1);
  await f.cycle('critical', 2);
  assert.equal(f.comments.length, 2); assert.match(f.comments[1].body, /incident \(critical\)/);
  await f.cycle('healthy', 3); assert.equal(f.issues[0].state, 'open');
  assert.equal((await f.cycle('healthy', 4)).level, 'healthy');
  assert.equal(f.issues[0].state, 'closed'); assert.equal(f.comments.length, 3);
  assert.match(f.comments[2].body, /@rubenatello.*recovery/);
  await f.cycle('warning', 5);
  assert.equal(f.issues.length, 1); assert.equal(f.issues[0].state, 'open');
});

test('an initial healthy non-canary observation remains an unpinned no-op', async () => {
  const f = fixture();
  const result = await f.cycle('healthy', 0);
  assert.deepEqual(result, { level: 'healthy', issueNumber: null });
  assert.equal(f.issues.length, 0);
  assert.equal(f.comments.length, 0);
});

test('a pinned authenticated issue cannot silently rebootstrap when deleted or unlabelled', async () => {
  for (const change of [
    f => f.issues.splice(0, 1),
    f => { f.issues[0].labels = []; },
  ]) {
    const f = fixture();
    const created = await f.cycle('warning', 0);
    assert.equal(created.issueNumber, 7);
    change(f);
    const issueCount = f.issues.length;
    const commentCount = f.comments.length;
    await assert.rejects(f.cycle('healthy', 1, '123:1', false, created.issueNumber), /QBO_GITHUB_MONITOR_FAILED/);
    assert.equal(f.issues.length, issueCount, 'loss must fail before creating a new state issue');
    assert.equal(f.comments.length, commentCount, 'loss must fail before recovery notification');
  }
});

test('a pinned signed replacement issue number is rejected, while the same closed issue can reopen', async () => {
  const replacement = fixture();
  const created = await replacement.cycle('warning', 0);
  replacement.issues[0] = { ...replacement.issues[0], number: 8 };
  await assert.rejects(replacement.cycle('healthy', 1, '123:1', false, created.issueNumber), /QBO_GITHUB_MONITOR_FAILED/);
  assert.equal(replacement.issues.length, 1);

  const reused = fixture();
  const pinned = (await reused.cycle('warning', 0)).issueNumber;
  await reused.cycle('healthy', 1, '123:1', false, pinned);
  await reused.cycle('healthy', 2, '123:1', false, pinned);
  assert.equal(reused.issues[0].state, 'closed');
  const reopened = await reused.cycle('warning', 3, '123:1', false, pinned);
  assert.equal(reopened.issueNumber, pinned);
  assert.equal(reused.issues.length, 1);
  assert.equal(reused.issues[0].state, 'open');
});

test('user same-title issue cannot suppress; bot forgery and duplicate trusted state fail closed', async () => {
  const f = fixture();
  f.issues.push({ ...issueFor(initialState('staging')), title: '[monitor] QuickBooks staging operational health', user: { id: 8, login: 'attacker', type: 'User' } });
  await f.cycle('warning', 0); assert.equal(f.issues.length, 2);
  f.issues.push({ ...f.issues[1], number: 9 });
  await assert.rejects(loadRecord(f.client, 'staging', key), /QBO_GITHUB_MONITOR_FAILED/);
  const forged = fixture();
  forged.issues.push({ ...issueFor(initialState('staging')), body: stateBody(initialState('staging'), key + '-wrong') });
  await assert.rejects(forged.cycle('warning', 0), /QBO_GITHUB_MONITOR_FAILED/);
  assert.equal(forged.comments.length, 0);
});

test('timeout after comment acceptance retains signed pending; next run reconciles without duplicate', async () => {
  const f = fixture(); f.faults.commentAcceptedThenThrow = true;
  await assert.rejects(f.cycle('warning', 0));
  assert.ok(parseIssue(f.issues[0], 'staging', key).state.pending);
  await f.cycle('warning', 1, '124:1');
  assert.equal(f.comments.length, 1);
  assert.equal(parseIssue(f.issues[0], 'staging', key).state.pending, null);
});

for (const fault of ['patchBefore', 'patchAfter']) test(`recovery ${fault} uncertainty is retry-idempotent`, async () => {
  const f = fixture();
  await f.cycle('warning', 0); await f.cycle('healthy', 1);
  f.faults[fault] = 4;
  await assert.rejects(f.cycle('healthy', 2));
  assert.equal(f.comments.length, 2);
  if (fault === 'patchBefore') assert.equal(f.issues[0].state, 'open');
  await f.cycle('healthy', 3, '124:1');
  assert.equal(f.comments.length, 2); assert.equal(f.issues[0].state, 'closed');
});

test('conflicting bot notification or excessive comment churn fails without clearing pending', async () => {
  for (const overflow of [false, true]) {
    const f = fixture(); f.faults.commentAcceptedThenThrow = true;
    await assert.rejects(f.cycle('warning', 0));
    if (overflow) f.issues[0].comments = 201;
    else f.comments[0].body += '\nforged body';
    await assert.rejects(flushPending(f.client, parseIssue(f.issues[0], 'staging', key), key), /QBO_GITHUB_MONITOR_FAILED/);
    assert.ok(parseIssue(f.issues[0], 'staging', key).state.pending);
  }
});

test('user copies are never receipts, daily canary is deduplicated and does not claim delivery', async () => {
  const f = fixture(); f.faults.commentAcceptedThenThrow = true;
  await assert.rejects(f.cycle('healthy', 0, '123:1', true));
  f.comments[0].user = { id: 10, login: 'attacker', type: 'User' };
  await f.cycle('healthy', 1, '124:1', true);
  assert.equal(f.comments.length, 2);
  assert.match(f.comments[1].body, /not a health or launch approval/);
  await f.cycle('healthy', 2, '124:1', true); assert.equal(f.comments.length, 2);
  assert.equal(f.issues[0].state, 'closed');
  assert.ok(!notification({ ...initialState('staging'), pending: { id: 'synthetic-id', kind: 'canary', level: 'healthy', at } }).includes(key));
});

test('hourly incident reminder is bounded and every unhealthy result resets recovery', () => {
  const state = cleanPending(transition(initialState('staging'), 'critical', at, 0, false, context(0)));
  assert.equal(transition(state, 'critical', at + 3_599_999, 1, false, context(1)).pending, null);
  assert.equal(transition(state, 'critical', at + 3_600_000, 1, false, context(1)).pending.kind, 'reminder');
});

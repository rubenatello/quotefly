import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

const REPOSITORY = 'rubenatello/quotefly';
const OWNER = 'rubenatello';
const BOT_ID = 41898282;
const PERIOD = 60_000;
const MAX_GAP = 180_000;
const kinds = ['incident', 'recovery', 'reminder', 'canary'];
const levels = ['healthy', 'warning', 'critical'];
const fail = () => { throw new Error('QBO_GITHUB_MONITOR_FAILED'); };
const integer = n => Number.isSafeInteger(n) && n >= 0;
const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o)
  && Object.keys(o).sort().join(',') === [...keys].sort().join(',');
const bot = user => user?.id === BOT_ID && user.login === 'github-actions[bot]' && user.type === 'Bot';

export function admission(env) {
  if (env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || env.GITHUB_REF_PROTECTED !== 'true' || env.QBO_MONITOR_ENABLED !== 'true'
    || !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(env.QBO_MONITOR_APPROVED_REF ?? '')
    || env.GITHUB_REF !== env.QBO_MONITOR_APPROVED_REF
    || !['staging', 'production'].includes(env.QBO_MONITOR_ENVIRONMENT)
    || (env.QBO_MONITOR_ENVIRONMENT === 'production' && env.GITHUB_REF !== 'refs/heads/main')
    || !/^[1-9][0-9]{0,2}$/.test(env.QBO_MONITOR_MINUTES ?? '')
    || Number(env.QBO_MONITOR_MINUTES) > 240
    || !['true', 'false'].includes(env.QBO_MONITOR_CANARY ?? '')
    || !/^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID ?? '')
    || !/^[1-9][0-9]{0,5}$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) fail();
  return { environment: env.QBO_MONITOR_ENVIRONMENT, minutes: Number(env.QBO_MONITOR_MINUTES),
    canary: env.QBO_MONITOR_CANARY === 'true', runKey: `${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}`,
    origin: env.QBO_MONITOR_ENVIRONMENT === 'staging' ? 'https://api-staging.quotefly.us' : 'https://api.quotefly.us' };
}

export function loadConfig(env) {
  const config = admission(env);
  const bearer = env.QBO_MONITOR_BEARER ?? '';
  const githubToken = env.GH_TOKEN ?? '';
  if (bearer.length < 32 || bearer.length > 4096 || /\s/.test(bearer)
    || githubToken.length < 20 || githubToken.length > 4096 || /\s/.test(githubToken)
    || bearer === githubToken) fail();
  return { ...config, bearer, githubToken };
}

async function boundedText(response, limit) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) fail();
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel(); }
}

export async function probe(config, fetcher = fetch) {
  const paths = ['/v1/health', '/v1/ready', '/v1/internal/quickbooks/monitor/warning', '/v1/internal/quickbooks/monitor/critical'];
  const codes = await Promise.all(paths.map(async (path, index) => {
    try {
      const response = await fetcher(config.origin + path, { method: 'GET', redirect: 'error',
        signal: AbortSignal.timeout(8000), headers: index < 2 ? {} : { authorization: `Bearer ${config.bearer}` } });
      const text = await boundedText(response, index < 2 ? 1024 : 0);
      if (index < 2) {
        const body = JSON.parse(text);
        if (response.status !== 200 || body?.service !== 'quotefly-api'
          || body.status !== (index === 0 ? 'ok' : 'ready')) return 0;
      }
      return response.status;
    } catch { return 0; }
  }));
  if (codes[0] !== 200 || codes[1] !== 200 || codes[3] !== 204 || ![204, 503].includes(codes[2])) return 'critical';
  return codes[2] === 503 ? 'warning' : 'healthy';
}

export function initialState(environment) {
  return { version: 1, environment, level: 'healthy', firstClean: null, observedAt: 0,
    lastAlertAt: 0, lastCanaryAt: 0, pending: null };
}

export function validateState(s, environment) {
  if (!exact(s, ['version', 'environment', 'level', 'firstClean', 'observedAt', 'lastAlertAt', 'lastCanaryAt', 'pending'])
    || s.version !== 1 || s.environment !== environment || !levels.includes(s.level)
    || ![s.observedAt, s.lastAlertAt, s.lastCanaryAt].every(integer)
    || (s.firstClean !== null && (!exact(s.firstClean, ['at', 'runKey', 'cycle', 'elapsedMs'])
      || !integer(s.firstClean.at) || s.firstClean.at > s.observedAt
      || !/^[1-9][0-9]{0,19}:[1-9][0-9]{0,5}$/.test(s.firstClean.runKey)
      || !integer(s.firstClean.cycle) || s.firstClean.cycle > 239 || !integer(s.firstClean.elapsedMs)))
    || s.lastAlertAt > s.observedAt || s.lastCanaryAt > s.observedAt) return false;
  const p = s.pending;
  return p === null || (exact(p, ['id', 'kind', 'level', 'at', 'commentBaseline'])
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(p.id)
    && kinds.includes(p.kind) && levels.includes(p.level) && integer(p.at) && p.at <= s.observedAt
    && integer(p.commentBaseline) && p.commentBaseline <= 100_000);
}

const intro = environment => `QuoteFly QuickBooks ${environment} monitor state.\nAggregate observations only; this issue is not proof of email delivery or accounting readiness.\n`;
export function stateBody(state, stateKey) {
  if (typeof stateKey !== 'string' || stateKey.length < 32) fail();
  const json = JSON.stringify(state);
  const mac = createHmac('sha256', stateKey).update('quotefly-github-monitor-state-v1\0').update(json).digest('hex');
  return `${intro(state.environment)}\n<!-- qbo-monitor-state:${json}\nqbo-monitor-mac:${mac} -->`;
}

export function parseIssue(issue, environment, stateKey) {
  const label = `qbo-monitor-${environment}`;
  if (!bot(issue?.user) || issue.pull_request || !issue.labels?.some(l => l.name === label)) return null;
  if (!Number.isSafeInteger(issue.number) || issue.number < 1 || !integer(issue.comments)
    || issue.comments > 100_000 || issue.locked !== false || !['open', 'closed'].includes(issue.state)
    || typeof issue.body !== 'string' || issue.body.length > 4096) fail();
  try {
    const prefix = `${intro(environment)}\n<!-- qbo-monitor-state:`;
    if (!issue.body.startsWith(prefix) || !issue.body.endsWith(' -->')) fail();
    const content = issue.body.slice(prefix.length, -4);
    const split = content.lastIndexOf('\nqbo-monitor-mac:');
    if (split < 0 || !/^[0-9a-f]{64}$/.test(content.slice(split + 17))) fail();
    const state = JSON.parse(content.slice(0, split));
    if (!validateState(state, environment)) fail();
    const expected = Buffer.from(stateBody(state, stateKey));
    const actual = Buffer.from(issue.body);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) fail();
    return { issue, state };
  } catch { fail(); }
}

// A recovery quorum is two complete, recent authoritative cycles, not two workflow conclusions.
export function transition(previous, level, now, comments, canary, context, id = randomUUID) {
  if (!validateState(previous, previous.environment) || !levels.includes(level) || !integer(now)
    || now <= previous.observedAt || previous.pending || !integer(comments) || comments > 100_000
    || !/^[1-9][0-9]{0,19}:[1-9][0-9]{0,5}$/.test(context?.runKey ?? '')
    || !integer(context?.cycle) || context.cycle > 239 || !integer(context?.elapsedMs)) fail();
  const next = structuredClone(previous);
  next.observedAt = now;
  let kind = null;
  if (level !== 'healthy') {
    next.firstClean = null;
    if (previous.level !== level) kind = 'incident';
    else if (now - previous.lastAlertAt >= 60 * PERIOD) kind = 'reminder';
    next.level = level;
  } else if (previous.level !== 'healthy') {
    const age = previous.firstClean === null ? null : context.elapsedMs - previous.firstClean.elapsedMs;
    if (age !== null && age >= PERIOD && age <= MAX_GAP
      && previous.firstClean.runKey === context.runKey && previous.firstClean.cycle === context.cycle - 1) {
      next.level = 'healthy'; next.firstClean = null; kind = 'recovery';
    } else next.firstClean = { at: now, runKey: context.runKey, cycle: context.cycle, elapsedMs: context.elapsedMs };
  } else next.firstClean = null;
  if (!kind && canary && now - previous.lastCanaryAt >= 24 * 60 * PERIOD) kind = 'canary';
  if (kind) {
    next.pending = { id: id(), kind, level: next.level, at: now, commentBaseline: comments };
    if (kind === 'canary') next.lastCanaryAt = now; else next.lastAlertAt = now;
  }
  return next;
}

export function notification(state) {
  const p = state.pending;
  if (!p) fail();
  return `@${OWNER} QuoteFly QuickBooks ${state.environment}: ${p.kind} (${p.level}).\n`
    + `Observed at ${new Date(p.at).toISOString()}.\n`
    + (p.kind === 'canary' ? 'Delivery check only. Confirm receipt in the selected mailbox; this is not a health or launch approval.\n'
      : 'Review the restricted Integration Health panel and monitoring runbook. This is a point-in-time aggregate observation, not proof that monitoring will remain available.\n')
    + `<!-- qbo-notification:${p.id} -->`;
}

export function githubClient(token, fetcher = fetch) {
  return async (path, method = 'GET', body) => {
    if (!/^\/(?:issues|labels)(?:[/?]|$)/.test(path) || path.includes('..') || /[\r\n#]/.test(path)) fail();
    try {
      const response = await fetcher(`https://api.github.com/repos/${REPOSITORY}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
          'content-type': 'application/json', 'x-github-api-version': '2026-03-10' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) { await response.body?.cancel(); fail(); }
      return JSON.parse(await boundedText(response, 1024 * 1024));
    } catch { fail(); }
  };
}

async function save(client, record, state, stateKey) {
  const updated = await client(`/issues/${record.issue.number}`, 'PATCH', { body: stateBody(state, stateKey),
    state: state.level === 'healthy' && !state.pending ? 'closed' : 'open' });
  const parsed = parseIssue(updated, state.environment, stateKey);
  if (!parsed || stateBody(parsed.state, stateKey) !== stateBody(state, stateKey)) fail();
  return parsed;
}

export async function flushPending(client, record, stateKey) {
  if (!record.state.pending) return record;
  const fresh = parseIssue(await client(`/issues/${record.issue.number}`), record.state.environment, stateKey);
  if (!fresh || stateBody(fresh.state, stateKey) !== stateBody(record.state, stateKey)) fail();
  const p = fresh.state.pending;
  const text = notification(fresh.state);
  if (fresh.issue.comments < p.commentBaseline || fresh.issue.comments - p.commentBaseline > 200) fail();
  const startPage = Math.floor(p.commentBaseline / 100) + 1;
  const lastPage = Math.max(startPage, Math.ceil(fresh.issue.comments / 100));
  let accepted = false;
  for (let page = startPage; page <= lastPage; page++) {
    const comments = await client(`/issues/${fresh.issue.number}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(comments) || comments.length > 100) fail();
    if (comments.some(c => bot(c?.user) && typeof c.body === 'string'
      && c.body.includes(`<!-- qbo-notification:${p.id} -->`) && c.body !== text)) fail();
    accepted ||= comments.some(c => bot(c?.user) && c.body === text);
  }
  if (!accepted) {
    const result = await client(`/issues/${fresh.issue.number}/comments`, 'POST', { body: text });
    if (!bot(result?.user) || result.body !== text) fail();
  }
  // A failed/ambiguous POST leaves pending intact. A later attempt reconciles before resending.
  return save(client, fresh, { ...fresh.state, pending: null }, stateKey);
}

export async function loadRecord(client, environment, stateKey, expectedIssueNumber = null) {
  if (expectedIssueNumber !== null && (!Number.isSafeInteger(expectedIssueNumber) || expectedIssueNumber < 1)) fail();
  const label = `qbo-monitor-${environment}`;
  const configured = await client(`/labels/${label}`);
  if (configured?.name !== label) fail(); // Pre-create under maintainer authority; never trust title alone.
  const issues = await client(`/issues?state=all&labels=${label}&per_page=100&sort=created&direction=asc`);
  if (!Array.isArray(issues) || issues.length >= 100) fail();
  const records = issues.map(i => parseIssue(i, environment, stateKey)).filter(Boolean);
  if (records.length > 1) fail();
  const record = records[0] ?? null;
  if (expectedIssueNumber !== null && record?.issue.number !== expectedIssueNumber) fail();
  return record;
}

export async function recordCycle(client, environment, level, at, canary, context, stateKey, expectedIssueNumber = null) {
  let record = await loadRecord(client, environment, stateKey, expectedIssueNumber);
  if (record) record = await flushPending(client, record, stateKey);
  const next = transition(record?.state ?? initialState(environment), level, at, record?.issue.comments ?? 0, canary, context);
  if (!record && !next.pending) return { level: next.level, issueNumber: null };
  if (!record) {
    const created = await client('/issues', 'POST', { title: `[monitor] QuickBooks ${environment} operational health`,
      body: stateBody(next, stateKey), labels: [`qbo-monitor-${environment}`], assignees: [OWNER] });
    record = parseIssue(created, environment, stateKey);
    if (!record || stateBody(record.state, stateKey) !== stateBody(next, stateKey)) fail();
  } else record = await save(client, record, next, stateKey);
  record = await flushPending(client, record, stateKey);
  return { level: record.state.level, issueNumber: record.issue.number };
}

export async function runMonitor(config, dependencies = {}) {
  const clock = dependencies.clock ?? Date.now;
  const monotonic = dependencies.monotonic ?? (dependencies.clock ? clock : () => performance.now());
  const pause = dependencies.sleep ?? sleep;
  const sample = dependencies.probe ?? (() => probe(config));
  const record = dependencies.record ?? ((level, at, canary, context, expectedIssueNumber) => recordCycle(githubClient(config.githubToken), config.environment, level, at, canary, context, config.bearer, expectedIssueNumber));
  const start = monotonic();
  let previousStart = start - PERIOD;
  let lastLevel = 'critical';
  let expectedIssueNumber = null;
  for (let cycle = 0; cycle < config.minutes; cycle++) {
    for (;;) {
      const remaining = previousStart + PERIOD - monotonic();
      if (remaining <= 0) break;
      await pause(Math.ceil(remaining));
    }
    const at = clock();
    const tick = monotonic();
    if (tick - start > 244 * PERIOD) fail();
    previousStart = tick;
    const level = await sample();
    const result = await record(level, at, config.canary, { runKey: config.runKey, cycle, elapsedMs: Math.floor(tick - start) }, expectedIssueNumber);
    const issueNumber = result?.issueNumber;
    if (expectedIssueNumber !== null && issueNumber !== expectedIssueNumber) fail();
    if (expectedIssueNumber === null && issueNumber !== undefined) {
      if (issueNumber !== null && (!Number.isSafeInteger(issueNumber) || issueNumber < 1)) fail();
      if (issueNumber !== null) expectedIssueNumber = issueNumber;
    }
    lastLevel = result.level;
  }
  return lastLevel === 'healthy' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === '--admission-only') { admission(process.env); process.stdout.write('QBO_MONITOR_ADMISSION_OK\n'); }
    else {
      const result = await runMonitor(loadConfig(process.env));
      process.stdout.write(result === 0 ? 'QBO_GITHUB_MONITOR_HEALTHY\n' : 'QBO_GITHUB_MONITOR_UNHEALTHY\n');
      process.exitCode = result;
    }
  } catch { process.stderr.write('QBO_GITHUB_MONITOR_FAILED\n'); process.exitCode = 1; }
}

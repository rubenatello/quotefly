import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluateImageScan } from './quickbooks-image-scan-policy.mjs';

const now = Date.parse('2026-09-06T22:00:00.000Z');
const database = { Version: 2, UpdatedAt: '2026-09-06T19:00:00Z' };
const imageTag = 'quotefly-qbo-watchdog:local-policy-test';
const configDigest = `sha256:${'a'.repeat(64)}`;
const baseDigest = `sha256:${'b'.repeat(64)}`;
const identity = {
  schema: 'quotefly.watchdog-image-archive/v1', format: 'oci', imageTag,
  outerImageDigest: `sha256:${'c'.repeat(64)}`, manifestDigest: `sha256:${'d'.repeat(64)}`,
  imageConfigDigest: configDigest, platform: 'linux/amd64', layerCount: 1,
};
const finding = {
  Severity: 'HIGH', VulnerabilityID: 'CVE-2026-12345', PkgName: 'fixture',
  InstalledVersion: '1', FixedVersion: '2',
};
const scopePaths = [
  'ops/quickbooks-watchdog/Dockerfile',
  'src/services/quickbooks-observability.ts',
  'src/services/quickbooks-worker-operational.ts',
  'src/watchdog/core.ts',
  'src/watchdog/main.ts',
  'src/watchdog/process-lock.ts',
  'src/watchdog/server.ts',
  'src/watchdog/store.ts',
];
const sourceRoot = mkdtempSync(join(tmpdir(), 'qbo-image-policy-'));

for (const path of scopePaths) {
  const absolute = join(sourceRoot, ...path.split('/'));
  mkdirSync(join(absolute, '..'), { recursive: true });
  const body = path.endsWith('Dockerfile')
    ? `FROM fixture@${baseDigest} AS build\r\nFROM fixture@${baseDigest}\r\n`
    : `// ${path}\r\nexport const fixture = true;\r\n`;
  writeFileSync(absolute, body);
}
after(() => rmSync(sourceRoot, { recursive: true, force: true }));

function sourceDigest(path) {
  const normalized = readFileSync(join(sourceRoot, ...path.split('/')), 'utf8').replace(/\r\n?/g, '\n');
  return `sha256:${createHash('sha256').update(normalized).digest('hex')}`;
}

const fixture = (vulnerabilities) => ({
  SchemaVersion: 2,
  CreatedAt: new Date(now).toISOString(),
  ArtifactType: 'container_image',
  Metadata: {
    ImageID: configDigest,
    RepoTags: [imageTag],
    OS: { Family: 'debian' },
    ImageConfig: { os: 'linux', architecture: 'amd64' },
  },
  Results: [{ Class: 'os-pkgs', Type: 'debian', Vulnerabilities: vulnerabilities }],
});

function dispositionEntry(entry) {
  return {
    vulnerabilityId: entry.VulnerabilityID,
    packageName: entry.PkgName,
    installedVersion: entry.InstalledVersion,
    rationale: 'Reviewed residual in the pinned runtime image without an available upstream fix.',
    sourceUrl: `https://security-tracker.debian.org/tracker/${entry.VulnerabilityID}`,
  };
}

function dispositions(residualFindings = []) {
  const unique = new Map(residualFindings.map((entry) => [
    JSON.stringify([entry.VulnerabilityID, entry.PkgName, entry.InstalledVersion]),
    dispositionEntry(entry),
  ]));
  return {
    schema: 'quotefly.watchdog-image-dispositions/v1',
    reviewedAtUtc: '2026-09-06T20:00:00.000Z',
    expiresAtUtc: '2026-09-30T20:00:00.000Z',
    reviewer: 'sentinel',
    platform: 'linux/amd64',
    baseDigest,
    scopeFiles: scopePaths.map((path) => ({ path, sha256: sourceDigest(path) })),
    entries: [...unique.values()],
  };
}

test('passes a fresh complete zero-finding scan bound to archive, tag, platform, and source scope', () => {
  const result = evaluateImageScan(fixture([]), database, dispositions(), identity, now, sourceRoot);
  assert.equal(result.passed, true);
  assert.equal(result.dispositionsMatched, 0);
});

test('blocks every fixable critical/high without suppression while retaining counts', () => {
  const result = evaluateImageScan(
    fixture([finding, { ...finding, Severity: 'CRITICAL' }]),
    database,
    dispositions(),
    identity,
    now,
    sourceRoot,
  );
  assert.equal(result.passed, false);
  assert.equal(result.fixableHighCritical, 2);
  assert.deepEqual(result.counts, { UNKNOWN: 0, LOW: 0, MEDIUM: 0, HIGH: 1, CRITICAL: 1 });
});

test('requires exact dispositions for every unique unfixed high/critical tuple', () => {
  const residual = { ...finding, FixedVersion: '' };
  const duplicateRecord = { ...residual };
  const result = evaluateImageScan(
    fixture([residual, duplicateRecord]), database, dispositions([residual]), identity, now, sourceRoot,
  );
  assert.equal(result.passed, true);
  assert.equal(result.residualHighCritical, 2);
  assert.equal(result.residualTupleCount, 1);

  for (const invalid of [
    { ...dispositions([residual]), entries: [] },
    { ...dispositions([residual]), entries: [...dispositions([residual]).entries, dispositionEntry({ ...residual, PkgName: 'extra' })] },
    { ...dispositions([residual]), entries: [...dispositions([residual]).entries, ...dispositions([residual]).entries] },
  ]) {
    assert.throws(
      () => evaluateImageScan(fixture([residual]), database, invalid, identity, now, sourceRoot),
      /EVIDENCE_INVALID/,
    );
  }
});

test('rejects stale, future, malformed, expired, or overlong evidence windows', () => {
  for (const db of [{}, { ...database, Version: 1 },
    { ...database, UpdatedAt: [database.UpdatedAt] },
    { ...database, UpdatedAt: '2026-09-04T00:00:00Z' },
    { ...database, UpdatedAt: '2026-09-07T00:00:00Z' }]) {
    assert.throws(() => evaluateImageScan(fixture([]), db, dispositions(), identity, now, sourceRoot), /EVIDENCE_INVALID/);
  }
  for (const CreatedAt of ['invalid', '2026-09-06T20:00:00Z', '2026-09-07T00:00:00Z', [new Date(now).toISOString()]]) {
    assert.throws(
      () => evaluateImageScan({ ...fixture([]), CreatedAt }, database, dispositions(), identity, now, sourceRoot),
      /EVIDENCE_INVALID/,
    );
  }
  for (const invalid of [
    { ...dispositions(), expiresAtUtc: '2026-09-06T21:59:59.000Z' },
    { ...dispositions(), reviewedAtUtc: '2026-09-07T00:00:00.000Z' },
    { ...dispositions(), expiresAtUtc: '2026-10-30T20:00:00.000Z' },
    { ...dispositions(), expiresAtUtc: ['2026-09-30T20:00:00.000Z'] },
  ]) {
    assert.throws(() => evaluateImageScan(fixture([]), database, invalid, identity, now, sourceRoot), /EVIDENCE_INVALID/);
  }
});

test('rejects report/archive identity, tag, or platform mismatches without coercion', () => {
  for (const report of [
    { ...fixture([]), Metadata: { ...fixture([]).Metadata, ImageID: `sha256:${'e'.repeat(64)}` } },
    { ...fixture([]), Metadata: { ...fixture([]).Metadata, RepoTags: imageTag } },
    { ...fixture([]), Metadata: { ...fixture([]).Metadata, RepoTags: ['quotefly-qbo-watchdog:local-other'] } },
    { ...fixture([]), Metadata: { ...fixture([]).Metadata, ImageConfig: { os: 'linux', architecture: ['amd64'] } } },
  ]) {
    assert.throws(() => evaluateImageScan(report, database, dispositions(), identity, now, sourceRoot), /EVIDENCE_INVALID/);
  }
  assert.throws(
    () => evaluateImageScan(fixture([]), database, dispositions(), { ...identity, platform: 'linux/arm64' }, now, sourceRoot),
    /EVIDENCE_INVALID/,
  );
});

test('rejects unknown severities and malformed findings rather than hiding them', () => {
  for (const entry of [{ ...finding, Severity: ['HIGH'] }, { ...finding, Severity: 'FATAL' },
    { ...finding, FixedVersion: ['2'] }, { ...finding, VulnerabilityID: '' }, null]) {
    assert.throws(
      () => evaluateImageScan(fixture([entry]), database, dispositions(), identity, now, sourceRoot),
      /EVIDENCE_INVALID/,
    );
  }
});

test('invalidates dispositions on source drift, scope changes, base changes, or malformed review data', () => {
  const changedPath = scopePaths.at(-1);
  const changedFile = join(sourceRoot, ...changedPath.split('/'));
  const original = readFileSync(changedFile, 'utf8');
  const reviewedBeforeDrift = dispositions();
  writeFileSync(changedFile, `${original}// drift\n`);
  assert.throws(
    () => evaluateImageScan(fixture([]), database, reviewedBeforeDrift, identity, now, sourceRoot),
    /EVIDENCE_INVALID/,
  );
  writeFileSync(changedFile, original);

  for (const invalid of [
    { ...dispositions(), baseDigest: `sha256:${'f'.repeat(64)}` },
    { ...dispositions(), scopeFiles: dispositions().scopeFiles.slice(1) },
    { ...dispositions(), scopeFiles: [...dispositions().scopeFiles, dispositions().scopeFiles[0]] },
    { ...dispositions(), reviewer: 'developer' },
    { ...dispositions(), reviewer: ['sentinel'] },
  ]) {
    assert.throws(() => evaluateImageScan(fixture([]), database, invalid, identity, now, sourceRoot), /EVIDENCE_INVALID/);
  }
});

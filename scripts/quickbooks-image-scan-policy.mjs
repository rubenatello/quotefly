import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectQuickBooksImageArchive } from './quickbooks-image-archive.mjs';

const severities = new Set(['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const cvePattern = /^CVE-[0-9]{4}-[0-9]{4,}$/;
const scopePaths = Object.freeze([
  'ops/quickbooks-watchdog/Dockerfile',
  'src/services/quickbooks-observability.ts',
  'src/services/quickbooks-worker-operational.ts',
  'src/watchdog/core.ts',
  'src/watchdog/main.ts',
  'src/watchdog/process-lock.ts',
  'src/watchdog/server.ts',
  'src/watchdog/store.ts',
]);
const fail = () => { throw new Error('QBO_IMAGE_SCAN_EVIDENCE_INVALID'); };

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail();
}

function exactIsoDate(value) {
  if (typeof value !== 'string'
    || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/.test(value)) fail();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail();
  return parsed;
}

function normalizedLfDigest(sourceRoot, relativePath) {
  let source;
  try {
    source = readFileSync(resolve(sourceRoot, ...relativePath.split('/')), 'utf8');
  } catch {
    fail();
  }
  if (source.includes('\u0000')) fail();
  const normalized = source.replace(/\r\n?/g, '\n');
  return `sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}

function validateSourceScope(dispositions, sourceRoot) {
  if (!Array.isArray(dispositions.scopeFiles) || dispositions.scopeFiles.length !== scopePaths.length) fail();
  const observed = new Map();
  for (const entry of dispositions.scopeFiles) {
    exactKeys(entry, ['path', 'sha256']);
    if (typeof entry.path !== 'string' || !scopePaths.includes(entry.path)
      || typeof entry.sha256 !== 'string' || !digestPattern.test(entry.sha256)
      || observed.has(entry.path)) fail();
    observed.set(entry.path, entry.sha256);
  }
  for (const path of scopePaths) {
    if (observed.get(path) !== normalizedLfDigest(sourceRoot, path)) fail();
  }

  const dockerfile = readFileSync(resolve(sourceRoot, 'ops', 'quickbooks-watchdog', 'Dockerfile'), 'utf8')
    .replace(/\r\n?/g, '\n');
  const baseDigests = [...dockerfile.matchAll(/^FROM\s+\S+@(sha256:[a-f0-9]{64})(?:\s|$)/gm)]
    .map((match) => match[1]);
  if (baseDigests.length !== 2 || baseDigests.some((digest) => digest !== dispositions.baseDigest)) fail();
}

function residualKey(finding) {
  return JSON.stringify([finding.VulnerabilityID, finding.PkgName, finding.InstalledVersion]);
}

function validateArchiveIdentity(identity) {
  exactKeys(identity, [
    'schema', 'format', 'identityMode', 'imageTag', 'engineImageId', 'rootDescriptorDigest',
    'outerImageDigest', 'manifestDigest', 'imageConfigDigest', 'platform', 'layerCount',
  ]);
  if (identity.schema !== 'quotefly.watchdog-image-archive/v1'
    || identity.platform !== 'linux/amd64'
    || typeof identity.imageTag !== 'string'
    || typeof identity.engineImageId !== 'string' || !digestPattern.test(identity.engineImageId)
    || typeof identity.outerImageDigest !== 'string' || !digestPattern.test(identity.outerImageDigest)
    || typeof identity.imageConfigDigest !== 'string' || !digestPattern.test(identity.imageConfigDigest)
    || !Number.isSafeInteger(identity.layerCount) || identity.layerCount < 1) fail();

  if (identity.format === 'oci') {
    if (typeof identity.rootDescriptorDigest !== 'string' || !digestPattern.test(identity.rootDescriptorDigest)
      || identity.outerImageDigest !== identity.rootDescriptorDigest
      || typeof identity.manifestDigest !== 'string' || !digestPattern.test(identity.manifestDigest)) fail();
    if (identity.identityMode === 'root_digest') {
      if (identity.engineImageId !== identity.rootDescriptorDigest) fail();
    } else if (identity.identityMode === 'config_digest') {
      if (identity.engineImageId !== identity.imageConfigDigest
        || identity.engineImageId === identity.rootDescriptorDigest) fail();
    } else fail();
    return;
  }

  if (identity.format !== 'docker' || identity.identityMode !== 'config_digest'
    || identity.rootDescriptorDigest !== null || identity.manifestDigest !== null
    || identity.engineImageId !== identity.imageConfigDigest
    || identity.outerImageDigest !== identity.engineImageId) fail();
}

function validateDispositions(dispositions, residuals, archiveIdentity, now, sourceRoot) {
  exactKeys(dispositions, [
    'schema', 'reviewedAtUtc', 'expiresAtUtc', 'reviewer', 'platform', 'baseDigest', 'scopeFiles', 'entries',
  ]);
  if (dispositions.schema !== 'quotefly.watchdog-image-dispositions/v1'
    || dispositions.platform !== 'linux/amd64'
    || dispositions.platform !== archiveIdentity.platform
    || typeof dispositions.baseDigest !== 'string' || !digestPattern.test(dispositions.baseDigest)
    || dispositions.reviewer !== 'sentinel'
    || !Array.isArray(dispositions.entries)) fail();
  const reviewed = exactIsoDate(dispositions.reviewedAtUtc);
  const expires = exactIsoDate(dispositions.expiresAtUtc);
  if (reviewed > now + 5 * 60 * 1000 || expires <= now
    || expires <= reviewed || expires - reviewed > 30 * 24 * 60 * 60 * 1000) fail();

  validateSourceScope(dispositions, sourceRoot);
  const dispositionKeys = new Set();
  for (const entry of dispositions.entries) {
    exactKeys(entry, ['vulnerabilityId', 'packageName', 'installedVersion', 'rationale', 'sourceUrl']);
    if (typeof entry.vulnerabilityId !== 'string' || !cvePattern.test(entry.vulnerabilityId)
      || typeof entry.packageName !== 'string' || !entry.packageName.trim() || entry.packageName.length > 240
      || typeof entry.installedVersion !== 'string' || !entry.installedVersion.trim() || entry.installedVersion.length > 240
      || typeof entry.rationale !== 'string' || entry.rationale.trim().length < 20 || entry.rationale.length > 2_000
      || typeof entry.sourceUrl !== 'string' || entry.sourceUrl.length > 2_048) fail();
    let source;
    try {
      source = new URL(entry.sourceUrl);
    } catch {
      fail();
    }
    if (source.protocol !== 'https:' || source.username || source.password || !source.hostname) fail();
    const key = JSON.stringify([entry.vulnerabilityId, entry.packageName, entry.installedVersion]);
    if (dispositionKeys.has(key)) fail();
    dispositionKeys.add(key);
  }
  if (dispositionKeys.size !== residuals.size
    || [...residuals].some((key) => !dispositionKeys.has(key))
    || [...dispositionKeys].some((key) => !residuals.has(key))) fail();
  return { reviewed, expires };
}

// The archive verifier cryptographically binds the local tag, outer image ID,
// selected linux/amd64 manifest, config, and every layer. This policy binds that
// config and tag to Trivy without printing image configuration or findings.
export function evaluateImageScan(report, database, dispositions, archiveIdentity, now = Date.now(), sourceRoot = process.cwd()) {
  validateArchiveIdentity(archiveIdentity);
  if (report?.SchemaVersion !== 2 || report.ArtifactType !== 'container_image'
    || typeof report.Metadata?.ImageID !== 'string'
    || !digestPattern.test(report.Metadata.ImageID)
    || report.Metadata.ImageID !== archiveIdentity?.imageConfigDigest
    || !Array.isArray(report.Metadata.RepoTags)
    || !report.Metadata.RepoTags.every((tag) => typeof tag === 'string')
    || !report.Metadata.RepoTags.includes(archiveIdentity.imageTag)
    || report.Metadata.OS?.Family !== 'debian'
    || report.Metadata.ImageConfig?.os !== 'linux'
    || report.Metadata.ImageConfig?.architecture !== 'amd64'
    || !Array.isArray(report.Results) || !report.Results.length
    || !report.Results.some((result) => result.Class === 'os-pkgs' && result.Type === 'debian')) fail();
  if (typeof database?.UpdatedAt !== 'string' || typeof report.CreatedAt !== 'string') fail();
  const updated = Date.parse(database.UpdatedAt);
  const scanned = Date.parse(report.CreatedAt);
  if (database?.Version !== 2 || !Number.isFinite(now)
    || !Number.isFinite(updated) || !Number.isFinite(scanned)
    || now - updated > 36 * 60 * 60 * 1000 || updated - now > 5 * 60 * 1000
    || now - scanned > 60 * 60 * 1000 || scanned - now > 5 * 60 * 1000) fail();
  const counts = { UNKNOWN: 0, LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
  let fixableHighCritical = 0;
  const residuals = new Set();
  let residualHighCritical = 0;
  for (const result of report.Results) {
    if (!['os-pkgs', 'lang-pkgs'].includes(result?.Class)) fail();
    if (result.Vulnerabilities === undefined) continue;
    if (!Array.isArray(result.Vulnerabilities)) fail();
    for (const finding of result.Vulnerabilities) {
      if (!severities.has(finding?.Severity)
        || typeof finding.VulnerabilityID !== 'string' || !finding.VulnerabilityID
        || typeof finding.PkgName !== 'string' || !finding.PkgName
        || typeof finding.InstalledVersion !== 'string' || !finding.InstalledVersion
        || (finding.FixedVersion !== undefined && typeof finding.FixedVersion !== 'string')) fail();
      counts[finding.Severity]++;
      if (finding.Severity === 'HIGH' || finding.Severity === 'CRITICAL') {
        if (finding.FixedVersion?.trim()) {
          fixableHighCritical++;
        } else {
          if (!cvePattern.test(finding.VulnerabilityID)) fail();
          residualHighCritical++;
          residuals.add(residualKey(finding));
        }
      }
    }
  }
  const dispositionWindow = validateDispositions(dispositions, residuals, archiveIdentity, now, sourceRoot);
  return {
    schema: 'quotefly.watchdog-image-scan/v1',
    imageConfigDigest: report.Metadata.ImageID,
    imageTag: archiveIdentity.imageTag,
    platform: archiveIdentity.platform,
    databaseUpdatedAtUtc: new Date(updated).toISOString(),
    scannedAtUtc: new Date(scanned).toISOString(),
    dispositionExpiresAtUtc: new Date(dispositionWindow.expires).toISOString(),
    counts,
    fixableHighCritical,
    residualHighCritical,
    residualTupleCount: residuals.size,
    dispositionsMatched: residuals.size,
    passed: fixableHighCritical === 0,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 8) fail();
    const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const database = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    const archiveIdentity = await inspectQuickBooksImageArchive(process.argv[4], process.argv[5], process.argv[6]);
    const dispositions = JSON.parse(readFileSync(process.argv[7], 'utf8'));
    const result = evaluateImageScan(report, database, dispositions, archiveIdentity);
    console.log(JSON.stringify(result));
    if (!result.passed) process.exitCode = 1;
  } catch {
    console.error('QBO_IMAGE_SCAN_EVIDENCE_INVALID');
    process.exitCode = 1;
  }
}

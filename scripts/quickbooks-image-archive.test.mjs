import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { inspectQuickBooksImageArchive } from './quickbooks-image-archive.mjs';

const root = mkdtempSync(join(tmpdir(), 'qbo-image-archive-'));
const tag = 'quotefly-qbo-watchdog:local-archive-test';
after(() => rmSync(root, { recursive: true, force: true }));

function digest(buffer) {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

function json(value) {
  return Buffer.from(JSON.stringify(value));
}

function writeBlob(directory, buffer, forcedDigest = digest(buffer)) {
  const path = join(directory, 'blobs', 'sha256', forcedDigest.slice('sha256:'.length));
  mkdirSync(join(directory, 'blobs', 'sha256'), { recursive: true });
  writeFileSync(path, buffer);
  return { mediaType: 'application/octet-stream', digest: forcedDigest, size: buffer.length };
}

function createTar(directory, name, members) {
  const archive = join(root, name);
  const result = spawnSync('tar', ['-cf', archive, '-C', directory, ...members], {
    windowsHide: true,
    stdio: 'ignore',
  });
  assert.equal(result.status, 0);
  return archive;
}

function createOciArchive(name, options = {}) {
  const directory = join(root, `${name}-source`);
  mkdirSync(directory, { recursive: true });
  const config = json({ architecture: 'amd64', os: 'linux', rootfs: { type: 'layers', diff_ids: [] } });
  const configDescriptor = writeBlob(directory, config);
  configDescriptor.mediaType = 'application/vnd.oci.image.config.v1+json';
  const layerBody = Buffer.from(options.tamperLayer ? 'tampered-layer' : 'verified-layer');
  const expectedLayerBody = Buffer.from('verified-layer');
  const layerDescriptor = writeBlob(
    directory,
    layerBody,
    options.tamperLayer ? digest(expectedLayerBody) : undefined,
  );
  layerDescriptor.mediaType = 'application/vnd.oci.image.layer.v1.tar';
  if (options.tamperLayer) layerDescriptor.size = expectedLayerBody.length;
  const manifestBody = json({ schemaVersion: 2, config: configDescriptor, layers: [layerDescriptor] });
  const manifestDescriptor = writeBlob(directory, manifestBody);
  manifestDescriptor.mediaType = 'application/vnd.oci.image.manifest.v1+json';
  manifestDescriptor.platform = { os: 'linux', architecture: 'amd64' };

  const leaves = [manifestDescriptor];
  if (options.ambiguousPlatform) leaves.push({ ...manifestDescriptor });
  const outerBody = json({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: leaves,
  });
  const outerDescriptor = writeBlob(directory, outerBody);
  outerDescriptor.mediaType = 'application/vnd.oci.image.index.v1+json';
  outerDescriptor.annotations = {
    'io.containerd.image.name': `docker.io/library/${tag}`,
    'org.opencontainers.image.ref.name': tag.slice(tag.indexOf(':') + 1),
  };
  writeFileSync(join(directory, 'index.json'), JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [outerDescriptor],
  }));
  writeFileSync(join(directory, 'oci-layout'), JSON.stringify({ imageLayoutVersion: '1.0.0' }));
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify([{
    Config: `blobs/sha256/${configDescriptor.digest.slice('sha256:'.length)}`,
    RepoTags: [tag],
    Layers: [`blobs/sha256/${layerDescriptor.digest.slice('sha256:'.length)}`],
  }]));
  const members = ['blobs', 'index.json', 'manifest.json', 'oci-layout'];
  return {
    archive: createTar(directory, `${name}.tar`, members),
    outerDigest: outerDescriptor.digest,
    configDigest: configDescriptor.digest,
  };
}

function createTraditionalArchive(name, { tamperLayer = false } = {}) {
  const directory = join(root, `${name}-source`);
  mkdirSync(directory, { recursive: true });
  const layer = Buffer.from(tamperLayer ? 'tampered-legacy-layer' : 'legacy-layer');
  const expectedLayer = Buffer.from('legacy-layer');
  writeFileSync(join(directory, 'layer.tar'), layer);
  const config = json({
    architecture: 'amd64', os: 'linux',
    rootfs: { type: 'layers', diff_ids: [digest(expectedLayer)] },
  });
  const configDigest = digest(config);
  const configName = `${configDigest.slice('sha256:'.length)}.json`;
  writeFileSync(join(directory, configName), config);
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify([{
    Config: configName, RepoTags: [tag], Layers: ['layer.tar'],
  }]));
  return {
    archive: createTar(directory, `${name}.tar`, [configName, 'layer.tar', 'manifest.json']),
    outerDigest: configDigest,
    configDigest,
  };
}

test('verifies the full containerd OCI index, unique platform manifest, config, layers, and legacy agreement', async () => {
  const fixture = createOciArchive('valid-oci');
  const result = await inspectQuickBooksImageArchive(fixture.archive, tag, fixture.outerDigest);
  assert.deepEqual(result, {
    schema: 'quotefly.watchdog-image-archive/v1',
    format: 'oci',
    imageTag: tag,
    outerImageDigest: fixture.outerDigest,
    manifestDigest: result.manifestDigest,
    imageConfigDigest: fixture.configDigest,
    platform: 'linux/amd64',
    layerCount: 1,
  });
  assert.match(result.manifestDigest, /^sha256:[a-f0-9]{64}$/);
});

test('supports traditional docker-save by binding config ID and every uncompressed layer DiffID', async () => {
  const fixture = createTraditionalArchive('valid-docker');
  const result = await inspectQuickBooksImageArchive(fixture.archive, tag, fixture.outerDigest);
  assert.equal(result.format, 'docker');
  assert.equal(result.imageConfigDigest, fixture.configDigest);
  assert.equal(result.manifestDigest, null);
  assert.equal(result.layerCount, 1);
});

test('rejects tampered OCI and traditional layers', async () => {
  const oci = createOciArchive('tampered-oci', { tamperLayer: true });
  const docker = createTraditionalArchive('tampered-docker', { tamperLayer: true });
  await assert.rejects(() => inspectQuickBooksImageArchive(oci.archive, tag, oci.outerDigest), /ARCHIVE_INVALID/);
  await assert.rejects(() => inspectQuickBooksImageArchive(docker.archive, tag, docker.outerDigest), /ARCHIVE_INVALID/);
});

test('rejects ambiguous linux/amd64 leaves and outer image digest or tag mismatches', async () => {
  const ambiguous = createOciArchive('ambiguous-oci', { ambiguousPlatform: true });
  await assert.rejects(() => inspectQuickBooksImageArchive(ambiguous.archive, tag, ambiguous.outerDigest), /ARCHIVE_INVALID/);
  const valid = createOciArchive('identity-mismatch');
  await assert.rejects(
    () => inspectQuickBooksImageArchive(valid.archive, tag, `sha256:${'f'.repeat(64)}`),
    /ARCHIVE_INVALID/,
  );
  await assert.rejects(
    () => inspectQuickBooksImageArchive(valid.archive, 'quotefly-qbo-watchdog:wrong', valid.outerDigest),
    /ARCHIVE_INVALID/,
  );
});

test('requires an absolute archive path and a confined local target', async () => {
  const valid = createOciArchive('path-validation');
  await assert.rejects(() => inspectQuickBooksImageArchive('relative.tar', tag, valid.outerDigest), /ARCHIVE_INVALID/);
  for (const invalidTag of [
    'registry.example/quotefly-qbo-watchdog:local-test',
    'quotefly-qbo-watchdog:latest',
    ['quotefly-qbo-watchdog:local-test'],
  ]) {
    await assert.rejects(() => inspectQuickBooksImageArchive(valid.archive, invalidTag, valid.outerDigest), /ARCHIVE_INVALID/);
  }
});

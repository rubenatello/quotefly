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

function createMobyV28Archive(name, options = {}) {
  const directory = join(root, `${name}-source`);
  mkdirSync(directory, { recursive: true });
  const baseLayerBody = Buffer.from('moby-base-layer');
  const reviewedLayerBodies = [
    baseLayerBody,
    options.repeatedDiffId ? baseLayerBody : Buffer.from('moby-application-layer'),
  ];
  const layerBodies = options.rewriteLayer
    ? [Buffer.from('rewritten-base-layer'), reviewedLayerBodies[1]]
    : reviewedLayerBodies;
  const reviewedDiffIds = reviewedLayerBodies.map((body) => digest(body));
  const layerDescriptors = layerBodies.map((body, index) => {
    const forcedDigest = options.wrongLayerDigest && index === 0 ? reviewedDiffIds[0] : undefined;
    const descriptor = writeBlob(directory, body, forcedDigest);
    descriptor.mediaType = 'application/vnd.oci.image.layer.v1.tar';
    if (options.compressedLayer && index === 0) {
      descriptor.mediaType = 'application/vnd.oci.image.layer.v1.tar+gzip';
    }
    if (options.foreignLayer && index === 0) {
      descriptor.mediaType = 'application/vnd.oci.image.layer.nondistributable.v1.tar';
      descriptor.urls = ['https://example.invalid/layer'];
    }
    if (options.extraLayerDescriptorField && index === 0) descriptor.annotations = {};
    if (options.wrongLayerSize && index === 0) descriptor.size++;
    return descriptor;
  });
  const configDiffIds = options.configDiffIds ?? reviewedDiffIds;
  const rootfs = options.rootfs ?? { type: 'layers', diff_ids: configDiffIds };
  const config = json({
    architecture: options.architecture ?? 'amd64',
    os: options.os ?? 'linux',
    rootfs,
  });
  const configDescriptor = writeBlob(directory, config);
  configDescriptor.mediaType = options.configMediaType ?? 'application/vnd.oci.image.config.v1+json';
  if (options.extraConfigDescriptorField) configDescriptor.annotations = {};
  const manifestLayers = options.reorderLayers ? [...layerDescriptors].reverse() : layerDescriptors;
  const manifestBody = json({
    schemaVersion: options.manifestSchemaVersion ?? 2,
    mediaType: options.manifestMediaType ?? 'application/vnd.oci.image.manifest.v1+json',
    config: configDescriptor,
    layers: manifestLayers,
    ...(options.extraManifestField ? { subject: {} } : {}),
  });
  const manifestDescriptor = writeBlob(directory, manifestBody);
  manifestDescriptor.mediaType = 'application/vnd.oci.image.manifest.v1+json';
  manifestDescriptor.annotations = {
    'io.containerd.image.name': options.wrongImageName ?? `docker.io/library/${tag}`,
    'org.opencontainers.image.ref.name': options.wrongReferenceName ?? tag.slice(tag.indexOf(':') + 1),
    ...(options.extraTagAnnotation ? { 'org.example.extra': 'invalid' } : {}),
  };
  if (options.platform !== 'missing') {
    manifestDescriptor.platform = options.platform ?? { os: 'linux', architecture: 'amd64' };
  }
  if (options.extraRootDescriptorField) manifestDescriptor.artifactType = 'application/example';
  const indexManifests = options.ambiguousTag
    ? [manifestDescriptor, { ...manifestDescriptor }]
    : [manifestDescriptor];
  writeFileSync(join(directory, 'index.json'), JSON.stringify({
    schemaVersion: options.indexSchemaVersion ?? 2,
    mediaType: options.indexMediaType ?? 'application/vnd.oci.image.index.v1+json',
    manifests: indexManifests,
    ...(options.extraIndexField ? { annotations: {} } : {}),
  }));
  writeFileSync(join(directory, 'oci-layout'), JSON.stringify({ imageLayoutVersion: '1.0.0' }));
  const layerSources = Object.fromEntries(configDiffIds.map((diffId, index) => {
    const source = { ...layerDescriptors[index] };
    if (options.layerSourceWrongDigest && index === 0) source.digest = reviewedDiffIds[1];
    if (options.layerSourceWrongSize && index === 0) source.size++;
    if (options.extraLayerSourceDescriptorField && index === 0) source.annotations = {};
    return [diffId, source];
  }));
  if (options.extraLayerSource) {
    layerSources[`sha256:${'e'.repeat(64)}`] = {
      mediaType: 'application/vnd.oci.image.layer.v1.tar',
      digest: `sha256:${'e'.repeat(64)}`,
      size: 1,
    };
  }
  const legacyEntry = {
    Config: `blobs/sha256/${configDescriptor.digest.slice('sha256:'.length)}`,
    RepoTags: [tag],
    Layers: manifestLayers.map(({ digest }) => `blobs/sha256/${digest.slice('sha256:'.length)}`),
    ...(!options.missingLayerSources && {
      LayerSources: options.malformedLayerSources ?? layerSources,
    }),
    ...(options.parent !== undefined ? { Parent: options.parent } : {}),
    ...(options.extraLegacyField ? { Extra: true } : {}),
  };
  const legacyManifest = options.ambiguousLegacyTag ? [legacyEntry, { ...legacyEntry }] : [legacyEntry];
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(legacyManifest));
  return {
    archive: createTar(directory, `${name}.tar`, ['blobs', 'index.json', 'manifest.json', 'oci-layout']),
    configDigest: configDescriptor.digest,
    manifestDigest: manifestDescriptor.digest,
    reviewedDiffIds,
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
    identityMode: 'root_digest',
    imageTag: tag,
    engineImageId: fixture.outerDigest,
    rootDescriptorDigest: fixture.outerDigest,
    outerImageDigest: fixture.outerDigest,
    manifestDigest: result.manifestDigest,
    imageConfigDigest: fixture.configDigest,
    platform: 'linux/amd64',
    layerCount: 1,
  });
  assert.match(result.manifestDigest, /^sha256:[a-f0-9]{64}$/);
});

test('supports the narrow Moby v28 direct-leaf OCI archive using its config image ID', async () => {
  const fixture = createMobyV28Archive('valid-moby-v28', { platform: 'missing' });
  const result = await inspectQuickBooksImageArchive(fixture.archive, tag, fixture.configDigest);
  assert.equal(result.identityMode, 'config_digest');
  assert.equal(result.engineImageId, fixture.configDigest);
  assert.equal(result.outerImageDigest, fixture.manifestDigest);
  assert.equal(result.rootDescriptorDigest, fixture.manifestDigest);
  assert.equal(result.imageConfigDigest, fixture.configDigest);
  assert.equal(result.layerCount, 2);
});

test('accepts a valid optional Moby parent and explicit matching platform', async () => {
  const fixture = createMobyV28Archive('valid-moby-parent-platform', {
    parent: `sha256:${'f'.repeat(64)}`,
    platform: { os: 'linux', architecture: 'amd64' },
  });
  const result = await inspectQuickBooksImageArchive(fixture.archive, tag, fixture.configDigest);
  assert.equal(result.identityMode, 'config_digest');
});

test('accepts omitted LayerSources and repeated ordered DiffIDs', async () => {
  for (const [name, options] of [
    ['omitted-layer-sources', { missingLayerSources: true }],
    ['repeated-diffid', { repeatedDiffId: true }],
  ]) {
    const fixture = createMobyV28Archive(name, { ...options, platform: 'missing' });
    const result = await inspectQuickBooksImageArchive(fixture.archive, tag, fixture.configDigest);
    assert.equal(result.identityMode, 'config_digest');
    assert.equal(result.layerCount, 2);
  }
});

test('config-ID mode rejects rewritten or reordered layer chains under the original trusted config', async () => {
  for (const [name, options] of [
    ['rewritten-layer', { rewriteLayer: true }],
    ['reordered-layers', { reorderLayers: true }],
  ]) {
    const fixture = createMobyV28Archive(name, { ...options, platform: 'missing' });
    await assert.rejects(
      () => inspectQuickBooksImageArchive(fixture.archive, tag, fixture.configDigest),
      /ARCHIVE_INVALID/,
    );
  }
});

test('config-ID mode rejects non-Moby layer descriptors and corrupted layer evidence', async () => {
  for (const [name, options] of [
    ['compressed-layer', { compressedLayer: true }],
    ['foreign-layer', { foreignLayer: true }],
    ['extra-layer-field', { extraLayerDescriptorField: true }],
    ['wrong-layer-size', { wrongLayerSize: true }],
    ['wrong-layer-digest', { wrongLayerDigest: true, rewriteLayer: true }],
  ]) {
    const fixture = createMobyV28Archive(name, { ...options, platform: 'missing' });
    await assert.rejects(
      () => inspectQuickBooksImageArchive(fixture.archive, tag, fixture.configDigest),
      /ARCHIVE_INVALID/,
    );
  }
});

test('config-ID mode requires closed exact LayerSources when present and bounded optional Parent', async () => {
  for (const [name, options] of [
    ['array-layer-sources', { malformedLayerSources: [] }],
    ['extra-layer-source', { extraLayerSource: true }],
    ['extra-layer-source-field', { extraLayerSourceDescriptorField: true }],
    ['wrong-layer-source-digest', { layerSourceWrongDigest: true }],
    ['wrong-layer-source-size', { layerSourceWrongSize: true }],
    ['invalid-parent', { parent: 'not-a-digest' }],
    ['array-parent', { parent: [`sha256:${'f'.repeat(64)}`] }],
    ['extra-legacy-field', { extraLegacyField: true }],
  ]) {
    const fixture = createMobyV28Archive(name, { ...options, platform: 'missing' });
    await assert.rejects(
      () => inspectQuickBooksImageArchive(fixture.archive, tag, fixture.configDigest),
      /ARCHIVE_INVALID/,
    );
  }
});

test('config-ID mode rejects malformed platform, identity, tag, schema, media, and descriptor shape', async () => {
  const cases = [
    ['wrong-platform', { platform: { os: 'linux', architecture: 'arm64' } }],
    ['array-platform', { platform: ['linux', 'amd64'] }],
    ['platform-variant', { platform: { os: 'linux', architecture: 'amd64', variant: 'v8' } }],
    ['extra-tag-annotation', { extraTagAnnotation: true, platform: 'missing' }],
    ['wrong-image-name', { wrongImageName: tag, platform: 'missing' }],
    ['wrong-reference-name', { wrongReferenceName: tag, platform: 'missing' }],
    ['extra-root-field', { extraRootDescriptorField: true, platform: 'missing' }],
    ['extra-index-field', { extraIndexField: true, platform: 'missing' }],
    ['wrong-index-schema', { indexSchemaVersion: 1, platform: 'missing' }],
    ['wrong-index-media', { indexMediaType: 'application/json', platform: 'missing' }],
    ['wrong-manifest-schema', { manifestSchemaVersion: 1, platform: 'missing' }],
    ['wrong-manifest-media', { manifestMediaType: 'application/json', platform: 'missing' }],
    ['wrong-config-media', { configMediaType: 'application/json', platform: 'missing' }],
    ['extra-config-field', { extraConfigDescriptorField: true, platform: 'missing' }],
    ['extra-manifest-field', { extraManifestField: true, platform: 'missing' }],
    ['ambiguous-index-tag', { ambiguousTag: true, platform: 'missing' }],
    ['ambiguous-legacy-tag', { ambiguousLegacyTag: true, platform: 'missing' }],
  ];
  for (const [name, options] of cases) {
    const fixture = createMobyV28Archive(name, options);
    await assert.rejects(
      () => inspectQuickBooksImageArchive(fixture.archive, tag, fixture.configDigest),
      /ARCHIVE_INVALID/,
    );
  }
  const fixture = createMobyV28Archive('unrelated-engine-id', { platform: 'missing' });
  await assert.rejects(
    () => inspectQuickBooksImageArchive(fixture.archive, tag, `sha256:${'a'.repeat(64)}`),
    /ARCHIVE_INVALID/,
  );
});

test('config-ID mode rejects invalid config platform and rootfs chains', async () => {
  for (const [name, options] of [
    ['config-os', { os: 'windows' }],
    ['config-architecture', { architecture: 'arm64' }],
    ['rootfs-type', { rootfs: { type: 'other', diff_ids: [`sha256:${'a'.repeat(64)}`] } }],
    ['empty-diffids', { rootfs: { type: 'layers', diff_ids: [] } }],
    ['missing-diffids', { rootfs: { type: 'layers' } }],
    ['invalid-diffid', { rootfs: { type: 'layers', diff_ids: ['invalid', `sha256:${'b'.repeat(64)}`] } }],
    ['wrong-diffid-count', { rootfs: { type: 'layers', diff_ids: [`sha256:${'a'.repeat(64)}`] } }],
  ]) {
    const fixture = createMobyV28Archive(name, { ...options, platform: 'missing' });
    await assert.rejects(
      () => inspectQuickBooksImageArchive(fixture.archive, tag, fixture.configDigest),
      /ARCHIVE_INVALID/,
    );
  }
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

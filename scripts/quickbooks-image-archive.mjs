import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TAG_PATTERN = /^quotefly-qbo-watchdog:local-[a-z0-9-]+$/;
const SAFE_MEMBER_PATTERN = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\/?$/;
const JSON_LIMIT_BYTES = 2 * 1024 * 1024;
const LIST_LIMIT_BYTES = 8 * 1024 * 1024;
const MEMBER_LIMIT = 20_000;

const fail = () => { throw new Error('QBO_IMAGE_ARCHIVE_INVALID'); };

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail();
}

function digestMember(digest) {
  if (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) fail();
  return `blobs/sha256/${digest.slice('sha256:'.length)}`;
}

function runTar(archivePath, args, { captureLimit = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const hash = createHash('sha256');
    const chunks = [];
    let size = 0;
    let settled = false;
    const rejectClosed = () => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('QBO_IMAGE_ARCHIVE_INVALID'));
    };
    child.once('error', rejectClosed);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (captureLimit && size > captureLimit) {
        rejectClosed();
        return;
      }
      hash.update(chunk);
      if (captureLimit) chunks.push(chunk);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error('QBO_IMAGE_ARCHIVE_INVALID'));
        return;
      }
      resolve({
        digest: `sha256:${hash.digest('hex')}`,
        size,
        content: captureLimit ? Buffer.concat(chunks) : null,
      });
    });
  });
}

async function listMembers(archivePath) {
  const listed = await runTar(archivePath, ['-tf', archivePath], { captureLimit: LIST_LIMIT_BYTES });
  const text = listed.content.toString('utf8').replace(/\r\n/g, '\n');
  if (text.includes('\u0000') || text.includes('\r')) fail();
  const rawMembers = text.split('\n').filter(Boolean);
  if (!rawMembers.length || rawMembers.length > MEMBER_LIMIT) fail();
  const members = rawMembers.map((rawMember) => rawMember.startsWith('./') ? rawMember.slice(2) : rawMember);
  const counts = new Map();
  for (const member of members) {
    if (!member || member.length > 512 || !SAFE_MEMBER_PATTERN.test(member)
      || member.startsWith('/') || member.includes('\\')
      || member.split('/').some((part) => part === '..')) fail();
    counts.set(member, (counts.get(member) ?? 0) + 1);
  }
  return counts;
}

function requireMember(members, member) {
  if (members.get(member) !== 1) fail();
}

async function readMember(archivePath, members, member, captureLimit = 0) {
  requireMember(members, member);
  return runTar(archivePath, ['-xOf', archivePath, '--', member], { captureLimit });
}

async function readJson(archivePath, members, member) {
  const result = await readMember(archivePath, members, member, JSON_LIMIT_BYTES);
  try {
    return { value: JSON.parse(result.content.toString('utf8')), ...result };
  } catch {
    fail();
  }
}

function validateDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)
    || typeof descriptor.mediaType !== 'string'
    || typeof descriptor.digest !== 'string' || !DIGEST_PATTERN.test(descriptor.digest)
    || !Number.isSafeInteger(descriptor.size) || descriptor.size < 0) fail();
  return descriptor;
}

async function readDescriptor(archivePath, members, descriptor, { json = false } = {}) {
  validateDescriptor(descriptor);
  const member = digestMember(descriptor.digest);
  const result = json
    ? await readJson(archivePath, members, member)
    : await readMember(archivePath, members, member);
  if (result.digest !== descriptor.digest || result.size !== descriptor.size) fail();
  return result;
}

function tagName(expectedTag) {
  return expectedTag.slice(expectedTag.indexOf(':') + 1);
}

function descriptorTagAgrees(descriptor, expectedTag) {
  const annotations = descriptor?.annotations;
  if (!annotations || typeof annotations !== 'object' || Array.isArray(annotations)) return false;
  const imageName = annotations['io.containerd.image.name'];
  const referenceName = annotations['org.opencontainers.image.ref.name'];
  if (imageName !== undefined
    && imageName !== expectedTag
    && imageName !== `docker.io/library/${expectedTag}`) return false;
  if (referenceName !== undefined
    && referenceName !== expectedTag
    && referenceName !== tagName(expectedTag)) return false;
  return imageName !== undefined || referenceName !== undefined;
}

function isLeafManifest(descriptor) {
  return descriptor.mediaType === 'application/vnd.oci.image.manifest.v1+json'
    || descriptor.mediaType === 'application/vnd.docker.distribution.manifest.v2+json';
}

function isIndex(descriptor) {
  return descriptor.mediaType === 'application/vnd.oci.image.index.v1+json'
    || descriptor.mediaType === 'application/vnd.docker.distribution.manifest.list.v2+json';
}

function isTargetPlatform(descriptor) {
  const platform = descriptor?.platform;
  const annotationType = descriptor?.annotations?.['vnd.docker.reference.type'];
  return annotationType !== 'attestation-manifest'
    && platform && typeof platform === 'object' && !Array.isArray(platform)
    && platform.os === 'linux' && platform.architecture === 'amd64'
    && (platform.variant === undefined || typeof platform.variant === 'string');
}

async function verifyManifest(archivePath, members, descriptor) {
  if (!isLeafManifest(descriptor)) fail();
  const manifestResult = await readDescriptor(archivePath, members, descriptor, { json: true });
  const manifest = manifestResult.value;
  if (manifest?.schemaVersion !== 2 || !manifest.config || !Array.isArray(manifest.layers)) fail();
  const configDescriptor = validateDescriptor(manifest.config);
  const configResult = await readDescriptor(archivePath, members, configDescriptor, { json: true });
  const config = configResult.value;
  if (config?.os !== 'linux' || config?.architecture !== 'amd64') fail();
  for (const layer of manifest.layers) await readDescriptor(archivePath, members, layer);
  return {
    manifestDigest: descriptor.digest,
    configDigest: configDescriptor.digest,
    configMember: digestMember(configDescriptor.digest),
    layerMembers: manifest.layers.map((layer) => digestMember(layer.digest)),
    layerCount: manifest.layers.length,
  };
}

function selectLegacyEntry(manifest, expectedTag) {
  if (!Array.isArray(manifest)) fail();
  const matches = manifest.filter((entry) => Array.isArray(entry?.RepoTags) && entry.RepoTags.includes(expectedTag));
  if (matches.length !== 1) fail();
  const entry = matches[0];
  exactKeys(entry, ['Config', 'RepoTags', 'Layers']);
  if (typeof entry.Config !== 'string' || !Array.isArray(entry.Layers) || !entry.Layers.length
    || !entry.RepoTags.every((tag) => typeof tag === 'string')) fail();
  return entry;
}

async function verifyLegacyAgreement(archivePath, members, expectedTag, verified) {
  if (!members.has('manifest.json')) return;
  const legacy = await readJson(archivePath, members, 'manifest.json');
  const entry = selectLegacyEntry(legacy.value, expectedTag);
  if (entry.Config !== verified.configMember
    || entry.Layers.length !== verified.layerMembers.length
    || entry.Layers.some((layer, index) => layer !== verified.layerMembers[index])) fail();
}

async function inspectOciArchive(archivePath, members, expectedTag, expectedOuterImageDigest) {
  const root = await readJson(archivePath, members, 'index.json');
  if (root.value?.schemaVersion !== 2 || !Array.isArray(root.value.manifests)) fail();
  const roots = root.value.manifests.filter((descriptor) => descriptorTagAgrees(descriptor, expectedTag));
  if (roots.length !== 1) fail();
  const rootDescriptor = validateDescriptor(roots[0]);
  if (rootDescriptor.digest !== expectedOuterImageDigest) fail();

  let leafDescriptor = rootDescriptor;
  if (isIndex(rootDescriptor)) {
    const outer = await readDescriptor(archivePath, members, rootDescriptor, { json: true });
    if (outer.value?.schemaVersion !== 2 || !Array.isArray(outer.value.manifests)) fail();
    const leaves = outer.value.manifests.filter((descriptor) => isLeafManifest(descriptor) && isTargetPlatform(descriptor));
    if (leaves.length !== 1) fail();
    leafDescriptor = validateDescriptor(leaves[0]);
  } else if (!isLeafManifest(rootDescriptor) || !isTargetPlatform(rootDescriptor)) {
    fail();
  }

  const verified = await verifyManifest(archivePath, members, leafDescriptor);
  await verifyLegacyAgreement(archivePath, members, expectedTag, verified);
  return {
    schema: 'quotefly.watchdog-image-archive/v1',
    format: 'oci',
    imageTag: expectedTag,
    outerImageDigest: expectedOuterImageDigest,
    manifestDigest: verified.manifestDigest,
    imageConfigDigest: verified.configDigest,
    platform: 'linux/amd64',
    layerCount: verified.layerCount,
  };
}

function legacyConfigDigest(configMember) {
  const blobMatch = /^blobs\/sha256\/([a-f0-9]{64})$/.exec(configMember);
  if (blobMatch) return `sha256:${blobMatch[1]}`;
  const jsonMatch = /^([a-f0-9]{64})\.json$/.exec(configMember);
  if (jsonMatch) return `sha256:${jsonMatch[1]}`;
  fail();
}

async function inspectTraditionalArchive(archivePath, members, expectedTag, expectedOuterImageDigest) {
  const legacy = await readJson(archivePath, members, 'manifest.json');
  const entry = selectLegacyEntry(legacy.value, expectedTag);
  const expectedConfigDigest = legacyConfigDigest(entry.Config);
  if (expectedConfigDigest !== expectedOuterImageDigest) fail();
  const configResult = await readJson(archivePath, members, entry.Config);
  if (configResult.digest !== expectedConfigDigest) fail();
  const config = configResult.value;
  if (config?.os !== 'linux' || config?.architecture !== 'amd64'
    || config?.rootfs?.type !== 'layers' || !Array.isArray(config.rootfs.diff_ids)
    || config.rootfs.diff_ids.length !== entry.Layers.length) fail();
  for (let index = 0; index < entry.Layers.length; index++) {
    const layer = entry.Layers[index];
    const expectedDiffId = config.rootfs.diff_ids[index];
    if (typeof layer !== 'string' || typeof expectedDiffId !== 'string' || !DIGEST_PATTERN.test(expectedDiffId)) fail();
    const layerResult = await readMember(archivePath, members, layer);
    if (layerResult.digest !== expectedDiffId) fail();
  }
  return {
    schema: 'quotefly.watchdog-image-archive/v1',
    format: 'docker',
    imageTag: expectedTag,
    outerImageDigest: expectedOuterImageDigest,
    manifestDigest: null,
    imageConfigDigest: expectedConfigDigest,
    platform: 'linux/amd64',
    layerCount: entry.Layers.length,
  };
}

export async function inspectQuickBooksImageArchive(archivePath, expectedTag, expectedOuterImageDigest) {
  if (typeof archivePath !== 'string' || !isAbsolute(archivePath)
    || typeof expectedTag !== 'string' || !TAG_PATTERN.test(expectedTag)
    || typeof expectedOuterImageDigest !== 'string' || !DIGEST_PATTERN.test(expectedOuterImageDigest)) fail();
  try {
    if (!statSync(archivePath, { throwIfNoEntry: false })?.isFile()) fail();
    const members = await listMembers(archivePath);
    if (members.has('index.json')) {
      return await inspectOciArchive(archivePath, members, expectedTag, expectedOuterImageDigest);
    }
    return await inspectTraditionalArchive(archivePath, members, expectedTag, expectedOuterImageDigest);
  } catch {
    fail();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 5) fail();
    const result = await inspectQuickBooksImageArchive(process.argv[2], process.argv[3], process.argv[4]);
    console.log(JSON.stringify(result));
  } catch {
    console.error('QBO_IMAGE_ARCHIVE_INVALID');
    process.exitCode = 1;
  }
}

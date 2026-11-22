// The Play bundle the app's android.bundle hook leaves behind, checked by the hub before any upload (design v3, "Play
// store package"). The hook builds and signs; the hub trusts none of it and reads the AAB itself:
//   - the base module's manifest names the package the policy says Play serves (store_package, else package) and carries
//     the planned versionCode (a bump that did not reach the export would upload the old one);
//   - the jar signature is intact and there is exactly one signer, whose SHA-256 is the policy's Play upload certificate
//     (store_upload_sha256). The device signer is never the answer: Play refuses an upload signed with any other key,
//     and a hook that signed with the debug key would otherwise get as far as Play.
// No bundletool and no secret: the manifest is protobuf inside a zip (read here), the signature check is the JDK's own
// jarsigner and keytool. Every refusal starts with HUB_PLAY_BUNDLE_REFUSED so a run log says what stopped it.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { inflateRawSync } from 'node:zlib';
import { signerEnvironment } from './android.mjs';
import { run } from './exec.mjs';

const refuse = (what, detail) => new Error(`HUB_PLAY_BUNDLE_REFUSED ${what}: ${detail}`);

// ---------------------------------------------------------------------------------------------------- zip

// One member of a zip, read from the central directory. Bundles are far below 4 GiB; zip64 is refused, not guessed at.
export function zipEntry(zip, name) {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw refuse('zip', 'not a zip archive (no end-of-central-directory record)');
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) throw refuse('zip', 'zip64 archives are not supported');
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw refuse('zip', 'corrupt central directory');
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const next = at + 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    if (zip.toString('utf8', at + 46, at + 46 + nameLength) === name) {
      const local = zip.readUInt32LE(at + 42);
      if (zip.readUInt32LE(local) !== 0x04034b50) throw refuse('zip', `corrupt local header for ${name}`);
      const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const raw = zip.subarray(data, data + size);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) return inflateRawSync(raw);
      throw refuse('zip', `${name} uses compression method ${method}`);
    }
    at = next;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------- protobuf

function* fieldsOf(buffer) {
  let at = 0;
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; ; shift += 7n) {
      if (at >= buffer.length) throw refuse('manifest', 'truncated protobuf');
      const byte = buffer[at++];
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
    }
  };
  while (at < buffer.length) {
    const key = Number(varint());
    const number = key >>> 3;
    const wire = key & 7;
    if (wire === 0) yield [number, varint()];
    else if (wire === 2) { const length = Number(varint()); yield [number, buffer.subarray(at, at + length)]; at += length; }
    else if (wire === 1) { yield [number, buffer.subarray(at, at + 8)]; at += 8; }
    else if (wire === 5) { yield [number, buffer.subarray(at, at + 4)]; at += 4; }
    else throw refuse('manifest', `protobuf wire type ${wire}`);
  }
}

// aapt2's proto XmlNode: element (1) { namespace_uri 2, name 3, attribute 4 { namespace_uri 1, name 2, value 3,
// compiled_item 6 { prim 7 { int_decimal_value 6 } } } }.
function attributesOf(element) {
  const found = [];
  let tag = '';
  for (const [number, value] of fieldsOf(element)) {
    if (number === 3) tag = value.toString('utf8');
    if (number !== 4) continue;
    const attribute = { namespace: '', name: '', value: '', number: null };
    for (const [id, inner] of fieldsOf(value)) {
      if (id === 1) attribute.namespace = inner.toString('utf8');
      else if (id === 2) attribute.name = inner.toString('utf8');
      else if (id === 3) attribute.value = inner.toString('utf8');
      else if (id === 6) {
        for (const [kind, item] of fieldsOf(inner)) if (kind === 7) for (const [prim, int] of fieldsOf(item)) if (prim === 6) attribute.number = Number(BigInt.asIntN(32, int));
      }
    }
    found.push(attribute);
  }
  return { tag, attributes: found };
}

export function parseBundleManifest(proto) {
  let root = null;
  for (const [number, value] of fieldsOf(proto)) if (number === 1) root = value;
  if (!root) throw refuse('manifest', 'the base manifest has no root element');
  const { tag, attributes } = attributesOf(root);
  if (tag !== 'manifest') throw refuse('manifest', `the base manifest root is <${tag}>, not <manifest>`);
  const pick = name => attributes.find(attribute => attribute.name === name);
  const code = pick('versionCode');
  const versionCode = code ? (code.number ?? (/^\d+$/.test(code.value) ? Number(code.value) : null)) : null;
  return { package: pick('package')?.value || null, versionCode, versionName: pick('versionName')?.value || null };
}

export function bundleIdentity(aab) {
  const zip = readFileSync(aab);
  const proto = zipEntry(zip, 'base/manifest/AndroidManifest.xml');
  if (!proto) throw refuse('manifest', 'base/manifest/AndroidManifest.xml is not in the bundle (not an app bundle)');
  return parseBundleManifest(proto);
}

// ---------------------------------------------------------------------------------------------------- signature

// `keytool -printcert -jarfile`: one "Signer #N:" block per signer, each led by its certificate (the leaf).
export function parseJarSigners(output) {
  return output.split(/^Signer #\d+:\s*$/m).slice(1).map(block => /^\s*SHA256:\s*([0-9A-F]{2}(?::[0-9A-F]{2}){31})\s*$/im.exec(block)?.[1].replaceAll(':', '').toLowerCase() ?? null);
}

export function bundleSigners({ aab, env = process.env, home = homedir(), exec = run }) {
  const tools = signerEnvironment(env, home);
  let verified;
  try { verified = exec('jarsigner', ['-verify', aab], { env: tools }); } catch (error) { throw refuse('signature', `jarsigner could not verify ${aab}: ${String(error.message).split('\n').slice(0, 3).join(' ')}`); }
  if (!/^jar verified/m.test(verified)) throw refuse('signature', 'the bundle is not a verified signed jar (unsigned, or jarsigner did not say "jar verified")');
  if (/unsigned entries/i.test(verified)) throw refuse('signature', 'the bundle holds entries the signature does not cover');
  const printed = exec('keytool', ['-printcert', '-jarfile', aab], { env: tools });
  return parseJarSigners(printed);
}

// What the hub holds a built bundle to: expect = { package, versionCode, uploadSha256 }. Returns the facts for the receipt.
export function verifyPlayBundle({ aab, expect, env = process.env, home = homedir(), exec = run }) {
  const identity = bundleIdentity(aab);
  if (identity.package !== expect.package) throw refuse('package', `the bundle is ${identity.package}, the policy says Play serves ${expect.package}`);
  if (expect.versionCode !== undefined && expect.versionCode !== null && identity.versionCode !== Number(expect.versionCode)) {
    throw refuse('versionCode', `the bundle carries versionCode ${identity.versionCode} but the plan says ${expect.versionCode}; the bump did not reach the bundle export`);
  }
  const signers = bundleSigners({ aab, env, home, exec });
  if (signers.length !== 1) throw refuse('signer', `the bundle must carry exactly one signer, found ${signers.length}`);
  if (signers[0] !== String(expect.uploadSha256).toLowerCase()) {
    throw refuse('signer', `the bundle is signed with ${signers[0]}, not the Play upload certificate ${String(expect.uploadSha256).toLowerCase()} (apps.<repo>.android.store_upload_sha256); Play would refuse it`);
  }
  return { package: identity.package, versionCode: identity.versionCode, versionName: identity.versionName, upload_sha256: signers[0] };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { apkLinks, versionRegex, appLink, addLink, parseNodes, resolvedVersion } from './obtainium-check.mjs';

const page = `<a class="button" href="https://s3.delo.sh/builds/earshot/editions/beta/0.1.11/earshot-beta-0.1.11-1011.apk">Download</a>
<a href="https://s3.delo.sh/builds/earshot/editions/beta/0.1.11/earshot-beta-0.1.11-1011.apk.sha256">checksum file</a><a href="latest.json">json</a>`;

test('apkLinks keeps only .apk links and resolves relative ones', () => {
  assert.deepEqual(apkLinks(page, 'https://s3.delo.sh/builds/x/index.html'), ['https://s3.delo.sh/builds/earshot/editions/beta/0.1.11/earshot-beta-0.1.11-1011.apk']);
  assert.deepEqual(apkLinks('<a href="a/b-1.2.3-4.apk">x</a>', 'https://h.test/p/index.html'), ['https://h.test/p/a/b-1.2.3-4.apk']);
});

test('versionRegex matches exactly the version in a hub APK name', () => {
  const m = new RegExp(versionRegex()).exec('earshot-beta-0.1.11-1011.apk');
  assert.equal(m[0], '0.1.11');
  assert.equal(new RegExp(versionRegex()).exec('app-1.2.3-4.apk')[0], '1.2.3');
  assert.equal(new RegExp(versionRegex()).exec('no-version.apk'), null);
});

test('appLink carries id, url and the version rule, percent-encoded for a deep link', () => {
  const link = appLink({ url: 'https://h.test/i.html', pkg: 'a.b', name: 'N' });
  assert.ok(link.startsWith('obtainium://app/%7B'));
  const app = JSON.parse(decodeURIComponent(link.slice('obtainium://app/'.length)));
  assert.equal(app.id, 'a.b'); assert.equal(app.url, 'https://h.test/i.html');
  assert.equal(JSON.parse(app.additionalSettings).versionExtractionRegEx, versionRegex());
  assert.equal(addLink('https://h.test/i.html'), 'obtainium://add/https://h.test/i.html');
});

test('parseNodes and resolvedVersion read Obtainium app-page text', () => {
  const xml = '<hierarchy><node text="Not installed&#10;0.1.11 Latest" class="x" bounds="[84,567][325,672]" /><node text="" content-desc="Install" bounds="[0,0][10,10]" /></hierarchy>';
  const nodes = parseNodes(xml);
  assert.equal(nodes[0].cx, 204); assert.equal(nodes[1].label, 'Install');
  assert.equal(resolvedVersion(nodes), '0.1.11');
  assert.equal(resolvedVersion(parseNodes('<node text="Unknown Latest" bounds="[0,0][1,1]"/>')), 'Unknown');
});

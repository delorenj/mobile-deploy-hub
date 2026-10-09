// The iPad's over-the-air install (design v1.1, C4): one manifest.plist per app, always naming the newest IPA, and the
// itms-services link that opens it. The install link is not percent-encoded, as in Apple's documentation.
import { runBounded } from './exec.mjs';

export const xml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function manifestPlist({ ipaUrl, bundle, version, title, displayImage = null, fullSizeImage = null }) {
  for (const [name, value] of Object.entries({ ipaUrl, displayImage, fullSizeImage })) {
    if (value !== null && !/^https:\/\/[^\s"<>]+$/.test(value ?? '')) throw new Error(`manifest.plist: ${name} must be an https URL`);
  }
  if (!/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/.test(bundle ?? '')) throw new Error('manifest.plist: bad bundle id');
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('manifest.plist: bad version');
  const asset = (kind, url) => `        <dict>\n          <key>kind</key>\n          <string>${kind}</string>\n          <key>url</key>\n          <string>${xml(url)}</string>\n        </dict>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
${asset('software-package', ipaUrl)}${displayImage ? asset('display-image', displayImage) : ''}${fullSizeImage ? asset('full-size-image', fullSizeImage) : ''}      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>${xml(bundle)}</string>
        <key>bundle-version</key>
        <string>${xml(version)}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>${xml(title)}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;
}

// The two OTA images from the app's optional project.icon, square PNGs (ImageMagick on big-chungus).
export function resizeIcon({ source, size, target, env = process.env, runner = runBounded }) {
  if (![57, 512].includes(size)) throw new Error(`icon size ${size} is not an OTA image size`);
  runner('magick', [source, '-resize', `${size}x${size}!`, '-strip', `png:${target}`], { env, timeout: 60_000, label: `magick icon ${size}` });
  return target;
}

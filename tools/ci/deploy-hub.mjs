import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';

function run(command, args, { log, ...options } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (log) spawnSync('tee', ['-a', log], { input: output, stdio: ['pipe', 'ignore', 'inherit'] });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args[0]} failed (${result.error?.message ?? `exit ${result.status}`})${log ? `; log ${log}` : ''}\n${output.slice(-4000)}`);
  }
  return result.stdout;
}

async function exportProject({ platform, path, preset, outDir }) {
  await mkdir(outDir, { recursive: true });
  const log = join(outDir, 'godot.log');
  
  // Update version before export (if needed) - assumes version is driven by CI environment if needed, but here we just export.
  const extension = platform === 'android' ? 'aab' : 'zip';
  const artifactName = `app.${extension}`;
  const artifactPath = join(outDir, artifactName);

  console.log(`Starting export for ${platform} using preset "${preset}"...`);
  
  // Find cached godot from pile-of-dumb-things or use GODOT_BIN
  const { stdout: findOut } = spawnSync('find', [join(process.env.HOME || '/home/delorenj', '.cache'), '-name', '*linux.x86_64', '-type', 'f', '-executable'], { encoding: 'utf8' });
  const engine = process.env.GODOT_BIN || findOut.split('\n').filter(line => line.includes('Godot_v')).pop() || 'godot';
  console.log(`Using Godot engine: ${engine}`);
  
  // Headless import first to ensure assets are ready
  run(engine, ['--headless', '--path', path, '--editor', '--import', '--quit'], { log });
  
  // Run export
  run(engine, ['--headless', '--path', path, '--export-release', preset, resolve(artifactPath)], { log });
  
  const logData = await readFile(log, 'utf8');
  if (/SCRIPT ERROR|Parse Error/.test(logData)) {
    throw new Error(`Godot reported script errors; see ${log}`);
  }
  
  console.log(`Successfully exported ${artifactPath}`);
}

async function uploadAndroid({ pkg, track, artifactPath, token }) {
  console.log(`Starting Android upload for ${pkg} to track ${track}`);
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${pkg}`;
  
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  // 1. Create Edit
  let res = await fetch(`${base}/edits`, { method: 'POST', headers, body: JSON.stringify({}) });
  if (!res.ok) throw new Error(`Create edit failed: ${await res.text()}`);
  const editId = (await res.json()).id;
  console.log(`Created edit ${editId}`);

  // 2. Upload AAB
  const buffer = await readFile(artifactPath);
  res = await fetch(`https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${pkg}/edits/${editId}/bundles?uploadType=media`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
    },
    body: buffer
  });
  if (!res.ok) throw new Error(`Upload AAB failed: ${await res.text()}`);
  const bundleInfo = await res.json();
  const versionCode = bundleInfo.versionCode;
  console.log(`Uploaded bundle versionCode ${versionCode}`);

  // 3. Assign to Track
  const trackData = {
    releases: [{
      versionCodes: [versionCode],
      status: 'completed'
    }]
  };
  res = await fetch(`${base}/edits/${editId}/tracks/${track}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(trackData)
  });
  if (!res.ok) throw new Error(`Assign to track failed: ${await res.text()}`);
  console.log(`Assigned to track ${track}`);

  // 4. Commit Edit
  res = await fetch(`${base}/edits/${editId}:commit`, { method: 'POST', headers });
  if (!res.ok) throw new Error(`Commit edit failed: ${await res.text()}`);
  console.log(`Committed edit successfully.`);
}

async function uploadIos({ pkg, artifactPath }) {
  console.log(`Starting iOS upload for ${pkg}`);
  if (process.platform !== 'darwin') {
    throw new Error('iOS upload must run on macOS');
  }

  // Extract App Store Connect credentials from 1Password
  console.log('Reading App Store Connect credentials from 1Password...');
  const keyId = run('op', ['read', '-n', 'op://DeLoSecrets/App Store Connect API Key/key_id']).trim();
  const issuerId = run('op', ['read', '-n', 'op://DeLoSecrets/App Store Connect API Key/issuer_id']).trim();
  const privateKey = run('op', ['read', '-n', 'op://DeLoSecrets/App Store Connect API Key/credential']);

  // Write private key to the location altool expects
  const keysDir = join(process.env.HOME, '.appstoreconnect', 'private_keys');
  await mkdir(keysDir, { recursive: true });
  const keyPath = join(keysDir, `AuthKey_${keyId}.p8`);
  await writeFile(keyPath, privateKey, { mode: 0o600 });

  try {
    const workDir = join(process.cwd(), `.deploy-hub-ios-${Date.now()}`);
    await mkdir(workDir, { recursive: true });
    
    console.log(`Unzipping ${artifactPath} to ${workDir}...`);
    run('unzip', ['-o', '-q', artifactPath, '-d', workDir]);

    const files = await readdir(workDir);
    const xcodeproj = files.find(f => f.endsWith('.xcodeproj'));
    if (!xcodeproj) throw new Error('No .xcodeproj found in exported archive');
    const projectPath = join(workDir, xcodeproj);
    
    const archivePath = join(workDir, 'App.xcarchive');
    const exportPath = join(workDir, 'export');
    const exportOptionsPlist = join(workDir, 'ExportOptions.plist');

    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store</string>
</dict>
</plist>`;
    await writeFile(exportOptionsPlist, plistContent);

    console.log(`Archiving ${projectPath}...`);
    run('xcodebuild', [
      '-project', projectPath,
      '-scheme', xcodeproj.replace('.xcodeproj', ''),
      '-archivePath', archivePath,
      'archive'
    ]);

    console.log('Exporting IPA...');
    run('xcodebuild', [
      '-exportArchive',
      '-archivePath', archivePath,
      '-exportOptionsPlist', exportOptionsPlist,
      '-exportPath', exportPath
    ]);

    const ipaFiles = await readdir(exportPath);
    const ipaName = ipaFiles.find(f => f.endsWith('.ipa'));
    if (!ipaName) throw new Error('Export failed to produce an .ipa file');
    const ipaPath = join(exportPath, ipaName);

    console.log(`Uploading ${ipaPath} to TestFlight...`);
    run('xcrun', [
      'altool', '--upload-app',
      '-f', ipaPath,
      '-t', 'ios',
      '--apiKey', keyId,
      '--apiIssuer', issuerId
    ]);
    
    console.log('iOS upload complete.');
  } finally {
    // Clean up private key
    try {
      await run('rm', ['-f', keyPath]);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const option = name => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };

  if (command === 'export') {
    await exportProject({
      platform: option('--platform'),
      path: option('--path'),
      preset: option('--preset'),
      outDir: option('--out') || '.deploy-hub-out'
    });
  } else if (command === 'upload-android') {
    await uploadAndroid({
      pkg: option('--package'),
      track: option('--track') || 'internal',
      artifactPath: option('--artifact'),
      token: process.env.PLAY_TOKEN
    });
  } else if (command === 'upload-ios') {
    await uploadIos({
      pkg: option('--package'),
      artifactPath: option('--artifact')
    });
  } else {
    throw new Error('Usage: deploy-hub.mjs export|upload-android|upload-ios [options]');
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});

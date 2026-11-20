# tools/verify

## obtainium-check.mjs

Proves, on an **emulator**, that a buyer who adds a hub public edition to Obtainium gets the advertised version, the same APK a direct download gives, and that Obtainium tracks the index page (the source) rather than one pinned APK. Works for any edition: it needs only the index page, the package and the version you expect.

```bash
export ANDROID_ADB_SERVER_PORT=5043          # optional private adb server
node tools/verify/obtainium-check.mjs \
  https://s3.delo.sh/builds/earshot/editions/beta/index.html io.automaticai.earshot 0.1.11 \
  --serial emulator-5554 --out /tmp/obt-check --name "Earshot Beta" \
  --signer edcb667da42bd67c7de3d31cb22c38e223d81c159d0987d186cda24e951d6eac
```

What it does (each step prints `PASS`/`FAIL`, and `result.json` plus four screenshots land in `--out`):

1. Fetches the index page: exactly one `.apk` link, its name carries the expected version, aapt2 identity of the direct download.
2. Installs the official Obtainium release on the emulator if it is missing (checks its `.sha256` and signer) and starts it with clean data.
3. Fires `obtainium://add/<index-url>` (the link a store page would carry) and checks Add app opens with the URL and the HTML source type.
4. Imports `obtainium://app/<json>` with `versionExtractionRegEx` `\d+\.\d+\.\d+(?=-\d+\.apk)`, refreshes, and reads the app page: resolved version, selected APK, and that the source is the index URL.
5. Installs through Obtainium's Install button (handles the unknown-sources toggle and the package installer), then reads back `dumpsys package` (versionName, installer is Obtainium), pulls the installed `base.apk` and compares its SHA-256 to the direct download, and prints the signer (a hard check with `--signer`).

Exit 0 means every check passed, 1 a check failed, 2 a usage or setup error.

Safety: it uninstalls `<package>` first and refuses any serial that is not `emulator-NNNN` with `ro.kernel.qemu=1`, so a physical phone cannot be touched (the private adb server can still auto-connect one; the script never addresses it). On the emulator it sets `package_verifier_user_consent -1` so the Play Protect scan sheet does not block the run; a buyer on a Play device sees that sheet and taps "Install without scanning" (see the Earshot buyer Obtainium guide).

Needs `adb`, `aapt2`, `apksigner` (Android build-tools) and Node 20+. Unit tests of the pure helpers: `node --test tools/verify/obtainium-check.test.mjs`.

### Findings it encodes (Obtainium 1.7.4, observed on an emulator)

- `obtainium://add/<url>` only opens Add app with the URL filled in. With no version rule Obtainium shows a partial-APK-hash pseudo-version (for example `2387dc03`), not the edition version.
- The regex `-(\d+\.\d+\.\d+)-\d+\.apk` needs "Match group to use" = 1; without it the version is `-0.1.11-1011.apk`. The lookahead `\d+\.\d+\.\d+(?=-\d+\.apk)` returns exactly the version with no group setting.
- `obtainium://app/<percent-encoded JSON>` imports a fully configured app (after an Import confirm), so it is the link to publish for a buyer.
- Obtainium prefixes the downloaded file name with a hash (`805198546-earshot-beta-0.1.11-1011.apk`); the bytes are the same.

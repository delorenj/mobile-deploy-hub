# Private device builds (MOBI-17)

Before MOBI-17 the whole `builds` bucket was anonymous: `https://s3.delo.sh/builds/*` answered any GET, so the device
APK of every app, its receipts and release notes, and the page that links them were one guess away from anyone. An app
that sells a public edition (Earshot's beta) was giving its paid-for device build away beside it. Now nothing is
anonymous unless `tools/ci/policy.json` says why, and the bucket policy that enforces it is generated from that file.

Applies to every app in the policy, not one.

## The rule

| What | Anonymous? | Why |
| --- | --- | --- |
| Listing the bucket | never | no `s3:ListBucket` for the public, ever (the live bucket already refused it; the check keeps it so) |
| A public edition, `builds/<slug>/editions/<name>/*` | yes | `apps.<repo>.android.editions.<name>.public: true` (MOBI-14). Obtainium and buyers read these |
| An iOS-lane app's over-the-air set | yes | the iPad and the Mac's catch-up have no key: `index.html`, `latest.json`, `inflight.json`, `ios/manifest.plist`, `*.ipa`, the two icons (D4: the iPad lane keeps its behavior) |
| A device-public app, `builds/<slug>/*` | yes | `apps.<repo>.android.public: true`, an explicit opt-in, and never together with a public edition |
| The root `index.html` and `index.json` | yes | rendered with only anonymous links |
| Everything else: device APKs and their checksums, receipts, release notes, an Android-only app's page and pointers | **no** | needs the hub's keys or a presigned link |

Today (`policy.json`): Tower and Gruvato are on the iPad lane (so their iPad objects are open and their device APK is
not); Earshot sells the `beta` public edition and keeps its device edition private; Shortwave is Android only and
fully private; Green In Between (the friend beta funnel) and Navi (client onboarding, the update gate) opt in with
`android.public: true`, because breaking their anonymous Install APK would cost more than it protects. An app that
sells a public edition can never be device-public: the parser refuses `public: true` beside a public edition.

A latest.json that an iOS-lane app serves anonymously still names its device APK's key and URL. It names it, it does
not grant it: the bucket policy answers that URL 403. The write guard (below) exempts exactly those two pointer files.

## Where the rule lives

`tools/ci/lib/access.mjs` is the one model. It is used three ways, so they cannot disagree:

1. `bucketPolicy(policy)` renders the MinIO bucket policy of `builds`. It is committed as
   `tools/ci/bucket-policy.json`, and `node tools/bucket-policy.mjs write` re-renders it. A test fails when the
   committed file is not what `policy.json` renders. **This policy is the only place access is enforced.**
2. `isAnonymous(policy, key)` decides, at write time, a key's cache header (`private, ...` for anything the public
   cannot read, so Cloudflare in front of `https://s3.delo.sh` never keeps a copy) and which links a page may carry.
3. `assertPublicText` is the write guard in `createS3.putText`: an object an anonymous reader can get never contains a
   presigned link (`X-Amz-Signature=` or `X-Amz-Credential=`), and never a link to a device APK that is not public
   (`HUB_ACCESS_REFUSED ...; nothing was written`). A bug in a renderer fails loudly instead of leaking.

## Credentials

Nothing secret is in policy, code, docs or receipts; every credential is a 1Password reference.

- The hub writer (jobs, the catch-up on big-chungus): `op://DeLoSecrets/dfch6zwvscl3ootrcbkwbfelka/{username,credential}`,
  read at call time (`writerCredentials`), memoized per process (`jobCredentials`) and used for writes through `mc` and,
  now, for every read of a private object.
- The bucket admin, only for applying the bucket policy: `op://DeLoSecrets/hwatizsoschtnq5oleume6kdpu/{username,password}`.
  It goes into the `mc` child's `MC_HOST_builds` over `http://127.0.0.1:9012` and nowhere else.

## Reads

- **Hub jobs** (`gate`, `plan`, `deliver`, `announce`, `hosts`): `readObject` signs every GET with SigV4 headers using the
  writer's keys over the loopback port, inside a workflow job (or `HUB_S3_LOCAL=1`). Outside a job, or with
  `credentials: null`, it reads anonymously and a private object answers 403 with an error that says why.
- **The catch-up on big-chungus**: `createStore({credentials})` signs each pointer read and each APK download with the
  writer's keys (`hubWriter().credentials()`). sha256 and signer checks are unchanged.
- **The catch-up on the Mac**: no keys, no 1Password token. It reads `https://s3.delo.sh` anonymously, and only for
  apps with an iOS lane (everything it needs is open for them). An Android-only app is skipped there (`<slug> no ios
  build`) instead of being counted unreadable; big-chungus owns it.

## Links a person gets

A page, `latest.json` or `index.json` never holds a presigned link; the guard refuses it. Presigned links exist in
exactly two places, the deploy notification and the catch-up event, built by `tools/ci/lib/links.mjs`:

- `https://s3.delo.sh/builds/<key>?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=<access>/<day>/us-east-1/s3/aws4_request&X-Amz-Date=...&X-Amz-Expires=604800&X-Amz-SignedHeaders=host&response-cache-control=private%2C%20no-store&X-Amz-Signature=...`
- valid 7 days, SigV4's ceiling (`lib/sigv4.mjs` refuses anything over `604800`, or under 1 second);
- the signed `response-cache-control` makes the answer `private, no-store`, so a cache keeps nothing even though old
  objects were uploaded with `public` headers;
- the link carries the access key id and a signature, never the secret.

Which links are presigned, per app: the "Install APK" button when the device edition is private (the S26 away case),
and the "Builds" page when the page is private (Android-only apps). Links to anonymous objects (the iPad OTA button, a
device-public app's APK, an iOS-lane app's page, public editions) stay plain. Without keys a private link is dropped
and logged (`HUB_LINKS_DROPPED`), never replaced by a URL that answers 403. A notification older than 7 days has dead
links; the next deploy sends fresh ones. The logs and receipts keep the plain canonical URL.

The pages themselves: a device-public app's page keeps "Install APK" and "Download retained APK". Any other page shows
a note that the Android build is private. The root index carries a device APK URL, or a page link, only for the apps
that publish them. The private device APK still reaches the S26 as before: `adb install`, Quickdrop, the catch-up, and
the presigned link in the notification.

The Android Release notes that `release` writes to the private GitHub Release carry the "Build page" line only when that
page is open.

## Applying it (land stage)

The bucket policy is applied by `tools/bucket-policy.mjs`, idempotently, and never by a deploy:

```
mise run bucket-policy               check: the committed file equals the rendered one, and credential-free probes of
                                     https://s3.delo.sh get the answers the policy promises (list 403, a private APK key
                                     403, a public key 404 or 200, ...). Exit 1 on drift.
mise run bucket-policy:apply         mc anonymous set-json (admin keys from 1Password), read it back and compare, run the check
node tools/bucket-policy.mjs apply --dry-run     the statements it would add and remove
node tools/bucket-policy.mjs diff                live against committed
node tools/bucket-policy.mjs write               re-render tools/ci/bucket-policy.json after a policy.json change
```

Apply replaces the bucket's anonymous policy as one document, so running it twice changes nothing. The probes use keys
that do not exist (`<slug>/0.0.0/<slug>-0.0.0-0.apk`), so they never touch a real object: a denied key answers 403, an
allowed missing key 404. `mise run release` runs the same check after conformance and refuses to release while the
live bucket disagrees with the committed policy, so a policy change cannot ship without being applied.

Order for a change to this repo: merge, `mise run bucket-policy:apply`, `mise run bucket-policy`, then release the hub
(`mise run release -- X.Y.Z`; a policy change is a hub release). The release gate needs the apply first, so there is a
short window where the old hub code meets the private bucket; keep apply and release together (below).

### Migration

- Old objects keep their public `Cache-Control` metadata. That is harmless once the policy denies the read (a denied
  request has no body to cache), and presigned links override it with `response-cache-control`. New objects are written
  with `private, ...` where the public cannot read them.
- Cloudflare does not edge-cache `s3.delo.sh` (`cf-cache-status: DYNAMIC`), so denial is immediate after the apply.
- Existing links to a private device APK, receipt or page stop working at the apply. That is the point.
- A deploy that still runs the previous hub version cannot read private pointers anonymously. Apply and release close
  together; the callers pin `v1`, which moves with the release.

## Failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `GET <key> from the build directory answered 403 (a private object read without the hub's keys)` | a read outside a job, or an old hub | run from a workflow job or `HUB_S3_LOCAL=1` |
| `HUB_ACCESS_REFUSED ... carry a presigned link` or `... link a private device APK` | a renderer put a private link in an anonymous object | fix the renderer; nothing was written |
| `BUCKET_POLICY_DRIFT <url> answered 404, expected 403` | the live bucket still has the old public-read policy | `mise run bucket-policy:apply` |
| `BUCKET_POLICY_DRIFT tools/ci/bucket-policy.json is not what policy.json renders` | `policy.json` changed | `node tools/bucket-policy.mjs write`, commit |
| `HUB_LINKS_DROPPED apk, page` | the announce job had no writer keys | check the 1Password service token on the runner |
| catch-up `HTTP 403` on an APK | big-chungus catch-up lost its keys | the units' service account token; `HUB_CATCHUP_ERROR` says which read |
| the Mac pass logs `<slug> no ios build` | normal: the Mac skips Android-only apps | none |

## Known edges

- Tower's android-hoard proof reads `TOWER_APK_URL=latest` anonymously. The device APK is private now, so that proof
  needs the hub's keys or a presigned link from the notification.
- An app's own docs that link `https://s3.delo.sh/builds/<slug>/<version>/<slug>-<version>-<code>.apk` break for
  private apps. Use the notification link, or opt the app in with `android.public: true` if a public Install APK is the
  product.
- `android.public: true` is a deliberate hole. Review it like a credential change.

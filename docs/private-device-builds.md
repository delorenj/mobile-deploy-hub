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
| Every app's pointers, `builds/<slug>/latest.json` and `inflight.json` | yes | they name a build (key, version, sha256) and never grant it: the APK they name answers 403. Anonymous so the catch-up's two-minute pass reads them without 1Password (below) |
| An iOS-lane app's over-the-air set | yes | the iPad has no key: `index.html`, `ios/manifest.plist`, `*.ipa`, the two icons (D4: the iPad lane keeps its behavior) |
| A device-public app, `builds/<slug>/*` | yes | `apps.<repo>.android.public: true`, an explicit opt-in, and never together with a public edition |
| The root `index.html` and `index.json` | yes | rendered with only anonymous links |
| Everything else: device APKs and their checksums, receipts, release notes, an Android-only app's page | **no** | needs the hub's keys or a presigned link |

Today (`policy.json`): Tower and Gruvato are on the iPad lane (so their iPad objects are open and their device APK is
not); Earshot sells the `beta` public edition and keeps its device edition private; Shortwave is Android only and
fully private; Green In Between and Navi opt in with `android.public: true` (decision record below). An app that sells
a public edition can never be device-public: the parser refuses `public: true` beside a public edition.

A latest.json still names its device APK's key and URL. It names it, it does not grant it: the bucket policy answers
that URL 403. The write guard (below) exempts exactly those two pointer files.

### Why the pointers are anonymous

The catch-up on big-chungus runs every two minutes and reads every app's `latest.json` each pass. The 1Password account
allows **1000 service-account reads a day** (`op service-account ratelimit`: `account read_write 1000`), shared by every
agent and deploy on the machine. A signed pointer read would cost two `op read`s a pass, 1440 a day, and lock 1Password
for everyone before evening. With anonymous pointers an idle pass reads nothing from 1Password; the keys are read only
when a pass downloads a private APK or writes `latest.json`, as before MOBI-17. A test holds it (`a pass with nothing to
install never asks 1Password`).

### Decision record (owner-delegated, 2026-11-19)

Jarad delegated the design: "make a decision that favors me making money; I don't want them accidentally or sneakily
finding a free download link". The ticket's own acceptance was "anonymous GET/list of a selling app's device APKs returns
403; S26 install, Quickdrop and catch-up still pass; single-edition apps unchanged unless opted in". Decided:

- **Private by default, for every app**, stronger than the ticket: Earshot, Shortwave, Tower and Gruvato device builds
  are private now, and any new app is private until its policy says otherwise.
- **An app that sells a public edition can never publish its device build** (parser rule). That is the money rule: the
  paid product's free twin is never one guess away, whatever anyone later sets.
- **Green In Between and Navi stay device-public** (`android.public: true`), rejecting the strict reading that would
  close them too. Both have live, revenue-side funnels built on the anonymous APK, and neither sells a public edition:
  - Green In Between's beta signup (`infra/src/mail.js`, smoke-tested by `infra/scripts/smoke.sh`) hands the current APK
    to anyone who signs up, by design, and its launch gate cites "the published APK". Closing the bucket would break
    the beta funnel and protect nothing, since the funnel gives the same APK away.
  - Navi is a client's technician app: sign-in is an SMS one-time code to rostered numbers, so the APK is useless to an
    outsider, and its in-app update gate (`src/lib/update.ts`) sends technicians to `builds/navi/index.html` for the new
    APK. Closing it would strand a paying client's field staff on old builds.
- Revisit when either sells: the day Green In Between prices its Android build, drop `android.public` (and move its
  signup funnel to a public edition or the store); a Navi that is sold per seat goes the same way.

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
  now, for every read of a private object. Its MinIO policy (`mobile-deploy-hub-builds`) already holds `s3:GetObject`
  on `builds/*`, so no new user or key was needed. The catch-up asks for it only when a pass touches a private object.
- The bucket admin, only for applying the bucket policy: `op://DeLoSecrets/hwatizsoschtnq5oleume6kdpu/{username,password}`.
  It goes into the `mc` child's `MC_HOST_builds` over `http://127.0.0.1:9012` and nowhere else.

## Reads

- **Hub jobs** (`gate`, `plan`, `deliver`, `announce`, `hosts`): `readObject` signs every GET with SigV4 headers using the
  writer's keys over the loopback port, inside a workflow job (or `HUB_S3_LOCAL=1`). Outside a job, or with
  `credentials: null`, it reads anonymously and a private object answers 403 with an error that says why.
- **The catch-up on big-chungus**: `createStore({credentials, signs})` signs exactly the reads the bucket policy does
  not open (`!isAnonymous(policy, key)`: the APK download), with the writer's keys (`hubWriter().credentials()`), read
  lazily. Pointers go anonymous, so an idle pass never reads 1Password. sha256 and signer checks are unchanged.
- **The catch-up on the Mac**: no keys, no 1Password token. It reads `https://s3.delo.sh` anonymously, and only for
  apps with an iOS lane. An Android-only app is skipped there (`<slug> no ios build`); big-chungus owns it.

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
device-public app's APK, an iOS-lane app's page, public editions) stay plain. announce asks 1Password for the keys twice
before giving up; without keys a private link is dropped, never replaced by a URL that answers 403, and the notification
says so (`... + Install APK link withheld (no signing keys)`, and `HUB_LINKS_DROPPED` in the log). A notification older
than 7 days has dead links; the next deploy sends fresh ones. The logs and receipts keep the plain canonical URL.

The pages themselves: a device-public app's page keeps "Install APK" and "Download retained APK". Any other page shows
a note that the Android build is private. The root index carries a device APK URL, or a page link, only for the apps
that publish them. The private device APK still reaches the S26 as before: `adb install`, Quickdrop, the catch-up, and
the presigned link in the notification.

The Android Release notes that `release` writes to the GitHub Release carry the "Build page" line only when that page is
open. The device APK and its receipts ride the Release only when GitHub says the repository is private (an unreadable
answer counts as public) or the policy publishes the device edition; otherwise `HUB_RELEASE_DEVICE_HELD`, so making an
app repo public never hands out what the bucket keeps private.

## Applying it (land stage)

The bucket policy is applied by `tools/bucket-policy.mjs`, idempotently, and never by a deploy:

```
mise run bucket-policy               strict check: the committed file equals the rendered one, and credential-free probes
                                     of https://s3.delo.sh get the answers the policy promises (list 403, a private APK
                                     key 403, a public key 404 or 200, ...). Exit 1 on any drift.
node tools/bucket-policy.mjs check --pending-ok    what the release runs: a private key that still answers is a warning
                                     (BUCKET_POLICY_PENDING); listing, a public key answering 403, no answer still fail
mise run bucket-policy:apply         refuses unless ready (below); mc anonymous set-json (admin keys from 1Password), read it
                                     back and compare, re-render every app page and the root index, then the strict check
node tools/bucket-policy.mjs apply --dry-run     the statements it would add and remove
node tools/bucket-policy.mjs diff                live against committed
node tools/bucket-policy.mjs pages               re-render every page and the root index (writer keys) on its own
node tools/bucket-policy.mjs write               re-render tools/ci/bucket-policy.json after a policy.json change
```

Apply replaces the bucket's anonymous policy as one document, so running it twice changes nothing. The probes use keys
that do not exist (`<slug>/0.0.0/<slug>-0.0.0-0.apk`), so they never touch a real object: a denied key answers 403, an
allowed missing key 404.

**Order.** Whatever reads the bucket must be able to read it before it changes:

- A change that makes something private (this one): merge, `mise run release -- X.Y.Z` (its bucket check tolerates
  the still-open keys), `mise run hosts:install` from the released main (the catch-up on both hosts runs an installed
  copy of the hub, and only this moves it), then `mise run bucket-policy:apply`, then `mise run bucket-policy`. A red
  release dry run moves v1 back onto code that reads the bucket anonymously, and the bucket is still open for it.
- A change that opens something (a new public edition): `mise run bucket-policy:apply` first, then the release.

`apply` enforces the first half itself (`BUCKET_POLICY_NOT_READY`, nothing applied): v1 on origin, the hub version every
app's deploy runs, must contain `tools/ci/lib/access.mjs`, and so must the catch-up installed on this host
(`~/.local/share/mobile-deploy-hub/current`). Without the guard, an old catch-up would get 403 on the APK, count it as a
failed install, and give up on the build for good after `max_failures` passes.

### Migration

- Old objects keep their public `Cache-Control` metadata. That is harmless once the policy denies the read (a denied
  request has no body to cache), and presigned links override it with `response-cache-control`. New objects are written
  with `private, ...` where the public cannot read them.
- Cloudflare does not edge-cache `s3.delo.sh` (`cf-cache-status: DYNAMIC`), so denial is immediate after the apply.
- Existing links to a private device APK, receipt or page stop working at the apply. That is the point.
- Pages and the root index written before the apply still named device APK URLs (now 403). `apply` re-renders every
  app page and the root index right after it sets the policy, so no anonymous page keeps a dead or private link.

## Failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `GET <key> from the build directory answered 403 (a private object read without the hub's keys)` | a read outside a job, or an old hub | run from a workflow job or `HUB_S3_LOCAL=1` |
| `HUB_ACCESS_REFUSED ... carry a presigned link` or `... link a private device APK` | a renderer put a private link in an anonymous object | fix the renderer; nothing was written |
| `BUCKET_POLICY_DRIFT <url> answered 404, expected 403` | the live bucket still has the old public-read policy | `mise run bucket-policy:apply` |
| `BUCKET_POLICY_PENDING ...` in a release | a private key still answers: the policy is applied after the release | release, `mise run hosts:install`, `mise run bucket-policy:apply` |
| `BUCKET_POLICY_NOT_READY v1 ... predates MOBI-17` | apply ran before the release | release the hub first |
| `BUCKET_POLICY_NOT_READY the catch-up installed on this host ... predates MOBI-17` | apply ran before hosts:install | `mise run hosts:install` from the released main |
| `HUB_RELEASE_DEVICE_HELD` | a public app repo, a private device edition | none: the device APK stays off a public Release |
| `BUCKET_POLICY_DRIFT tools/ci/bucket-policy.json is not what policy.json renders` | `policy.json` changed | `node tools/bucket-policy.mjs write`, commit |
| `HUB_LINKS_DROPPED apk, page`, "link withheld (no signing keys)" in the notification | the announce job had no writer keys (two tries) | check the 1Password service token on the runner, and `op service-account ratelimit` |
| catch-up `HTTP 403` on an APK | big-chungus catch-up lost its keys | the units' service account token; `HUB_CATCHUP_ERROR` says which read |
| the Mac pass logs `<slug> no ios build` | normal: the Mac skips Android-only apps | none |

## Known edges

- Tower's android-hoard proof reads `TOWER_APK_URL=latest` anonymously. The device APK is private now, so that proof
  needs the hub's keys or a presigned link from the notification.
- An app's own docs that link `https://s3.delo.sh/builds/<slug>/<version>/<slug>-<version>-<code>.apk` break for
  private apps. Use the notification link, or opt the app in with `android.public: true` if a public Install APK is the
  product.
- `android.public: true` is a deliberate hole. Review it like a credential change.
- The iOS-lane and opted-in apps' anonymous pages show device states and run links (private repos answer 404 to
  outsiders). Nothing there downloads a private build.

## Live verification (2026-11-19, v1.2.41)

Applied in the documented order: release (every app's strict dry run green), `hosts:install` (catch-up v1.2.41 on big-chungus and the Mac), `bucket-policy:apply` (set-json, read-back equal, pages re-rendered for all six apps), strict `bucket-policy` (59 of 59 anonymous probes answer as the policy says). Everything below is plain `curl` with no credentials against `https://s3.delo.sh/builds`.

| Request | Code |
| --- | --- |
| `/`, `/?prefix=earshot/`, `/?list-type=2`, `/?list-type=2&prefix=earshot/editions/beta/` (listings) | 403 |
| `earshot/<v>/earshot-<v>-<code>.apk` and `.sha256`, receipt, release notes | 403 |
| `earshot/index.html` (device-only app page) | 403 |
| `tower-of-lost-things`, `gruvato`, `shortwave` device `.apk` and `.sha256` | 403 |
| `earshot/latest.json`, `index.html` (root), `index.json` | 200 |
| `earshot/editions/beta/latest.json`, `index.html` | 200 |
| `earshot/editions/beta/0.1.11/...-1011.apk` (public edition) | 206 |
| `green-in-between` and `navi` device `.apk` (kept public, see the decision record) | 206 |
| `tower-of-lost-things`, `gruvato`, `navi`, `green-in-between` iPad page | 206 |

The anonymous pointer names the device APK's key; that name opens nothing, the object answers 403.

Earshot's real deploy of 0.1.11 (run 44668200341, green) went through the hub: the S26 reads back `versionName=0.1.11`, the public pointer and the beta edition pointer both moved to 0.1.11, and the beta APK is publicly readable. The completion event's Install APK link is presigned for 7 days (`X-Amz-Expires=604800`, `response-cache-control=private, no-store`): without credentials it answered 200 with the exact bytes (sha256 equals the pointer's), while the plain URL of the same object answered 403.

One release attempt (v1.2.40) went red on the green-in-between dry run: that app's own pinned clock-site test did not know its new capture driver. The hub rolled `v1` back, the app test was fixed in the app, and v1.2.41 shipped green.

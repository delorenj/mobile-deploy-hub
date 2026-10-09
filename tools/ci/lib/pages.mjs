// The build directory's pages (design v1.1, C2 and C4): static HTML rendered by deliver (and the catch-up reporter)
// from latest.json, with no external scripts or fonts, so Safari on the iPad and Chrome on the S26 open them directly.
// builds/index.html lists every app; builds/<slug>/index.html is one app's page: Install APK, Install on iPad, each
// device's state, sizes, commit, run and the APK history. builds/index.json carries the same as data.
const html = text => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const attr = url => html(url);

export function megabytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  return `${(bytes / 1e6).toFixed(bytes >= 1e8 ? 0 : 1)} MB`;
}

// "0.2.2 (4)", or just "0.2.5" when the build is the version itself (Gruvato's iOS build).
export function releaseLabel(version, build) {
  return build === undefined || build === null || String(build) === String(version) ? String(version) : `${version} (${build})`;
}

// One device's line on a phone screen, release first and the reason in plain words:
//   "S26 0.2.2 (4): pending, installs when it is back (not on big-chungus's adb)"
//   "iPad 0.2.2 (4): installed by deploy"
// A pending device whose host's catch-up is off does not promise an automatic install.
export function deviceLine(platform, block) {
  if (!block) return `${platform === 'android' ? 'S26' : 'iPad'}: no build yet`;
  const device = block.device;
  const head = `${device.name} ${releaseLabel(block.version, platform === 'android' ? block.code : block.build)}`;
  const why = device.reason ? ` (${device.reason})` : '';
  if (device.status === 'installed') return `${head}: installed${device.by ? ` by ${device.by}` : ''}`;
  if (device.status === 'pending') return `${head}: pending${/catch-up off/.test(device.reason ?? '') ? '' : ', installs when it is back'}${why}`;
  return `${head}: ${device.status}${why}`;
}

const style = `
:root { color-scheme: light dark; --bg: #f7f5f0; --fg: #1d1b16; --muted: #6b665c; --card: #ffffff; --line: #e3ded3; --accent: #2f6d3f; --accent-fg: #ffffff; --warn: #9a5b00; --bad: #a12a1f; }
@media (prefers-color-scheme: dark) { :root { --bg: #15140f; --fg: #ece8de; --muted: #a39d90; --card: #201e18; --line: #34312a; --accent: #6fbf7f; --accent-fg: #0f1a12; --warn: #e0a64a; --bad: #ef7d70; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width: 640px; margin: 0 auto; padding: 20px 16px 48px; }
h1 { font-size: 1.5rem; margin: 0 0 4px; }
h2 { font-size: 1.1rem; margin: 28px 0 8px; }
p, li { margin: 4px 0; }
.muted { color: var(--muted); font-size: 0.9rem; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px; margin: 14px 0; }
.buttons { display: flex; flex-wrap: wrap; gap: 10px; margin: 12px 0 4px; }
.button { display: inline-block; padding: 12px 18px; border-radius: 999px; background: var(--accent); color: var(--accent-fg); text-decoration: none; font-weight: 600; }
.button.secondary { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
.status-installed { color: var(--accent); }
.status-pending, .status-skipped { color: var(--warn); }
.status-failed { color: var(--bad); }
ul { padding-left: 20px; }
a { color: var(--accent); }
code { font-size: 0.85rem; }
`;

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${html(title)}</title>
<style>${style}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

function buttons(latest) {
  const parts = [];
  if (latest.android?.url) parts.push(`<a class="button" href="${attr(latest.android.url)}">Install APK${latest.android.bytes ? ` (${megabytes(latest.android.bytes)})` : ''}</a>`);
  if (latest.ios?.install_url) parts.push(`<a class="button" href="${attr(latest.ios.install_url)}">Install on iPad</a>`);
  return parts.length > 0 ? `<div class="buttons">${parts.join('')}</div>` : '';
}

function deviceItems(latest) {
  return ['android', 'ios'].filter(platform => latest[platform]).map(platform => {
    const block = latest[platform];
    const note = platform === 'ios' && block.key === null ? '; no over-the-air copy' : '';
    return `<li class="status-${html(block.device.status)}">${html(deviceLine(platform, block))}${note}</li>`;
  }).join('\n');
}

const short = sha => String(sha ?? '').slice(0, 7);

// The device states come from latest.json, which deliver and the catch-up both keep current; the page never carries
// a per-run list that a catch-up re-render would lose.
export function appPage({ latest, history = [] }) {
  const runLink = latest.run?.url ? `<a href="${attr(latest.run.url)}">run ${html(latest.run.id)}</a>` : `run ${html(latest.run?.id ?? '-')}`;
  const sizes = [
    latest.android ? `APK ${megabytes(latest.android.bytes)}` : null,
    latest.ios?.bytes ? `IPA ${megabytes(latest.ios.bytes)}` : null,
  ].filter(Boolean).join(', ');
  const older = history.length > 0
    ? `<h2>Android history</h2>\n<ul>\n${history.map(item => `<li><a href="${attr(item.url)}">${html(item.version)} (${html(item.code)})</a>${item.bytes ? ` <span class="muted">${megabytes(item.bytes)}</span>` : ''}</li>`).join('\n')}\n</ul>`
    : '';
  const body = `<h1>${html(latest.name)}</h1>
<p class="muted">Newest deploy ${html(latest.version)}, commit <code>${html(short(latest.commit))}</code>, ${runLink}${latest.hub_ref ? `, hub ${html(latest.hub_ref)}` : ''}</p>
<div class="card">
${buttons(latest)}
<ul>
${deviceItems(latest)}
</ul>
${sizes ? `<p class="muted">${html(sizes)}</p>` : ''}
</div>
${older}
<p class="muted">Updated ${html(latest.updated_at)}. Builds older than the newest five APKs, and every IPA but the newest, are removed.</p>`;
  return page(`${latest.name} builds`, body);
}

export function indexData(apps, now = new Date()) {
  return {
    schema: 1,
    updated_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    apps: apps.map(latest => ({
      slug: latest.slug,
      name: latest.name,
      version: latest.version,
      page: `${latest.slug}/index.html`,
      android: latest.android ? { version: latest.android.version, code: latest.android.code, url: latest.android.url, bytes: latest.android.bytes, device: latest.android.device.status } : null,
      ios: latest.ios ? { version: latest.ios.version, build: latest.ios.build, install_url: latest.ios.install_url, device: latest.ios.device.status } : null,
    })),
  };
}

export function indexPage(apps) {
  const cards = apps.length === 0
    ? '<p class="muted">No builds yet. The first real deploy of each app publishes here.</p>'
    : apps.map(latest => `<div class="card">
<h2><a href="${attr(`${latest.slug}/index.html`)}">${html(latest.name)}</a> ${html(latest.version)}</h2>
${buttons(latest)}
<ul>
${deviceItems(latest)}
</ul>
</div>`).join('\n');
  return page('Builds', `<h1>Builds</h1>\n<p class="muted">Tower of Lost Things, Green In Between and Gruvato, as mobile-deploy-hub published them.</p>\n${cards}`);
}

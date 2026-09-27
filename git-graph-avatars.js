// git-graph-avatars.js — SSRF-safe avatar fetch for the Git Graph tab.
//
// The lookup target is derived from the repository's remote-origin URL, which
// is fully attacker-controlled (a hostile `origin`, set via addRemote/
// editRemote or simply by cloning a hostile repo, can try to point this
// main-process fetch at an internal host — this runs with none of a browser
// tab's CORS/sandbox restrictions). Defenses, checked before every request:
//
//   1. Fixed host allow-list: only 'api.github.com' and 'gravatar.com' are
//      ever contacted automatically. The repository's remote-origin host is
//      never templated into a request URL — it only ever *selects* which of
//      these fixed providers to use (github.com origin -> github provider,
//      gitlab.com origin -> gitlab provider), it never becomes the request
//      host itself. A self-hosted GitLab host is the one exception, and it
//      requires the user to have explicitly confirmed it once (stored in
//      RepoConfig.avatarsSelfHostedGitLabHost) — never auto-derived.
//   2. https only; any other scheme is rejected outright.
//   3. The hostname is resolved via DNS first, and the request is refused if
//      every resolved address is private/loopback/link-local/multicast (a
//      small hand-rolled RFC 1918/4193/link-local range check). The request
//      is then pinned to that already-checked address (so a second DNS
//      answer at connect time can't swap in a different address — TOCTOU /
//      DNS-rebinding).
//   4. A redirect is only followed when its target host matches the
//      already-validated host (or a small per-provider asset-host allow-
//      list, e.g. GitHub's own avatar CDN) — never cross-host, never to an
//      unvalidated host.
//
// On-disk cache is keyed by sha256(lowercased trimmed email), served to the
// (contextIsolated) renderer through preview-assets.js's existing
// switchboard-preview:// mechanism, exactly like any other cached asset.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const https = require('https');

// api.github.com and gravatar.com are the plan's own fixed allow-list;
// gitlab.com (the public SaaS host, distinct from any self-hosted instance)
// is included on the same footing since it is just as fixed/well-known —
// only a *self-hosted* GitLab host needs the separate one-time user
// confirmation (point 2 below), never the public one.
const ALLOWED_PROVIDER_HOSTS = new Set(['api.github.com', 'gravatar.com', 'gitlab.com']);
const ALLOWED_ASSET_HOST_SUFFIXES = ['.githubusercontent.com'];
const ALLOWED_ASSET_HOSTS = new Set(['gravatar.com', 'secure.gravatar.com']);

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const CACHE_MAX_AGE_ENTRIES_TO_KEEP = null; // cleared manually; entries do not expire

let dataDir = null;
let log = console;
let httpsGetOverride = null;
let resolveOverride = null;

function init(ctx = {}) {
  dataDir = ctx.dataDir || null;
  log = ctx.log || console;
  httpsGetOverride = ctx.httpsGet || null;
  resolveOverride = ctx.resolve || null;
  if (dataDir) { try { fs.mkdirSync(dataDir, { recursive: true }); } catch {} }
}

function ensureDataDir() {
  if (!dataDir) throw new Error('git-graph-avatars: not initialised with a dataDir');
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
  return dataDir;
}

// --- Private/reserved IP range checks (hand-rolled; no such check existed
// anywhere in this codebase before) ---

function ipv4ToInt(parts) {
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateIPv4(address) {
  const m = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const parts = m.slice(1).map(Number);
  if (parts.some(p => p > 255)) return false;
  const value = ipv4ToInt(parts);
  const inRange = (base, maskBits) => {
    const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0;
    return (value & mask) === (ipv4ToInt(base) & mask);
  };
  return (
    inRange([10, 0, 0, 0], 8) ||      // RFC1918
    inRange([172, 16, 0, 0], 12) ||   // RFC1918
    inRange([192, 168, 0, 0], 16) ||  // RFC1918
    inRange([127, 0, 0, 0], 8) ||     // loopback
    inRange([169, 254, 0, 0], 16) ||  // link-local
    inRange([0, 0, 0, 0], 8) ||       // "this" network
    inRange([100, 64, 0, 0], 10) ||   // shared address space (CGNAT)
    inRange([224, 0, 0, 0], 4) ||     // multicast
    inRange([192, 0, 0, 0], 24) ||    // IETF protocol assignments
    inRange([192, 0, 2, 0], 24) ||    // documentation (TEST-NET-1)
    inRange([198, 18, 0, 0], 15) ||   // benchmarking
    inRange([198, 51, 100, 0], 24) || // documentation (TEST-NET-2)
    inRange([203, 0, 113, 0], 24)     // documentation (TEST-NET-3)
  );
}

function isPrivateIPv6(address) {
  const a = address.toLowerCase();
  if (a === '::1') return true; // loopback
  if (a === '::') return true; // unspecified
  if (a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb')) return true; // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(a)) return true; // fc00::/7 unique local (RFC4193)
  if (a.startsWith('ff')) return true; // multicast
  // IPv4-mapped (::ffff:a.b.c.d) — check the embedded v4 address too.
  const mapped = a.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

function isPrivateOrReservedIp(address) {
  if (address.includes(':')) return isPrivateIPv6(address);
  return isPrivateIPv4(address);
}

/** Resolve a hostname and reject if it (or any resolved address) is private/reserved. */
/**
 * Raw DNS resolution only — no safety decision here. `resolveOverride` (test
 * seam) stands in for `dns.lookup` alone, returning one address or an array;
 * the private/reserved-range check below always runs on its result too, so
 * a test can fake *which addresses DNS returns* without ever bypassing the
 * actual safety check — the two are deliberately not the same override.
 */
function rawDnsLookup(hostname) {
  if (resolveOverride) {
    return Promise.resolve(resolveOverride(hostname)).then((result) => {
      const list = Array.isArray(result) ? result : [result];
      if (!list.length || !list[0]) throw new Error(`No DNS records for ${hostname}`);
      return list;
    });
  }
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) { reject(err); return; }
      if (!addresses || !addresses.length) { reject(new Error(`No DNS records for ${hostname}`)); return; }
      resolve(addresses.map(a => a.address));
    });
  });
}

async function resolvePinnedAddress(hostname) {
  const addresses = await rawDnsLookup(hostname);
  const unsafe = addresses.find(address => isPrivateOrReservedIp(address));
  if (unsafe) throw new Error(`Refusing to contact ${hostname}: resolves to a private/reserved address (${unsafe})`);
  return addresses[0];
}

// --- Provider selection — never templates the raw origin host directly ---

function parseOriginHost(originUrl) {
  if (!originUrl || typeof originUrl !== 'string') return null;
  // https://host/owner/repo(.git) or http://... or ssh://git@host/owner/repo
  let m = originUrl.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)/i);
  if (m) return m[1].toLowerCase();
  // git@host:owner/repo.git (scp-like syntax)
  m = originUrl.match(/^[^@\s]+@([^:\s]+):/);
  if (m) return m[1].toLowerCase();
  return null;
}

function pickProvider(originUrl, repoConfig) {
  const host = parseOriginHost(originUrl);
  if (host === 'github.com') return { provider: 'github', requestHost: 'api.github.com' };
  if (host === 'gitlab.com') return { provider: 'gitlab', requestHost: 'gitlab.com' };
  const confirmedHost = repoConfig && repoConfig.avatarsSelfHostedGitLabHost;
  if (confirmedHost && host === String(confirmedHost).toLowerCase()) {
    return { provider: 'gitlab', requestHost: confirmedHost };
  }
  return { provider: 'gravatar', requestHost: 'gravatar.com' };
}

// Independent of pickProvider's own logic (defense in depth): true only for
// the two fixed hosts, or a self-hosted GitLab host the user has explicitly
// confirmed for this exact repo (never any other string, however derived).
function isAllowedRequestHost(host, repoConfig) {
  if (ALLOWED_PROVIDER_HOSTS.has(host)) return true;
  const confirmedHost = repoConfig && repoConfig.avatarsSelfHostedGitLabHost;
  return !!confirmedHost && host === String(confirmedHost).toLowerCase();
}

function isAllowedAssetHost(host) {
  if (ALLOWED_ASSET_HOSTS.has(host)) return true;
  return ALLOWED_ASSET_HOST_SUFFIXES.some(suffix => host.endsWith(suffix));
}

// --- SSRF-safe HTTPS GET, pinned to a pre-validated address ---

async function httpsGetPinned(hostname, requestPath, headers = {}) {
  // The DNS-pin + private-range check always runs first, for every request,
  // real or test-doubled — httpsGetOverride (test seam) stands in only for
  // "make the socket request", never for "decide whether this address is
  // safe to contact".
  const address = await resolvePinnedAddress(hostname);
  if (httpsGetOverride) return httpsGetOverride(hostname, requestPath, headers, address);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: address,
      servername: hostname, // TLS SNI + cert validation still checks the real hostname
      path: requestPath,
      method: 'GET',
      headers: { Host: hostname, 'User-Agent': 'Switchboard-GitGraph', ...headers },
      timeout: REQUEST_TIMEOUT_MS,
      rejectUnauthorized: true,
    }, (res) => {
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) { req.destroy(new Error('Avatar response too large')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('Avatar request timed out')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * GET https://hostname/requestPath, following only same-host (or asset-
 * allow-listed) redirects. Callers must have already checked the initial
 * hostname via isAllowedRequestHost/isAllowedAssetHost — this function's own
 * job is the DNS-pin + redirect-host discipline, not the initial allow-list.
 */
async function fetchSafely(hostname, requestPath, { headers } = {}) {
  let host = hostname;
  let reqPath = requestPath;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const res = await httpsGetPinned(host, reqPath, headers);
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      const location = new URL(res.headers.location, `https://${host}${reqPath}`);
      if (location.protocol !== 'https:') throw new Error('Refusing a non-https redirect');
      const nextHost = location.hostname.toLowerCase();
      if (nextHost !== host && !isAllowedAssetHost(nextHost)) {
        throw new Error(`Refusing a cross-host redirect to ${nextHost}`);
      }
      host = nextHost;
      reqPath = location.pathname + (location.search || '');
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects');
}

// --- Cache ---

function cacheKeyFor(email) {
  return crypto.createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('hex');
}

function extFromContentType(contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (type === 'image/png') return '.png';
  if (type === 'image/jpeg' || type === 'image/jpg') return '.jpg';
  if (type === 'image/gif') return '.gif';
  if (type === 'image/webp') return '.webp';
  return '.img';
}

function findCachedFile(key) {
  const dir = ensureDataDir();
  const entries = fs.readdirSync(dir);
  const match = entries.find(name => name.startsWith(key + '.'));
  return match ? path.join(dir, match) : null;
}

function saveToCache(key, buffer, contentType) {
  const dir = ensureDataDir();
  const file = path.join(dir, key + extFromContentType(contentType));
  fs.writeFileSync(file, buffer);
  return file;
}

function clearCache() {
  const dir = ensureDataDir();
  for (const name of fs.readdirSync(dir)) {
    try { fs.unlinkSync(path.join(dir, name)); } catch {}
  }
  return { ok: true };
}

function toPreviewUrl(filePath) {
  // eslint-disable-next-line global-require
  const { createPreviewAssetUrl } = require('./preview-assets');
  return createPreviewAssetUrl(filePath, ensureDataDir());
}

// --- Provider lookups (email -> image bytes), each host-gated ---

async function lookupGravatar(email) {
  const hash = crypto.createHash('md5').update(String(email || '').trim().toLowerCase()).digest('hex');
  const res = await fetchSafely('gravatar.com', `/avatar/${hash}?s=80&d=404`);
  if (res.statusCode !== 200) return null;
  return { buffer: res.body, contentType: res.headers['content-type'] };
}

async function lookupGitLab(host, email) {
  const res = await fetchSafely(host, `/api/v4/avatar?email=${encodeURIComponent(email)}`);
  if (res.statusCode !== 200) return null;
  let parsed;
  try { parsed = JSON.parse(res.body.toString('utf8')); } catch { return null; }
  const avatarUrl = parsed && parsed.avatar_url;
  if (!avatarUrl) return null;
  const url = new URL(avatarUrl);
  if (url.protocol !== 'https:') return null;
  const assetHost = url.hostname.toLowerCase();
  if (assetHost !== host && !isAllowedAssetHost(assetHost)) return null;
  const imgRes = await fetchSafely(assetHost, url.pathname + (url.search || ''), { isAssetHost: true });
  if (imgRes.statusCode !== 200) return null;
  return { buffer: imgRes.body, contentType: imgRes.headers['content-type'] };
}

async function lookupGitHub(email) {
  const res = await fetchSafely('api.github.com', `/search/users?q=${encodeURIComponent(email)}+in:email`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (res.statusCode !== 200) return null;
  let parsed;
  try { parsed = JSON.parse(res.body.toString('utf8')); } catch { return null; }
  const avatarUrl = parsed && parsed.items && parsed.items[0] && parsed.items[0].avatar_url;
  if (!avatarUrl) return null;
  const url = new URL(avatarUrl);
  if (url.protocol !== 'https:') return null;
  const assetHost = url.hostname.toLowerCase();
  if (!isAllowedAssetHost(assetHost)) return null;
  const imgRes = await fetchSafely(assetHost, url.pathname + (url.search || ''), { isAssetHost: true });
  if (imgRes.statusCode !== 200) return null;
  return { buffer: imgRes.body, contentType: imgRes.headers['content-type'] };
}

/**
 * Resolve a viewer-safe avatar URL for an email, given the repo's remote
 * origin URL (used only to *select* a fixed provider, never templated
 * directly into a request). Returns null on any failure — avatars are a
 * nice-to-have, never a hard error for the caller.
 */
async function getAvatarUrl(email, { originUrl, repoConfig } = {}) {
  if (!email) return null;
  const key = cacheKeyFor(email);
  const cached = findCachedFile(key);
  if (cached) return toPreviewUrl(cached);

  const { provider, requestHost } = pickProvider(originUrl, repoConfig);
  if (!isAllowedRequestHost(requestHost, repoConfig)) return null;

  // The DNS-resolve-then-pin check runs inside httpsGetPinned/fetchSafely
  // for every request this makes, including the self-hosted-GitLab case —
  // a confirmed host string is still re-validated against private ranges
  // every time, not just at confirmation time.
  let looked = null;
  try {
    if (provider === 'gravatar') looked = await lookupGravatar(email);
    else if (provider === 'gitlab') looked = await lookupGitLab(requestHost, email);
    else if (provider === 'github') looked = await lookupGitHub(email);
  } catch (err) {
    log.info?.('[git-graph-avatars] lookup failed', err.message);
    return null;
  }
  if (!looked) return null;

  const file = saveToCache(key, looked.buffer, looked.contentType);
  return toPreviewUrl(file);
}

module.exports = {
  init,
  isPrivateOrReservedIp,
  resolvePinnedAddress,
  parseOriginHost,
  pickProvider,
  isAllowedRequestHost,
  isAllowedAssetHost,
  fetchSafely,
  cacheKeyFor,
  getAvatarUrl,
  clearCache,
};

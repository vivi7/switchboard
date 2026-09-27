const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const avatars = require('../git-graph-avatars');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// --- Private/reserved IP range checks — the core SSRF defense ---

test('isPrivateOrReservedIp flags loopback/private/link-local IPv4 ranges', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.5.5', '192.168.1.1', '169.254.1.1', '0.0.0.0', '100.64.0.1']) {
    assert.equal(avatars.isPrivateOrReservedIp(ip), true, `${ip} should be flagged private/reserved`);
  }
});

test('isPrivateOrReservedIp accepts ordinary public IPv4 addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '140.82.121.3']) {
    assert.equal(avatars.isPrivateOrReservedIp(ip), false, `${ip} should not be flagged`);
  }
});

test('isPrivateOrReservedIp flags loopback/link-local/unique-local IPv6, and IPv4-mapped addresses', () => {
  assert.equal(avatars.isPrivateOrReservedIp('::1'), true);
  assert.equal(avatars.isPrivateOrReservedIp('fe80::1'), true);
  assert.equal(avatars.isPrivateOrReservedIp('fd00::1'), true);
  assert.equal(avatars.isPrivateOrReservedIp('::ffff:127.0.0.1'), true, 'an IPv4-mapped loopback address must still be caught');
  assert.equal(avatars.isPrivateOrReservedIp('2606:4700:4700::1111'), false);
});

// --- Provider selection never templates the raw origin host into a request ---

test('parseOriginHost handles https, ssh://, and git@ scp-like remote URLs', () => {
  assert.equal(avatars.parseOriginHost('https://github.com/owner/repo.git'), 'github.com');
  assert.equal(avatars.parseOriginHost('ssh://git@gitlab.example.com:2222/owner/repo.git'), 'gitlab.example.com');
  assert.equal(avatars.parseOriginHost('git@github.com:owner/repo.git'), 'github.com');
  assert.equal(avatars.parseOriginHost('git://github.com/owner/repo.git'), 'github.com');
  assert.equal(avatars.parseOriginHost(null), null);
  assert.equal(avatars.parseOriginHost(''), null);
});

test('pickProvider selects github.com/gitlab.com by host, and never invents a host from an unrecognized origin', () => {
  assert.deepEqual(avatars.pickProvider('https://github.com/o/r.git', null), { provider: 'github', requestHost: 'api.github.com' });
  assert.deepEqual(avatars.pickProvider('git@gitlab.com:o/r.git', null), { provider: 'gitlab', requestHost: 'gitlab.com' });
  // An unrecognized/malicious origin host falls back to Gravatar — it is
  // never used as (or templated into) a request host itself.
  const result = avatars.pickProvider('https://127.0.0.1:9999/evil.git', null);
  assert.deepEqual(result, { provider: 'gravatar', requestHost: 'gravatar.com' });
});

test('pickProvider only honours a self-hosted GitLab host the caller explicitly confirmed for this exact repo', () => {
  const confirmed = avatars.pickProvider('https://git.internal.example/o/r.git', { avatarsSelfHostedGitLabHost: 'git.internal.example' });
  assert.deepEqual(confirmed, { provider: 'gitlab', requestHost: 'git.internal.example' });

  // A different, unconfirmed host is never trusted just because *some*
  // confirmed host exists in RepoConfig for a different repo/origin.
  const mismatched = avatars.pickProvider('https://attacker.example/o/r.git', { avatarsSelfHostedGitLabHost: 'git.internal.example' });
  assert.equal(mismatched.provider, 'gravatar');
});

test('isAllowedRequestHost is independent of pickProvider — only the two fixed hosts or an explicitly confirmed self-hosted GitLab host pass', () => {
  assert.equal(avatars.isAllowedRequestHost('api.github.com', null), true);
  assert.equal(avatars.isAllowedRequestHost('gitlab.com', null), true);
  assert.equal(avatars.isAllowedRequestHost('evil.example', null), false);
  assert.equal(avatars.isAllowedRequestHost('git.internal.example', { avatarsSelfHostedGitLabHost: 'git.internal.example' }), true);
  assert.equal(avatars.isAllowedRequestHost('git.internal.example', { avatarsSelfHostedGitLabHost: 'other.example' }), false);
});

test('isAllowedAssetHost allows GitHub\'s avatar CDN suffix and Gravatar, nothing else', () => {
  assert.equal(avatars.isAllowedAssetHost('avatars.githubusercontent.com'), true);
  assert.equal(avatars.isAllowedAssetHost('gravatar.com'), true);
  assert.equal(avatars.isAllowedAssetHost('secure.gravatar.com'), true);
  assert.equal(avatars.isAllowedAssetHost('evil.example'), false);
  assert.equal(avatars.isAllowedAssetHost('notgithubusercontent.com'), false);
});

// A fixed, genuinely public-looking address for every test below that fakes
// the transport layer (httpsGet) but still wants the real DNS-pin safety
// check to run — resolvePinnedAddress always runs it, real DNS or faked.
const PUBLIC_ADDR = '93.184.216.34';
const resolveToPublic = async () => PUBLIC_ADDR;

// --- resolvePinnedAddress: DNS-resolve-then-pin, refusing private/loopback targets ---
// The `resolve` seam only fakes *what DNS returns*; the private/reserved
// range check itself is never bypassed by a test override — verified here by
// asserting rejection with a faked-private DNS answer, not by disabling the
// check.

test('resolvePinnedAddress rejects when the (possibly faked) DNS answer is private/reserved', async () => {
  avatars.init({ dataDir: tmpDir('gg-avatars-'), resolve: async () => '127.0.0.1' });
  await assert.rejects(avatars.resolvePinnedAddress('whatever.example'), /private|reserved/);
});

test('resolvePinnedAddress accepts a public address and returns it', async () => {
  avatars.init({ dataDir: tmpDir('gg-avatars-'), resolve: resolveToPublic });
  assert.equal(await avatars.resolvePinnedAddress('whatever.example'), PUBLIC_ADDR);
});

test('resolvePinnedAddress rejects when every address in a multi-address answer is private', async () => {
  avatars.init({ dataDir: tmpDir('gg-avatars-'), resolve: async () => ['10.0.0.1', '192.168.1.1'] });
  await assert.rejects(avatars.resolvePinnedAddress('whatever.example'), /private|reserved/);
});

test('a malicious/loopback self-hosted-GitLab host is refused before any socket is opened', async () => {
  const calls = [];
  const dataDir = tmpDir('gg-avatars-');
  avatars.init({
    dataDir,
    httpsGet: async (hostname) => { calls.push(hostname); return { statusCode: 200, headers: {}, body: Buffer.from('') }; },
    resolve: async (hostname) => {
      // Simulate the confirmed self-hosted host resolving to a loopback
      // address — exactly the DNS-rebinding-to-metadata-service scenario
      // the plan calls out. The DNS-pin check runs before httpsGet is ever
      // reached, real or faked.
      if (hostname === 'localhost.evil.example') return '127.0.0.1';
      return PUBLIC_ADDR;
    },
  });

  const repoConfig = { avatarsSelfHostedGitLabHost: 'localhost.evil.example' };
  const url = await avatars.getAvatarUrl('someone@example.com', { originUrl: 'https://localhost.evil.example/o/r.git', repoConfig });
  assert.equal(url, null, 'must refuse and return null rather than surface any error');
  assert.equal(calls.length, 0, 'no HTTPS request was ever attempted against the malicious host');
});

// --- fetchSafely: same-host-only redirects ---

test('fetchSafely follows a same-host redirect but refuses a cross-host redirect', async () => {
  const dataDir = tmpDir('gg-avatars-');
  let call = 0;
  avatars.init({
    dataDir,
    resolve: resolveToPublic,
    httpsGet: async (host) => {
      call += 1;
      if (host === 'gravatar.com' && call === 1) {
        return { statusCode: 302, headers: { location: 'https://gravatar.com/avatar/next' }, body: Buffer.alloc(0) };
      }
      if (host === 'gravatar.com' && call === 2) {
        return { statusCode: 200, headers: {}, body: Buffer.from('img-bytes') };
      }
      throw new Error('unexpected host ' + host);
    },
  });
  const res = await avatars.fetchSafely('gravatar.com', '/avatar/abc');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.toString(), 'img-bytes');
});

test('fetchSafely refuses a redirect to an unrelated, non-allow-listed host', async () => {
  avatars.init({
    dataDir: tmpDir('gg-avatars-'),
    resolve: resolveToPublic,
    httpsGet: async () => ({ statusCode: 302, headers: { location: 'https://attacker.example/steal' }, body: Buffer.alloc(0) }),
  });
  await assert.rejects(avatars.fetchSafely('gravatar.com', '/avatar/abc'), /cross-host redirect/);
});

test('fetchSafely refuses a non-https redirect target', async () => {
  avatars.init({
    dataDir: tmpDir('gg-avatars-'),
    resolve: resolveToPublic,
    httpsGet: async () => ({ statusCode: 302, headers: { location: 'http://gravatar.com/avatar/abc' }, body: Buffer.alloc(0) }),
  });
  await assert.rejects(avatars.fetchSafely('gravatar.com', '/avatar/abc'), /non-https/);
});

// --- getAvatarUrl: end-to-end happy path + cache ---

test('getAvatarUrl fetches, caches to disk, and returns a preview URL; a second call reuses the cache', async () => {
  const dataDir = tmpDir('gg-avatars-');
  let fetchCount = 0;
  avatars.init({
    dataDir,
    resolve: resolveToPublic,
    httpsGet: async (host, reqPath) => {
      fetchCount += 1;
      assert.equal(host, 'gravatar.com');
      assert.match(reqPath, /^\/avatar\//);
      return { statusCode: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from('fake-png-bytes') };
    },
  });

  const email = 'nexus@adspulse.dev';
  const url1 = await avatars.getAvatarUrl(email, { originUrl: null, repoConfig: null });
  assert.ok(url1, 'expected a preview URL for a successful lookup');
  assert.match(url1, /^switchboard-preview:\/\//);

  const key = avatars.cacheKeyFor(email);
  const cachedFile = fs.readdirSync(dataDir).find(name => name.startsWith(key + '.'));
  assert.ok(cachedFile, 'expected the fetched bytes to be cached on disk');

  const url2 = await avatars.getAvatarUrl(email, { originUrl: null, repoConfig: null });
  assert.equal(fetchCount, 1, 'the second call must be served from cache, not a second fetch');
  assert.equal(url2.split('/').pop(), url1.split('/').pop());
});

test('getAvatarUrl returns null on a 404/not-found lookup without throwing', async () => {
  avatars.init({
    dataDir: tmpDir('gg-avatars-'),
    resolve: resolveToPublic,
    httpsGet: async () => ({ statusCode: 404, headers: {}, body: Buffer.alloc(0) }),
  });
  const url = await avatars.getAvatarUrl('nobody@example.com', { originUrl: null, repoConfig: null });
  assert.equal(url, null);
});

test('getAvatarUrl returns null for a missing email rather than hashing an empty string', async () => {
  avatars.init({ dataDir: tmpDir('gg-avatars-') });
  assert.equal(await avatars.getAvatarUrl('', {}), null);
  assert.equal(await avatars.getAvatarUrl(null, {}), null);
});

test('a GitLab avatar_url pointing off-host is refused', async () => {
  avatars.init({
    dataDir: tmpDir('gg-avatars-'),
    resolve: resolveToPublic,
    httpsGet: async (host) => {
      if (host === 'gitlab.com') {
        return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ avatar_url: 'https://attacker.example/x.png' })) };
      }
      throw new Error('should never reach the malicious asset host: ' + host);
    },
  });
  const url = await avatars.getAvatarUrl('someone@example.com', { originUrl: 'https://gitlab.com/o/r.git', repoConfig: null });
  assert.equal(url, null);
});

test('a GitHub search result avatar_url is only followed on the real avatar CDN suffix', async () => {
  avatars.init({
    dataDir: tmpDir('gg-avatars-'),
    resolve: resolveToPublic,
    httpsGet: async (host) => {
      if (host === 'api.github.com') {
        return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ items: [{ avatar_url: 'https://avatars.githubusercontent.com/u/1' }] })) };
      }
      if (host === 'avatars.githubusercontent.com') {
        return { statusCode: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from('gh-avatar-bytes') };
      }
      throw new Error('unexpected host ' + host);
    },
  });
  const url = await avatars.getAvatarUrl('octocat@example.com', { originUrl: 'https://github.com/o/r.git', repoConfig: null });
  assert.ok(url);
});

// --- clearCache ---

test('clearCache empties the avatar cache directory', async () => {
  const dataDir = tmpDir('gg-avatars-');
  avatars.init({
    dataDir,
    resolve: resolveToPublic,
    httpsGet: async () => ({ statusCode: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from('x') }),
  });
  await avatars.getAvatarUrl('someone@example.com', { originUrl: null, repoConfig: null });
  assert.ok(fs.readdirSync(dataDir).length > 0);
  avatars.clearCache();
  assert.equal(fs.readdirSync(dataDir).length, 0);
});

test('cacheKeyFor is case-insensitive and whitespace-trimmed (sha256 of the normalized email)', () => {
  const a = avatars.cacheKeyFor('Someone@Example.com');
  const b = avatars.cacheKeyFor('  someone@example.com  ');
  const expected = crypto.createHash('sha256').update('someone@example.com').digest('hex');
  assert.equal(a, expected);
  assert.equal(b, expected);
});

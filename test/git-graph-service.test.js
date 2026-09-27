const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const service = require('../git-graph-service');
const realGit = require('../git');

const haveGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

// A minimal in-memory settings store — the same shape as db.js's
// getSetting/setSetting, no SQLite (db.js needs Electron's ABI to load, same
// reason test/projects.test.js fakes it too).
function makeFakeDb() {
  const rows = new Map();
  return {
    rows,
    getSetting: (key) => (rows.has(key) ? JSON.parse(JSON.stringify(rows.get(key))) : null),
    setSetting: (key, value) => { rows.set(key, JSON.parse(JSON.stringify(value))); },
  };
}

function gitIn(repo, ...args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || `git ${args[0]} failed`);
  return r.stdout.trim();
}

/** A throwaway repository with one commit on main, identity set locally. */
function makeRepo(prefix = 'switchboard-gg-') {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  gitIn(repo, 'init', '-q', '-b', 'main');
  gitIn(repo, 'config', 'user.email', 'test@example.com');
  gitIn(repo, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'README.md'), '# hello\n');
  gitIn(repo, 'add', 'README.md');
  gitIn(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

function setupService(extra = {}) {
  const db = makeFakeDb();
  const events = [];
  service.init({
    db,
    log: { info() {}, error() {} },
    send: (channel, ...args) => events.push({ channel, args }),
    git: realGit,
    actionTimeoutMs: 80,
    networkActionTimeoutMs: 150,
    repoWatchPollMs: 30,
    repoWatchDebounceMs: 20,
    ...extra,
  });
  return { db, events };
}

test.afterEach(() => {
  service.stopAllRepoWatches();
});

// --- Pseudo-commit synthesis — pure, no git needed ---

test('synthesizeStashPseudoCommit/synthesizeUncommittedPseudoCommit produce commit-shaped rows', () => {
  const stashPseudo = service.synthesizeStashPseudoCommit({ hash: 'deadbeef', index: 0, branch: 'main', message: 'WIP on main: x', date: '2024-01-01T00:00:00Z', baseCommitHash: 'cafef00d' });
  assert.equal(stashPseudo.kind, 'stash');
  assert.deepEqual(stashPseudo.parents, ['cafef00d']);
  assert.equal(stashPseudo.hash, 'deadbeef');

  const uncommittedPseudo = service.synthesizeUncommittedPseudoCommit('cafef00d', { changeCount: 3, changes: [] });
  assert.equal(uncommittedPseudo.kind, 'uncommitted');
  assert.deepEqual(uncommittedPseudo.parents, ['cafef00d']);
  assert.match(uncommittedPseudo.subject, /Uncommitted Changes \(3\)/);

  const noParentUncommitted = service.synthesizeUncommittedPseudoCommit(null, null);
  assert.deepEqual(noParentUncommitted.parents, []);
  assert.match(noParentUncommitted.subject, /\(0\)/);
});

test('interleavePseudoCommits inserts a stash above its base commit and uncommitted on top', () => {
  const commits = [
    { hash: 'c3', parents: ['c2'] },
    { hash: 'c2', parents: ['c1'] },
    { hash: 'c1', parents: [] },
  ];
  const stashes = [{ hash: 'stash1', index: 0, branch: 'main', message: 'WIP', date: 'now', baseCommitHash: 'c2' }];
  const uncommitted = { changeCount: 1, changes: [] };
  const merged = service.interleavePseudoCommits(commits, { stashes, uncommitted, headHash: 'c3' });
  assert.deepEqual(merged.map(c => c.hash), ['#uncommitted', 'c3', 'stash1', 'c2', 'c1']);
});

test('interleavePseudoCommits leaves out a stash whose base commit is outside the loaded window', () => {
  const commits = [{ hash: 'c3', parents: ['c2'] }];
  const stashes = [{ hash: 'stash1', index: 0, branch: 'main', message: 'WIP', date: 'now', baseCommitHash: 'not-loaded' }];
  const merged = service.interleavePseudoCommits(commits, { stashes, uncommitted: null, headHash: 'c3' });
  assert.deepEqual(merged.map(c => c.hash), ['c3']);
});

// --- Global preferences ---

test('getGitGraphGlobalPreferences returns the documented defaults', () => {
  setupService();
  const { preferences } = service.getGitGraphGlobalPreferences();
  assert.equal(preferences.initialLoad, 300);
  assert.equal(preferences.loadMore, 100);
  assert.equal(preferences.commitsOrder, undefined); // commitsOrder is a RepoConfig field, not GlobalPrefs
  assert.equal(preferences.dateFormat, 'date-time');
  assert.equal(preferences.repositoryDropdownOrder, 'attachmentOrder');
  assert.equal(preferences.dialogDefaults.merge.noFastForward, true);
  assert.equal(preferences.dialogDefaults.pushBranch.setUpstream, true);
  assert.equal(preferences.graphColours.length, 12);
});

test('setGitGraphGlobalPreferences merges top-level and one level into dialogDefaults', () => {
  setupService();
  service.setGitGraphGlobalPreferences({ initialLoad: 50, dialogDefaults: { merge: { noFastForward: false } } });
  const { preferences } = service.getGitGraphGlobalPreferences();
  assert.equal(preferences.initialLoad, 50);
  assert.equal(preferences.loadMore, 100); // untouched sibling survives the merge
  assert.equal(preferences.dialogDefaults.merge.noFastForward, false);
  assert.equal(preferences.dialogDefaults.merge.squashCommits, false); // untouched sibling field survives
  assert.equal(preferences.dialogDefaults.pushBranch.setUpstream, true); // untouched sibling dialog survives
});

// --- Repo config + identity cache ---

test('getGitGraphRepoConfig defaults on first read and persists rootCommitHashes', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  try {
    const { config, trusted } = await service.getGitGraphRepoConfig(repo);
    assert.equal(trusted, false);
    assert.equal(config.showStashes, true);
    assert.equal(config.commitsOrder, 'date');
    assert.equal(config.rootCommitHashes.length, 1);
  } finally { rm(repo); }
});

test('a stale RepoConfig is ignored (not inherited) when a different repo now occupies the path', { skip: !haveGit && 'git not installed' }, async () => {
  const { db } = setupService();
  const repoA = makeRepo();
  try {
    await service.setGitGraphRepoConfig(repoA, { customDisplayName: 'Repo A', showTags: false });
    let { config } = await service.getGitGraphRepoConfig(repoA);
    assert.equal(config.customDisplayName, 'Repo A');

    // Simulate a worktree-reuse: a different repository now lives at
    // the same path, but the stored RepoConfig (keyed by path) still says
    // "Repo A" — force an actual identity change by rewriting history.
    fs.rmSync(path.join(repoA, '.git'), { recursive: true, force: true });
    gitIn(repoA, 'init', '-q', '-b', 'main');
    gitIn(repoA, 'config', 'user.email', 'test@example.com');
    gitIn(repoA, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repoA, 'other.txt'), 'x\n');
    gitIn(repoA, 'add', 'other.txt');
    gitIn(repoA, 'commit', '-q', '-m', 'a different repo entirely');

    ({ config } = await service.getGitGraphRepoConfig(repoA));
    assert.equal(config.customDisplayName, null, 'stale config must not be inherited by the new repo at this path');
    assert.equal(config.showTags, true, 'defaults, not the old repo\'s override');
  } finally { rm(repoA); }
});

test('setGitGraphRepoConfig cannot be used to smuggle in rootCommitHashes/trustedExternalConfig directly', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  try {
    await service.setGitGraphRepoConfig(repo, { rootCommitHashes: ['forged'], trustedExternalConfig: true, showTags: false });
    const { config, trusted } = await service.getGitGraphRepoConfig(repo);
    assert.equal(trusted, false);
    assert.notDeepEqual(config.rootCommitHashes, ['forged']);
    assert.equal(config.showTags, false);
  } finally { rm(repo); }
});

test('setGitGraphRepoConfig silently strips avatarsSelfHostedGitLabHost — only setGitGraphAvatarsSelfHostedGitLabHost can set it', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  try {
    await service.setGitGraphRepoConfig(repo, { avatarsSelfHostedGitLabHost: 'attacker.example', showTags: false });
    let { config } = await service.getGitGraphRepoConfig(repo);
    assert.equal(config.avatarsSelfHostedGitLabHost, null, 'the generic patch channel must never set this field');
    assert.equal(config.showTags, false, 'the rest of the patch still applies');

    ({ config } = await service.setGitGraphAvatarsSelfHostedGitLabHost(repo, 'git.internal.example'));
    assert.equal(config.avatarsSelfHostedGitLabHost, 'git.internal.example');

    await assert.rejects(service.setGitGraphAvatarsSelfHostedGitLabHost(repo, 'not a host!'), /not a valid host name/);
  } finally { rm(repo); }
});

test('a repo-committed external config file is never applied until explicitly trusted', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, '.switchboard-git-graph.json'), JSON.stringify({
      issueLinking: { regex: '#(\\d+)', url: 'https://example.com/$1', useGlobally: false },
      customDisplayName: 'From repo file',
    }));

    let { config, trusted } = await service.getGitGraphRepoConfig(repo);
    assert.equal(trusted, false);
    assert.equal(config.issueLinking, null, 'untrusted external config must not be applied');
    assert.equal(config.customDisplayName, null);

    await service.trustGitGraphRepoConfig(repo, true);
    ({ config, trusted } = await service.getGitGraphRepoConfig(repo));
    assert.equal(trusted, true);
    assert.equal(config.customDisplayName, 'From repo file');
    assert.equal(config.issueLinking.regex, '#(\\d+)');

    await service.trustGitGraphRepoConfig(repo, false);
    ({ config, trusted } = await service.getGitGraphRepoConfig(repo));
    assert.equal(trusted, false);
    assert.equal(config.customDisplayName, null, 'revoking trust falls back to defaults/user-set fields again');
  } finally { rm(repo); }
});

test('trust is pinned to the file\'s reviewed content: a later, unreviewed edit reverts the repo to untrusted', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  const configFile = path.join(repo, '.switchboard-git-graph.json');
  try {
    fs.writeFileSync(configFile, JSON.stringify({ customDisplayName: 'Reviewed name' }));
    await service.trustGitGraphRepoConfig(repo, true);
    let { config, trusted } = await service.getGitGraphRepoConfig(repo);
    assert.equal(trusted, true);
    assert.equal(config.customDisplayName, 'Reviewed name');

    // Simulate a further, unreviewed commit changing the trusted file.
    fs.writeFileSync(configFile, JSON.stringify({ customDisplayName: 'Sneaked in later' }));
    ({ config, trusted } = await service.getGitGraphRepoConfig(repo));
    assert.equal(trusted, false, 'content changed since review — trust does not carry over');
    assert.equal(config.customDisplayName, null, 'the new, unreviewed content must never be applied');

    // The repo is left untrusted in storage too, not just in this one reply.
    ({ trusted } = await service.getGitGraphRepoConfig(repo));
    assert.equal(trusted, false);
  } finally { rm(repo); }
});

// --- setGitGraphRepoConfig/setGitGraphGlobalPreferences validate every field ---

test('setGitGraphRepoConfig rejects an unknown field before writing anything', { skip: !haveGit && 'git not installed' }, async () => {
  const { db } = setupService();
  const repo = makeRepo();
  try {
    await assert.rejects(service.setGitGraphRepoConfig(repo, { notARealField: true }), /Unknown Git Graph repository setting.*notARealField/);
    assert.equal(db.rows.has(`gitGraph.repo:${repo}`), false, 'a rejected patch must not touch storage at all');
  } finally { rm(repo); }
});

test('setGitGraphRepoConfig rejects a wrong-typed value for a real field', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  try {
    await assert.rejects(service.setGitGraphRepoConfig(repo, { showTags: 'yes' }), /Invalid value.*showTags/);
    await assert.rejects(service.setGitGraphRepoConfig(repo, { commitsOrder: 'newest-first' }), /Invalid value.*commitsOrder/);
    await assert.rejects(service.setGitGraphRepoConfig(repo, { onLoadShowSpecificBranches: 'main' }), /Invalid value.*onLoadShowSpecificBranches/);
    const { config } = await service.getGitGraphRepoConfig(repo);
    assert.equal(config.showTags, true, 'the rejected patches never partially applied');
  } finally { rm(repo); }
});

test('setGitGraphRepoConfig accepts every documented field shape the view round-trips', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  try {
    const patch = {
      showRemoteBranches: false, showStashes: false, muteMergeCommits: false, onlyFollowFirstParent: true,
      commitsOrder: 'topo', columnWidths: { date: 120, author: 80 }, branchDropdownSelection: ['main', 'feature'],
      perRemoteVisibility: { origin: true, upstream: false }, fetchAvatars: true,
      issueLinking: { regex: '#(\\d+)', url: 'https://example.com/$1', useGlobally: false },
      pullRequestProvider: { kind: 'github', sourceRemote: 'origin', destRemote: 'origin', destBranch: 'main' },
      codeReview: { abc123: { reviewedPaths: ['a.txt'], startedAt: '2024-01-01' } },
    };
    const { config } = await service.setGitGraphRepoConfig(repo, patch);
    assert.equal(config.showRemoteBranches, false);
    assert.equal(config.commitsOrder, 'topo');
    assert.deepEqual(config.columnWidths, { date: 120, author: 80 });
    assert.deepEqual(config.branchDropdownSelection, ['main', 'feature']);
    assert.deepEqual(config.perRemoteVisibility, { origin: true, upstream: false });
    assert.equal(config.issueLinking.regex, '#(\\d+)');
    assert.equal(config.pullRequestProvider.kind, 'github');
    assert.ok(config.codeReview.abc123);
  } finally { rm(repo); }
});

test('setGitGraphGlobalPreferences rejects an unknown top-level field', () => {
  setupService();
  assert.throws(() => service.setGitGraphGlobalPreferences({ notAField: 1 }), /Unknown Git Graph preference.*notAField/);
});

test('setGitGraphGlobalPreferences rejects a wrong-typed value for a real field', () => {
  setupService();
  assert.throws(() => service.setGitGraphGlobalPreferences({ initialLoad: 'lots' }), /Invalid value.*initialLoad/);
  assert.throws(() => service.setGitGraphGlobalPreferences({ dateFormat: 'yyyy-mm-dd' }), /Invalid value.*dateFormat/);
});

test('setGitGraphGlobalPreferences rejects an unknown dialogDefaults sub-key', () => {
  setupService();
  assert.throws(() => service.setGitGraphGlobalPreferences({ dialogDefaults: { notADialog: {} } }), /Unknown Git Graph dialog default.*notADialog/);
  // A known dialog with a nested patch still goes through (matches the
  // existing "merges top-level and one level into dialogDefaults" test).
  service.setGitGraphGlobalPreferences({ dialogDefaults: { pushBranch: { setUpstream: false } } });
  assert.equal(service.getGitGraphGlobalPreferences().preferences.dialogDefaults.pushBranch.setUpstream, false);
});

// --- exportGitGraphRepoConfig ---

test('exportGitGraphRepoConfig writes only the allow-listed fields, atomically, to the repo root', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  try {
    await service.setGitGraphRepoConfig(repo, {
      issueLinking: { regex: '#(\\d+)', url: 'https://example.com/$1', useGlobally: false },
      customDisplayName: 'Shared config',
      showTags: false, // NOT in the export allow-list — must not appear in the written file
    });
    const { path: written } = await service.exportGitGraphRepoConfig(repo);
    assert.equal(written, path.join(repo, '.switchboard-git-graph.json'));
    const onDisk = JSON.parse(fs.readFileSync(written, 'utf8'));
    assert.deepEqual(Object.keys(onDisk).sort(), ['customDisplayName', 'issueLinking', 'pullRequestProvider']);
    assert.equal(onDisk.customDisplayName, 'Shared config');
    assert.equal(onDisk.issueLinking.regex, '#(\\d+)');
    assert.equal(onDisk.showTags, undefined, 'a non-allow-listed field must never be written');

    // No leftover temp file from the atomic write.
    const entries = fs.readdirSync(repo).filter((name) => name.includes('.switchboard-git-graph.json.') && name.endsWith('.tmp'));
    assert.deepEqual(entries, []);
  } finally { rm(repo); }
});

test('a repo exported then re-trusted round-trips through the same allow-list on the way back in', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repoA = makeRepo('switchboard-gg-export-a-');
  const repoB = makeRepo('switchboard-gg-export-b-');
  try {
    await service.setGitGraphRepoConfig(repoA, { customDisplayName: 'Team config', issueLinking: { regex: '#(\\d+)', url: 'https://x/$1', useGlobally: false } });
    const { path: exported } = await service.exportGitGraphRepoConfig(repoA);
    fs.copyFileSync(exported, path.join(repoB, '.switchboard-git-graph.json'));

    let { config, trusted } = await service.getGitGraphRepoConfig(repoB);
    assert.equal(trusted, false, 'a freshly-copied file is not auto-trusted just because it exists');
    assert.equal(config.customDisplayName, null);

    await service.trustGitGraphRepoConfig(repoB, true);
    ({ config, trusted } = await service.getGitGraphRepoConfig(repoB));
    assert.equal(trusted, true);
    assert.equal(config.customDisplayName, 'Team config');
    assert.equal(config.issueLinking.regex, '#(\\d+)');
  } finally { rm(repoA); rm(repoB); }
});

// --- getGitGraphUserDetails ---

test('getGitGraphUserDetails delegates to git.userDetails for the repo', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  try {
    const { ok, details } = await service.getGitGraphUserDetails(repo);
    assert.equal(ok, true);
    assert.deepEqual(details.local, { name: 'Test', email: 'test@example.com' });
  } finally { rm(repo); }
});

// --- getProjectGitGraph: payload assembly + paging ---

test('getProjectGitGraph merges refs by hash, marks HEAD, and reports hasMore at the boundary', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    gitIn(repo, 'add', 'a.txt');
    gitIn(repo, 'commit', '-q', '-m', 'second');
    gitIn(repo, 'tag', '-a', 'v1', '-m', 'release');
    gitIn(repo, 'branch', 'feature');

    const full = await service.getProjectGitGraph(repo, { limit: 10 });
    assert.equal(full.ok, true);
    assert.equal(full.hasMore, false);
    assert.ok(full.refs);
    const [head, root] = full.commits.filter(c => c.kind !== 'uncommitted');
    assert.equal(head.isHead, true);
    assert.ok(head.refs.heads.includes('main'));
    assert.ok(head.refs.tags.includes('v1'));
    assert.ok(head.refs.heads.includes('feature'), 'feature was branched from the current head, not the root');
    assert.equal(root.refs, undefined, 'the root commit has no refs pointing at it');

    const paged = await service.getProjectGitGraph(repo, { limit: 1 });
    assert.equal(paged.hasMore, true);
    assert.equal(paged.commits.length, 1);
  } finally { rm(repo); }
});

test('getProjectGitGraph with showTags:false strips tags from both the ref set and the commits they were attached to', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  try {
    gitIn(repo, 'tag', '-a', 'v1', '-m', 'release');

    const shown = await service.getProjectGitGraph(repo, { limit: 10 });
    assert.deepEqual(shown.refs.tags.map(t => t.name), ['v1']);
    assert.ok(shown.commits[0].refs.tags.includes('v1'));

    const hidden = await service.getProjectGitGraph(repo, { limit: 10, showTags: false });
    assert.deepEqual(hidden.refs.tags, []);
    assert.deepEqual(hidden.commits[0].refs.tags, []);
  } finally { rm(repo); }
});

test('getProjectGitGraph omits refs on an unchanged-filter "Load More" call', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  try {
    for (let i = 0; i < 3; i += 1) {
      fs.writeFileSync(path.join(repo, `f${i}.txt`), String(i));
      gitIn(repo, 'add', `f${i}.txt`);
      gitIn(repo, 'commit', '-q', '-m', `commit ${i}`);
    }
    const page1 = await service.getProjectGitGraph(repo, { limit: 2 });
    assert.ok(page1.refs);
    assert.equal(page1.hasMore, true);

    const page2 = await service.getProjectGitGraph(repo, { limit: 2, skip: 2, refsUnchanged: true });
    assert.equal(page2.refs, null);
    assert.equal(page2.commits.length, 2);
  } finally { rm(repo); }
});

test('getProjectGitGraph reports stashes and uncommitted changes alongside the commit window, without merging them into it', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'README.md'), '# stashed change\n');
    gitIn(repo, 'stash', 'push', '-q', '-m', 'wip');
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'dirty\n');

    const payload = await service.getProjectGitGraph(repo, { limit: 10 });
    assert.equal(payload.stashes.length, 1);
    assert.ok(payload.uncommitted);
    assert.equal(payload.uncommitted.changeCount, 1);
    // The renderer does its own equivalent merge from these two fields plus
    // `commits`; if this endpoint merged them in too, every stash and the
    // working-tree row would render twice.
    assert.ok(!payload.commits.some(c => c.kind === 'uncommitted'));
    assert.ok(!payload.commits.some(c => c.kind === 'stash'));
  } finally { rm(repo); }
});

test('getProjectGitGraph degrades gracefully on an empty repo with an unborn HEAD', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-gg-empty-'));
  gitIn(repo, 'init', '-q', '-b', 'main');
  try {
    const payload = await service.getProjectGitGraph(repo, { limit: 10 });
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.commits.filter(c => !c.kind), []);
    assert.equal(payload.uncommitted, null);
  } finally { rm(repo); }
});

// --- Read endpoints: commit/compare/file-at-revision ---

test('getGitGraphCommitDetail returns parents, body, and a files list', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'README.md'), '# changed\n');
    gitIn(repo, 'commit', '-q', '-am', 'second\n\nBody line');
    const hash = gitIn(repo, 'rev-parse', 'HEAD');
    const { commit, files } = await service.getGitGraphCommitDetail(repo, hash);
    assert.equal(commit.subject, 'second');
    assert.match(commit.body, /Body line/);
    assert.equal(commit.parents.length, 1);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'README.md');
    assert.equal(files[0].status, 'modified');
  } finally { rm(repo); }
});

test('getGitGraphCommitDetail rejects a malformed hash before running anything', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  try {
    await assert.rejects(service.getGitGraphCommitDetail(repo, '-not-a-hash'), /not a valid|must not start/);
    await assert.rejects(service.getGitGraphCommitDetail(repo, 'zz'), /not a valid/);
  } finally { rm(repo); }
});

test('getGitGraphFileDiffBetween reads a blob from a revision and from the working tree', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  try {
    const firstHash = gitIn(repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'README.md'), '# working tree version\n');
    const result = await service.getGitGraphFileDiffBetween(repo, firstHash, null, 'README.md');
    assert.match(result.oldContent, /# hello/);
    assert.match(result.newContent, /working tree version/);
  } finally { rm(repo); }
});

test('getGitGraphCompareDetail against the working tree includes untracked files, not just tracked changes', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  try {
    const headHash = gitIn(repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'README.md'), '# changed\n'); // tracked, unstaged change
    fs.writeFileSync(path.join(repo, 'new-file.txt'), 'line one\nline two\n'); // untracked

    const { files } = await service.getGitGraphCompareDetail(repo, headHash, null);
    const untracked = files.find(f => f.path === 'new-file.txt');
    assert.ok(untracked, 'an untracked file must still appear in the Uncommitted Changes file list');
    assert.equal(untracked.status, 'untracked');
    assert.equal(untracked.insertions, 2);
    assert.ok(files.some(f => f.path === 'README.md'), 'the tracked change is still reported alongside it');
  } finally { rm(repo); }
});

test('getGitGraphFileAtRevision refuses a path that escapes the repository', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  try {
    const hash = gitIn(repo, 'rev-parse', 'HEAD');
    await assert.rejects(service.getGitGraphFileAtRevision(repo, hash, '../outside.txt'), /outside the repository/);
  } finally { rm(repo); }
});

test('getGitGraphRemotes and getGitGraphTagDetails read real repo state', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  const remoteRepo = makeRepo('switchboard-gg-remote-');
  try {
    gitIn(repo, 'remote', 'add', 'origin', remoteRepo);
    const { remotes } = await service.getGitGraphRemotes(repo);
    assert.equal(remotes.length, 1);
    assert.equal(remotes[0].name, 'origin');

    gitIn(repo, 'tag', '-a', 'v1', '-m', 'first release');
    const { tag } = await service.getGitGraphTagDetails(repo, 'v1');
    assert.equal(tag.name, 'v1');
    assert.match(tag.message, /first release/);
    assert.ok(tag.commitHash);
  } finally { rm(remoteRepo); rm(repo); }
});

// --- Mutating action dispatcher: whitelist lookup, concurrency, timeout, cancel ---

test('runGitGraphAction rejects an unrecognized actionId before running anything', async () => {
  setupService({ gitActions: { ACTIONS: {} } });
  const result = await service.runGitGraphAction('/tmp/whatever', 'notARealAction', {});
  assert.match(result.error, /Unknown git graph action/);
});

test('runGitGraphAction serializes mutating actions per repo', async () => {
  let started = 0;
  setupService({
    gitActions: {
      ACTIONS: {
        slowNoop: {
          run: async (repoPath, params, { signal }) => {
            started += 1;
            await new Promise((resolve, reject) => {
              const t = setTimeout(resolve, 40);
              signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
            });
            return { didSomething: true };
          },
        },
      },
    },
  });
  const first = service.runGitGraphAction('/repo/a', 'slowNoop', {});
  const second = await service.runGitGraphAction('/repo/a', 'slowNoop', {});
  assert.match(second.error, /already running/);
  const firstResult = await first;
  assert.equal(firstResult.ok, true);
  assert.equal(started, 1, 'the second call never actually ran the action');
});

test('runGitGraphAction times out a hung action and kills it via the abort signal', async () => {
  setupService({
    actionTimeoutMs: 30,
    gitActions: {
      ACTIONS: {
        hangs: {
          run: (repoPath, params, { signal }) => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('killed')));
          }),
        },
      },
    },
  });
  const result = await service.runGitGraphAction('/repo/b', 'hangs', {});
  assert.match(result.error, /timed out/);
});

test('cancelGitGraphAction cancels an in-flight action', async () => {
  setupService();
  const service2 = service; // same singleton; re-init with a cancellable action
  service2.init({
    db: makeFakeDb(),
    log: { info() {}, error() {} },
    git: realGit,
    actionTimeoutMs: 5000,
    gitActions: {
      ACTIONS: {
        cancellable: {
          run: (repoPath, params, { signal }) => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('killed')));
          }),
        },
      },
    },
  });
  const pending = service.runGitGraphAction('/repo/c', 'cancellable', {});
  await new Promise(resolve => setTimeout(resolve, 10));
  const cancelResult = service.cancelGitGraphAction('/repo/c', 'cancellable');
  assert.equal(cancelResult.cancelled, true);
  const result = await pending;
  assert.match(result.error, /cancelled/);
});

test('cancelGitGraphAction is a no-op when nothing is running for that repo', () => {
  setupService();
  const result = service.cancelGitGraphAction('/repo/nothing-running', 'whatever');
  assert.equal(result.cancelled, false);
});

test('an action progress callback is forwarded as a git-graph-action-progress event', async () => {
  const { events } = setupService({
    gitActions: {
      ACTIONS: {
        withProgress: {
          run: async (repoPath, params, { onProgress }) => { onProgress('halfway'); return { ok: true }; },
        },
      },
    },
  });
  await service.runGitGraphAction('/repo/d', 'withProgress', {});
  const progressEvents = events.filter(e => e.channel === 'git-graph-action-progress');
  assert.equal(progressEvents.length, 1);
  assert.equal(progressEvents[0].args[0].text, 'halfway');
  assert.equal(progressEvents[0].args[0].actionId, 'withProgress');
});

test('runGitGraphAction reports "unavailable" cleanly when git-actions.js has not landed yet', async () => {
  service.init({ db: makeFakeDb(), log: { info() {}, error() {} }, git: realGit, gitActions: null });
  // Force the real (lazy) require path, which will fail until git-actions.js exists.
  const result = await service.runGitGraphAction('/repo/e', 'anything', {});
  assert.ok(result.error);
});

// --- Repo-change watcher ---

test('ensureRepoWatch fires git-graph-repo-changed after HEAD moves, debounced', { skip: !haveGit && 'git not installed' }, async () => {
  const { events } = setupService({ repoWatchPollMs: 20, repoWatchDebounceMs: 15 });
  const repo = makeRepo();
  try {
    await service.ensureRepoWatch(repo);
    await new Promise(resolve => setTimeout(resolve, 60)); // let the baseline fingerprint settle
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    gitIn(repo, 'add', 'b.txt');
    gitIn(repo, 'commit', '-q', '-m', 'moves HEAD');
    await new Promise(resolve => setTimeout(resolve, 150));
    const changed = events.filter(e => e.channel === 'git-graph-repo-changed' && e.args[0] === repo);
    assert.ok(changed.length >= 1, 'expected at least one repo-changed event');
  } finally {
    service.stopRepoWatch(repo);
    rm(repo);
  }
});

test('stopRepoWatch/stopAllRepoWatches actually stop polling (no more events after stop)', { skip: !haveGit && 'git not installed' }, async () => {
  const { events } = setupService({ repoWatchPollMs: 15, repoWatchDebounceMs: 10 });
  const repo = makeRepo();
  try {
    await service.ensureRepoWatch(repo);
    await new Promise(resolve => setTimeout(resolve, 40));
    service.stopRepoWatch(repo);
    const before = events.length;
    fs.writeFileSync(path.join(repo, 'c.txt'), 'c\n');
    gitIn(repo, 'add', 'c.txt');
    gitIn(repo, 'commit', '-q', '-m', 'after stop');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(events.length, before, 'no new events after the watch was stopped');
  } finally { rm(repo); }
});

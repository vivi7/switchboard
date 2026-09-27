const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const { spawnSync } = require('child_process');
const git = require('../git');
const actions = require('../git-actions');

const haveGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

function run(actionId, dir, params, ctx) {
  return actions.ACTIONS[actionId].run(dir, params || {}, ctx || {});
}

// Same makeRepo() shape as test/git.test.js: a throwaway repo with one
// commit and a locally-scoped identity, independent of whatever global git
// config happens to be set in the environment running the test.
async function makeRepo(prefix = 'switchboard-gitactions-') {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  await git.run(['init', '-q', '-b', 'main'], repo);
  await git.run(['config', 'user.email', 'test@example.com'], repo);
  await git.run(['config', 'user.name', 'Test'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# hello\n');
  await git.run(['add', 'README.md'], repo);
  await git.run(['commit', '-q', '-m', 'init'], repo);
  return repo;
}

/** A temp bare repo registered as "origin", with `main` already pushed — the fixture every
 * network-action test (fetch/push/pull/delete-remote-branch/push-tag) is run against. */
async function addBareOrigin(repo) {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-gitactions-origin-'));
  fs.rmSync(bare, { recursive: true, force: true });
  await git.run(['init', '-q', '--bare', '-b', 'main', bare], repo);
  await git.run(['remote', 'add', 'origin', bare], repo);
  await git.run(['push', '-q', 'origin', 'main'], repo);
  return bare;
}

function rmrf(...dirs) {
  for (const dir of dirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ } }
}

// --- assertSafePositionalArg / qualifyRef — pure, no git needed ----------

test('assertSafePositionalArg rejects empty, NUL, and leading-dash values for every kind', () => {
  for (const kind of [undefined, 'hash', 'remote', 'stash-ref', 'branch', 'tag']) {
    assert.throws(() => actions.assertSafePositionalArg('', kind), /value is required/);
    assert.throws(() => actions.assertSafePositionalArg('foo\0bar', kind), /NUL byte/);
    assert.throws(() => actions.assertSafePositionalArg('-foo', kind), /must not start with/);
  }
});

test('assertSafePositionalArg applies a shape check on top of the baseline, per kind', () => {
  assert.equal(actions.assertSafePositionalArg('a1b2c3d4', 'hash'), 'a1b2c3d4');
  assert.throws(() => actions.assertSafePositionalArg('not-a-hash!', 'hash'), /not a valid commit hash/);
  assert.throws(() => actions.assertSafePositionalArg('zzzz', 'hash'), /not a valid commit hash/);

  assert.equal(actions.assertSafePositionalArg('origin', 'remote'), 'origin');
  assert.throws(() => actions.assertSafePositionalArg('origin; rm -rf /', 'remote'), /not a valid remote name/);

  assert.equal(actions.assertSafePositionalArg('stash@{0}', 'stash-ref'), 'stash@{0}');
  assert.throws(() => actions.assertSafePositionalArg('stash@{x}', 'stash-ref'), /not a valid stash reference/);

  assert.throws(() => actions.assertSafePositionalArg('a/../b', 'branch'), /not a valid reference name/);
  assert.throws(() => actions.assertSafePositionalArg('a.lock', 'branch'), /not a valid reference name/);
  // Real branch names with shell metacharacters are shape-valid — safety
  // comes from execFile's argv-array form, not character rejection here.
  assert.equal(actions.assertSafePositionalArg('foo$(id)', 'branch'), 'foo$(id)');
});

test('fullyQualify* prefix names into their unambiguous ref form', () => {
  assert.equal(actions.fullyQualifyBranch('main'), 'refs/heads/main');
  assert.equal(actions.fullyQualifyTag('v1'), 'refs/tags/v1');
  assert.equal(actions.fullyQualifyRemoteBranch('origin', 'main'), 'refs/remotes/origin/main');
});

test('qualifyRef resolves {ref, refType, remote} for merge/rebase/archive-style targets', () => {
  assert.equal(actions.qualifyRef({ ref: 'abc123', refType: 'hash' }), 'abc123');
  assert.equal(actions.qualifyRef({ ref: 'main', refType: 'branch' }), 'refs/heads/main');
  assert.equal(actions.qualifyRef({ ref: 'v1', refType: 'tag' }), 'refs/tags/v1');
  assert.equal(actions.qualifyRef({ ref: 'main', refType: 'remote-branch', remote: 'origin' }), 'refs/remotes/origin/main');
  assert.throws(() => actions.qualifyRef({ ref: 'x', refType: 'nonsense' }), /Unknown refType/);
});

// --- Validator rejections never spawn a process ---------------------------
// Each of these is a pure shape violation (no git call could tell it apart
// from a well-formed value any faster than the regex already does), so the
// exec layer must never be touched. cp.execFile/cp.spawn are property
// lookups in git-actions.js (not destructured), so stubbing them here does
// intercept every call this module makes.

function stubExecLayer() {
  const originalExecFile = cp.execFile;
  const originalSpawn = cp.spawn;
  const calls = [];
  cp.execFile = (...callArgs) => { calls.push('execFile'); throw new Error('execFile must not be called'); };
  cp.spawn = (...callArgs) => { calls.push('spawn'); throw new Error('spawn must not be called'); };
  return { calls, restore: () => { cp.execFile = originalExecFile; cp.spawn = originalSpawn; } };
}

/** Delays the *delivery* of the result of the first bare `rev-parse HEAD` call by delayMs (the
 * real command still runs immediately, so it still captures the old HEAD value) — opening a
 * deterministic window for a real, concurrent write to land between dropCommit's tip-case HEAD
 * check and its own, un-delayed re-check immediately before resetting. */
function stubDelayFirstRevParseHead(delayMs) {
  const original = cp.execFile;
  let delayed = false;
  cp.execFile = (...callArgs) => {
    const args = callArgs[1];
    if (!delayed && Array.isArray(args) && args[0] === 'rev-parse' && args[1] === 'HEAD') {
      delayed = true;
      const realCallback = callArgs[callArgs.length - 1];
      const patchedArgs = callArgs.slice(0, -1).concat((err, stdout, stderr) => {
        setTimeout(() => realCallback(err, stdout, stderr), delayMs);
      });
      return original(...patchedArgs);
    }
    return original(...callArgs);
  };
  return () => { cp.execFile = original; };
}

test('a malformed input is rejected before any git process is spawned', async () => {
  const stub = stubExecLayer();
  try {
    await assert.rejects(run('createBranch', '/tmp', { name: '', commit: 'deadbeef' }));
    await assert.rejects(run('createBranch', '/tmp', { name: 'a\0b', commit: 'deadbeef' }));
    await assert.rejects(run('createBranch', '/tmp', { name: '-force', commit: 'deadbeef' }));
    await assert.rejects(run('checkoutCommit', '/tmp', { commit: 'not-a-hash' }), /not a valid commit hash/);
    await assert.rejects(run('addRemote', '/tmp', { name: 'origin; rm -rf /', url: 'https://example.com/x.git' }), /not a valid remote name/);
    await assert.rejects(run('resetFileToRevision', '/tmp', { commit: 'a1b2c3d4', relPath: '../../etc/passwd' }), /outside the repository/);
    assert.equal(stub.calls.length, 0, 'no execFile/spawn call for any of the above');
  } finally {
    stub.restore();
  }
});

// --- Real end-to-end tests against temp repos -----------------------------

test('addTag creates an annotated and a lightweight tag, and can push both', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  const bare = await addBareOrigin(repo);
  try {
    const head = await git.run(['rev-parse', 'HEAD'], repo);
    await run('addTag', repo, { name: 'v1', type: 'annotated', message: 'release', commit: head, pushToRemotes: ['origin'] });
    await run('addTag', repo, { name: 'v1-lw', type: 'lightweight', commit: head });

    assert.equal(await git.tagExists(repo, 'v1'), true);
    assert.equal(await git.tagExists(repo, 'v1-lw'), true);
    const remoteTags = await git.run(['ls-remote', '--tags', bare], repo);
    assert.match(remoteTags, /refs\/tags\/v1/);

    await assert.rejects(run('addTag', repo, { name: 'v1', type: 'lightweight', commit: head }), /already exists/);
    await assert.rejects(run('addTag', repo, { name: 'v2', type: 'annotated', message: '', commit: head }), /requires a message/);
  } finally {
    rmrf(repo, bare);
  }
});

test('createBranch creates at a commit, optionally checking it out, and rejects a collision', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    const head = await git.run(['rev-parse', 'HEAD'], repo);
    await run('createBranch', repo, { name: 'feature', commit: head, checkOut: false });
    assert.equal(await git.branchExists(repo, 'feature'), true);
    assert.equal((await git.status(repo)).branch, 'main');

    await run('createBranch', repo, { name: 'feature2', commit: head, checkOut: true });
    assert.equal((await git.status(repo)).branch, 'feature2');

    await assert.rejects(run('createBranch', repo, { name: 'feature', commit: head }), /already exists/);
  } finally {
    rmrf(repo);
  }
});

test('checkoutCommit detaches HEAD at the given commit', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    const head = await git.run(['rev-parse', 'HEAD'], repo);
    await run('checkoutCommit', repo, { commit: head });
    assert.equal((await git.status(repo)).branch, 'HEAD', 'rev-parse --abbrev-ref HEAD reports the literal string "HEAD" when detached');
  } finally {
    rmrf(repo);
  }
});

test('checkoutBranchImmediate checks out an existing local branch with no confirmation step', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    await git.run(['branch', 'feature'], repo);
    await run('checkoutBranchImmediate', repo, { name: 'feature' });
    assert.equal((await git.status(repo)).branch, 'feature');
    await assert.rejects(run('checkoutBranchImmediate', repo, { name: 'does-not-exist' }), /does not exist/);
  } finally {
    rmrf(repo);
  }
});

test('checkoutRemoteBranch creates a new local branch, or fast-forwards a colliding one', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  const bare = await addBareOrigin(repo);
  try {
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-gitactions-clone-'));
    fs.rmSync(clone, { recursive: true, force: true });
    await git.run(['clone', '-q', bare, clone], repo);
    await git.run(['config', 'user.email', 'test@example.com'], clone);
    await git.run(['config', 'user.name', 'Test'], clone);

    const result = await run('checkoutRemoteBranch', clone, { remote: 'origin', shortName: 'main', name: 'main-local' });
    assert.equal(result.collision, false);
    assert.equal((await git.status(clone)).branch, 'main-local');

    // Now push a new commit to origin and prove the collision path fast-forwards it.
    fs.writeFileSync(path.join(repo, 'more.txt'), 'more\n');
    await git.run(['add', 'more.txt'], repo);
    await git.run(['commit', '-q', '-m', 'more'], repo);
    await git.run(['push', '-q', 'origin', 'main'], repo);
    await git.run(['fetch', '-q', 'origin'], clone);

    // The clone's original checkout (before we switched to main-local above)
    // left a local 'main' branch behind, now behind origin/main — exactly
    // the name-collision case.
    const collisionResult = await run('checkoutRemoteBranch', clone, { remote: 'origin', shortName: 'main' });
    assert.equal(collisionResult.collision, true);
    assert.ok(fs.existsSync(path.join(clone, 'more.txt')), 'fast-forwarded to the remote\'s new commit');

    rmrf(clone);
  } finally {
    rmrf(repo, bare);
  }
});

test('renameBranch renames and rejects a collision or a missing source', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    await git.run(['branch', 'old-name'], repo);
    await run('renameBranch', repo, { oldName: 'old-name', newName: 'new-name' });
    assert.equal(await git.branchExists(repo, 'old-name'), false);
    assert.equal(await git.branchExists(repo, 'new-name'), true);

    await assert.rejects(run('renameBranch', repo, { oldName: 'nope', newName: 'x' }), /does not exist/);
    await git.run(['branch', 'another'], repo);
    await assert.rejects(run('renameBranch', repo, { oldName: 'another', newName: 'new-name' }), /already exists/);
  } finally {
    rmrf(repo);
  }
});

test('deleteBranch refuses the current branch, retries with force on a not-fully-merged branch, and can delete on a remote', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  const bare = await addBareOrigin(repo);
  try {
    await assert.rejects(run('deleteBranch', repo, { name: 'main' }), /current branch/);

    await git.run(['checkout', '-q', '-b', 'unmerged'], repo);
    fs.writeFileSync(path.join(repo, 'unmerged.txt'), 'x\n');
    await git.run(['add', 'unmerged.txt'], repo);
    await git.run(['commit', '-q', '-m', 'unmerged work'], repo);
    await git.run(['checkout', '-q', 'main'], repo);

    // Not pushed anywhere yet, so `-d` sees a branch not merged into HEAD
    // *or* any upstream — a genuine not-fully-merged failure.
    let err = null;
    try { await run('deleteBranch', repo, { name: 'unmerged' }); } catch (e) { err = e; }
    assert.ok(err && err.notFullyMerged, 'a plain -d failure is tagged notFullyMerged for the UI\'s one-click retry');

    await git.run(['push', '-q', 'origin', 'unmerged'], repo);
    await run('deleteBranch', repo, { name: 'unmerged', forceDelete: true, deleteOnRemotes: ['origin'] });
    assert.equal(await git.branchExists(repo, 'unmerged'), false);
    const remoteRefs = await git.run(['ls-remote', '--heads', bare], repo);
    assert.doesNotMatch(remoteRefs, /refs\/heads\/unmerged/);
  } finally {
    rmrf(repo, bare);
  }
});

test('deleteBranch\'s remote delete is unambiguous even when the remote also has a tag with the same name', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  const bare = await addBareOrigin(repo);
  try {
    await git.run(['checkout', '-q', '-b', 'release-1.0'], repo);
    fs.writeFileSync(path.join(repo, 'rel.txt'), 'x\n');
    await git.run(['add', 'rel.txt'], repo);
    await git.run(['commit', '-q', '-m', 'release work'], repo);
    await git.run(['push', '-q', 'origin', 'release-1.0'], repo);
    await git.run(['tag', 'release-1.0'], repo); // same name as the branch, on purpose
    await git.run(['push', '-q', 'origin', 'refs/tags/release-1.0'], repo);
    await git.run(['checkout', '-q', 'main'], repo);

    await run('deleteBranch', repo, { name: 'release-1.0', forceDelete: true, deleteOnRemotes: ['origin'] });
    const remoteRefs = await git.run(['ls-remote', bare], repo);
    assert.doesNotMatch(remoteRefs, /refs\/heads\/release-1\.0/);
    assert.match(remoteRefs, /refs\/tags\/release-1\.0/, 'the same-named tag must survive');
  } finally {
    rmrf(repo, bare);
  }
});

test('deleteRemoteBranch deletes a live remote branch, and falls back to cleaning up a stale tracking ref', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  const bare = await addBareOrigin(repo);
  try {
    await git.run(['checkout', '-q', '-b', 'topic'], repo);
    await git.run(['push', '-q', '-u', 'origin', 'topic'], repo);

    const live = await run('deleteRemoteBranch', repo, { remote: 'origin', shortName: 'topic' });
    assert.equal(live.staleTrackingRefRemoved, false);
    const remoteRefs = await git.run(['ls-remote', '--heads', bare], repo);
    assert.doesNotMatch(remoteRefs, /refs\/heads\/topic/);

    // A modern git prunes refs/remotes/origin/topic locally as a side effect
    // of *this* repo's own successful push --delete, so the only way to get
    // a genuinely stale tracking ref is to have the branch disappear from
    // the remote through some other path — delete it directly on the bare
    // repo itself, bypassing this repo's push entirely.
    await git.run(['checkout', '-q', '-b', 'topic2'], repo);
    await git.run(['push', '-q', '-u', 'origin', 'topic2'], repo);
    await git.run(['branch', '-D', 'topic2'], bare);
    await git.run(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/topic2'], repo); // still present, stale

    const stale = await run('deleteRemoteBranch', repo, { remote: 'origin', shortName: 'topic2' });
    assert.equal(stale.staleTrackingRefRemoved, true);
    await assert.rejects(git.run(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/topic2'], repo));
  } finally {
    rmrf(repo, bare);
  }
});

test('cherryPick applies a commit onto the current branch, requiring -m only for a merge commit', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    await git.run(['checkout', '-q', '-b', 'topic'], repo);
    fs.writeFileSync(path.join(repo, 'topic.txt'), 'x\n');
    await git.run(['add', 'topic.txt'], repo);
    await git.run(['commit', '-q', '-m', 'topic work'], repo);
    const topicCommit = await git.run(['rev-parse', 'HEAD'], repo);
    await git.run(['checkout', '-q', 'main'], repo);

    await run('cherryPick', repo, { commit: topicCommit });
    assert.ok(fs.existsSync(path.join(repo, 'topic.txt')));
    const log = await git.run(['log', '-1', '--pretty=%s'], repo);
    assert.equal(log, 'topic work');

    await git.run(['checkout', '-q', '-b', 'other'], repo);
    fs.writeFileSync(path.join(repo, 'other.txt'), 'y\n');
    await git.run(['add', 'other.txt'], repo);
    await git.run(['commit', '-q', '-m', 'other work'], repo);
    await git.run(['checkout', '-q', 'main'], repo);
    await git.run(['branch', 'target'], repo); // a snapshot of main *before* the merge below
    await git.run(['merge', '--no-ff', '-q', '-m', 'merge other', 'other'], repo);
    const mergeCommit = await git.run(['rev-parse', 'HEAD'], repo);

    // Cherry-picking onto main itself would be a no-op (main already *is*
    // the merge commit) — cherry-pick it onto a branch that doesn't have
    // other.txt yet, where it actually has something to apply.
    await git.run(['checkout', '-q', 'target'], repo);
    await assert.rejects(run('cherryPick', repo, { commit: mergeCommit }), /pick which parent/);
    await run('cherryPick', repo, { commit: mergeCommit, parent: 1 });
    assert.ok(fs.existsSync(path.join(repo, 'other.txt')));
  } finally {
    rmrf(repo);
  }
});

test('revert creates a revert commit, requiring -m only for a merge commit', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'README.md'), '# changed\n');
    await git.run(['commit', '-aq', '-m', 'change'], repo);
    const changeCommit = await git.run(['rev-parse', 'HEAD'], repo);

    await run('revert', repo, { commit: changeCommit });
    assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), '# hello\n');
    assert.match(await git.run(['log', '-1', '--pretty=%s'], repo), /Revert/);
  } finally {
    rmrf(repo);
  }
});

test('dropCommit resets the tip to its parent, verifying HEAD has not moved first', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    const first = await git.run(['rev-parse', 'HEAD'], repo);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    await git.run(['add', 'b.txt'], repo);
    await git.run(['commit', '-q', '-m', 'second'], repo);
    const second = await git.run(['rev-parse', 'HEAD'], repo);

    const result = await run('dropCommit', repo, { commit: second });
    assert.equal(result.mode, 'tip');
    assert.equal(await git.run(['rev-parse', 'HEAD'], repo), first);
  } finally {
    rmrf(repo);
  }
});

test('dropCommit\'s tip case re-verifies HEAD immediately before resetting, catching a real race', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    const second = await (async () => {
      fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
      await git.run(['add', 'b.txt'], repo);
      await git.run(['commit', '-q', '-m', 'second'], repo);
      return git.run(['rev-parse', 'HEAD'], repo);
    })();

    const unstub = stubDelayFirstRevParseHead(300);
    let dropPromise;
    try {
      // "second" was HEAD when the menu was opened; delaying dropCommit's
      // first internal HEAD check gives this test a real window to land a
      // concurrent commit before dropCommit's own, un-delayed re-check runs.
      dropPromise = run('dropCommit', repo, { commit: second });
      await new Promise(resolve => setTimeout(resolve, 60));
      fs.writeFileSync(path.join(repo, 'c.txt'), 'c\n');
      await git.run(['add', 'c.txt'], repo);
      await git.run(['commit', '-q', '-m', 'concurrent'], repo);
      await assert.rejects(dropPromise, /repository has changed/);
    } finally {
      unstub();
      await dropPromise.catch(() => {});
    }
    assert.equal(await git.run(['log', '-1', '--pretty=%s'], repo), 'concurrent', 'nothing was reset — the concurrent commit is still HEAD');
  } finally {
    rmrf(repo);
  }
});

test('dropCommit rebases away a mid-history commit with exactly one non-merge child', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    await git.run(['add', 'b.txt'], repo);
    await git.run(['commit', '-q', '-m', 'to-drop'], repo);
    const toDrop = await git.run(['rev-parse', 'HEAD'], repo);
    fs.writeFileSync(path.join(repo, 'c.txt'), 'c\n');
    await git.run(['add', 'c.txt'], repo);
    await git.run(['commit', '-q', '-m', 'keep-me'], repo);

    const result = await run('dropCommit', repo, { commit: toDrop });
    assert.equal(result.mode, 'rebase');
    const subjects = (await git.run(['log', '--pretty=%s'], repo)).split('\n');
    assert.deepEqual(subjects, ['keep-me', 'init']);
  } finally {
    rmrf(repo);
  }
});

test('dropCommit refuses a commit with more than one child or a merge child', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    const base = await git.run(['rev-parse', 'HEAD'], repo);
    await git.run(['checkout', '-q', '-b', 'a'], repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    await git.run(['add', 'a.txt'], repo);
    await git.run(['commit', '-q', '-m', 'a work'], repo);
    await git.run(['checkout', '-q', 'main'], repo);
    fs.writeFileSync(path.join(repo, 'main2.txt'), 'm\n');
    await git.run(['add', 'main2.txt'], repo);
    await git.run(['commit', '-q', '-m', 'main2'], repo);

    await assert.rejects(run('dropCommit', repo, { commit: base }), /exactly one non-merge child/);
  } finally {
    rmrf(repo);
  }
});

test('dropCommit refuses a root commit even with exactly one non-merge child', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    const root = await git.run(['rev-parse', 'HEAD'], repo);
    fs.writeFileSync(path.join(repo, 'second.txt'), 'x\n');
    await git.run(['add', 'second.txt'], repo);
    await git.run(['commit', '-q', '-m', 'second'], repo); // root's only child, non-merge

    await assert.rejects(run('dropCommit', repo, { commit: root }), /root commit cannot be dropped/);
  } finally {
    rmrf(repo);
  }
});

test('dropCommit\'s rebase case refuses a commit that is not an ancestor of the current branch, never touching it', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    const root = await git.run(['rev-parse', 'HEAD'], repo);

    // 'sidebranch': root -> s1, checked out.
    await git.run(['checkout', '-q', '-b', 'sidebranch'], repo);
    fs.writeFileSync(path.join(repo, 's1.txt'), 's1\n');
    await git.run(['add', 's1.txt'], repo);
    await git.run(['commit', '-q', '-m', 's1'], repo);
    const sidebranchTip = await git.run(['rev-parse', 'HEAD'], repo);

    // 'main': root -> p -> a -> f1 (unrelated to sidebranch); 'a' is the only
    // eligible-by-child-count commit but is nowhere in sidebranch's history.
    await git.run(['checkout', '-q', 'main'], repo);
    fs.writeFileSync(path.join(repo, 'p.txt'), 'p\n');
    await git.run(['add', 'p.txt'], repo);
    await git.run(['commit', '-q', '-m', 'p'], repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    await git.run(['add', 'a.txt'], repo);
    await git.run(['commit', '-q', '-m', 'a'], repo);
    const commitA = await git.run(['rev-parse', 'HEAD'], repo);
    await git.run(['checkout', '-q', '-b', 'feature'], repo);
    fs.writeFileSync(path.join(repo, 'f1.txt'), 'f1\n');
    await git.run(['add', 'f1.txt'], repo);
    await git.run(['commit', '-q', '-m', 'f1'], repo); // commitA's only child anywhere

    await git.run(['checkout', '-q', 'sidebranch'], repo);
    await assert.rejects(run('dropCommit', repo, { commit: commitA }), /not on the current branch/);
    assert.equal(await git.run(['rev-parse', 'HEAD'], repo), sidebranchTip, 'sidebranch must be untouched');
    assert.equal(fs.existsSync(path.join(repo, '.git', 'rebase-merge')), false);
    assert.equal(fs.existsSync(path.join(repo, '.git', 'rebase-apply')), false);
  } finally {
    rmrf(repo);
  }
});

test('merge fast-forwards, or creates a merge commit with --no-ff, by ref type', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    await git.run(['checkout', '-q', '-b', 'ff-branch'], repo);
    fs.writeFileSync(path.join(repo, 'ff.txt'), 'x\n');
    await git.run(['add', 'ff.txt'], repo);
    await git.run(['commit', '-q', '-m', 'ff work'], repo);
    await git.run(['checkout', '-q', 'main'], repo);
    await run('merge', repo, { ref: 'ff-branch', refType: 'branch' });
    assert.ok(fs.existsSync(path.join(repo, 'ff.txt')));

    await git.run(['checkout', '-q', '-b', 'noff-branch'], repo);
    fs.writeFileSync(path.join(repo, 'noff.txt'), 'y\n');
    await git.run(['add', 'noff.txt'], repo);
    await git.run(['commit', '-q', '-m', 'noff work'], repo);
    await git.run(['checkout', '-q', 'main'], repo);
    await run('merge', repo, { ref: 'noff-branch', refType: 'branch', noFastForward: true });
    const parents = (await git.run(['rev-parse', 'HEAD^@'], repo)).split('\n').filter(Boolean);
    assert.equal(parents.length, 2, 'a --no-ff merge always creates a merge commit');
  } finally {
    rmrf(repo);
  }
});

test('merge drops --no-ff when squash is also requested, since git rejects that combination outright', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    await git.run(['checkout', '-q', '-b', 'squash-branch'], repo);
    fs.writeFileSync(path.join(repo, 'squash.txt'), 'x\n');
    await git.run(['add', 'squash.txt'], repo);
    await git.run(['commit', '-q', '-m', 'squash work'], repo);
    await git.run(['checkout', '-q', 'main'], repo);

    // Both dialog checkboxes checked at once — the Merge dialog's own noFastForward
    // default is true, so this is the combination a user hits just by also
    // checking Squash Commits and never touching the (pre-checked) no-ff box.
    await run('merge', repo, { ref: 'squash-branch', refType: 'branch', noFastForward: true, squash: true });
    const parents = (await git.run(['rev-parse', 'HEAD^@'], repo)).split('\n').filter(Boolean);
    assert.equal(parents.length, 1, 'squash never creates a merge commit');
    assert.ok(fs.existsSync(path.join(repo, 'squash.txt')));
  } finally {
    rmrf(repo);
  }
});

test('rebase replays the current branch onto an upstream', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    await git.run(['checkout', '-q', '-b', 'topic'], repo);
    fs.writeFileSync(path.join(repo, 'topic.txt'), 'x\n');
    await git.run(['add', 'topic.txt'], repo);
    await git.run(['commit', '-q', '-m', 'topic work'], repo);
    await git.run(['checkout', '-q', 'main'], repo);
    fs.writeFileSync(path.join(repo, 'main2.txt'), 'y\n');
    await git.run(['add', 'main2.txt'], repo);
    await git.run(['commit', '-q', '-m', 'main2'], repo);
    await git.run(['checkout', '-q', 'topic'], repo);

    await run('rebase', repo, { upstream: 'main', refType: 'branch' });
    const parents = (await git.run(['rev-parse', 'HEAD^@'], repo)).split('\n').filter(Boolean);
    assert.equal(parents.length, 1);
    assert.equal(await git.run(['log', '-1', '--pretty=%s', 'HEAD~1'], repo), 'main2');
  } finally {
    rmrf(repo);
  }
});

test('rebaseInteractive never spawns a process or writes to a terminal — only a display string', { skip: !haveGit && 'git not installed' }, async () => {
  const stub = stubExecLayer();
  try {
    const result = await run('rebaseInteractive', '/some/repo', { upstream: 'main', refType: 'branch' });
    assert.equal(result.command, 'git rebase -i refs/heads/main');
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('resetToCommit supports soft/mixed/hard and rejects an invalid mode', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    const first = await git.run(['rev-parse', 'HEAD'], repo);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    await git.run(['add', 'b.txt'], repo);
    await git.run(['commit', '-q', '-m', 'second'], repo);

    await run('resetToCommit', repo, { commit: first, mode: 'soft' });
    assert.equal(await git.run(['rev-parse', 'HEAD'], repo), first);
    assert.ok((await git.run(['diff', '--cached', '--name-only'], repo)).includes('b.txt'), 'soft reset keeps the change staged');

    await assert.rejects(run('resetToCommit', repo, { commit: first, mode: 'nonsense' }), /Invalid reset mode/);
  } finally {
    rmrf(repo);
  }
});

test('resetUncommitted discards working-tree changes with --hard', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'README.md'), '# dirty\n');
    await run('resetUncommitted', repo, { mode: 'hard' });
    assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), '# hello\n');
  } finally {
    rmrf(repo);
  }
});

test('cleanUntracked removes untracked files, and directories only when asked', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'loose.txt'), 'x\n');
    fs.mkdirSync(path.join(repo, 'loose-dir'));
    fs.writeFileSync(path.join(repo, 'loose-dir', 'inner.txt'), 'y\n');

    await run('cleanUntracked', repo, { removeDirectories: false });
    assert.ok(!fs.existsSync(path.join(repo, 'loose.txt')));
    assert.ok(fs.existsSync(path.join(repo, 'loose-dir')), 'directories are kept without -d');

    await run('cleanUntracked', repo, { removeDirectories: true });
    assert.ok(!fs.existsSync(path.join(repo, 'loose-dir')));
  } finally {
    rmrf(repo);
  }
});

test('stashPush/Apply/Pop/Drop round-trip a working-tree change', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'README.md'), '# stashed\n');
    await run('stashPush', repo, { message: 'wip' });
    assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), '# hello\n');

    await run('stashApply', repo, { stashRef: 'stash@{0}' });
    assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), '# stashed\n');

    await run('stashDrop', repo, { stashRef: 'stash@{0}' });
    assert.equal((await git.stashList(repo)).length, 0);

    fs.writeFileSync(path.join(repo, 'README.md'), '# stashed again\n');
    await run('stashPush', repo, {});
    await run('stashPop', repo, { stashRef: 'stash@{0}' });
    assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), '# stashed again\n');
    assert.equal((await git.stashList(repo)).length, 0);
  } finally {
    rmrf(repo);
  }
});

test('stashCreateBranch builds a new branch from a stash', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'README.md'), '# stashed\n');
    await run('stashPush', repo, {});
    await run('stashCreateBranch', repo, { name: 'from-stash', stashRef: 'stash@{0}' });
    assert.equal((await git.status(repo)).branch, 'from-stash');
    assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), '# stashed\n');
    assert.equal((await git.stashList(repo)).length, 0, 'stash branch also drops the stash');
  } finally {
    rmrf(repo);
  }
});

test('pushBranch pushes with --set-upstream by default and resolves a default remote', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  const bare = await addBareOrigin(repo);
  try {
    await git.run(['checkout', '-q', '-b', 'feature'], repo);
    fs.writeFileSync(path.join(repo, 'feature.txt'), 'x\n');
    await git.run(['add', 'feature.txt'], repo);
    await git.run(['commit', '-q', '-m', 'feature work'], repo);

    const result = await run('pushBranch', repo, { branch: 'feature' });
    assert.deepEqual(result.pushed, ['origin']);
    const remoteRefs = await git.run(['ls-remote', '--heads', bare], repo);
    assert.match(remoteRefs, /refs\/heads\/feature/);
    assert.equal(await git.run(['config', '--get', 'branch.feature.remote'], repo), 'origin', '--set-upstream recorded the tracking branch');
  } finally {
    rmrf(repo, bare);
  }
});

test('pushBranch force-with-lease vs plain force map to distinct flags', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  const bare = await addBareOrigin(repo);
  try {
    await run('pushBranch', repo, { branch: 'main', setUpstream: false, force: 'lease' });
    await run('pushBranch', repo, { branch: 'main', setUpstream: false, force: 'force' });
  } finally {
    rmrf(repo, bare);
  }
});

test('pushTag defaults to origin and can target an explicit remote list', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  const bare = await addBareOrigin(repo);
  try {
    await git.run(['tag', 'v1'], repo);
    const result = await run('pushTag', repo, { tagName: 'v1' });
    assert.deepEqual(result.pushed, ['origin']);
    assert.match(await git.run(['ls-remote', '--tags', bare], repo), /refs\/tags\/v1/);
  } finally {
    rmrf(repo, bare);
  }
});

test('deleteTag removes a tag locally and, when asked, on a remote too', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  const bare = await addBareOrigin(repo);
  try {
    await git.run(['tag', 'v1'], repo);
    await git.run(['push', '-q', 'origin', 'v1'], repo);

    await run('deleteTag', repo, { name: 'v1', deleteOnRemotes: ['origin'] });
    assert.equal(await git.tagExists(repo, 'v1'), false);
    assert.doesNotMatch(await git.run(['ls-remote', '--tags', bare], repo), /refs\/tags\/v1/);

    await assert.rejects(run('deleteTag', repo, { name: 'v1' }), /does not exist/);
  } finally {
    rmrf(repo, bare);
  }
});

test('fetchRemote and fetchAllRemotes pull down new refs from a bare origin', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  const bare = await addBareOrigin(repo);
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-gitactions-clone-'));
  try {
    fs.rmSync(clone, { recursive: true, force: true });
    await git.run(['clone', '-q', bare, clone], repo);

    await git.run(['checkout', '-q', '-b', 'topic'], repo);
    await git.run(['push', '-q', 'origin', 'topic'], repo);

    await run('fetchRemote', clone, { remote: 'origin' });
    assert.match(await git.run(['branch', '-r'], clone), /origin\/topic/);

    await run('fetchAllRemotes', clone, {});
  } finally {
    rmrf(repo, bare, clone);
  }
});

test('fetchIntoLocalBranch creates a new local branch tracking a remote one, without checking it out', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  const bare = await addBareOrigin(repo);
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-gitactions-clone-'));
  try {
    fs.rmSync(clone, { recursive: true, force: true });
    await git.run(['clone', '-q', bare, clone], repo);
    await git.run(['checkout', '-q', '-b', 'topic'], repo);
    await git.run(['push', '-q', 'origin', 'topic'], repo);
    await git.run(['fetch', '-q', 'origin'], clone);

    await run('fetchIntoLocalBranch', clone, { remote: 'origin', shortName: 'topic', localName: 'topic-local' });
    assert.equal(await git.branchExists(clone, 'topic-local'), true);
    assert.equal((await git.status(clone)).branch, 'main', 'the current branch is untouched');
  } finally {
    rmrf(repo, bare, clone);
  }
});

test('pullBranch fetches then merges FETCH_HEAD', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  const bare = await addBareOrigin(repo);
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-gitactions-clone-'));
  try {
    fs.rmSync(clone, { recursive: true, force: true });
    await git.run(['clone', '-q', bare, clone], repo);

    fs.writeFileSync(path.join(repo, 'more.txt'), 'more\n');
    await git.run(['add', 'more.txt'], repo);
    await git.run(['commit', '-q', '-m', 'more'], repo);
    await git.run(['push', '-q', 'origin', 'main'], repo);

    await run('pullBranch', clone, { remote: 'origin', shortName: 'main' });
    assert.ok(fs.existsSync(path.join(clone, 'more.txt')));
  } finally {
    rmrf(repo, bare, clone);
  }
});

test('createArchive writes a real .zip and .tar of a ref to an absolute path', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-gitactions-archive-'));
  try {
    const zipPath = path.join(outDir, 'out.zip');
    await run('createArchive', repo, { ref: 'main', refType: 'branch', absPath: zipPath, format: 'zip' });
    assert.ok(fs.statSync(zipPath).size > 0);

    const tarPath = path.join(outDir, 'out.tar');
    await run('createArchive', repo, { ref: 'main', refType: 'branch', absPath: tarPath, format: 'tar' });
    assert.ok(fs.statSync(tarPath).size > 0);

    await assert.rejects(run('createArchive', repo, { ref: 'main', refType: 'branch', absPath: 'relative/path.zip', format: 'zip' }), /absolute output path/);
    await assert.rejects(run('createArchive', repo, { ref: 'main', refType: 'branch', absPath: zipPath, format: 'rar' }), /Unsupported archive format/);
  } finally {
    rmrf(repo, outDir);
  }
});

test('resetFileToRevision checks out a single file from a historical commit', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    const first = await git.run(['rev-parse', 'HEAD'], repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# changed\n');
    await git.run(['commit', '-aq', '-m', 'change'], repo);

    await run('resetFileToRevision', repo, { commit: first, relPath: 'README.md' });
    const status = await git.run(['status', '--porcelain'], repo);
    assert.match(status, /README\.md/);
    assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), '# hello\n');
  } finally {
    rmrf(repo);
  }
});

test('resetFileToRevision normalizes a backslash-style relative path before it reaches git\'s pathspec', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    fs.mkdirSync(path.join(repo, 'sub'));
    fs.writeFileSync(path.join(repo, 'sub', 'nested.txt'), 'v1\n');
    await git.run(['add', 'sub/nested.txt'], repo);
    await git.run(['commit', '-q', '-m', 'add nested'], repo);
    const first = await git.run(['rev-parse', 'HEAD'], repo);
    fs.writeFileSync(path.join(repo, 'sub', 'nested.txt'), 'v2\n');
    await git.run(['commit', '-aq', '-m', 'change nested'], repo);

    await run('resetFileToRevision', repo, { commit: first, relPath: 'sub\\nested.txt' });
    assert.match(await git.run(['status', '--porcelain'], repo), /sub\/nested\.txt/);
  } finally {
    rmrf(repo);
  }
});

test('addRemote/editRemote/deleteRemote manage a repository\'s remotes', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-gitactions-bare-'));
  try {
    await git.run(['init', '-q', '--bare', bare], repo);
    await run('addRemote', repo, { name: 'origin', url: bare });
    assert.deepEqual((await git.remoteList(repo)).map(r => r.name), ['origin']);

    await run('editRemote', repo, { oldName: 'origin', newName: 'upstream', url: bare + '2' });
    const remotes = await git.remoteList(repo);
    assert.equal(remotes[0].name, 'upstream');
    assert.equal(remotes[0].url, bare + '2');

    await run('deleteRemote', repo, { name: 'upstream' });
    assert.deepEqual(await git.remoteList(repo), []);

    await assert.rejects(run('addRemote', repo, { name: 'bad', url: 'not-a-url' }), /not a recognized remote URL/);
  } finally {
    rmrf(repo, bare, bare + '2');
  }
});

test('setUserDetails sets and unsets local (and, when asked, global) git identity', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    await run('setUserDetails', repo, { name: 'New Name', email: 'new@example.com' });
    assert.equal(await git.run(['config', 'user.name'], repo), 'New Name');
    assert.equal(await git.run(['config', 'user.email'], repo), 'new@example.com');

    await run('setUserDetails', repo, { name: null });
    // --local (not plain 'user.name', which would fall back to this
    // machine's own real global identity once the local value is gone).
    await assert.rejects(git.run(['config', '--local', 'user.name'], repo));
  } finally {
    rmrf(repo);
  }
});

// --- Argument-injection resistance ----------------------------------------

test('a branch named with shell metacharacters is handled safely — no shell ever sees it', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  const canary = path.join(os.tmpdir(), `switchboard-gg-canary-${Date.now()}`);
  const hostileName = `foo$(id>${canary})`;
  try {
    // Documents *why* leading-dash rejection/character filtering alone
    // could never be the real defense: git's own check-ref-format accepts a
    // name like this outright (no leading dash, no space — the only things
    // it actually forbids here).
    await assert.doesNotReject(git.run(['check-ref-format', '--branch', hostileName], repo), 'expected check-ref-format to accept this name');

    await git.run(['branch', hostileName], repo); // set up the fixture directly — bypassing our own validator on purpose
    assert.equal(await git.branchExists(repo, hostileName), true);

    await run('checkoutBranchImmediate', repo, { name: hostileName });
    assert.equal((await git.status(repo)).branch, hostileName);
    assert.ok(!fs.existsSync(canary), 'the embedded command never ran — execFile never hands this to a shell');
  } finally {
    rmrf(repo);
    try { fs.rmSync(canary); } catch { /* good — it shouldn't exist */ }
  }
});

// --- Cancellation: ctx.signal must actually kill the child ----------------
// Timeouts/cancellation are the service layer's job (an AbortController it
// owns); this file's job is only to prove every child process it spawns
// forwards that signal so an abort truly kills it rather than abandoning
// the promise while the process keeps running.

function withFakeSlowGit(fn) {
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-fake-git-'));
  const script = path.join(fakeDir, 'git');
  fs.writeFileSync(script, '#!/bin/sh\nsleep 5\n');
  fs.chmodSync(script, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = fakeDir + path.delimiter + originalPath;
  return Promise.resolve(fn()).finally(() => {
    process.env.PATH = originalPath;
    fs.rmSync(fakeDir, { recursive: true, force: true });
  });
}

test('an aborted signal kills an execFile-based action promptly instead of waiting it out', { skip: !haveGit && 'git not installed' }, async () => {
  await withFakeSlowGit(async () => {
    const ac = new AbortController();
    const started = Date.now();
    const p = run('cleanUntracked', os.tmpdir(), {}, { signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    await assert.rejects(p);
    assert.ok(Date.now() - started < 3000, 'rejected well before the fake git\'s 5s sleep would finish');
  });
});

test('an aborted signal kills a spawn-based network action promptly instead of waiting it out', { skip: !haveGit && 'git not installed' }, async () => {
  await withFakeSlowGit(async () => {
    const ac = new AbortController();
    const started = Date.now();
    const p = run('fetchRemote', os.tmpdir(), { remote: 'origin' }, { signal: ac.signal, onProgress: () => {} });
    setTimeout(() => ac.abort(), 150);
    await assert.rejects(p);
    assert.ok(Date.now() - started < 3000, 'rejected well before the fake git\'s 5s sleep would finish');
  });
});

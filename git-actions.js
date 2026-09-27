// git-actions.js — the whitelist of mutating git operations the Git Graph
// tab may run. `ACTIONS` maps a fixed actionId to a `run(dir, params, ctx)`
// function; git-graph-service.js looks an id up here before ever spawning a
// process, so an id that isn't a key of this table is never run at all.
//
// Every argv is a plain array handed to execFile/spawn — never a shell — and
// every positional ref/hash/remote/stash-ref argument, whether it names
// something being *created* or something *already existing* referenced
// positionally, goes through assertSafePositionalArg() before it is placed
// into that array. An existing branch/tag/remote-branch is additionally
// passed in its fully-qualified form (refs/heads/<name>, refs/tags/<name>,
// refs/remotes/<remote>/<name>) wherever the git command accepts one, so a
// branch legitimately named e.g. "-f" can never be misread as a flag — this
// is on top of, not instead of, the leading-dash rejection every positional
// value gets.
//
// Timeouts and cancellation are the service layer's job (git-graph-
// service.js owns the per-repo concurrency guard, the timer, and the
// AbortController), not this file's: `ctx.signal` arrives already wired to
// both, and every child process this file spawns forwards it so an abort
// actually kills whatever's running rather than abandoning the promise.
// `ctx.onProgress` is only meaningful for the five network actions
// (fetchRemote, fetchAllRemotes, fetchIntoLocalBranch, pullBranch,
// pushBranch), which alone run via spawn with a streamed stderr instead of
// execFile — everything else is a quick local operation.
//
// GIT_TERMINAL_PROMPT is always '0': Switchboard never prompts for
// credentials, it relies on the user's own credential helper/SSH agent. A
// fetch/push/pull that would need one simply fails fast with git's own
// stderr, surfaced as this action's error like any other failure.

'use strict';

const cp = require('child_process'); // not destructured — tests stub cp.execFile/cp.spawn directly
const path = require('path');
const git = require('./git');

const MAX_BUFFER = 4 * 1024 * 1024;
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };

/** Run one git subprocess to completion, argv-array only, no shell. */
function execGit(args, { cwd, signal } = {}) {
  return new Promise((resolve, reject) => {
    cp.execFile('git', args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      signal,
      env: { ...process.env, ...GIT_ENV },
    }, (err, stdout, stderr) => {
      if (err) {
        const message = String(stderr || err.message || '').trim() || `git ${args[0]} failed`;
        const error = new Error(message);
        error.stderr = String(stderr || '');
        reject(error);
        return;
      }
      resolve(String(stdout));
    });
  });
}

/**
 * Like execGit, but via spawn with stderr streamed line-by-line to
 * onProgress — git writes its fetch/push/pull progress meter to stderr with
 * \r-terminated lines. Used only by the five network actions.
 */
function spawnGit(args, { cwd, signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn) => { if (!settled) { settled = true; fn(); } };
    let child;
    try {
      child = cp.spawn('git', args, { cwd, signal, env: { ...process.env, ...GIT_ENV } });
    } catch (err) {
      settle(() => reject(err));
      return;
    }
    let stdoutBuf = '';
    let stderrTail = '';
    let lineBuf = '';
    child.stdout?.on('data', (chunk) => { stdoutBuf += chunk; });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderrTail = (stderrTail + text).slice(-16000);
      if (typeof onProgress !== 'function') return;
      lineBuf += text;
      const parts = lineBuf.split(/\r\n|\r|\n/);
      lineBuf = parts.pop() || '';
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed) onProgress(trimmed);
      }
    });
    child.on('error', (err) => settle(() => reject(err)));
    child.on('close', (code) => settle(() => {
      if (code === 0) { resolve(stdoutBuf); return; }
      const tail = stderrTail.trim().split(/\r\n|\r|\n/).filter(Boolean).slice(-10).join('\n');
      reject(new Error(tail || `git ${args[0]} failed with code ${code}`));
    }));
  });
}

function gitCtx(dir, ctx) { return { cwd: dir, signal: ctx && ctx.signal }; }
function gitSpawnCtx(dir, ctx) { return { cwd: dir, signal: ctx && ctx.signal, onProgress: ctx && ctx.onProgress }; }

// --- Shared positional-argument validation -------------------------------

const HASH_RE = /^[0-9a-f]{4,40}$/;
const REMOTE_NAME_RE = /^[A-Za-z0-9._-]+$/;
const STASH_REF_RE = /^stash@\{\d+\}$/;
// Structural baseline for a ref short name: no control characters, no ".."
// segment, no leading/trailing '/', no "@{" (git's own reflog-shorthand
// syntax, which would let a "name" resolve to something other than itself),
// no trailing ".lock". Deliberately does NOT reject '$', '(', ')', ';', '|',
// '&', backticks, or similar — a real branch can be named that (verified:
// `git check-ref-format --branch 'foo$(id)'` exits 0 on git 2.50.1) and
// execFile's argv-array form is what keeps such a name from ever being read
// as shell syntax, not character rejection here.
const REF_BASELINE_INVALID_RE = /[\x00-\x1f\x7f]|\.\.|@\{|(^\/)|(\/$)|(\.lock$)/;

/**
 * The single choke point every positional ref/hash/remote/stash-ref
 * argument in this file goes through — whether it names something being
 * *created* or something *already existing* referenced positionally.
 * Rejects empty values, embedded NUL bytes, and any value starting with
 * '-' (git's own `check-ref-format --branch -foo` already rejects a
 * leading dash for names being created; this extends the same rejection to
 * hashes/remotes/existing refs that check-ref-format is never run against
 * at all). `kind` adds a shape check on top of that baseline.
 */
function assertSafePositionalArg(value, kind) {
  const label = kind || 'value';
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label}: a value is required`);
  if (value.includes('\0')) throw new Error(`${label}: must not contain a NUL byte`);
  if (value.startsWith('-')) throw new Error(`${label}: must not start with '-'`);
  if (kind === 'hash') {
    if (!HASH_RE.test(value)) throw new Error(`${label}: '${value}' is not a valid commit hash`);
  } else if (kind === 'remote') {
    if (!REMOTE_NAME_RE.test(value)) throw new Error(`${label}: '${value}' is not a valid remote name`);
  } else if (kind === 'stash-ref') {
    if (!STASH_REF_RE.test(value)) throw new Error(`${label}: '${value}' is not a valid stash reference`);
  } else if (REF_BASELINE_INVALID_RE.test(value)) {
    throw new Error(`${label}: '${value}' is not a valid reference name`);
  }
  return value;
}

function fullyQualifyBranch(name) { assertSafePositionalArg(name, 'branch'); return `refs/heads/${name}`; }
function fullyQualifyTag(name) { assertSafePositionalArg(name, 'tag'); return `refs/tags/${name}`; }
function fullyQualifyRemoteBranch(remote, name) {
  assertSafePositionalArg(remote, 'remote');
  assertSafePositionalArg(name, 'branch');
  return `refs/remotes/${remote}/${name}`;
}

/**
 * Resolve a merge/rebase/archive-style target — {ref, refType, remote?} —
 * into its argv-safe form: a bare hash, or a fully-qualified existing
 * branch/tag/remote-branch ref.
 */
function qualifyRef({ ref, refType, remote } = {}) {
  if (refType === 'hash') { assertSafePositionalArg(ref, 'hash'); return ref; }
  if (refType === 'branch') return fullyQualifyBranch(ref);
  if (refType === 'tag') return fullyQualifyTag(ref);
  if (refType === 'remote-branch') return fullyQualifyRemoteBranch(remote, ref);
  throw new Error(`Unknown refType '${refType}'`);
}

/**
 * A name being newly created (branch/tag/stash-branch) additionally goes
 * through the real `git check-ref-format --branch` — the actual arbiter of
 * ref-name validity, including rules not worth re-deriving by hand — on top
 * of the baseline shape/leading-dash check every positional value gets.
 * git's own stdout (its shorthand-expansion result) is discarded; the
 * caller's own `name` is what's used for the real command either way.
 */
async function assertValidNewRefName(name, ctx) {
  assertSafePositionalArg(name, 'ref');
  try {
    await execGit(['check-ref-format', '--branch', name], ctx);
  } catch {
    throw new Error(`'${name}' is not a valid reference name`);
  }
}

const NOT_FULLY_MERGED_RE = /not fully merged/i;
const REMOTE_REF_GONE_RE = /remote ref does not exist/i;

async function currentBranch(dir, ctx) {
  try { return (await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], gitCtx(dir, ctx))).trim(); } catch { return null; }
}

/** All parent hashes of a commit, via `<rev>^@` — empty for a root commit. */
async function parentHashes(dir, commit, ctx) {
  const out = await execGit(['rev-parse', `${commit}^@`], gitCtx(dir, ctx));
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

/** Direct children of a commit across all refs, with each child's own parent count. */
/**
 * Whether `commit` is in `ancestorOf`'s history, via `git merge-base
 * --is-ancestor` — documented to communicate its answer purely through the
 * exit code (0 yes, 1 no) and print nothing to stderr either way; a real
 * failure (bad revision, corrupt object) does print to stderr, which is how
 * this tells "not an ancestor" apart from an actual error.
 */
async function isAncestorOf(dir, commit, ancestorOf, ctx) {
  try {
    await execGit(['merge-base', '--is-ancestor', commit, ancestorOf], gitCtx(dir, ctx));
    return true;
  } catch (err) {
    if (String(err.stderr || '').trim()) throw err;
    return false;
  }
}

async function findChildren(dir, commit, ctx) {
  const out = await execGit(['rev-list', '--all', '--parents'], gitCtx(dir, ctx));
  const children = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [hash, ...parents] = line.trim().split(/\s+/);
    if (parents.includes(commit)) children.push({ hash, parentCount: parents.length });
  }
  return children;
}

async function firstConfigValue(dir, keys, ctx) {
  for (const key of keys) {
    try {
      const value = (await execGit(['config', '--get', key], gitCtx(dir, ctx))).trim();
      if (value) return value;
    } catch { /* key unset — try the next tier */ }
  }
  return null;
}

/** branch.<name>.pushRemote -> remote.pushDefault -> branch.<name>.remote -> 'origin'. */
async function resolveDefaultPushRemote(dir, branch, ctx) {
  const resolved = await firstConfigValue(dir, [`branch.${branch}.pushRemote`, 'remote.pushDefault', `branch.${branch}.remote`], ctx);
  return resolved || 'origin';
}

const REMOTE_URL_RE = /^(https?:\/\/|git:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:|\.{1,2}\/|\/|[A-Za-z]:[\\/])/;

// --- Action table ----------------------------------------------------------

const ACTIONS = {};
function defineAction(id, run) { ACTIONS[id] = { run }; }

defineAction('addTag', async (dir, params, ctx) => {
  const { name, message, commit, type = 'annotated', pushToRemotes } = params || {};
  await assertValidNewRefName(name, gitCtx(dir, ctx));
  if (await git.tagExists(dir, name)) throw new Error(`Tag '${name}' already exists`);
  assertSafePositionalArg(commit, 'hash');
  if (type === 'annotated' && !String(message || '').trim()) throw new Error('An annotated tag requires a message');
  const argv = type === 'annotated' ? ['tag', '-a', name, '-m', String(message), commit] : ['tag', name, commit];
  await execGit(argv, gitCtx(dir, ctx));
  const pushedTo = [];
  for (const remote of pushToRemotes || []) {
    assertSafePositionalArg(remote, 'remote');
    await execGit(['push', remote, fullyQualifyTag(name)], gitCtx(dir, ctx));
    pushedTo.push(remote);
  }
  return { name, pushedTo };
});

defineAction('createBranch', async (dir, params, ctx) => {
  const { name, commit, checkOut = false } = params || {};
  await assertValidNewRefName(name, gitCtx(dir, ctx));
  if (await git.branchExists(dir, name)) throw new Error(`Branch '${name}' already exists`);
  assertSafePositionalArg(commit, 'hash');
  await execGit(checkOut ? ['checkout', '-b', name, commit] : ['branch', name, commit], gitCtx(dir, ctx));
  return { name };
});

defineAction('checkoutCommit', async (dir, params, ctx) => {
  const { commit } = params || {};
  assertSafePositionalArg(commit, 'hash');
  await execGit(['checkout', commit], gitCtx(dir, ctx));
  return { commit };
});

// Deliberately `switch --`, not `checkout <fully-qualified-ref>`: verified
// against a real git 2.50.1 that `checkout refs/heads/<name>` — the
// fully-qualified form this file otherwise favours for an existing ref —
// checks out that *commit* and leaves HEAD **detached**, not attached to
// the branch, because a full ref path doesn't hit checkout's short-name
// branch-switch heuristic. `switch -- <name>` attaches correctly (confirmed:
// `git symbolic-ref HEAD` resolves afterward) and, exactly like fully-
// qualifying, is immune to a leading '-' — `--` is switch's own standard
// end-of-options marker, so `assertSafePositionalArg`'s baseline check is
// what's actually load-bearing here, not a fully-qualified path.
defineAction('checkoutBranchImmediate', async (dir, params, ctx) => {
  const { name } = params || {};
  assertSafePositionalArg(name, 'branch');
  if (!(await git.branchExists(dir, name))) throw new Error(`Branch '${name}' does not exist`);
  await execGit(['switch', '--', name], gitCtx(dir, ctx));
  return { name };
});

defineAction('checkoutRemoteBranch', async (dir, params, ctx) => {
  const { remote, shortName, name } = params || {};
  assertSafePositionalArg(remote, 'remote');
  assertSafePositionalArg(shortName, 'branch');
  const source = fullyQualifyRemoteBranch(remote, shortName);
  const localName = name || shortName;
  if (await git.branchExists(dir, localName)) {
    // Name collision with an existing local branch: check it out (see the
    // `switch --` note above), then fast-forward it from the remote instead
    // of creating a second branch.
    await execGit(['switch', '--', localName], gitCtx(dir, ctx));
    await execGit(['pull', '--ff-only', remote, `refs/heads/${shortName}`], gitCtx(dir, ctx));
    return { name: localName, collision: true };
  }
  await assertValidNewRefName(localName, gitCtx(dir, ctx));
  // Unlike a bare switch, `-b`/`checkout -b` always creates and attaches a
  // *new* branch regardless of how its start point is written, so the
  // fully-qualified `source` here has no detachment concern.
  await execGit(['checkout', '-b', localName, source], gitCtx(dir, ctx));
  return { name: localName, collision: false };
});

defineAction('renameBranch', async (dir, params, ctx) => {
  const { oldName, newName } = params || {};
  assertSafePositionalArg(oldName, 'branch');
  if (!(await git.branchExists(dir, oldName))) throw new Error(`Branch '${oldName}' does not exist`);
  await assertValidNewRefName(newName, gitCtx(dir, ctx));
  if (await git.branchExists(dir, newName)) throw new Error(`Branch '${newName}' already exists`);
  await execGit(['branch', '-m', oldName, newName], gitCtx(dir, ctx));
  return { oldName, newName };
});

defineAction('deleteBranch', async (dir, params, ctx) => {
  const { name, forceDelete = false, deleteOnRemotes } = params || {};
  assertSafePositionalArg(name, 'branch');
  if ((await currentBranch(dir, ctx)) === name) throw new Error(`Cannot delete '${name}': it is the current branch`);
  if (!(await git.branchExists(dir, name))) throw new Error(`Branch '${name}' does not exist`);
  try {
    await execGit(['branch', forceDelete ? '-D' : '-d', name], gitCtx(dir, ctx));
  } catch (err) {
    err.notFullyMerged = NOT_FULLY_MERGED_RE.test(err.message);
    throw err;
  }
  const deletedOnRemotes = [];
  for (const remote of deleteOnRemotes || []) {
    assertSafePositionalArg(remote, 'remote');
    // Fully-qualified, exactly like deleteTag's own remote-delete call below:
    // a bare short name is ambiguous when the remote also has a tag with the
    // same name ("dst refspec ... matches more than one"), which is a
    // realistic collision for a release branch/tag pair.
    await execGit(['push', remote, '--delete', fullyQualifyBranch(name)], gitCtx(dir, ctx));
    deletedOnRemotes.push(remote);
  }
  return { name, deletedOnRemotes };
});

// Missing from an earlier pass: the remote-branch menu's own "Delete Remote
// Branch…" has no local branch to delete at all, so it cannot go through
// deleteBranch above.
defineAction('deleteRemoteBranch', async (dir, params, ctx) => {
  const { remote, shortName } = params || {};
  assertSafePositionalArg(remote, 'remote');
  assertSafePositionalArg(shortName, 'branch');
  try {
    // Deliberately the bare short name, not a fully-qualified refs/heads/...
    // path: verified against a real git 2.50.1 that deleting an *already
    // absent* ref by its fully-qualified form exits 0 (just a "deleting a
    // non-existent ref" warning), while the short form still fails with
    // "remote ref does not exist" — and the stale-tracking-ref recovery
    // below depends on getting that real failure to know it needs to run.
    await execGit(['push', remote, '--delete', shortName], gitCtx(dir, ctx));
    return { remote, shortName, staleTrackingRefRemoved: false };
  } catch (err) {
    if (!REMOTE_REF_GONE_RE.test(err.message)) throw err;
    // The ref is already gone on the remote — only our own stale tracking ref is left.
    await execGit(['branch', '-d', '-r', `${remote}/${shortName}`], gitCtx(dir, ctx));
    return { remote, shortName, staleTrackingRefRemoved: true };
  }
});

defineAction('cherryPick', async (dir, params, ctx) => {
  const { commit, noCommit = false, recordOrigin = false, parent } = params || {};
  assertSafePositionalArg(commit, 'hash');
  const parents = await parentHashes(dir, commit, ctx);
  if (parents.length >= 2 && !parent) throw new Error('This is a merge commit — pick which parent to cherry-pick against');
  if (parents.length < 2 && parent) throw new Error('Only a merge commit takes a parent number');
  const argv = ['cherry-pick'];
  if (noCommit) argv.push('-n');
  if (recordOrigin) argv.push('-x');
  if (parent) argv.push('-m', String(parent));
  argv.push(commit);
  await execGit(argv, gitCtx(dir, ctx));
  return { commit };
});

defineAction('revert', async (dir, params, ctx) => {
  const { commit, parent } = params || {};
  assertSafePositionalArg(commit, 'hash');
  const parents = await parentHashes(dir, commit, ctx);
  if (parents.length >= 2 && !parent) throw new Error('This is a merge commit — pick which parent to revert against');
  if (parents.length < 2 && parent) throw new Error('Only a merge commit takes a parent number');
  const argv = ['revert', '--no-edit'];
  if (parent) argv.push('-m', String(parent));
  argv.push(commit);
  await execGit(argv, gitCtx(dir, ctx));
  return { commit };
});

// The tip case resets to the commit's own recorded parent hash — an
// absolute value, never the relative `HEAD~1` an earlier pass used, which
// names "whatever the tip is right now minus one" rather than "the specific
// commit the menu was opened on". Immediately before running it, HEAD is
// re-checked against the commit that was clicked so a HEAD that moved
// between menu-open and click-confirm (e.g. an external change) is caught
// rather than silently reset to the wrong place.
defineAction('dropCommit', async (dir, params, ctx) => {
  const { commit } = params || {};
  assertSafePositionalArg(commit, 'hash');
  const head = (await execGit(['rev-parse', 'HEAD'], gitCtx(dir, ctx))).trim();
  if (head === commit) {
    const parents = await parentHashes(dir, commit, ctx);
    if (parents.length !== 1) throw new Error('A root commit or a merge commit cannot be dropped this way');
    const parentHash = parents[0];
    const recheck = (await execGit(['rev-parse', 'HEAD'], gitCtx(dir, ctx))).trim();
    if (recheck !== commit) throw new Error('The repository has changed — please refresh and try again');
    await execGit(['reset', '--hard', parentHash], gitCtx(dir, ctx));
    return { commit, mode: 'tip', resetTo: parentHash };
  }
  const children = await findChildren(dir, commit, ctx);
  if (children.length !== 1 || children[0].parentCount !== 1) {
    throw new Error('This commit cannot be dropped — it does not have exactly one non-merge child');
  }
  const parents = await parentHashes(dir, commit, ctx);
  if (parents.length === 0) throw new Error('A root commit cannot be dropped this way');
  // `findChildren` looks across every ref in the repo, not just the current
  // branch, so a commit that satisfies the child-count rule can still be
  // completely unrelated to what's checked out. Without this check, the
  // `rebase --onto` below would run against whatever HEAD happens to be
  // (rebase takes its range from the current branch when no <branch> is
  // given), silently rewriting a branch that has nothing to do with the
  // commit the user actually clicked.
  if (!(await isAncestorOf(dir, commit, 'HEAD', ctx))) {
    throw new Error('This commit is not on the current branch');
  }
  const branch = await currentBranch(dir, ctx);
  if (!branch) throw new Error('Cannot drop this commit while HEAD is detached');
  await execGit(['rebase', '--onto', `${commit}~1`, commit, branch], gitCtx(dir, ctx));
  return { commit, mode: 'rebase' };
});

defineAction('merge', async (dir, params, ctx) => {
  const { ref, refType, remote, noFastForward = false, noCommit = false, squash = false, squashMessage } = params || {};
  const qualified = qualifyRef({ ref, refType, remote });
  const argv = ['merge'];
  // git rejects '--squash' and '--no-ff' together outright ("options
  // '--squash' and '--no-ff.' cannot be used together"), and a squash merge
  // never fast-forwards in the first place, so --no-ff has nothing to add
  // once squash is requested — drop it rather than let the two dialog
  // checkboxes produce a command git refuses to run.
  if (noFastForward && !squash) argv.push('--no-ff');
  if (noCommit) argv.push('--no-commit');
  if (squash) argv.push('--squash');
  argv.push(qualified);
  await execGit(argv, gitCtx(dir, ctx));
  if (squash && !noCommit) await execGit(['commit', '-m', squashMessage || `Squashed commit of '${ref}'`], gitCtx(dir, ctx));
  return { ref };
});

defineAction('rebase', async (dir, params, ctx) => {
  const { upstream, refType, remote, ignoreDate = true } = params || {};
  const qualified = qualifyRef({ ref: upstream, refType, remote });
  const argv = ['rebase'];
  if (ignoreDate) argv.push('--ignore-date');
  argv.push(qualified);
  await execGit(argv, gitCtx(dir, ctx));
  return { upstream };
});

// Deliberately builds nothing runnable. A real `git 2.50.1` confirms
// `check-ref-format --branch` accepts a name containing `$()`/backticks/`;`/
// `|`/`&` as long as it has no space, so a hostile repo could ship a branch
// literally named e.g. `main$(id)` — typing a constructed `git rebase -i
// <ref>` command line into a real shell would execute it. This action never
// does that: it only validates the ref (so the *displayed* text is at least
// well-formed) and hands back a read-only command string for the renderer
// to show next to a bare terminal it opens itself — nothing here ever calls
// execFile/spawn, and nothing here ever touches a terminal-launch/PTY-write
// call. The user pastes and runs the command themselves.
defineAction('rebaseInteractive', async (dir, params) => {
  const { upstream, refType, remote } = params || {};
  const qualified = qualifyRef({ ref: upstream, refType, remote });
  return { command: `git rebase -i ${qualified}`, upstream };
});

const RESET_MODES = new Set(['soft', 'mixed', 'hard']);
defineAction('resetToCommit', async (dir, params, ctx) => {
  const { commit, mode = 'mixed' } = params || {};
  assertSafePositionalArg(commit, 'hash');
  if (!RESET_MODES.has(mode)) throw new Error(`Invalid reset mode '${mode}'`);
  await execGit(['reset', `--${mode}`, commit], gitCtx(dir, ctx));
  return { commit, mode };
});

const UNCOMMITTED_RESET_MODES = new Set(['mixed', 'hard']);
defineAction('resetUncommitted', async (dir, params, ctx) => {
  const { mode = 'mixed' } = params || {};
  if (!UNCOMMITTED_RESET_MODES.has(mode)) throw new Error(`Invalid reset mode '${mode}'`);
  await execGit(['reset', `--${mode}`, 'HEAD'], gitCtx(dir, ctx));
  return { mode };
});

defineAction('cleanUntracked', async (dir, params, ctx) => {
  const { removeDirectories = false } = params || {};
  const argv = ['clean', '-f'];
  if (removeDirectories) argv.push('-d');
  await execGit(argv, gitCtx(dir, ctx));
  return {};
});

defineAction('stashPush', async (dir, params, ctx) => {
  const { includeUntracked = false, message } = params || {};
  const argv = ['stash', 'push'];
  if (includeUntracked) argv.push('--include-untracked');
  if (message) argv.push('-m', String(message));
  await execGit(argv, gitCtx(dir, ctx));
  return {};
});

defineAction('stashApply', async (dir, params, ctx) => {
  const { stashRef, reinstateIndex = false } = params || {};
  assertSafePositionalArg(stashRef, 'stash-ref');
  const argv = ['stash', 'apply'];
  if (reinstateIndex) argv.push('--index');
  argv.push(stashRef);
  await execGit(argv, gitCtx(dir, ctx));
  return { stashRef };
});

defineAction('stashPop', async (dir, params, ctx) => {
  const { stashRef, reinstateIndex = false } = params || {};
  assertSafePositionalArg(stashRef, 'stash-ref');
  const argv = ['stash', 'pop'];
  if (reinstateIndex) argv.push('--index');
  argv.push(stashRef);
  await execGit(argv, gitCtx(dir, ctx));
  return { stashRef };
});

defineAction('stashDrop', async (dir, params, ctx) => {
  const { stashRef } = params || {};
  assertSafePositionalArg(stashRef, 'stash-ref');
  await execGit(['stash', 'drop', stashRef], gitCtx(dir, ctx));
  return { stashRef };
});

defineAction('stashCreateBranch', async (dir, params, ctx) => {
  const { name, stashRef } = params || {};
  await assertValidNewRefName(name, gitCtx(dir, ctx));
  if (await git.branchExists(dir, name)) throw new Error(`Branch '${name}' already exists`);
  assertSafePositionalArg(stashRef, 'stash-ref');
  await execGit(['stash', 'branch', name, stashRef], gitCtx(dir, ctx));
  return { name, stashRef };
});

// One of the five network actions run via spawn with streamed progress —
// per-remote, sequentially, under the one timeout/signal the service hands
// this whole call.
defineAction('pushBranch', async (dir, params, ctx) => {
  const { branch, remotes, setUpstream = true, force = 'none' } = params || {};
  assertSafePositionalArg(branch, 'branch');
  const targets = Array.isArray(remotes) && remotes.length ? remotes : [await resolveDefaultPushRemote(dir, branch, ctx)];
  const pushed = [];
  for (const remote of targets) {
    assertSafePositionalArg(remote, 'remote');
    const argv = ['push'];
    if (setUpstream) argv.push('--set-upstream');
    if (force === 'lease') argv.push('--force-with-lease');
    else if (force === 'force') argv.push('--force');
    argv.push(remote, fullyQualifyBranch(branch));
    await spawnGit(argv, gitSpawnCtx(dir, ctx));
    pushed.push(remote);
  }
  return { branch, pushed };
});

// Not one of the five spawn-based network actions (deliberately just
// fetch/fetch-all/fetch-into-local/pull/push-branch) — pushTag runs via
// execGit like everything else outside that list, and has
// no per-branch resolution tier to mirror (git has none for tags): it
// defaults to 'origin' when the caller doesn't pick a remote, full stop.
defineAction('pushTag', async (dir, params, ctx) => {
  const { tagName, remotes } = params || {};
  assertSafePositionalArg(tagName, 'tag');
  let targets = Array.isArray(remotes) && remotes.length ? remotes : null;
  if (!targets) {
    const allRemotes = await git.remoteList(dir);
    if (!allRemotes.length) throw new Error('This repository has no remote to push the tag to');
    const origin = allRemotes.find(r => r.name === 'origin');
    targets = [origin ? origin.name : allRemotes[0].name];
  }
  const pushed = [];
  for (const remote of targets) {
    assertSafePositionalArg(remote, 'remote');
    await execGit(['push', remote, fullyQualifyTag(tagName)], gitCtx(dir, ctx));
    pushed.push(remote);
  }
  return { tagName, pushed };
});

defineAction('deleteTag', async (dir, params, ctx) => {
  const { name, deleteOnRemotes } = params || {};
  assertSafePositionalArg(name, 'tag');
  if (!(await git.tagExists(dir, name))) throw new Error(`Tag '${name}' does not exist`);
  await execGit(['tag', '-d', name], gitCtx(dir, ctx));
  const deletedOnRemotes = [];
  for (const remote of deleteOnRemotes || []) {
    assertSafePositionalArg(remote, 'remote');
    await execGit(['push', remote, '--delete', fullyQualifyTag(name)], gitCtx(dir, ctx));
    deletedOnRemotes.push(remote);
  }
  return { name, deletedOnRemotes };
});

defineAction('fetchRemote', async (dir, params, ctx) => {
  const { remote, prune = false, pruneTags = false } = params || {};
  assertSafePositionalArg(remote, 'remote');
  const argv = ['fetch', remote, '--progress'];
  if (prune) argv.push('--prune');
  if (pruneTags) argv.push('--prune-tags');
  await spawnGit(argv, gitSpawnCtx(dir, ctx));
  return { remote };
});

defineAction('fetchAllRemotes', async (dir, params, ctx) => {
  const { prune = false, pruneTags = false } = params || {};
  const argv = ['fetch', '--all', '--progress'];
  if (prune) argv.push('--prune');
  if (pruneTags) argv.push('--prune-tags');
  await spawnGit(argv, gitSpawnCtx(dir, ctx));
  return {};
});

defineAction('fetchIntoLocalBranch', async (dir, params, ctx) => {
  const { remote, shortName, localName, forceFetch = false } = params || {};
  assertSafePositionalArg(remote, 'remote');
  assertSafePositionalArg(shortName, 'branch');
  await assertValidNewRefName(localName, gitCtx(dir, ctx));
  const refspec = `${shortName}:${localName}`;
  const argv = forceFetch ? ['fetch', '--force', remote, refspec, '--progress'] : ['fetch', remote, refspec, '--progress'];
  await spawnGit(argv, gitSpawnCtx(dir, ctx));
  return { remote, shortName, localName };
});

defineAction('pullBranch', async (dir, params, ctx) => {
  const { remote, shortName, noFastForward = false, squash = false } = params || {};
  assertSafePositionalArg(remote, 'remote');
  assertSafePositionalArg(shortName, 'branch');
  await spawnGit(['fetch', remote, shortName, '--progress'], gitSpawnCtx(dir, ctx));
  const argv = ['merge'];
  if (noFastForward && !squash) argv.push('--no-ff'); // see the same note in `merge` above
  if (squash) argv.push('--squash');
  argv.push('FETCH_HEAD');
  await execGit(argv, gitCtx(dir, ctx));
  return { remote, shortName };
});

defineAction('createArchive', async (dir, params, ctx) => {
  const { ref, refType, remote, absPath, format } = params || {};
  const qualified = qualifyRef({ ref, refType, remote });
  if (typeof absPath !== 'string' || !absPath || !path.isAbsolute(absPath)) throw new Error('An absolute output path is required');
  if (format !== 'zip' && format !== 'tar') throw new Error(`Unsupported archive format '${format}'`);
  await execGit(['archive', `--format=${format}`, '-o', git.toGitPath(absPath), qualified], gitCtx(dir, ctx));
  return { absPath, format };
});

defineAction('resetFileToRevision', async (dir, params, ctx) => {
  const { commit, relPath } = params || {};
  assertSafePositionalArg(commit, 'hash');
  const { relative } = git.safeRelativePath(dir, relPath);
  await execGit(['checkout', commit, '--', git.toGitPath(relative)], gitCtx(dir, ctx));
  return { commit, path: relative };
});

defineAction('addRemote', async (dir, params, ctx) => {
  const { name, url } = params || {};
  assertSafePositionalArg(name, 'remote');
  if (typeof url !== 'string' || !url || !REMOTE_URL_RE.test(url)) throw new Error(`'${url}' is not a recognized remote URL`);
  await execGit(['remote', 'add', name, url], gitCtx(dir, ctx));
  return { name, url };
});

defineAction('editRemote', async (dir, params, ctx) => {
  const { oldName, newName, url } = params || {};
  assertSafePositionalArg(oldName, 'remote');
  let finalName = oldName;
  if (newName && newName !== oldName) {
    assertSafePositionalArg(newName, 'remote');
    await execGit(['remote', 'rename', oldName, newName], gitCtx(dir, ctx));
    finalName = newName;
  }
  if (url) {
    if (!REMOTE_URL_RE.test(url)) throw new Error(`'${url}' is not a recognized remote URL`);
    await execGit(['remote', 'set-url', finalName, url], gitCtx(dir, ctx));
  }
  return { name: finalName, url: url || null };
});

defineAction('deleteRemote', async (dir, params, ctx) => {
  const { name } = params || {};
  assertSafePositionalArg(name, 'remote');
  await execGit(['remote', 'remove', name], gitCtx(dir, ctx));
  return { name };
});

defineAction('setUserDetails', async (dir, params, ctx) => {
  const { global = false, name, email } = params || {};
  const scope = global ? ['--global'] : [];
  const result = {};
  if (name === null) {
    try { await execGit(['config', ...scope, '--unset', 'user.name'], gitCtx(dir, ctx)); } catch { /* was already unset */ }
    result.name = null;
  } else if (typeof name === 'string' && name.trim()) {
    await execGit(['config', ...scope, 'user.name', name], gitCtx(dir, ctx));
    result.name = name;
  }
  if (email === null) {
    try { await execGit(['config', ...scope, '--unset', 'user.email'], gitCtx(dir, ctx)); } catch { /* was already unset */ }
    result.email = null;
  } else if (typeof email === 'string' && email.trim()) {
    await execGit(['config', ...scope, 'user.email', email], gitCtx(dir, ctx));
    result.email = email;
  }
  return result;
});

module.exports = {
  ACTIONS,
  assertSafePositionalArg,
  fullyQualifyBranch,
  fullyQualifyTag,
  fullyQualifyRemoteBranch,
  qualifyRef,
};

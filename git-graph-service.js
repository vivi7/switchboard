// git-graph-service.js — assembles Git Graph tab payloads, dispatches the
// whitelisted mutating actions from git-actions.js, and owns the
// cross-cutting safety mechanisms the plan calls out: per-repo mutating
// action serialization, per-action timeout/cancel, a repo-identity-checked
// RepoConfig cache, and a debounced watcher on the repo's common git dir.
//
// This module is a singleton initialised with init(ctx), the same shape as
// projects.js/session-cache.js, so tests can hand it a fake db and fake git/
// git-actions modules without touching the real ones. `git.js` and
// `git-actions.js` are the only things this file shells out through; it
// never runs a git subprocess itself.
//
// Boundary note: this module does not check whether folderPath is attached
// to a project — that check happens one layer up, in projects.js, exactly
// like it already does for projectGitDiff.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git's well-known empty-tree constant
const EXTERNAL_CONFIG_FILE = '.switchboard-git-graph.json';
const EXTERNAL_CONFIG_MAX_BYTES = 64 * 1024;
const EXTERNAL_CONFIG_FIELDS = ['issueLinking', 'pullRequestProvider', 'customDisplayName'];

const GLOBAL_PREFS_KEY = 'gitGraph.preferences';
const repoConfigKey = (folderPath) => `gitGraph.repo:${folderPath}`;

const NETWORK_ACTION_IDS = new Set(['fetchRemote', 'fetchAllRemotes', 'fetchIntoLocalBranch', 'pullBranch', 'pushBranch']);
const REFS_WALK_MAX_ENTRIES = 20_000;

// Timing knobs, overridable via init(ctx) so tests can run in milliseconds
// instead of real minutes without touching the mechanism under test.
let DEFAULT_ACTION_TIMEOUT_MS = 30_000;
let NETWORK_ACTION_TIMEOUT_MS = 120_000;
let REPO_WATCH_POLL_MS = 1500;
let REPO_WATCH_DEBOUNCE_MS = 300;
let REPO_WATCH_IDLE_SWEEP_MS = 5 * 60 * 1000;
let REPO_WATCH_IDLE_MAX_MS = 15 * 60 * 1000;

// Switchboard's own palette for lanes 1-4, extended
// with additional hues for lanes 5-12 rather than upstream's own values.
const DEFAULT_GRAPH_COLOURS = [
  '#69c47c', '#df7180', '#e0aa63', '#8992dc',
  '#5fb3d9', '#c77dd1', '#9fd15a', '#e08fb0',
  '#6fa8e0', '#d1a5e0', '#7fd1b8', '#e0c05f',
];

const DEFAULT_REPO_CONFIG = Object.freeze({
  showRemoteBranches: true,
  showRemoteHeads: true,
  showStashes: true,
  showTags: true,
  showCommitsOnlyReferencedByTags: true,
  showUncommittedChanges: true,
  showUntrackedFiles: true,
  includeCommitsMentionedByReflogs: false,
  onlyFollowFirstParent: false,
  muteMergeCommits: true,
  muteNonAncestors: false,
  commitsOrder: 'date',
  useMailmap: false,
  signCommits: false,
  signTags: false,
  onLoadScrollToHead: false,
  onLoadShowCheckedOutBranch: false,
  onLoadShowSpecificBranches: [],
  customDisplayName: null,
  perRemoteVisibility: {},
  issueLinking: null,
  pullRequestProvider: null,
  branchDropdownSelection: 'all',
  columnWidths: {},
  commitDetailsPanelHeight: null,
  fetchAvatars: null,
  fetchAndPrune: false,
  fetchAndPruneTags: false,
  showSignatureStatus: false,
  fileEncoding: 'utf8',
  rootCommitHashes: [],
  trustedExternalConfig: false,
  trustedExternalConfigHash: null,
  codeReview: {},
  // A self-hosted GitLab host the user has
  // explicitly confirmed for this repo. Never auto-derived from the remote
  // origin URL — see git-graph-avatars.js.
  avatarsSelfHostedGitLabHost: null,
});

const DEFAULT_GLOBAL_PREFS = Object.freeze({
  dateFormat: 'date-time',
  dateType: 'author',
  graphStyle: 'rounded',
  graphColours: DEFAULT_GRAPH_COLOURS,
  columnVisibility: { date: true, author: true, commit: true },
  referenceLabelAlignment: 'normal',
  combineLocalAndRemoteBranchLabels: true,
  fetchAvatars: false,
  contextMenuActionsVisibility: {},
  repositoryDropdownOrder: 'attachmentOrder',
  markdownRendering: true,
  enhancedAccessibility: false,
  graphUncommittedChangesStyle: 'openAtUncommitted',
  commitDetailsView: { location: 'inline', autoCenter: true },
  fileViewType: 'tree',
  compactFolders: true,
  dialogDefaults: {
    addTag: { type: 'annotated', pushToRemote: false },
    createBranch: { checkOut: false },
    cherryPick: { noCommit: false, recordOrigin: false },
    merge: { noFastForward: true, noCommit: false, squashCommits: false, squashMessageFormat: 'default' },
    pullBranch: { noFastForward: false, noCommit: false, squashCommits: false, squashMessageFormat: 'default' },
    rebase: { ignoreDate: true },
    resetCurrentBranchToCommit: { mode: 'mixed' },
    resetUncommittedChanges: { mode: 'mixed' },
    stashUncommittedChanges: { includeUntracked: true },
    applyStash: { reinstateIndex: false },
    popStash: { reinstateIndex: false },
    deleteBranch: { forceDelete: false },
    fetchRemote: { prune: false, pruneTags: false },
    fetchIntoLocalBranch: { forceFetch: false },
    cleanUntracked: { removeDirectories: false },
    pushBranch: { setUpstream: true, force: 'none' },
    referenceInputSpaceSubstitution: 'none',
  },
  customBranchGlobPatterns: [],
  customPullRequestProviders: [],
  customEmojiShortcodeMappings: {},
  initialLoad: 300,
  loadMore: 100,
  loadMoreAutomatically: true,
});

let db, log, send, git, gitActionsOverride, avatarsOverride;

/** Wire dependencies. Mirrors projects.js's init(ctx) so tests can inject fakes. */
function init(ctx = {}) {
  db = ctx.db || null;
  log = ctx.log || console;
  send = typeof ctx.send === 'function' ? ctx.send : (() => {});
  git = ctx.git || require('./git');
  gitActionsOverride = ctx.gitActions || null;
  avatarsOverride = ctx.avatars || null;
  if (ctx.actionTimeoutMs) DEFAULT_ACTION_TIMEOUT_MS = ctx.actionTimeoutMs;
  if (ctx.networkActionTimeoutMs) NETWORK_ACTION_TIMEOUT_MS = ctx.networkActionTimeoutMs;
  if (ctx.repoWatchPollMs) REPO_WATCH_POLL_MS = ctx.repoWatchPollMs;
  if (ctx.repoWatchDebounceMs) REPO_WATCH_DEBOUNCE_MS = ctx.repoWatchDebounceMs;
  if (ctx.repoWatchIdleSweepMs) REPO_WATCH_IDLE_SWEEP_MS = ctx.repoWatchIdleSweepMs;
  if (ctx.repoWatchIdleMaxMs) REPO_WATCH_IDLE_MAX_MS = ctx.repoWatchIdleMaxMs;
}

// git-actions.js may not exist yet at require-time in a partially-built
// tree; requiring it lazily (rather than at module scope) means this whole
// service can still load and be tested before that file lands. Tests inject
// a fake table via init({ gitActions }).
function loadGitActions() {
  if (gitActionsOverride) return gitActionsOverride;
  // eslint-disable-next-line global-require
  return require('./git-actions');
}

// --- Shared positional-argument validation for the read endpoints below ---
// Every rev/hash/remote read-endpoint argument here goes through the same
// discipline as git-actions.js's mutating whitelist — so this
// delegates to git-actions.js's real assertSafePositionalArg(value, kind)
// (the single choke point it defines for exactly this), falling back to an
// equivalent local baseline only if that module is unavailable (e.g. a
// stubbed gitActions in a unit test that doesn't care about this specific
// behaviour). This is intentionally the *same* function, not a second copy
// left to drift from it.
const HASH_RE = /^[0-9a-f]{4,40}$/i;
const REF_BASELINE_INVALID_RE = /[\x00-\x1f\x7f]|\.\.|@\{|(^\/)|(\/$)|(\.lock$)/;

function localAssertSafePositionalArg(value, kind) {
  const label = kind || 'value';
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label}: a value is required`);
  if (value.includes('\0')) throw new Error(`${label}: must not contain a NUL byte`);
  if (value.startsWith('-')) throw new Error(`${label}: must not start with '-'`);
  if (kind === 'hash') {
    if (!HASH_RE.test(value)) throw new Error(`${label}: '${value}' is not a valid commit hash`);
  } else if (REF_BASELINE_INVALID_RE.test(value)) {
    throw new Error(`${label}: '${value}' is not a valid reference name`);
  }
  return value;
}

function assertSafePositionalArg(value, kind) {
  try {
    const shared = loadGitActions().assertSafePositionalArg;
    if (typeof shared === 'function') return shared(value, kind);
  } catch { /* git-actions.js unavailable (or a test stub without it) — use the local baseline */ }
  return localAssertSafePositionalArg(value, kind);
}

function assertRev(value, label = 'revision') {
  return assertSafePositionalArg(value, label);
}

function assertHash(value, label = 'hash') {
  return assertSafePositionalArg(value, 'hash');
}

/** Path-traversal containment for a repo-relative file path touching the real worktree. */
function safeRelative(dir, relPath, label = 'path') {
  if (typeof relPath !== 'string' || !relPath) throw new Error(`${label} is required`);
  const normalized = relPath.replace(/\\/g, '/');
  const absolute = path.resolve(dir, normalized);
  const relative = path.relative(dir, absolute);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error(`${label} is outside the repository`);
  }
  return { absolute, relative: relative.split(path.sep).join('/') };
}

// --- Log revspec / ordering ---

function orderArgs(order) {
  if (order === 'author-date') return ['--author-date-order'];
  if (order === 'topo') return ['--topo-order'];
  return ['--date-order'];
}

function buildRevspec(opts = {}) {
  const args = [];
  const { branches, tags } = opts;
  const pickedTags = Array.isArray(tags);
  // An explicit branch list restricts the graph to those branches (plus any
  // explicitly picked tags); remote branches and all tags only join "Show All".
  const allBranches = !Array.isArray(branches) || (!branches.length && !(pickedTags && tags.length));
  if (allBranches) {
    args.push('--branches');
    if (opts.showRemote) args.push('--remotes');
  } else {
    for (const name of branches) args.push(assertRev(name, 'branch'));
  }
  if (pickedTags) {
    for (const name of tags) args.push(`refs/tags/${assertRev(name, 'tag')}`);
  } else if (allBranches && opts.showTags !== false) {
    args.push('--tags');
  }
  if (opts.includeReflogCommits) args.push('--reflog');
  if (opts.firstParentOnly) args.push('--first-parent');
  return args;
}

// --- Pseudo-commit synthesis ---
//
// Turns a Stash/Uncommitted entry into a commit-shaped row for display. Not
// wired into getProjectGitGraph below: that endpoint's paging (skip/hasMore)
// is defined purely in terms of real commits, and the renderer already does
// its own equivalent merge once it has the real commits plus the separate
// `stashes`/`uncommitted` fields — doing it here too would show every stash
// and the working-tree row twice. Kept as a plain, independently-tested
// formatter in case a future single-page (non-paginated) endpoint wants the
// same row shape without re-deriving it.

function synthesizeStashPseudoCommit(stash) {
  return {
    hash: stash.hash,
    shortHash: stash.hash.slice(0, 7),
    parents: stash.baseCommitHash ? [stash.baseCommitHash] : [],
    authorName: stash.branch ? `stash@{${stash.index}} on ${stash.branch}` : `stash@{${stash.index}}`,
    authorEmail: '',
    authorDate: stash.date,
    committerName: '',
    committerEmail: '',
    commitDate: stash.date,
    subject: stash.message,
    isHead: false,
    refs: { heads: [], remotes: [], tags: [] },
    kind: 'stash',
    stashIndex: stash.index,
  };
}

function synthesizeUncommittedPseudoCommit(headHash, uncommitted) {
  const now = new Date().toISOString();
  return {
    hash: '#uncommitted',
    shortHash: '#uncommit',
    parents: headHash ? [headHash] : [],
    authorName: '*',
    authorEmail: '',
    authorDate: now,
    committerName: '*',
    committerEmail: '',
    commitDate: now,
    subject: `Uncommitted Changes (${uncommitted ? uncommitted.changeCount : 0})`,
    isHead: false,
    refs: { heads: [], remotes: [], tags: [] },
    kind: 'uncommitted',
  };
}

/** Merge stash/uncommitted pseudo-commits into the loaded commit window. */
function interleavePseudoCommits(commits, { stashes = [], uncommitted = null, headHash = null } = {}) {
  const byHash = new Map(commits.map((c, i) => [c.hash, i]));
  const out = commits.slice();
  // Insert each stash directly above its base commit's row, when that base
  // commit is actually part of this loaded window. A stash whose base commit
  // is outside the current page is still reported in `stashes` (for the
  // stash list / menus) but is not mis-positioned into this page's rows —
  // a documented simplification, not silently wrong placement.
  const insertions = [];
  for (const stash of stashes) {
    const pseudo = synthesizeStashPseudoCommit(stash);
    const idx = byHash.get(stash.baseCommitHash);
    if (idx !== undefined) insertions.push({ at: idx, commit: pseudo });
  }
  insertions.sort((a, b) => a.at - b.at);
  let offset = 0;
  for (const { at, commit } of insertions) {
    out.splice(at + offset, 0, commit);
    offset += 1;
  }
  if (uncommitted) {
    out.unshift(synthesizeUncommittedPseudoCommit(headHash, uncommitted));
  }
  return out;
}

// --- Uncommitted changes (built from git.js's already-exported primitives —
// no new frozen git.js function needed for this) ---

const UNTRACKED_STAT_MAX_BYTES = 2 * 1024 * 1024;

function countFileLines(absolutePath) {
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile() || stat.size > UNTRACKED_STAT_MAX_BYTES) return 0;
    const content = fs.readFileSync(absolutePath);
    if (content.includes(0)) return 0; // binary
    if (!content.length) return 0;
    return content.toString('utf8').split('\n').length - (content.at(-1) === 10 ? 1 : 0);
  } catch { return 0; }
}

function parseNumstat(output) {
  const byPath = new Map();
  for (const line of String(output || '').split('\n')) {
    if (!line) continue;
    const [ins, del, ...rest] = line.split('\t');
    const filePath = rest.join('\t');
    if (!filePath) continue;
    const arrow = filePath.split(' => ');
    const finalPath = arrow.length > 1 ? arrow[1].replace(/[{}]/g, '').trim() : filePath;
    byPath.set(finalPath, {
      insertions: ins === '-' ? 0 : Number(ins) || 0,
      deletions: del === '-' ? 0 : Number(del) || 0,
    });
  }
  return byPath;
}

async function buildUncommitted(dir) {
  const raw = await git.run(['-c', 'core.quotepath=false', '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], dir);
  const changes = git.parsePorcelain(raw);
  if (!changes.length) return null;

  let numstat = new Map();
  try {
    const out = await git.run(['-c', 'core.quotepath=false', '--no-optional-locks', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--numstat', 'HEAD'], dir);
    numstat = parseNumstat(out);
  } catch { /* unborn HEAD or nothing staged against HEAD yet */ }

  const files = changes.map((change) => {
    const stat = numstat.get(change.path) || null;
    let insertions = stat ? stat.insertions : 0;
    let deletions = stat ? stat.deletions : 0;
    if (change.status === 'untracked' && !stat) {
      insertions = countFileLines(path.resolve(dir, change.path));
    }
    return {
      path: change.path,
      oldPath: change.oldPath,
      status: change.status,
      insertions,
      deletions,
    };
  });

  return { changeCount: files.length, changes: files };
}

// --- Read endpoints ---

/** Current HEAD commit hash, or null on an unborn HEAD. Works whether HEAD is attached or detached. */
async function currentHeadHash(dir) {
  try { return await git.run(['--no-optional-locks', 'rev-parse', 'HEAD'], dir); } catch { return null; }
}

/** getProjectGitGraph — assembles commits+refs+stashes+uncommitted, paged. */
async function getProjectGitGraph(dir, opts = {}) {
  const limit = Math.max(1, Math.min(5000, Number(opts.limit) || 300));
  const skip = Math.max(0, Number(opts.skip) || 0);
  const order = opts.order === 'author-date' || opts.order === 'topo' ? opts.order : 'date';

  const revspec = buildRevspec(opts);
  const [raw, headHash] = await Promise.all([
    git.logWithParents(dir, { revspec, order, skip, limit: limit + 1 }),
    currentHeadHash(dir),
  ]);
  const hasMore = raw.length > limit;
  const commits = raw.slice(0, limit);

  let refs = null;
  if (!opts.refsUnchanged) {
    refs = await git.forEachRef(dir);
    // showTags only gated the log traversal above (whether a tag-only commit
    // is reachable at all); the ref set itself always comes back with every
    // tag, so "Show Tags" off must also strip them here or every tag pill
    // stays visible regardless of the toggle.
    if (opts.showTags === false) refs.tags = [];
    applyRefsToCommits(commits, refs, headHash);
  } else {
    markHead(commits, headHash);
  }

  let stashes = [];
  if (opts.showStashes !== false) {
    try { stashes = await git.stashList(dir); } catch (err) { log.info?.('[git-graph] stashList failed', err.message); }
  }

  let uncommitted = null;
  if (opts.showUncommittedChanges !== false) {
    try { uncommitted = await buildUncommitted(dir); } catch (err) { log.info?.('[git-graph] uncommitted diff failed', err.message); }
  }

  // `commits` here is real commits only — see the note above
  // synthesizeStashPseudoCommit for why the stash/uncommitted rows aren't
  // merged into it at this layer.
  return { ok: true, commits, refs, stashes, uncommitted, hasMore };
}

function markHead(commits, headHash) {
  if (!headHash) return;
  const c = commits.find(item => item.hash === headHash);
  if (c) c.isHead = true;
}

// forEachRef (git.js) reports `isHead` per local-branch entry, but that
// only tells us *which branch* is checked out, not the commit HEAD actually
// points at while detached — so commit-level isHead is always derived from
// the separately rev-parsed headHash, never from refs.heads[].isHead.
function applyRefsToCommits(commits, refs, headHash) {
  if (!refs) return;
  const byHash = new Map(commits.map(c => [c.hash, c]));
  for (const head of refs.heads || []) {
    const c = byHash.get(head.hash);
    if (c) {
      c.refs = c.refs || { heads: [], remotes: [], tags: [] };
      c.refs.heads.push(head.name);
    }
  }
  for (const remote of refs.remotes || []) {
    const c = byHash.get(remote.hash);
    if (c) {
      c.refs = c.refs || { heads: [], remotes: [], tags: [] };
      c.refs.remotes.push({ remote: remote.remote, name: remote.name });
    }
  }
  for (const tag of refs.tags || []) {
    const c = byHash.get(tag.hash);
    if (c) {
      c.refs = c.refs || { heads: [], remotes: [], tags: [] };
      c.refs.tags.push(tag.name);
    }
  }
  markHead(commits, headHash);
}

async function diffNameStatusAndStat(dir, fromRev, toRevOrNull) {
  assertRev(fromRev, 'fromRev');
  const uncommitted = toRevOrNull === null || toRevOrNull === '#uncommitted' || toRevOrNull === undefined;
  const toArgs = uncommitted ? [] : [assertRev(toRevOrNull, 'toRev')];

  // `git diff` never reports a file it has no tracked blob for on either
  // side, so a plain diff against the working tree always omits untracked
  // files — listed here separately and merged in below, the same way
  // buildUncommitted() already does for the Uncommitted Changes row's own
  // file count.
  const [nameStatusRaw, numstatRaw, untrackedRaw] = await Promise.all([
    git.run(['-c', 'core.quotepath=false', '--no-optional-locks', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--name-status', '-z', fromRev, ...toArgs], dir),
    git.run(['-c', 'core.quotepath=false', '--no-optional-locks', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--numstat', '-z', fromRev, ...toArgs], dir),
    uncommitted
      ? git.run(['-c', 'core.quotepath=false', '--no-optional-locks', 'ls-files', '--others', '--exclude-standard', '-z'], dir)
      : Promise.resolve(''),
  ]);

  const statusByPath = new Map();
  const nsFields = nameStatusRaw.split('\0').filter(Boolean);
  for (let i = 0; i < nsFields.length; i += 1) {
    const code = nsFields[i];
    if (!/^[AMDRCU]/.test(code)) continue;
    let filePath = nsFields[++i];
    let oldPath = null;
    if (/^[RC]/.test(code)) { oldPath = filePath; filePath = nsFields[++i]; }
    const kind = code[0] === 'A' ? 'added' : code[0] === 'D' ? 'deleted'
      : code[0] === 'R' ? 'renamed' : code[0] === 'C' ? 'renamed'
      : code[0] === 'U' ? 'conflicted' : 'modified';
    statusByPath.set(filePath, { path: filePath, oldPath, status: kind, insertions: 0, deletions: 0 });
  }

  const nsNum = numstatRaw.split('\0').filter(Boolean);
  for (let i = 0; i < nsNum.length; i += 1) {
    const insRaw = nsNum[i];
    const parts = insRaw.split('\t');
    let ins = parts[0], del = parts[1], filePath = parts[2];
    if (filePath === undefined) { filePath = nsNum[++i]; }
    let oldPath = null;
    if (filePath === '' || filePath === undefined) { oldPath = nsNum[++i]; filePath = nsNum[++i]; }
    const entry = statusByPath.get(filePath) || statusByPath.get(oldPath);
    if (entry) {
      entry.insertions = ins === '-' ? 0 : Number(ins) || 0;
      entry.deletions = del === '-' ? 0 : Number(del) || 0;
    }
  }

  if (uncommitted) {
    for (const filePath of untrackedRaw.split('\0').filter(Boolean)) {
      if (statusByPath.has(filePath)) continue;
      statusByPath.set(filePath, {
        path: filePath, oldPath: null, status: 'untracked',
        insertions: countFileLines(path.resolve(dir, filePath)), deletions: 0,
      });
    }
  }

  return [...statusByPath.values()];
}

async function getGitGraphCommitDetail(dir, hash) {
  assertHash(hash, 'hash');
  const fields = ['%H', '%h', '%P', '%an', '%ae', '%aI', '%cn', '%ce', '%cI', '%s'].join('%x00');
  const raw = await git.run(['--no-optional-locks', 'log', '-1', '--no-color', '--no-show-signature', `--pretty=format:${fields}%x00%b`, hash], dir);
  const parts = raw.split('\0');
  const [rawHash, shortHash, parentsRaw, authorName, authorEmail, authorDate, committerName, committerEmail, commitDate, subject] = parts;
  const body = parts.slice(10).join('\0');
  const parents = parentsRaw ? parentsRaw.split(' ').filter(Boolean) : [];
  const fromRev = parents[0] || EMPTY_TREE_HASH;
  const files = await diffNameStatusAndStat(dir, fromRev, rawHash);
  return {
    ok: true,
    commit: {
      hash: rawHash, shortHash, parents,
      authorName, authorEmail, authorDate,
      committerName, committerEmail, commitDate,
      subject, body,
      isHead: false,
      refs: { heads: [], remotes: [], tags: [] },
    },
    files,
  };
}

async function getGitGraphCompareDetail(dir, fromHash, toHash) {
  assertHash(fromHash, 'fromHash');
  if (toHash !== null && toHash !== undefined) assertHash(toHash, 'toHash');
  const files = await diffNameStatusAndStat(dir, fromHash, toHash ?? null);
  return { ok: true, files };
}

async function getGitGraphFileAtRevision(dir, rev, relPath) {
  assertRev(rev, 'rev');
  const { relative } = safeRelative(dir, relPath, 'path');
  const content = await git.blobAtRevision(dir, rev, relative);
  return { ok: true, content };
}

async function getGitGraphFileDiffBetween(dir, fromRev, toRevOrNull, relPath) {
  assertRev(fromRev, 'fromRev');
  const { relative, absolute } = safeRelative(dir, relPath, 'path');
  let oldContent = '';
  try { oldContent = await git.blobAtRevision(dir, fromRev, relative); } catch { oldContent = ''; }

  let newContent = '';
  if (toRevOrNull === null || toRevOrNull === undefined) {
    try { newContent = fs.readFileSync(absolute, 'utf8'); } catch { newContent = ''; }
  } else {
    assertRev(toRevOrNull, 'toRev');
    try { newContent = await git.blobAtRevision(dir, toRevOrNull, relative); } catch { newContent = ''; }
  }
  return { ok: true, oldContent, newContent };
}

// --- Repo config ---

function readExternalConfigFile(dir) {
  try {
    const file = path.join(dir, EXTERNAL_CONFIG_FILE);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > EXTERNAL_CONFIG_MAX_BYTES) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch { return null; }
}

function pickExternalFields(raw) {
  const out = {};
  for (const key of EXTERNAL_CONFIG_FIELDS) if (key in raw) out[key] = raw[key];
  return out;
}

/** A stable digest of the picked external fields, so a later commit that changes
 * .switchboard-git-graph.json can be told apart from the exact content a user
 * already reviewed and trusted — the trust gate below is keyed on this
 * content, not just on which repo occupies this path — see
 * trustGitGraphRepoConfig/getGitGraphRepoConfig. */
function hashExternalFields(fields) {
  return crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

function sameHashSet(a, b) {
  const sa = [...(a || [])].sort().join(',');
  const sb = [...(b || [])].sort().join(',');
  return sa === sb;
}

/**
 * The persisted base config, identity-checked but with the
 * external-file merge NOT yet applied. Every writer (setGitGraphRepoConfig,
 * trustGitGraphRepoConfig) must build on *this*, never on
 * getGitGraphRepoConfig's own return value — that one may already have the
 * external file's fields merged in, and persisting that merged view back
 * would bake a trusted file's contents permanently into the stored config,
 * surviving even after trust is later revoked.
 */
async function getStoredRepoConfigBase(dir) {
  const stored = db.getSetting(repoConfigKey(dir));
  let rootHashes = [];
  try { rootHashes = await git.rootCommitHashes(dir); } catch { rootHashes = []; }

  if (!stored || !sameHashSet(stored.rootCommitHashes, rootHashes)) {
    // No stored config yet, or a different repository now occupies this path
    // — never inherit its settings.
    const fresh = { ...DEFAULT_REPO_CONFIG, rootCommitHashes: rootHashes };
    db.setSetting(repoConfigKey(dir), fresh);
    return fresh;
  }
  return { ...DEFAULT_REPO_CONFIG, ...stored, rootCommitHashes: rootHashes };
}

/** Read RepoConfig, re-checking repo identity before trusting the cache. */
async function getGitGraphRepoConfig(dir) {
  const base = await getStoredRepoConfigBase(dir);
  let trusted = !!base.trustedExternalConfig;
  let config = base;
  if (trusted) {
    const ext = readExternalConfigFile(dir);
    if (ext) {
      const picked = pickExternalFields(ext);
      if (hashExternalFields(picked) === base.trustedExternalConfigHash) {
        config = { ...base, ...picked };
      } else {
        // The file has changed since the user actually reviewed and trusted
        // it — a further commit could just as easily be a supply-chain
        // compromise as a legitimate edit, so trust does not silently carry
        // over to new content. Revert to untrusted and drop the stale hash,
        // so gitGraphShowTrustRepoConfigDialog runs again on the new content.
        trusted = false;
        config = { ...base, trustedExternalConfig: false, trustedExternalConfigHash: null };
        db.setSetting(repoConfigKey(dir), config);
      }
    }
  }
  return { ok: true, config, trusted };
}

// --- Patch validation — every field the view round-trips through
// setGitGraphRepoConfig/setGitGraphGlobalPreferences is checked against a
// known-field allow-list and a light type check before it's ever persisted,
// so a caller's typo (or a stale/renamed field from an older build) fails
// loudly instead of quietly living on forever in a stored blob nothing reads
// back. This is deliberately shallow (one predicate per field, no schema
// library) — the fields here are plain, already-enumerated in DEFAULT_REPO_
// CONFIG/DEFAULT_GLOBAL_PREFS above, so a full schema would just restate
// that table a second time. ---

const isBoolean = (v) => typeof v === 'boolean';
const isBooleanOrNull = (v) => v === null || typeof v === 'boolean';
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isFiniteNumberOrNull = (v) => v === null || isFiniteNumber(v);
const isNonEmptyString = (v) => typeof v === 'string';
const isStringOrNull = (v) => v === null || typeof v === 'string';
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isArrayOfStrings = (v) => Array.isArray(v) && v.every((item) => typeof item === 'string');
const isEnumOf = (...values) => (v) => values.includes(v);

/** {name: string, templateUrl: string}[] — git-graph.customPullRequestProviders. */
const isCustomPullRequestProviderList = (v) => Array.isArray(v)
  && v.every((entry) => isPlainObject(entry) && typeof entry.name === 'string' && typeof entry.templateUrl === 'string');

const REPO_CONFIG_VALIDATORS = {
  showRemoteBranches: isBoolean,
  showRemoteHeads: isBoolean,
  showStashes: isBoolean,
  showTags: isBoolean,
  showCommitsOnlyReferencedByTags: isBoolean,
  showUncommittedChanges: isBoolean,
  showUntrackedFiles: isBoolean,
  includeCommitsMentionedByReflogs: isBoolean,
  onlyFollowFirstParent: isBoolean,
  muteMergeCommits: isBoolean,
  muteNonAncestors: isBoolean,
  commitsOrder: isEnumOf('date', 'author-date', 'topo'),
  useMailmap: isBoolean,
  signCommits: isBoolean,
  signTags: isBoolean,
  onLoadScrollToHead: isBoolean,
  onLoadShowCheckedOutBranch: isBoolean,
  onLoadShowSpecificBranches: isArrayOfStrings,
  customDisplayName: isStringOrNull,
  perRemoteVisibility: (v) => isPlainObject(v) && Object.values(v).every(isBoolean),
  issueLinking: (v) => v === null || (isPlainObject(v)
    && (v.regex === undefined || typeof v.regex === 'string')
    && (v.url === undefined || typeof v.url === 'string')
    && (v.useGlobally === undefined || isBoolean(v.useGlobally))),
  pullRequestProvider: (v) => v === null || isPlainObject(v),
  branchDropdownSelection: (v) => v === 'all' || isArrayOfStrings(v),
  columnWidths: (v) => isPlainObject(v) && Object.values(v).every(isFiniteNumber),
  commitDetailsPanelHeight: isFiniteNumberOrNull,
  fetchAvatars: isBooleanOrNull,
  fetchAndPrune: isBoolean,
  fetchAndPruneTags: isBoolean,
  showSignatureStatus: isBoolean,
  fileEncoding: isNonEmptyString,
  codeReview: isPlainObject,
};

/** Fields a patch may carry but that are never taken from it directly —
 * validated as "known" but silently stripped, not type-checked or rejected here.
 * avatarsSelfHostedGitLabHost is here for a different reason than the other
 * two: it's meant to require its own one-time confirmation of exactly which
 * host commit-author emails will be sent to (see setGitGraphAvatarsSelfHostedGitLabHost
 * below), so the generic patch channel — reachable from any script running in
 * the renderer — must never be able to set it, confirmed or not. */
const REPO_CONFIG_SERVER_MANAGED_FIELDS = new Set(['rootCommitHashes', 'trustedExternalConfig', 'trustedExternalConfigHash', 'avatarsSelfHostedGitLabHost']);

const SELF_HOSTED_GITLAB_HOST_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;

/**
 * Sets RepoConfig.avatarsSelfHostedGitLabHost directly, bypassing the generic
 * setGitGraphRepoConfig patch path entirely — the only way this field is ever
 * written. Callers (main.js's IPC handler) must only reach this after the
 * user has actually confirmed, in a real dialog naming this exact host, that
 * this repo's commit-author email addresses may be sent to it for avatar
 * lookup; this function itself only validates the host's shape, it does not
 * (and cannot, from here) confirm anything.
 */
async function setGitGraphAvatarsSelfHostedGitLabHost(dir, host) {
  if (host !== null && (typeof host !== 'string' || !SELF_HOSTED_GITLAB_HOST_RE.test(host))) {
    throw new Error(`'${host}' is not a valid host name`);
  }
  const current = await getStoredRepoConfigBase(dir);
  db.setSetting(repoConfigKey(dir), { ...current, avatarsSelfHostedGitLabHost: host });
  return getGitGraphRepoConfig(dir);
}

function validateRepoConfigPatch(patch) {
  for (const key of Object.keys(patch || {})) {
    if (REPO_CONFIG_SERVER_MANAGED_FIELDS.has(key)) continue;
    if (!(key in DEFAULT_REPO_CONFIG)) throw new Error(`Unknown Git Graph repository setting: '${key}'`);
    const value = patch[key];
    const isValid = REPO_CONFIG_VALIDATORS[key];
    if (value !== undefined && isValid && !isValid(value)) throw new Error(`Invalid value for Git Graph repository setting '${key}'`);
  }
}

async function setGitGraphRepoConfig(dir, patch = {}) {
  validateRepoConfigPatch(patch);
  const current = await getStoredRepoConfigBase(dir);
  const safePatch = { ...patch };
  for (const key of REPO_CONFIG_SERVER_MANAGED_FIELDS) delete safePatch[key];
  const next = { ...current, ...safePatch };
  db.setSetting(repoConfigKey(dir), next);
  return getGitGraphRepoConfig(dir);
}

async function trustGitGraphRepoConfig(dir, trusted) {
  const current = await getStoredRepoConfigBase(dir);
  // Pin trust to the exact content the user is reviewing right now (in
  // gitGraphShowTrustRepoConfigDialog) — not just to this repo's identity —
  // so a later, unreviewed commit to the external file can't silently ride
  // in on an old approval (see the matching check in getGitGraphRepoConfig).
  const ext = trusted ? readExternalConfigFile(dir) : null;
  const trustedExternalConfigHash = trusted && ext ? hashExternalFields(pickExternalFields(ext)) : null;
  db.setSetting(repoConfigKey(dir), { ...current, trustedExternalConfig: !!trusted, trustedExternalConfigHash });
  return getGitGraphRepoConfig(dir);
}

/**
 * Writes this repo's shareable Git Graph settings to `.switchboard-git-graph.json`
 * at the repo root — exactly the same EXTERNAL_CONFIG_FIELDS
 * allow-list that readExternalConfigFile()/pickExternalFields() apply on the
 * way back in, so export and the trust-gated import stay symmetric by
 * construction rather than by two lists kept in sync by hand. The write is
 * atomic (write to a sibling temp file, then rename over the target) so a
 * reader — including this same process's next getGitGraphRepoConfig() call —
 * never observes a half-written file.
 */
async function exportGitGraphRepoConfig(dir) {
  const base = await getStoredRepoConfigBase(dir);
  const payload = pickExternalFields(base);
  const file = path.join(dir, EXTERNAL_CONFIG_FILE);
  const tmpFile = path.join(dir, `${EXTERNAL_CONFIG_FILE}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpFile, file);
  return { ok: true, path: file };
}

// --- User Details — local vs global git identity, read-only here;
// the write path is setUserDetails in git-actions.js. ---

async function getGitGraphUserDetails(dir) {
  return { ok: true, details: await git.userDetails(dir) };
}

// --- Global preferences ---

function mergeOneLevel(base, patch) {
  const out = { ...base };
  for (const key of Object.keys(patch || {})) {
    const value = patch[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = { ...base[key], ...value };
    } else {
      out[key] = value;
    }
  }
  return out;
}

function getGitGraphGlobalPreferences() {
  const stored = db.getSetting(GLOBAL_PREFS_KEY);
  const preferences = mergeOneLevel(DEFAULT_GLOBAL_PREFS, stored || {});
  if (stored && stored.dialogDefaults) {
    preferences.dialogDefaults = mergeOneLevel(DEFAULT_GLOBAL_PREFS.dialogDefaults, stored.dialogDefaults);
  }
  return { ok: true, preferences };
}

const GLOBAL_PREFS_VALIDATORS = {
  dateFormat: isEnumOf('date-time', 'date-only', 'iso', 'iso-date-only', 'relative'),
  dateType: isEnumOf('author', 'commit'),
  graphStyle: isEnumOf('rounded', 'angular'),
  graphColours: isArrayOfStrings,
  columnVisibility: (v) => isPlainObject(v) && ['date', 'author', 'commit'].every((k) => v[k] === undefined || isBoolean(v[k])),
  referenceLabelAlignment: isEnumOf('normal', 'branches-left-tags-right', 'branches-on-graph-tags-right'),
  combineLocalAndRemoteBranchLabels: isBoolean,
  fetchAvatars: isBoolean,
  contextMenuActionsVisibility: isPlainObject,
  repositoryDropdownOrder: isEnumOf('fullPath', 'name', 'attachmentOrder'),
  markdownRendering: isBoolean,
  enhancedAccessibility: isBoolean,
  graphUncommittedChangesStyle: isEnumOf('openAtUncommitted', 'openAtCheckedOutCommit'),
  commitDetailsView: (v) => isPlainObject(v)
    && (v.location === undefined || isEnumOf('inline', 'docked')(v.location))
    && (v.autoCenter === undefined || isBoolean(v.autoCenter)),
  fileViewType: isEnumOf('tree', 'list'),
  compactFolders: isBoolean,
  customBranchGlobPatterns: isArrayOfStrings,
  customPullRequestProviders: isCustomPullRequestProviderList,
  customEmojiShortcodeMappings: isPlainObject,
  initialLoad: isFiniteNumber,
  loadMore: isFiniteNumber,
  loadMoreAutomatically: isBoolean,
};

/** One level down from validateGlobalPrefsPatch below — checks only that every
 * sub-key of a `dialogDefaults` patch names a real dialog (per-field value shape
 * inside each dialog's own defaults object is left to that dialog, same as
 * today; the field this closes is the "typo'd/renamed dialog name silently
 * ignored forever" gap, not a full per-field schema for all 16 dialogs). */
function validateDialogDefaultsPatch(patch) {
  if (!isPlainObject(patch)) throw new Error("Invalid value for Git Graph preference 'dialogDefaults'");
  for (const key of Object.keys(patch)) {
    if (!(key in DEFAULT_GLOBAL_PREFS.dialogDefaults)) throw new Error(`Unknown Git Graph dialog default: '${key}'`);
  }
}

function validateGlobalPrefsPatch(patch) {
  for (const key of Object.keys(patch || {})) {
    if (!(key in DEFAULT_GLOBAL_PREFS)) throw new Error(`Unknown Git Graph preference: '${key}'`);
    const value = patch[key];
    if (key === 'dialogDefaults') {
      if (value !== undefined) validateDialogDefaultsPatch(value);
      continue;
    }
    const isValid = GLOBAL_PREFS_VALIDATORS[key];
    if (value !== undefined && isValid && !isValid(value)) throw new Error(`Invalid value for Git Graph preference '${key}'`);
  }
}

function setGitGraphGlobalPreferences(patch = {}) {
  validateGlobalPrefsPatch(patch);
  const current = getGitGraphGlobalPreferences().preferences;
  const next = mergeOneLevel(current, patch);
  if (patch.dialogDefaults) next.dialogDefaults = mergeOneLevel(current.dialogDefaults, patch.dialogDefaults);
  db.setSetting(GLOBAL_PREFS_KEY, next);
  return { ok: true, preferences: next };
}

// --- Remotes / tags ---

async function getGitGraphRemotes(dir) {
  return { ok: true, remotes: await git.remoteList(dir) };
}

async function getGitGraphTagDetails(dir, tagName) {
  assertRev(tagName, 'tagName');
  const format = ['%(objectname)', '%(*objectname)', '%(taggername)', '%(taggeremail:trim)', '%(taggerdate:iso-strict)', '%(contents)'].join('%00');
  const raw = await git.run(['--no-optional-locks', 'for-each-ref', `refs/tags/${tagName}`, `--format=${format}`], dir);
  if (!raw) throw new Error(`Tag not found: ${tagName}`);
  const [objectHash, dereferenced, tagger, email, date, ...rest] = raw.split('\0');
  const message = rest.join('\0');
  const commitHash = dereferenced || objectHash;
  return {
    ok: true,
    tag: { name: tagName, tagger: tagger || null, email: email || null, date: date || null, message: message || '', objectHash, commitHash },
  };
}

// --- Avatars (delegated to git-graph-avatars.js) ---

function loadAvatars() {
  if (avatarsOverride) return avatarsOverride;
  // eslint-disable-next-line global-require
  return require('./git-graph-avatars');
}

async function getGitGraphAvatarUrl(dir, email) {
  const { config } = await getGitGraphRepoConfig(dir);
  const { preferences } = getGitGraphGlobalPreferences();
  const enabled = config.fetchAvatars === null || config.fetchAvatars === undefined ? preferences.fetchAvatars : config.fetchAvatars;
  if (!enabled) return { ok: true, url: null };
  const avatars = loadAvatars();
  try {
    const remotes = await git.remoteList(dir).catch(() => []);
    const origin = remotes.find(r => r.name === 'origin') || remotes[0] || null;
    const url = await avatars.getAvatarUrl(email, { originUrl: origin ? origin.url : null, repoConfig: config });
    return { ok: true, url };
  } catch (err) {
    log.info?.('[git-graph] avatar lookup failed', err.message);
    return { ok: true, url: null };
  }
}

async function clearAvatarCache() {
  const avatars = loadAvatars();
  return avatars.clearCache();
}

// --- Mutating action dispatcher ---

const inFlight = new Map(); // folderPath -> { actionId, controller, cancelled }

async function runGitGraphAction(dir, actionId, params) {
  let actions;
  try {
    actions = loadGitActions().ACTIONS;
  } catch (err) {
    return { error: `Git actions are unavailable: ${err.message}` };
  }
  const entry = actions && actions[actionId];
  if (!entry || typeof entry.run !== 'function') {
    return { error: `Unknown git graph action: ${actionId}` };
  }
  if (inFlight.has(dir)) {
    return { error: 'An operation is already running for this repository' };
  }

  const controller = new AbortController();
  const timeoutMs = NETWORK_ACTION_IDS.has(actionId) ? NETWORK_ACTION_TIMEOUT_MS : DEFAULT_ACTION_TIMEOUT_MS;
  const record = { actionId, controller, cancelled: false, timedOut: false };
  inFlight.set(dir, record);
  const timer = setTimeout(() => { record.timedOut = true; controller.abort(); }, timeoutMs);

  const onProgress = (text) => { try { send('git-graph-action-progress', { folderPath: dir, actionId, text }); } catch {} };

  try {
    const result = await entry.run(dir, params || {}, { signal: controller.signal, onProgress });
    return result && typeof result === 'object' ? { ok: true, ...result } : { ok: true };
  } catch (err) {
    if (record.timedOut) return { error: `git-graph: "${actionId}" timed out` };
    if (record.cancelled) return { error: `git-graph: "${actionId}" was cancelled` };
    return { error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
    inFlight.delete(dir);
  }
}

function cancelGitGraphAction(dir, actionId) {
  const record = inFlight.get(dir);
  if (!record || (actionId && record.actionId !== actionId)) return { ok: true, cancelled: false };
  record.cancelled = true;
  record.controller.abort();
  return { ok: true, cancelled: true };
}

// --- Repo-change watcher — polling fingerprint of HEAD/packed-refs/refs/*,
// deliberately not relying on fs.watch's inconsistent recursive support. ---

const watches = new Map(); // folderPath -> { commonDir, fingerprint, timer, debounceTimer, lastAccess, primed }
let idleSweepTimer = null;

function statMtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function computeFingerprint(commonDir) {
  const parts = [statMtime(path.join(commonDir, 'HEAD')), statMtime(path.join(commonDir, 'packed-refs')), statMtime(path.join(commonDir, 'index'))];
  const refsRoot = path.join(commonDir, 'refs');
  let count = 0;
  const stack = [refsRoot];
  while (stack.length && count < REFS_WALK_MAX_ENTRIES) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (count >= REFS_WALK_MAX_ENTRIES) break;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      parts.push(`${full}:${statMtime(full)}`);
      count += 1;
    }
  }
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
}

function pollOnce(folderPath) {
  const state = watches.get(folderPath);
  if (!state) return;
  const fp = computeFingerprint(state.commonDir);
  if (!state.primed) { state.fingerprint = fp; state.primed = true; return; }
  if (fp === state.fingerprint) return;
  state.fingerprint = fp;
  clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => { try { send('git-graph-repo-changed', folderPath); } catch {} }, REPO_WATCH_DEBOUNCE_MS);
}

function sweepIdleWatches() {
  const now = Date.now();
  for (const [folderPath, state] of watches) {
    if (now - state.lastAccess > REPO_WATCH_IDLE_MAX_MS) stopRepoWatch(folderPath);
  }
}

async function ensureRepoWatch(dir) {
  const existing = watches.get(dir);
  if (existing) { existing.lastAccess = Date.now(); return; }
  let commonDir;
  try { commonDir = await git.gitCommonDir(dir); } catch { return; }
  const state = { commonDir, fingerprint: null, primed: false, debounceTimer: null, lastAccess: Date.now() };
  state.timer = setInterval(() => pollOnce(dir), REPO_WATCH_POLL_MS);
  if (typeof state.timer.unref === 'function') state.timer.unref();
  watches.set(dir, state);
  pollOnce(dir); // establish the baseline fingerprint without firing a spurious change

  if (!idleSweepTimer) {
    idleSweepTimer = setInterval(sweepIdleWatches, REPO_WATCH_IDLE_SWEEP_MS);
    if (typeof idleSweepTimer.unref === 'function') idleSweepTimer.unref();
  }
}

function stopRepoWatch(dir) {
  const state = watches.get(dir);
  if (!state) return;
  clearInterval(state.timer);
  clearTimeout(state.debounceTimer);
  watches.delete(dir);
}

function stopAllRepoWatches() {
  for (const folderPath of [...watches.keys()]) stopRepoWatch(folderPath);
  if (idleSweepTimer) { clearInterval(idleSweepTimer); idleSweepTimer = null; }
}

module.exports = {
  init,
  DEFAULT_REPO_CONFIG,
  DEFAULT_GLOBAL_PREFS,
  synthesizeStashPseudoCommit,
  synthesizeUncommittedPseudoCommit,
  interleavePseudoCommits,
  getProjectGitGraph,
  getGitGraphCommitDetail,
  getGitGraphCompareDetail,
  getGitGraphFileAtRevision,
  getGitGraphFileDiffBetween,
  getGitGraphRepoConfig,
  setGitGraphRepoConfig,
  trustGitGraphRepoConfig,
  setGitGraphAvatarsSelfHostedGitLabHost,
  exportGitGraphRepoConfig,
  getGitGraphUserDetails,
  getGitGraphGlobalPreferences,
  setGitGraphGlobalPreferences,
  getGitGraphRemotes,
  getGitGraphTagDetails,
  getGitGraphAvatarUrl,
  clearAvatarCache,
  runGitGraphAction,
  cancelGitGraphAction,
  ensureRepoWatch,
  stopRepoWatch,
  stopAllRepoWatches,
};

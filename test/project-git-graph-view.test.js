// Renderer-logic tests for the Git Graph tab (public/project-git-graph-view.js
// + public/git-graph-render.js), in the house `node --test` style used by
// test/git.test.js / test/projects.test.js: the modules are dedicated,
// side-effect-free-at-require-time files, so they are `require()`d directly
// (no jsdom/Electron) with the handful of browser globals they read
// (`escapeHtml`, `PICONS`, `window.api`, `showContextMenu`, …) provided as
// plain stubs — the same idea as test/project-messages-view.test.js's
// vm+stubbed-globals approach, minus the vm slicing this file doesn't need
// since it owns its whole source file.
//
// Deliberately does NOT load git-graph-layout.js / git-graph-menus.js /
// git-graph-dialogs.js (files owned elsewhere): every call into them is
// behind a `typeof x === 'function'` guard, and this suite exists partly to
// prove that guard holds — the tab's own logic must not depend on those
// files being present. git-graph-settings.js is different: it's this same
// tab's own secondary-UI code, just split into its own file for size, so it
// loads here unguarded exactly like git-graph-render.js does.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

global.escapeHtml = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
global.escapeAttr = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const render = require(path.join(__dirname, '../public/git-graph-render.js'));
Object.assign(global, render);

const settings = require(path.join(__dirname, '../public/git-graph-settings.js'));
Object.assign(global, settings);

const view = require(path.join(__dirname, '../public/project-git-graph-view.js'));
Object.assign(global, view);

// --- Small fake-DOM element, enough for the paint/wire functions under test
// to run to completion without throwing — mirrors project-messages-view.test.js's
// hand-stubbed-element idea, generalised so every query returns *something*
// usable rather than enumerating every selector a render pass might touch. ---

function fakeElement() {
  const el = {
    style: {}, dataset: {}, className: '', innerHTML: '', textContent: '',
    isConnected: true,
    appendChild(child) { return child; },
    prepend() {},
    remove() {},
    focus() {}, select() {}, scrollIntoView() {},
    closest() { return null; },
    getAttribute() { return null; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    querySelector() { return fakeElement(); },
    querySelectorAll() { return []; },
  };
  return el;
}

function fakeTargetElement(attrs, href) {
  const dataset = { ...attrs };
  const el = {
    dataset,
    getAttribute(name) { return name === 'href' ? (href || null) : null; },
    href,
    closest(selector) {
      return selector === '[data-gg-kind]' && dataset.ggKind ? el : null;
    },
  };
  return el;
}

// === Pure helpers: git-graph-render.js ===

test('gitGraphFormatDate covers all five date-format variants', () => {
  const iso = '2019-03-24T21:34:00Z';
  assert.match(render.gitGraphFormatDate(iso, 'date-time'), /24 Mar 2019 \d{2}:\d{2}/);
  assert.equal(render.gitGraphFormatDate(iso, 'date-only'), '24 Mar 2019');
  assert.match(render.gitGraphFormatDate(iso, 'iso'), /^2019-03-24 \d{2}:\d{2}$/);
  assert.equal(render.gitGraphFormatDate(iso, 'iso-date-only'), '2019-03-24');
  const relative = render.gitGraphFormatDate(new Date(Date.now() - 5 * 60000).toISOString(), 'relative');
  assert.match(relative, /minute/);
});

test('gitGraphBuildLayoutInput always puts Uncommitted at the top and attaches stashes as single-parent pseudo-commits', () => {
  const commits = [
    { hash: 'c2', parents: ['c1'], authorDate: '2024-01-02T00:00:00Z', isHead: true, refs: { heads: [], remotes: [], tags: [] } },
    { hash: 'c1', parents: [], authorDate: '2024-01-01T00:00:00Z', refs: { heads: [], remotes: [], tags: [] } },
  ];
  const stashes = [{ hash: 's1', index: 0, baseHash: 'c1', message: 'WIP', date: '2024-01-01T12:00:00Z' }];
  const merged = render.gitGraphBuildLayoutInput(commits, stashes, { changeCount: 3 }, 'c2');
  assert.equal(merged[0].kind, 'uncommitted');
  assert.equal(merged[0].hash, '#uncommitted');
  assert.equal(merged[0].parents[0], 'c2');
  assert.ok(merged.some(r => r.kind === 'stash' && r.hash === 's1' && r.parents[0] === 'c1'));
  // Real commits are untouched (still 'commit' kind) and still present.
  assert.ok(merged.some(r => r.hash === 'c2' && r.kind === 'commit'));
});

test('gitGraphFallbackLayout: a minimal one-lane-no-edges stand-in, used only when the real layout function is not loaded', () => {
  const commits = [
    { hash: 'c', parents: ['b'] }, { hash: 'b', parents: ['a'] }, { hash: 'a', parents: [] },
  ];
  const layout = render.gitGraphFallbackLayout(commits);
  assert.deepEqual(layout.map(r => r.hash), ['c', 'b', 'a']);
  assert.deepEqual(layout.map(r => r.lane), [0, 0, 0]);
  assert.deepEqual(layout.map(r => r.edges), [[], [], []]);
});

test('gitGraphResolveLayoutFn picks the real computeGitGraphLayout when it is loaded, the fallback otherwise', () => {
  assert.equal(render.gitGraphResolveLayoutFn(), render.gitGraphFallbackLayout);
  global.computeGitGraphLayout = () => [];
  try {
    assert.equal(render.gitGraphResolveLayoutFn(), global.computeGitGraphLayout);
  } finally {
    delete global.computeGitGraphLayout;
  }
});

test('gitGraphRenderRefPills: combined local+remote pill carries the two independently-hit-testable regions', () => {
  const commit = {
    hash: 'abc123', isHead: true,
    refs: { heads: ['main'], remotes: [{ remote: 'origin', name: 'main' }], tags: [] },
  };
  const html = render.gitGraphRenderRefPills(commit, { headBranchName: 'main' });
  assert.match(html, /data-gg-kind="branch"[^>]*data-gg-ref-type="local"/);
  assert.match(html, /data-gg-kind="remote-branch"[^>]*data-gg-ref-type="remote"/);
  assert.match(html, /gg-pill-head/); // HEAD emphasis on the matching local pill
});

test('gitGraphRenderRefPills: no HEAD emphasis when the branch name is not the checked-out one', () => {
  const commit = { hash: 'x', isHead: false, refs: { heads: ['feature'], remotes: [], tags: [] } };
  const html = render.gitGraphRenderRefPills(commit, { headBranchName: 'main' });
  assert.equal(html.includes('gg-pill-head'), false);
});

test('gitGraphRenderRefPills: local branch with no same-named remote gets its own single pill, not a combined pair', () => {
  const commit = { hash: 'x', refs: { heads: ['solo'], remotes: [{ remote: 'origin', name: 'other' }], tags: [] } };
  const html = render.gitGraphRenderRefPills(commit, {});
  assert.equal((html.match(/data-gg-kind="branch"/g) || []).length, 1);
  assert.equal((html.match(/data-gg-kind="remote-branch"/g) || []).length, 1);
  assert.equal(html.includes('gg-pill-combined'), false);
});

test('gitGraphRowClasses: merge commits are muted by default, stashes/uncommitted never are', () => {
  const merge = render.gitGraphRowClasses({ kind: 'commit', parents: ['a', 'b'] }, { muteMergeCommits: true });
  assert.ok(merge.includes('gg-muted'));
  const stash = render.gitGraphRowClasses({ kind: 'stash', parents: ['a', 'b'] }, { muteMergeCommits: true });
  assert.equal(stash.includes('gg-muted'), false);
  const off = render.gitGraphRowClasses({ kind: 'commit', parents: ['a', 'b'] }, { muteMergeCommits: false });
  assert.equal(off.includes('gg-muted'), false);
});

test('gitGraphBuildFileTree compacts single-child folder chains when compactFolders is on', () => {
  const files = [{ path: 'docs/device/setup.md', status: 'modified', insertions: 1, deletions: 0 }];
  const tree = render.gitGraphBuildFileTree(files, { compactFolders: true });
  const top = [...tree.children.values()][0];
  assert.equal(top.name, 'docs/device');
});

test('gitGraphBuildFileTree keeps folders separate when compactFolders is off', () => {
  const files = [{ path: 'docs/device/setup.md', status: 'modified', insertions: 1, deletions: 0 }];
  const tree = render.gitGraphBuildFileTree(files, { compactFolders: false });
  const top = [...tree.children.values()][0];
  assert.equal(top.name, 'docs');
});

test('gitGraphDiffStatHtml / gitGraphAccessibilityBadge', () => {
  assert.match(render.gitGraphDiffStatHtml({ insertions: 3, deletions: 1 }), /\+3/);
  assert.match(render.gitGraphDiffStatHtml({ insertions: 3, deletions: 1 }), /-1/);
  assert.equal(render.gitGraphDiffStatHtml({ insertions: 0, deletions: 0 }), '');
  assert.equal(render.gitGraphAccessibilityBadge('renamed'), 'R');
  assert.equal(render.gitGraphAccessibilityBadge('untracked'), 'U');
});

// === Pure helpers: project-git-graph-view.js ===

test('gitGraphFindMatches: matches message/date/author/hash/branch/tag substrings', () => {
  const rows = [
    { hash: 'aa11', subject: 'Fix login bug', authorName: 'Ada', authorDate: '2024-05-01T00:00:00Z', refs: { heads: [], remotes: [], tags: [] } },
    { hash: 'bb22', subject: 'Unrelated', authorName: 'Grace', authorDate: '2024-05-02T00:00:00Z', refs: { heads: ['release-login'], remotes: [], tags: [] } },
    { hash: 'cc33', subject: 'Nothing matches here', authorName: 'Bob', authorDate: '2024-05-03T00:00:00Z', refs: { heads: [], remotes: [], tags: ['login-tag'] } },
  ];
  assert.deepEqual(view.gitGraphFindMatches(rows, 'login', false), [0, 1, 2]);
  assert.deepEqual(view.gitGraphFindMatches(rows, 'ada', false), [0]);
  assert.deepEqual(view.gitGraphFindMatches(rows, 'Ada', true), [0]);
  assert.deepEqual(view.gitGraphFindMatches(rows, 'ada', true), []);
  assert.deepEqual(view.gitGraphFindMatches(rows, '', false), []);
});

test('gitGraphHandleEscapePriority closes dialog, then menu, then details, in that order', () => {
  const order = [];
  view.gitGraphHandleEscapePriority({
    closeDialog: () => { order.push('dialog'); return true; },
    closeMenu: () => { order.push('menu'); return true; },
    closeDetails: () => { order.push('details'); return true; },
  });
  assert.deepEqual(order, ['dialog']);

  order.length = 0;
  const result = view.gitGraphHandleEscapePriority({
    closeDialog: () => false,
    closeMenu: () => { order.push('menu'); return true; },
    closeDetails: () => { order.push('details'); return true; },
  });
  assert.deepEqual(order, ['menu']);
  assert.equal(result, 'menu');

  order.length = 0;
  view.gitGraphHandleEscapePriority({
    closeDialog: () => false,
    closeMenu: () => false,
    closeDetails: () => { order.push('details'); return true; },
  });
  assert.deepEqual(order, ['details']);

  order.length = 0;
  const findResult = view.gitGraphHandleEscapePriority({
    closeDialog: () => false,
    closeMenu: () => false,
    closeDetails: () => false,
    closeFind: () => { order.push('find'); return true; },
  });
  assert.deepEqual(order, ['find'], 'Escape closes the Find widget when nothing higher-priority is open');
  assert.equal(findResult, 'find');
});

// === A stale repositories cache is refreshed on tab re-entry ===

test('gitGraphSameStringSet compares two path lists regardless of order', () => {
  assert.equal(view.gitGraphSameStringSet(['a', 'b'], ['b', 'a']), true);
  assert.equal(view.gitGraphSameStringSet(['a'], ['a', 'b']), false);
});

test('renderProjectGitGraphTab notices a folder attached elsewhere and refreshes the repo list without losing the loaded graph', async () => {
  const project = { id: 'proj-attach-1', root: '/repo-a', folders: [] };
  const body = fakeElement();
  const calls = [];
  global.document = { addEventListener() {}, removeEventListener() {}, getElementById: () => null };
  global.selectedProject = () => project;
  global.projectTab = () => 'gitgraph';
  global.pathBasename = (p) => String(p || '').split('/').filter(Boolean).pop() || '';
  global.window = {
    api: {
      getProjectGitInfo: (id) => {
        calls.push(id);
        const repos = [{ path: '/repo-a', git: true }, ...project.folders.map(f => ({ path: f.path, git: true }))];
        return Promise.resolve({ ok: true, repositories: repos });
      },
    },
  };

  // First render populates the cache with just the root repo.
  view.renderProjectGitGraphTab(project, body);
  await new Promise(resolve => setImmediate(resolve));
  const state = view.gitGraphState(project.id);
  assert.deepEqual(state.repositories.map(r => r.path), ['/repo-a']);
  assert.equal(calls.length, 1);

  // A folder gets attached elsewhere (e.g. from the Settings tab) while this
  // tab isn't the one being painted — project.folders changes, nothing else
  // tells this tab about it.
  project.folders = [{ path: '/repo-b' }];
  state.rows = [{ hash: 'kept' }]; // stands in for an already-loaded graph that must survive the refresh
  view.renderProjectGitGraphTab(project, body);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(state.repositories.map(r => r.path).sort(), ['/repo-a', '/repo-b']);
  assert.equal(calls.length, 2);
  assert.deepEqual(state.rows, [{ hash: 'kept' }], 'the already-loaded graph for the still-selected repo is not thrown away');
});

// === Commit Details arrow-key navigation ===

test('gitGraphSameBranchNeighbor follows the row\'s own same-lane edge for a parent, and the earlier row pointing back at it for a child', () => {
  const state = {
    rows: [{ hash: 'c3' }, { hash: 'c2' }, { hash: 'c1' }],
    layout: [
      { edges: [{ parentHash: 'c2', style: 'same-lane' }] },
      { edges: [{ parentHash: 'c1', style: 'same-lane' }] },
      { edges: [] },
    ],
  };
  assert.equal(view.gitGraphSameBranchNeighbor(state, 'c3', 1), 'c2', 'Ctrl+Down from c3 reaches its parent c2');
  assert.equal(view.gitGraphSameBranchNeighbor(state, 'c1', -1), 'c2', 'Ctrl+Up from c1 reaches its child c2');
  assert.equal(view.gitGraphSameBranchNeighbor(state, 'c1', 1), null, 'the root commit has no parent to follow');
});

test('gitGraphAlternateBranchNeighbor follows a branch-out/merge-in edge instead of the same-lane one', () => {
  const state = {
    rows: [{ hash: 'merge' }, { hash: 'main1' }, { hash: 'feat1' }, { hash: 'base' }],
    layout: [
      { edges: [{ parentHash: 'main1', style: 'same-lane' }, { parentHash: 'feat1', style: 'branch-out' }] },
      { edges: [{ parentHash: 'base', style: 'same-lane' }] },
      { edges: [{ parentHash: 'base', style: 'merge-in' }] },
      { edges: [] },
    ],
  };
  assert.equal(view.gitGraphAlternateBranchNeighbor(state, 'merge', 1), 'feat1', 'the alternate parent at the merge is the other side, not main1');
  assert.equal(view.gitGraphAlternateBranchNeighbor(state, 'base', -1), 'feat1', 'the alternate child of base is the merge-in side, not main1');
});

test('gitGraphMoveDetailsFocus with mode "plain" steps to the row directly above/below, ignoring branch structure', () => {
  const state = view.gitGraphState('proj-nav-1');
  state.repositories = [{ path: '/repo', git: true }];
  state.selectedRepo = '/repo';
  state.rows = [{ hash: 'a', parents: [] }, { hash: 'b', parents: [] }, { hash: 'c', parents: [] }];
  state.layout = [{ edges: [] }, { edges: [] }, { edges: [] }];
  state.selectedHash = 'b';
  const project = { id: 'proj-nav-1' };
  const body = fakeElement();
  global.window = { api: { getGitGraphCommitDetail: () => Promise.resolve({ ok: true, commit: {}, files: [] }) } };

  view.gitGraphMoveDetailsFocus(project, state, body, 1, 'plain');
  assert.equal(state.selectedHash, 'c');
  view.gitGraphMoveDetailsFocus(project, state, body, -1, 'plain');
  assert.equal(state.selectedHash, 'b');
  view.gitGraphMoveDetailsFocus(project, state, body, -1, 'plain');
  assert.equal(state.selectedHash, 'a');
  view.gitGraphMoveDetailsFocus(project, state, body, -1, 'plain');
  assert.equal(state.selectedHash, 'a', 'stepping past the top of the loaded window is a no-op');
});

test('Escape closes the Find widget when it is the only thing open', () => {
  const state = view.gitGraphState('proj-find-esc-1');
  state.repositories = [{ path: '/repo', git: true }];
  state.selectedRepo = '/repo';
  state.rows = [];
  state.findOpen = true;
  const project = { id: 'proj-find-esc-1' };
  const body = fakeElement();
  global.window = { api: {} };
  global.document = { addEventListener: (type, fn) => { if (type === 'keydown') global.document._handler = fn; }, removeEventListener() {}, getElementById: () => null };
  global.selectedProject = () => project;
  global.projectTab = () => 'gitgraph';

  view.gitGraphBindKeyboard(project, state, body);
  global.document._handler({ key: 'Escape', target: {}, preventDefault() {} });
  assert.equal(state.findOpen, false);
});

test('gitGraphReadTargetData reads the frozen data-gg-* contract off the carrying element', () => {
  const el = fakeTargetElement({ ggKind: 'remote-branch', ggRefName: 'main', ggRemote: 'origin', ggRefType: 'remote', ggHash: 'deadbeef' });
  const data = view.gitGraphReadTargetData(el);
  assert.equal(data.kind, 'remote-branch');
  assert.equal(data.refName, 'main');
  assert.equal(data.remote, 'origin');
  assert.equal(data.refType, 'remote');
  assert.equal(view.gitGraphReadTargetData({ closest: () => null }), null);
});

test('gitGraphHandleDoubleClick checks out a commit immediately with no dialog', () => {
  const calls = [];
  global.window = { api: { runGitGraphAction: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); } } };
  const el = fakeTargetElement({ ggKind: 'commit', ggHash: 'c0ffee' });
  const action = view.gitGraphHandleDoubleClick(el, { projectId: 'p1', repoPath: '/repo' });
  assert.equal(action, 'checkoutCommit');
  assert.deepEqual(calls[0], ['p1', '/repo', 'checkoutCommit', { commit: 'c0ffee' }]);
});

test('gitGraphHandleDoubleClick checks out a local branch immediately, never a remote-branch region', () => {
  const calls = [];
  global.window = { api: { runGitGraphAction: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); } } };
  const local = fakeTargetElement({ ggKind: 'branch', ggRefName: 'feature-x' });
  assert.equal(view.gitGraphHandleDoubleClick(local, { projectId: 'p1', repoPath: '/repo' }), 'checkoutBranchImmediate');
  assert.deepEqual(calls[0], ['p1', '/repo', 'checkoutBranchImmediate', { name: 'feature-x' }]);

  calls.length = 0;
  const remote = fakeTargetElement({ ggKind: 'remote-branch', ggRefName: 'feature-x', ggRemote: 'origin' });
  assert.equal(view.gitGraphHandleDoubleClick(remote, { projectId: 'p1', repoPath: '/repo' }), null);
  assert.equal(calls.length, 0);
});

test('gitGraphHandleDoubleClick on the remote half of a combined pill checks out the matching local branch', () => {
  const calls = [];
  global.window = { api: { runGitGraphAction: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); } } };
  const remote = fakeTargetElement({ ggKind: 'remote-branch', ggRefName: 'feature-x', ggRemote: 'origin' });
  const ctx = { projectId: 'p1', repoPath: '/repo', localBranchNames: new Set(['feature-x']) };
  assert.equal(view.gitGraphHandleDoubleClick(remote, ctx), 'checkoutBranchImmediate');
  assert.deepEqual(calls[0], ['p1', '/repo', 'checkoutBranchImmediate', { name: 'feature-x' }]);

  // A bare remote pill with no matching local branch still does nothing.
  calls.length = 0;
  const bareRemote = fakeTargetElement({ ggKind: 'remote-branch', ggRefName: 'no-local', ggRemote: 'origin' });
  assert.equal(view.gitGraphHandleDoubleClick(bareRemote, ctx), null);
  assert.equal(calls.length, 0);
});

test('gitGraphComputeChildren maps a parent hash to every commit that names it as a parent, including octopus merges', () => {
  const commits = [
    { hash: 'merge', parents: ['a', 'b', 'c'] },
    { hash: 'a', parents: ['root'] },
    { hash: 'b', parents: ['root'] },
    { hash: 'c', parents: ['root'] },
  ];
  const map = view.gitGraphComputeChildren(commits);
  assert.deepEqual(map.get('root').map(c => c.hash).sort(), ['a', 'b', 'c']);
  assert.deepEqual(map.get('a').map(c => c.hash), ['merge']);
  assert.equal(map.has('merge'), false);
});

test('gitGraphAllBranchKeys / gitGraphDefaultRemoteName / gitGraphRemoteBranchesByLocalName', () => {
  const refs = {
    heads: [{ name: 'main', hash: 'h1', isHead: true }, { name: 'dev', hash: 'h2', isHead: false }],
    remotes: [{ remote: 'origin', name: 'main', hash: 'h1' }, { remote: 'upstream', name: 'main', hash: 'h1' }],
  };
  assert.deepEqual(view.gitGraphAllBranchKeys({ refs }), ['main', 'dev', 'origin/main', 'upstream/main']);
  assert.equal(view.gitGraphDefaultRemoteName([{ name: 'upstream' }, { name: 'origin' }]), 'origin');
  assert.equal(view.gitGraphDefaultRemoteName([{ name: 'upstream' }]), 'upstream');
  assert.equal(view.gitGraphDefaultRemoteName([]), null);
  const byLocal = view.gitGraphRemoteBranchesByLocalName(refs);
  assert.equal(byLocal.main.length, 2);
});

test('gitGraphPopulateTargetField fills the one target-specific ctx field git-graph-menus.js expects, per kind', () => {
  const state = {
    rows: [{ hash: 'c1', shortHash: 'c1', subject: 'Do a thing', parents: ['p1'] }],
    childrenByHash: new Map([['p1', [{ hash: 'c1', parents: ['p1'] }]]]),
    refs: { tags: [{ name: 'v1', hash: 'c1', annotated: true }] },
    stashes: [{ hash: 's1', index: 0, branch: 'main', message: 'WIP on main' }],
    detailsData: { mode: 'single', hash: 'c1', kind: 'commit', files: [{ path: 'a/b.txt', status: 'modified' }] },
    repositories: [{ path: '/repo' }],
    selectedRepo: '/repo',
  };

  const commitCtx = {}; view.gitGraphPopulateTargetField(commitCtx, state, { kind: 'commit', hash: 'c1' });
  assert.equal(commitCtx.commit.subject, 'Do a thing');
  assert.equal(commitCtx.commit.children.length, 0); // c1 has no children in this fixture

  const localCtx = {}; view.gitGraphPopulateTargetField(localCtx, state, { kind: 'branch', refType: 'local', refName: 'main', hash: 'h' });
  assert.deepEqual(localCtx.localBranch, { name: 'main', hash: 'h' });
  assert.equal(localCtx.remoteBranch, undefined);

  // The combined pill's *remote* hit-region (data-gg-kind="branch" data-gg-ref-type="remote") must
  // populate remoteBranch, not localBranch — this is the dual-hit-region contract.
  const combinedRemoteCtx = {}; view.gitGraphPopulateTargetField(combinedRemoteCtx, state, { kind: 'branch', refType: 'remote', refName: 'main', remote: 'origin', hash: 'h' });
  assert.deepEqual(combinedRemoteCtx.remoteBranch, { remote: 'origin', name: 'main', hash: 'h' });
  assert.equal(combinedRemoteCtx.localBranch, undefined);

  const tagCtx = {}; view.gitGraphPopulateTargetField(tagCtx, state, { kind: 'tag', refName: 'v1', hash: 'c1' });
  assert.equal(tagCtx.tag.annotated, true);

  const stashCtx = {}; view.gitGraphPopulateTargetField(stashCtx, state, { kind: 'stash', hash: 's1' });
  assert.equal(stashCtx.stash.message, 'WIP on main');

  const fileCtx = {}; view.gitGraphPopulateTargetField(fileCtx, state, { kind: 'file', filePath: 'a/b.txt' });
  assert.equal(fileCtx.file.relativePath, 'a/b.txt');
  assert.equal(fileCtx.file.isHistoricalSingleCommit, true);

  const linkCtx = {}; view.gitGraphPopulateTargetField(linkCtx, state, { kind: 'link', el: fakeTargetElement({}, 'https://example.com/x') });
  assert.equal(linkCtx.link.url, 'https://example.com/x');
});

test('gitGraphBuildFileCtx: a file in an Uncommitted-Changes details view is flagged as the working-tree side', () => {
  const state = {
    detailsData: { mode: 'single', kind: 'uncommitted', files: [{ path: 'x.txt', status: 'deleted' }] },
    repositories: [{ path: '/repo' }], selectedRepo: '/repo',
  };
  const fileCtx = view.gitGraphBuildFileCtx(state, 'x.txt');
  assert.equal(fileCtx.isWorkingTreeSide, true);
  assert.equal(fileCtx.existsOnDisk, false);
  assert.equal(fileCtx.isHistoricalSingleCommit, false);
});

test('gitGraphDispatchContextMenu (own fallback dispatcher) routes each data-gg-kind to the matching global builder name', () => {
  const seen = [];
  for (const builderName of Object.values(view.GG_MENU_BUILDERS)) {
    global[builderName] = (ctx) => { seen.push([builderName, ctx.marker]); return [{ label: 'x' }]; };
  }
  let shown = null;
  global.showContextMenu = (items, position) => { shown = { items, position }; };

  const kinds = [
    ['commit', {}], ['uncommitted', {}], ['tag', {}], ['stash', {}],
    ['file', {}], ['column-header', {}], ['link', {}],
  ];
  for (const [kind] of kinds) {
    seen.length = 0;
    const el = fakeTargetElement({ ggKind: kind });
    const ok = view.gitGraphDispatchContextMenu(el, { marker: kind }, { x: 1, y: 2 });
    assert.equal(ok, true, `expected a builder for kind=${kind}`);
    assert.equal(seen[0][1], kind);
  }

  // The combined pill's dual hit-regions: a "branch" kind with refType 'remote'
  // must route to the remote-branch builder, never the local one.
  seen.length = 0;
  const remoteRegion = fakeTargetElement({ ggKind: 'branch', ggRefType: 'remote' });
  view.gitGraphDispatchContextMenu(remoteRegion, { marker: 'combined-remote-region' }, { x: 0, y: 0 });
  assert.equal(seen[0][0], view.GG_MENU_BUILDERS['remote-branch']);

  seen.length = 0;
  const localRegion = fakeTargetElement({ ggKind: 'branch' });
  view.gitGraphDispatchContextMenu(localRegion, { marker: 'local-region' }, { x: 0, y: 0 });
  assert.equal(seen[0][0], view.GG_MENU_BUILDERS.branch);

  for (const builderName of Object.values(view.GG_MENU_BUILDERS)) delete global[builderName];
  delete global.showContextMenu;
});

test('gitGraphDispatchContextMenu returns false for an element carrying no data-gg-kind, and never calls showContextMenu', () => {
  let called = false;
  global.showContextMenu = () => { called = true; };
  const plain = { closest() { return null; } };
  assert.equal(view.gitGraphDispatchContextMenu(plain, {}, { x: 0, y: 0 }), false);
  assert.equal(called, false);
  delete global.showContextMenu;
});

// === A light integration-shaped test: staleness guard on the main graph load ===
// Mirrors project-git-view.js's own tested "only the latest request wins" pattern
// applied to getProjectGitGraph.

test('gitGraphLoadGraph discards an older reply once a newer load has started, regardless of resolution order', async () => {
  const state = view.gitGraphState('proj-stale-1');
  state.repositories = [{ path: '/repo', git: true }];
  state.selectedRepo = '/repo';
  const project = { id: 'proj-stale-1' };
  const body = fakeElement();

  const resolvers = [];
  global.window = {
    api: {
      getProjectGitGraph: () => new Promise((resolve) => resolvers.push(resolve)),
    },
  };

  const p1 = view.gitGraphLoadGraph(project, state, body, { reset: true });
  const p2 = view.gitGraphLoadGraph(project, state, body, { reset: true });

  assert.equal(resolvers.length, 2);
  // Resolve the *second* (current) request first, then the stale first one late.
  resolvers[1]({ ok: true, commits: [{ hash: 'winner', parents: [], authorDate: '2024-02-01T00:00:00Z', refs: { heads: [], remotes: [], tags: [] } }], refs: { heads: [], remotes: [], tags: [] }, hasMore: false });
  await p2;
  resolvers[0]({ ok: true, commits: [{ hash: 'stale', parents: [], authorDate: '2024-01-01T00:00:00Z', refs: { heads: [], remotes: [], tags: [] } }], refs: { heads: [], remotes: [], tags: [] }, hasMore: false });
  await p1;

  assert.equal(state.rawCommits.length, 1);
  assert.equal(state.rawCommits[0].hash, 'winner');
});

test('gitGraphLoadGraph in Load-More mode (reset:false) appends to the existing window and advances skip', async () => {
  const state = view.gitGraphState('proj-loadmore-1');
  state.repositories = [{ path: '/repo', git: true }];
  state.selectedRepo = '/repo';
  state.rawCommits = [{ hash: 'existing', parents: [], authorDate: '2024-01-01T00:00:00Z', refs: { heads: [], remotes: [], tags: [] } }];
  state.skip = 1;
  const project = { id: 'proj-loadmore-1' };
  const body = fakeElement();

  global.window = {
    api: {
      getProjectGitGraph: (_id, _folder, opts) => {
        assert.equal(opts.skip, 1);
        assert.equal(opts.refsUnchanged, true);
        return Promise.resolve({ ok: true, commits: [{ hash: 'more', parents: [], authorDate: '2023-12-31T00:00:00Z', refs: { heads: [], remotes: [], tags: [] } }], refs: null, hasMore: false });
      },
    },
  };

  await view.gitGraphLoadGraph(project, state, body, { reset: false });
  assert.deepEqual(state.rawCommits.map(c => c.hash), ['existing', 'more']);
  assert.equal(state.skip, 2);
});

test('gitGraphLoadGraph\'s layout recompute forwards firstParentOnly to the layout function', async () => {
  const state = view.gitGraphState('proj-fpo-1');
  state.repositories = [{ path: '/repo', git: true }];
  state.selectedRepo = '/repo';
  state.firstParentOnly = true;
  const project = { id: 'proj-fpo-1' };
  const body = fakeElement();
  global.window = { api: { getProjectGitGraph: () => Promise.resolve({ ok: true, commits: [], refs: { heads: [], remotes: [], tags: [] }, hasMore: false }) } };
  let capturedOpts = null;
  global.computeGitGraphLayout = (rows, order, opts) => { capturedOpts = opts; return []; };
  try {
    await view.gitGraphLoadGraph(project, state, body, { reset: true });
    assert.equal(capturedOpts && capturedOpts.firstParentOnly, true);
  } finally {
    delete global.computeGitGraphLayout;
  }
});

test('gitGraphLoadGraph surfaces a {error} reply as state.error rather than throwing', async () => {
  const state = view.gitGraphState('proj-error-1');
  state.repositories = [{ path: '/repo', git: true }];
  state.selectedRepo = '/repo';
  const project = { id: 'proj-error-1' };
  const body = fakeElement();
  global.window = { api: { getProjectGitGraph: () => Promise.resolve({ error: 'git not found' }) } };
  await view.gitGraphLoadGraph(project, state, body, { reset: true });
  assert.equal(state.error, 'git not found');
  assert.equal(state.loading, false);
});

// === Avatars ===

test('gitGraphAvatarHtml renders an <img> when a URL is known, a lettered placeholder otherwise — both carrying data-gg-avatar-email', () => {
  const withUrl = render.gitGraphAvatarHtml('Jane@Example.com', 'switchboard-preview://abc');
  assert.match(withUrl, /<img/);
  assert.match(withUrl, /data-gg-avatar-email="jane@example.com"/);
  const placeholder = render.gitGraphAvatarHtml('Jane@Example.com', null);
  assert.doesNotMatch(placeholder, /<img/);
  assert.match(placeholder, />J</);
});

test('gitGraphAvatarsEnabled: a per-repo override beats the global default in either direction', () => {
  assert.equal(view.gitGraphAvatarsEnabled({ repoConfig: { fetchAvatars: true }, globalFetchAvatars: false }), true);
  assert.equal(view.gitGraphAvatarsEnabled({ repoConfig: { fetchAvatars: false }, globalFetchAvatars: true }), false);
  assert.equal(view.gitGraphAvatarsEnabled({ repoConfig: { fetchAvatars: null }, globalFetchAvatars: true }), true);
  assert.equal(view.gitGraphAvatarsEnabled({ repoConfig: null, globalFetchAvatars: false }), false);
});

test('gitGraphAvatarUrlFor reads the per-viewer cache case-insensitively, and returns null on a cache miss', () => {
  const state = { avatarCache: new Map([['jane@example.com', 'switchboard-preview://abc']]) };
  assert.equal(view.gitGraphAvatarUrlFor(state, 'Jane@Example.com'), 'switchboard-preview://abc');
  assert.equal(view.gitGraphAvatarUrlFor(state, 'nobody@example.com'), null);
  assert.equal(view.gitGraphAvatarUrlFor({ avatarCache: new Map() }, ''), null);
});

// === Signature status ===

test('gitGraphSignatureStatusBucket buckets git\'s %G? codes into good/bad/unknown/none', () => {
  assert.equal(render.gitGraphSignatureStatusBucket('G'), 'good');
  assert.equal(render.gitGraphSignatureStatusBucket('U'), 'good');
  assert.equal(render.gitGraphSignatureStatusBucket('B'), 'bad');
  assert.equal(render.gitGraphSignatureStatusBucket('E'), 'unknown');
  assert.equal(render.gitGraphSignatureStatusBucket('N'), 'none');
  assert.equal(render.gitGraphSignatureStatusBucket(undefined), 'none');
});

test('gitGraphSignatureBadgeHtml renders nothing without a signature, and a titled badge with one', () => {
  assert.equal(render.gitGraphSignatureBadgeHtml(null), '');
  assert.equal(render.gitGraphSignatureBadgeHtml({ status: 'N' }), '');
  const html = render.gitGraphSignatureBadgeHtml({ status: 'G', signer: 'Jane <jane@example.com>' });
  assert.match(html, /gg-signature-good/);
  assert.match(html, /Jane/);
});

test('gitGraphSingleCommitHeaderHtml only shows the signature badge when RepoConfig.showSignatureStatus is on', () => {
  const commit = { hash: 'abc', parents: [], authorName: 'Jane', authorEmail: 'jane@example.com', authorDate: '2024-01-01T00:00:00Z', commitDate: '2024-01-01T00:00:00Z', committerName: 'Jane', body: '', signature: { status: 'G', signer: 'Jane' } };
  const off = view.gitGraphSingleCommitHeaderHtml(commit, 'commit', { repoConfig: { showSignatureStatus: false } });
  assert.doesNotMatch(off, /gg-signature-badge/);
  const on = view.gitGraphSingleCommitHeaderHtml(commit, 'commit', { repoConfig: { showSignatureStatus: true } });
  assert.match(on, /gg-signature-badge/);
});

test('gitGraphLinkifySubject wraps every issue-regex match in its built URL, leaving the rest as plain escaped text', () => {
  const issueLinking = { regex: '#(\\d+)', url: 'https://issues.example.test/$1' };
  const html = view.gitGraphLinkifySubject('Fix widget rendering glitch (#42)', issueLinking);
  assert.equal(html, 'Fix widget rendering glitch (<a class="gg-link" data-gg-kind="link" href="https://issues.example.test/42" target="_blank" rel="noopener">#42</a>)');
  assert.equal(view.gitGraphLinkifySubject('no issue ref here', issueLinking), 'no issue ref here');
  assert.equal(view.gitGraphLinkifySubject('<script>', issueLinking), '&lt;script&gt;');
  assert.equal(view.gitGraphLinkifySubject('plain subject', null), 'plain subject');
});

test('gitGraphSingleCommitHeaderHtml shows the Subject field, with Issue Linking applied when configured', () => {
  const commit = { hash: 'abc', parents: [], subject: 'Fix thing (#7)', authorName: 'Jane', authorEmail: 'jane@example.com', authorDate: '2024-01-01T00:00:00Z', commitDate: '2024-01-01T00:00:00Z', committerName: 'Jane', body: '' };
  const state = { repoConfig: { issueLinking: { regex: '#(\\d+)', url: 'https://issues.example.test/$1' } } };
  const html = view.gitGraphSingleCommitHeaderHtml(commit, 'commit', state);
  assert.match(html, /Subject:/);
  assert.match(html, /href="https:\/\/issues\.example\.test\/7"/);
});

// === Minimal inline Markdown ===

test('gitGraphRenderMarkdownInline wraps bold/italic/bold-italic/inline-code, and only ever operates on already-escaped text', () => {
  assert.equal(render.gitGraphRenderMarkdownInline('**bold**'), '<strong>bold</strong>');
  assert.equal(render.gitGraphRenderMarkdownInline('*italic*'), '<em>italic</em>');
  assert.equal(render.gitGraphRenderMarkdownInline('***both***'), '<strong><em>both</em></strong>');
  assert.equal(render.gitGraphRenderMarkdownInline('`code`'), '<code>code</code>');
  // Already-escaped, so a literal "<script>" in the input can never survive to here as a real tag.
  assert.equal(render.gitGraphRenderMarkdownInline('&lt;script&gt;'), '&lt;script&gt;');
});

test('gitGraphLinkifyBody applies Markdown only when enabled, after which URL linkification still runs', () => {
  const plain = view.gitGraphLinkifyBody('**bold** see https://example.com', false);
  assert.doesNotMatch(plain, /<strong>/);
  assert.match(plain, /<a class="gg-link"/);
  const withMarkdown = view.gitGraphLinkifyBody('**bold** see https://example.com', true);
  assert.match(withMarkdown, /<strong>bold<\/strong>/);
  assert.match(withMarkdown, /<a class="gg-link"/);
});

test('gitGraphLinkifyBody never lets a quote character in the commit body break out of the href attribute', () => {
  const hostile = 'see https://x" onmouseover="fetch(\'https://evil/\')';
  const html = view.gitGraphLinkifyBody(hostile, false);
  // The injected text does still appear (as inert text after the closed
  // </a>, and inside a second auto-linked https://evil/ href) — what must
  // never happen is "onmouseover" landing inside a tag's own attribute list.
  const firstTag = /<a\b[^>]*>/.exec(html);
  assert.ok(firstTag, 'expected the first https:// match to still be linkified');
  assert.doesNotMatch(firstTag[0], /onmouseover/, 'the quote must end the href, not open a live attribute inside the <a> tag');
  assert.match(firstTag[0], /^<a class="gg-link" data-gg-kind="link" href="https:\/\/x" target="_blank" rel="noopener">$/);
});

// === Commit Comparison is order-independent (ancestor always "from") ===

test('gitGraphIsAncestor walks parent links through the loaded window', () => {
  const rows = [
    { hash: 'c3', parents: ['c2'] },
    { hash: 'c2', parents: ['c1'] },
    { hash: 'c1', parents: [] },
  ];
  assert.equal(view.gitGraphIsAncestor(rows, 'c1', 'c3'), true);
  assert.equal(view.gitGraphIsAncestor(rows, 'c3', 'c1'), false);
  assert.equal(view.gitGraphIsAncestor(rows, 'c1', 'c1'), false, 'a commit is not its own ancestor');
});

test('Ctrl-clicking an older ancestor after a newer commit still compares from the ancestor, regardless of click order', () => {
  const state = view.gitGraphState('proj-cmp-1');
  state.repositories = [{ path: '/repo', git: true }];
  state.selectedRepo = '/repo';
  state.rows = [
    { hash: 'newer', parents: ['older'] },
    { hash: 'older', parents: [] },
  ];
  state.selectedHash = 'newer'; // clicked first
  const project = { id: 'proj-cmp-1' };
  const body = fakeElement();
  const calls = [];
  global.window = { api: { getGitGraphCompareDetail: (...args) => { calls.push(args); return Promise.resolve({ ok: true, files: [] }); } } };

  const el = { dataset: { ggHash: 'older' } }; // ctrl-clicked second
  view.gitGraphHandleRowClick(project, state, body, el, { ctrlKey: true });

  assert.equal(state.detailsData.fromHash, 'older');
  assert.equal(state.detailsData.toHash, 'newer');
  assert.deepEqual(calls[0].slice(2), ['older', 'newer']);
});

// === Enhanced accessibility file-status glyph ===

test('gitGraphFileStatusGlyph is colour-only (empty) by default, and shows the letter once enhancedAccessibility is on', () => {
  assert.equal(render.gitGraphFileStatusGlyph('renamed', false), '');
  assert.equal(render.gitGraphFileStatusGlyph('renamed', true), 'R');
});

// === Code Review file-list styling ===

test('gitGraphFileRowHtml bolds a file only while a review is active and that file is still unreviewed', () => {
  const file = { path: 'a.js', status: 'modified', insertions: 1, deletions: 0 };
  const noReview = view.gitGraphFileRowHtml(file, {});
  assert.doesNotMatch(noReview, /gg-file-unreviewed/);
  const activeUnreviewed = view.gitGraphFileRowHtml(file, { codeReview: { reviewedPaths: new Set() } });
  assert.match(activeUnreviewed, /gg-file-unreviewed/);
  const activeReviewed = view.gitGraphFileRowHtml(file, { codeReview: { reviewedPaths: new Set(['a.js']) } });
  assert.doesNotMatch(activeReviewed, /gg-file-unreviewed/);
});

test('gitGraphFileRowHtml marks the most-recently-viewed file with the eye indicator', () => {
  const file = { path: 'a.js', status: 'modified' };
  assert.doesNotMatch(view.gitGraphFileRowHtml(file, {}), /gg-file-eye/);
  assert.match(view.gitGraphFileRowHtml(file, { lastViewedFilePath: 'a.js' }), /gg-file-eye/);
});

// === ctx.codeReview wiring (populates the menu items git-graph-menus.js already builds) ===

test('gitGraphBuildMenuCtx exposes the active Code Review (or null) and a working onMarkFileReviewed callback', () => {
  const state = view.gitGraphState('proj-codereview-ctx-1');
  state.repositories = [{ path: '/repo', git: true }];
  state.selectedRepo = '/repo';
  state.rows = [];
  const project = { id: 'proj-codereview-ctx-1' };
  const body = fakeElement();
  const repo = { path: '/repo' };

  const ctxNoReview = view.gitGraphBuildMenuCtx(project, state, body, repo, null);
  assert.equal(ctxNoReview.codeReview, null);

  state.codeReview = { key: 'abc', reviewedPaths: new Set(['a.js']) };
  const ctxWithReview = view.gitGraphBuildMenuCtx(project, state, body, repo, null);
  assert.equal(ctxWithReview.codeReview.key, 'abc');
  assert.ok(ctxWithReview.codeReview.reviewedPaths.has('a.js'));
  assert.equal(typeof ctxWithReview.onMarkFileReviewed, 'function');
});

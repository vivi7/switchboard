const test = require('node:test');
const assert = require('node:assert/strict');

// git-graph-menus.js is a plain browser-global script (no bundler); it reads
// `window`, `alert`, `PICONS` and the shared `showContextMenu` as bare
// globals, so tests stub those on Node's `global` before requiring it, the
// same way other renderer-logic tests in this repo stub `document`/`window`.
global.PICONS = {};
global.alert = (msg) => { global.alert.calls.push(msg); };
global.alert.calls = [];
global.showContextMenu = (items, position) => { global.showContextMenu.calls.push({ items, position }); };
global.showContextMenu.calls = [];
global.window = { api: {} };

const menus = require('../public/git-graph-menus');

function resetWindowApi(overrides = {}) {
  global.alert.calls = [];
  global.showContextMenu.calls = [];
  global.window.api = {
    runGitGraphAction: async () => ({ ok: true }),
    writeClipboard: (text) => { global.window.api.writeClipboard.calls.push(text); },
    openExternal: (url) => { global.window.api.openExternal.calls.push(url); },
    ...overrides,
  };
  global.window.api.writeClipboard.calls = [];
  global.window.api.openExternal.calls = [];
}

function labels(items) { return items.filter(i => !i.sep).map(i => i.label); }

// --- Commit menu ---

test('commit menu hides Checkout on the currently checked-out commit, shows it otherwise', () => {
  resetWindowApi();
  const base = { projectId: 'p', folderPath: '/repo', head: { hash: 'abc123', branch: 'main' } };
  const onHead = menus.gitGraphBuildCommitMenu({ ...base, commit: { hash: 'abc123', shortHash: 'abc123', subject: 's', parents: ['p1'], children: [] } });
  assert.equal(labels(onHead).includes('Checkout…'), false);
  const notHead = menus.gitGraphBuildCommitMenu({ ...base, commit: { hash: 'def456', shortHash: 'def456', subject: 's', parents: ['p1'], children: [] } });
  assert.equal(labels(notHead).includes('Checkout…'), true);
});

test('commit menu shows Drop only for a single non-merge child, hides it for 0/2+ children, a merge child, or a merge commit itself', () => {
  resetWindowApi();
  const base = { projectId: 'p', folderPath: '/repo', head: { hash: 'zzz', branch: 'main' } };
  const cases = [
    { children: [], expect: false },
    { children: [{ hash: 'c1', parents: ['x'] }], expect: true },
    { children: [{ hash: 'c1', parents: ['x'] }, { hash: 'c2', parents: ['x'] }], expect: false },
    { children: [{ hash: 'c1', parents: ['x', 'y'] }], expect: false },
  ];
  for (const c of cases) {
    const items = menus.gitGraphBuildCommitMenu({ ...base, commit: { hash: 'h', shortHash: 'h', subject: 's', parents: ['p1'], children: c.children } });
    assert.equal(labels(items).includes('Drop…'), c.expect, JSON.stringify(c));
  }
  const mergeCommit = menus.gitGraphBuildCommitMenu({ ...base, commit: { hash: 'h', shortHash: 'h', subject: 's', parents: ['p1', 'p2'], children: [{ hash: 'c1', parents: ['h'] }] } });
  assert.equal(labels(mergeCommit).includes('Drop…'), false);
});

test('GlobalPrefs.contextMenuActionsVisibility hides a specific commit-menu item by id, without leaving a doubled separator', () => {
  resetWindowApi();
  const base = { projectId: 'p', folderPath: '/repo', head: { hash: 'zzz', branch: 'main' }, commit: { hash: 'h', shortHash: 'h', subject: 's', parents: ['p1'], children: [] } };
  const shown = menus.gitGraphBuildCommitMenu(base);
  assert.equal(labels(shown).includes('Create Branch…'), true);

  const hidden = menus.gitGraphBuildCommitMenu({ ...base, contextMenuActionsVisibility: { commit: { createBranch: false } } });
  assert.equal(labels(hidden).includes('Create Branch…'), false);
  assert.equal(labels(hidden).includes('Add Tag…'), true, 'an unrelated item stays visible');
  assert.notEqual(hidden[0].sep, true, 'removing the second of two adjacent items must not leave a leading separator');
});

test('gitGraphApplyMenuVisibility collapses the doubled separator left by a hidden middle item down to one, and drops a leading/trailing separator entirely', () => {
  const items = [
    { id: 'a', label: 'A' }, { sep: true }, { id: 'b', label: 'B' }, { sep: true }, { id: 'c', label: 'C' },
  ];
  const result = menus.gitGraphApplyMenuVisibility(items, { contextMenuActionsVisibility: { cat: { b: false } } }, 'cat');
  assert.deepEqual(result.map(i => i.id || 'sep'), ['a', 'sep', 'c'], 'one divider survives between the two remaining items, not two');

  const leading = [{ sep: true }, { id: 'a', label: 'A' }];
  assert.deepEqual(menus.gitGraphApplyMenuVisibility(leading, {}, 'cat').map(i => i.id || 'sep'), ['a']);
  const trailing = [{ id: 'a', label: 'A' }, { sep: true }];
  assert.deepEqual(menus.gitGraphApplyMenuVisibility(trailing, {}, 'cat').map(i => i.id || 'sep'), ['a']);
});

test('commit menu hides Drop for a root commit even with exactly one non-merge child', () => {
  resetWindowApi();
  const items = menus.gitGraphBuildCommitMenu({
    projectId: 'p', folderPath: '/repo', head: { hash: 'zzz', branch: 'main' },
    commit: { hash: 'root', shortHash: 'root', subject: 's', parents: [], children: [{ hash: 'c1', parents: ['root'] }] },
  });
  assert.equal(labels(items).includes('Drop…'), false);
});

test('gitGraphSuggestNextTagName bumps the highest leading-number tag and keeps the rest of the name, empty when nothing matches', () => {
  assert.equal(menus.gitGraphSuggestNextTagName(['v1.0', 'v2.0']), 'v3.0');
  assert.equal(menus.gitGraphSuggestNextTagName(['release-9']), 'release-10');
  assert.equal(menus.gitGraphSuggestNextTagName(['not-a-version', 'also-none']), '');
  assert.equal(menus.gitGraphSuggestNextTagName([]), '');
});

test('commit menu hides Merge/Rebase when the commit is the current branch tip', () => {
  resetWindowApi();
  const onTip = menus.gitGraphBuildCommitMenu({ projectId: 'p', folderPath: '/repo', head: { hash: 'tip', branch: 'main' }, commit: { hash: 'tip', shortHash: 'tip', subject: 's', parents: ['p1'], children: [] } });
  assert.equal(labels(onTip).some(l => l.startsWith('Merge into current branch')), false);
  assert.equal(labels(onTip).some(l => l.startsWith('Rebase current branch')), false);
  const notTip = menus.gitGraphBuildCommitMenu({ projectId: 'p', folderPath: '/repo', head: { hash: 'tip', branch: 'main' }, commit: { hash: 'other', shortHash: 'other', subject: 's', parents: ['p1'], children: [] } });
  assert.equal(labels(notTip).includes('Merge into current branch…'), true);
  assert.equal(labels(notTip).some(l => l.startsWith('Rebase current branch')), true);
});

test('commit menu copy actions write exactly the hash and the subject', () => {
  resetWindowApi();
  const items = menus.gitGraphBuildCommitMenu({ projectId: 'p', folderPath: '/repo', head: { hash: 'zzz', branch: 'main' }, commit: { hash: 'fullhash40', shortHash: 'fullhas', subject: 'Fix the thing', parents: [], children: [] } });
  items.find(i => i.label === 'Copy Commit Hash to Clipboard').onClick();
  items.find(i => i.label === 'Copy Commit Subject to Clipboard').onClick();
  assert.deepEqual(global.window.api.writeClipboard.calls, ['fullhash40', 'Fix the thing']);
});

test('Reset current branch to this Commit is always offered', () => {
  resetWindowApi();
  const items = menus.gitGraphBuildCommitMenu({ projectId: 'p', folderPath: '/repo', head: { hash: 'tip', branch: 'main' }, commit: { hash: 'tip', shortHash: 'tip', subject: 's', parents: [], children: [] } });
  assert.equal(labels(items).includes('Reset current branch to this Commit…'), true);
});

// --- Local branch menu ---

test('local branch menu hides Checkout/Delete/Merge/Rebase on the current branch, and select/unselect are mutually exclusive', () => {
  resetWindowApi();
  const current = menus.gitGraphBuildLocalBranchMenu({ projectId: 'p', folderPath: '/repo', head: { hash: 'h', branch: 'main' }, localBranch: { name: 'main', hash: 'h' }, remotes: [], selectedBranchKeys: new Set() });
  assert.equal(labels(current).includes('Checkout Branch'), false);
  assert.equal(labels(current).includes('Delete Branch…'), false);
  assert.equal(labels(current).some(l => l.startsWith('Merge into current branch')), false);
  assert.equal(labels(current).some(l => l.startsWith('Rebase current branch')), false);

  const other = menus.gitGraphBuildLocalBranchMenu({ projectId: 'p', folderPath: '/repo', head: { hash: 'h', branch: 'main' }, localBranch: { name: 'feature', hash: 'g' }, remotes: [], selectedBranchKeys: new Set() });
  assert.equal(labels(other).includes('Checkout Branch'), true);
  assert.equal(labels(other).includes('Delete Branch…'), true);
  assert.equal(labels(other).includes('Select in Branches Dropdown'), true);
  assert.equal(labels(other).includes('Unselect in Branches Dropdown'), false);

  const selected = menus.gitGraphBuildLocalBranchMenu({ projectId: 'p', folderPath: '/repo', head: { hash: 'h', branch: 'main' }, localBranch: { name: 'feature', hash: 'g' }, remotes: [], selectedBranchKeys: new Set(['feature']) });
  assert.equal(labels(selected).includes('Select in Branches Dropdown'), false);
  assert.equal(labels(selected).includes('Unselect in Branches Dropdown'), true);
});

test('local branch menu View Issue / Create Pull Request are gated on configuration', () => {
  resetWindowApi();
  const noConfig = menus.gitGraphBuildLocalBranchMenu({ projectId: 'p', folderPath: '/repo', head: { hash: 'h', branch: 'main' }, localBranch: { name: 'feature/PROJ-42', hash: 'g' }, remotes: [{ name: 'origin', url: 'https://github.com/acme/widget.git' }], selectedBranchKeys: 'all' });
  assert.equal(labels(noConfig).includes('View Issue'), false);
  assert.equal(labels(noConfig).includes('Create Pull Request…'), false);

  const withConfig = menus.gitGraphBuildLocalBranchMenu({
    projectId: 'p', folderPath: '/repo', head: { hash: 'h', branch: 'main' },
    localBranch: { name: 'feature/PROJ-42', hash: 'g' },
    remotes: [{ name: 'origin', url: 'https://github.com/acme/widget.git' }],
    selectedBranchKeys: 'all',
    issueLinking: { regex: 'PROJ-(\\d+)', url: 'https://issues.example.com/$1' },
    pullRequestProvider: { kind: 'github' },
    defaultBranch: 'main',
  });
  assert.equal(labels(withConfig).includes('View Issue'), true);
  assert.equal(labels(withConfig).includes('Create Pull Request…'), true);
  withConfig.find(i => i.label === 'View Issue').onClick();
  assert.equal(global.window.api.openExternal.calls[0], 'https://issues.example.com/42');
  withConfig.find(i => i.label === 'Create Pull Request…').onClick();
  assert.match(global.window.api.openExternal.calls[1], /^https:\/\/github\.com\/acme\/widget\/compare\/main\.\.\.feature%2FPROJ-42\?expand=1$/);
});

test('local branch Delete Branch offers exactly the remotes that carry a same-named branch, keyed by remote id', () => {
  resetWindowApi();
  let capturedParams = null;
  global.gitGraphShowDeleteBranchDialog = (params) => { capturedParams = params; };
  try {
    const items = menus.gitGraphBuildLocalBranchMenu({
      projectId: 'p', folderPath: '/repo', head: { hash: 'h', branch: 'main' },
      localBranch: { name: 'feature', hash: 'g' }, remotes: [{ name: 'origin' }, { name: 'fork' }],
      selectedBranchKeys: 'all', remoteBranchesByLocalName: { feature: [{ remote: 'origin', name: 'feature' }] },
    });
    items.find(i => i.label === 'Delete Branch…').onClick();
    assert.deepEqual(capturedParams.remoteMatches, [{ name: 'origin' }]);
  } finally { delete global.gitGraphShowDeleteBranchDialog; }
});

test('local branch Create Archive asks main to show the save dialog itself, with the branch as a filename hint only', async () => {
  const calls = [];
  resetWindowApi({ saveGitGraphArchive: async (...args) => { calls.push(args); return { ok: true }; } });
  const items = menus.gitGraphBuildLocalBranchMenu({ projectId: 'proj-1', folderPath: '/repo', head: { hash: 'h', branch: 'main' }, localBranch: { name: 'feature', hash: 'g' }, remotes: [], selectedBranchKeys: 'all' });
  await items.find(i => i.label === 'Create Archive').onClick();
  assert.deepEqual(calls, [['proj-1', '/repo', { ref: 'feature', refType: 'branch', remote: undefined, suggestedName: 'feature' }]]);
});

test('checkoutBranchImmediate reports git errors via alert and never calls refresh', async () => {
  const calls = [];
  resetWindowApi({ runGitGraphAction: async (...args) => { calls.push(args); return { error: 'error: pathspec did not match' }; } });
  let refreshed = false;
  const items = menus.gitGraphBuildLocalBranchMenu({ projectId: 'proj-1', folderPath: '/repo', refresh: () => { refreshed = true; }, head: { hash: 'h', branch: 'main' }, localBranch: { name: 'feature', hash: 'g' }, remotes: [], selectedBranchKeys: 'all' });
  await items.find(i => i.label === 'Checkout Branch').onClick();
  assert.deepEqual(calls, [['proj-1', '/repo', 'checkoutBranchImmediate', { name: 'feature' }]]);
  assert.deepEqual(global.alert.calls, ['error: pathspec did not match']);
  assert.equal(refreshed, false);
});

// --- Remote branch menu ---

test('remote branch menu always shows Delete Remote Branch, Merge and Pull; Fetch-into-local only for a same-name non-current local branch', () => {
  resetWindowApi();
  const noLocal = menus.gitGraphBuildRemoteBranchMenu({ projectId: 'p', folderPath: '/repo', head: { hash: 'h', branch: 'main' }, remoteBranch: { remote: 'origin', name: 'feature', hash: 'g' }, localBranches: [], remotes: [{ name: 'origin' }], selectedBranchKeys: new Set() });
  assert.equal(labels(noLocal).includes('Delete Remote Branch…'), true);
  assert.equal(labels(noLocal).includes('Merge into current branch…'), true);
  assert.equal(labels(noLocal).includes('Pull into current branch…'), true);
  assert.equal(labels(noLocal).includes('Fetch into local branch…'), false);

  const localButCurrent = menus.gitGraphBuildRemoteBranchMenu({ projectId: 'p', folderPath: '/repo', head: { hash: 'h', branch: 'feature' }, remoteBranch: { remote: 'origin', name: 'feature', hash: 'g' }, localBranches: [{ name: 'feature', hash: 'g' }], remotes: [{ name: 'origin' }], selectedBranchKeys: new Set() });
  assert.equal(labels(localButCurrent).includes('Fetch into local branch…'), false);

  const localNotCurrent = menus.gitGraphBuildRemoteBranchMenu({ projectId: 'p', folderPath: '/repo', head: { hash: 'h', branch: 'main' }, remoteBranch: { remote: 'origin', name: 'feature', hash: 'g' }, localBranches: [{ name: 'feature', hash: 'g' }], remotes: [{ name: 'origin' }], selectedBranchKeys: new Set() });
  assert.equal(labels(localNotCurrent).includes('Fetch into local branch…'), true);
});

test('remote branch Copy Branch Name copies only the short name', () => {
  resetWindowApi();
  const items = menus.gitGraphBuildRemoteBranchMenu({ projectId: 'p', folderPath: '/repo', head: { hash: 'h', branch: 'main' }, remoteBranch: { remote: 'origin', name: 'feature', hash: 'g' }, localBranches: [], remotes: [], selectedBranchKeys: new Set() });
  items.find(i => i.label === 'Copy Branch Name to Clipboard').onClick();
  assert.deepEqual(global.window.api.writeClipboard.calls, ['feature']);
});

test('remote branch select/unselect key is remote/name and toggles via the view callbacks', () => {
  resetWindowApi();
  let selectedKey = null, unselectedKey = null;
  const items = menus.gitGraphBuildRemoteBranchMenu({
    projectId: 'p', folderPath: '/repo', head: { hash: 'h', branch: 'main' },
    remoteBranch: { remote: 'origin', name: 'feature', hash: 'g' }, localBranches: [], remotes: [],
    selectedBranchKeys: new Set(), onSelectBranch: (k) => { selectedKey = k; }, onUnselectBranch: (k) => { unselectedKey = k; },
  });
  items.find(i => i.label === 'Select in Branches Dropdown').onClick();
  assert.equal(selectedKey, 'origin/feature');
  assert.equal(unselectedKey, null);
});

// --- Tag menu ---

test('tag menu shows View Details only for annotated tags', () => {
  resetWindowApi();
  const annotated = menus.gitGraphBuildTagMenu({ projectId: 'p', folderPath: '/repo', tag: { name: 'v1', hash: 'h', annotated: true }, remotes: [] });
  assert.equal(labels(annotated).includes('View Details'), true);
  const lightweight = menus.gitGraphBuildTagMenu({ projectId: 'p', folderPath: '/repo', tag: { name: 'v1', hash: 'h', annotated: false }, remotes: [] });
  assert.equal(labels(lightweight).includes('View Details'), false);
});

// --- Stash menu ---

test('stash menu has all 6 items and copies the message/hash separately', () => {
  resetWindowApi();
  const items = menus.gitGraphBuildStashMenu({ projectId: 'p', folderPath: '/repo', stash: { hash: 'stashhash', index: 0, branch: 'main', message: 'WIP: thing' } });
  assert.deepEqual(labels(items), ['Apply Stash…', 'Create Branch from Stash…', 'Pop Stash…', 'Drop Stash…', 'Copy Stash Name to Clipboard', 'Copy Stash Hash to Clipboard']);
  items.find(i => i.label === 'Copy Stash Name to Clipboard').onClick();
  items.find(i => i.label === 'Copy Stash Hash to Clipboard').onClick();
  assert.deepEqual(global.window.api.writeClipboard.calls, ['WIP: thing', 'stashhash']);
});

// --- Uncommitted Changes menu ---

test('uncommitted-changes menu shows Clean only when there are untracked files', () => {
  resetWindowApi();
  const withUntracked = menus.gitGraphBuildUncommittedMenu({ projectId: 'p', folderPath: '/repo', hasUntrackedFiles: true });
  assert.equal(labels(withUntracked).includes('Clean untracked files…'), true);
  const withoutUntracked = menus.gitGraphBuildUncommittedMenu({ projectId: 'p', folderPath: '/repo', hasUntrackedFiles: false });
  assert.equal(labels(withoutUntracked).includes('Clean untracked files…'), false);
  let opened = false;
  withoutUntracked.find(i => i.label === 'Open Source Control View').onClick();
  const items2 = menus.gitGraphBuildUncommittedMenu({ projectId: 'p', folderPath: '/repo', onOpenSourceControlView: () => { opened = true; } });
  items2.find(i => i.label === 'Open Source Control View').onClick();
  assert.equal(opened, true);
});

// --- Commit-details file menu ---

test('file menu hides View-Diff-with-Working-File on the working-tree side, and Open File only when the file exists on disk', () => {
  resetWindowApi();
  const workingTreeSide = menus.gitGraphBuildFileMenu({ projectId: 'p', folderPath: '/repo', file: { path: 'a.js', isWorkingTreeSide: true, existsOnDisk: true } });
  assert.equal(labels(workingTreeSide).includes('View Diff with Working File'), false);
  assert.equal(labels(workingTreeSide).includes('Open File'), true);
  const historical = menus.gitGraphBuildFileMenu({ projectId: 'p', folderPath: '/repo', file: { path: 'a.js', isWorkingTreeSide: false, existsOnDisk: false } });
  assert.equal(labels(historical).includes('View Diff with Working File'), true);
  assert.equal(labels(historical).includes('Open File'), false);
});

test('file menu Mark as (Not) Reviewed is gated on an active Code Review and the file\'s reviewed state', () => {
  resetWindowApi();
  const noReview = menus.gitGraphBuildFileMenu({ projectId: 'p', folderPath: '/repo', file: { path: 'a.js' }, codeReview: null });
  assert.equal(labels(noReview).includes('Mark as Reviewed'), false);
  assert.equal(labels(noReview).includes('Mark as Not Reviewed'), false);

  const unreviewed = menus.gitGraphBuildFileMenu({ projectId: 'p', folderPath: '/repo', file: { path: 'a.js' }, codeReview: { key: 'k', reviewedPaths: new Set() } });
  assert.equal(labels(unreviewed).includes('Mark as Reviewed'), true);
  assert.equal(labels(unreviewed).includes('Mark as Not Reviewed'), false);

  const reviewed = menus.gitGraphBuildFileMenu({ projectId: 'p', folderPath: '/repo', file: { path: 'a.js' }, codeReview: { key: 'k', reviewedPaths: new Set(['a.js']) } });
  assert.equal(labels(reviewed).includes('Mark as Reviewed'), false);
  assert.equal(labels(reviewed).includes('Mark as Not Reviewed'), true);
});

test('file menu Reset File to this Revision only appears when viewing a single historical commit', () => {
  resetWindowApi();
  const single = menus.gitGraphBuildFileMenu({ projectId: 'p', folderPath: '/repo', file: { path: 'a.js', isHistoricalSingleCommit: true } });
  assert.equal(labels(single).includes('Reset File to this Revision…'), true);
  const comparison = menus.gitGraphBuildFileMenu({ projectId: 'p', folderPath: '/repo', file: { path: 'a.js', isHistoricalSingleCommit: false } });
  assert.equal(labels(comparison).includes('Reset File to this Revision…'), false);
});

// --- Column header menu ---

test('column header menu has 3 toggles + 3-way order radio, and marks the active ones checked', () => {
  resetWindowApi();
  const items = menus.gitGraphBuildColumnHeaderMenu({ projectId: 'p', folderPath: '/repo', columnHeader: { columnVisibility: { date: true, author: false, commit: true }, commitsOrder: 'topo' } });
  assert.deepEqual(labels(items), ['Date', 'Author', 'Commit', 'Order: Date', 'Order: Author Date', 'Order: Topological']);
  assert.equal(items.find(i => i.label === 'Date').checked, true);
  assert.equal(items.find(i => i.label === 'Author').checked, false);
  assert.equal(items.find(i => i.label === 'Order: Topological').checked, true);
  assert.equal(items.find(i => i.label === 'Order: Date').checked, false);

  let changedCol = null, changedOrder = null;
  const items2 = menus.gitGraphBuildColumnHeaderMenu({
    columnHeader: { columnVisibility: {}, commitsOrder: 'date' },
    onColumnVisibilityChange: (col, v) => { changedCol = [col, v]; },
    onCommitsOrderChange: (order) => { changedOrder = order; },
  });
  items2.find(i => i.label === 'Author').onClick();
  items2.find(i => i.label === 'Order: Topological').onClick();
  assert.deepEqual(changedCol, ['author', true]);
  assert.equal(changedOrder, 'topo');
});

// --- Link menu ---

test('link menu copies the link url', () => {
  resetWindowApi();
  const items = menus.gitGraphBuildLinkMenu({ link: { url: 'https://example.com/issue/1' } });
  assert.deepEqual(labels(items), ['Copy Link to Clipboard']);
  items[0].onClick();
  assert.deepEqual(global.window.api.writeClipboard.calls, ['https://example.com/issue/1']);
});

// --- Combined local+remote pill dual hit-region routing ---

function fakeEl(attrs, parent = null) {
  return {
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    parentElement: parent,
  };
}

test('a click on the local-name region of a combined pill opens the local-branch menu', () => {
  resetWindowApi();
  const row = fakeEl({ 'data-gg-kind': 'commit', 'data-gg-hash': 'h' });
  const localRegion = fakeEl({ 'data-gg-kind': 'branch', 'data-gg-ref-name': 'main', 'data-gg-ref-type': 'local' }, row);
  const ctx = { projectId: 'p', folderPath: '/repo', head: { hash: 'h', branch: 'other' }, localBranch: { name: 'main', hash: 'h' }, remotes: [], selectedBranchKeys: new Set() };
  const items = menus.gitGraphBuildMenuItems(localRegion, ctx);
  assert.equal(labels(items).includes('Rename Branch…'), true);
  assert.equal(labels(items).includes('Delete Remote Branch…'), false);
});

test('a click on the remote-qualified region of a combined pill opens the remote-branch menu', () => {
  resetWindowApi();
  const row = fakeEl({ 'data-gg-kind': 'commit', 'data-gg-hash': 'h' });
  const remoteRegion = fakeEl({ 'data-gg-kind': 'remote-branch', 'data-gg-ref-name': 'main', 'data-gg-remote': 'origin', 'data-gg-ref-type': 'remote' }, row);
  const ctx = { projectId: 'p', folderPath: '/repo', head: { hash: 'h', branch: 'other' }, remoteBranch: { remote: 'origin', name: 'main', hash: 'h' }, localBranches: [], remotes: [], selectedBranchKeys: new Set() };
  const items = menus.gitGraphBuildMenuItems(remoteRegion, ctx);
  assert.equal(labels(items).includes('Delete Remote Branch…'), true);
  assert.equal(labels(items).includes('Rename Branch…'), false);
});

test('a plain (non-combined) branch=\'branch\' region with no ref-type still opens the local-branch menu', () => {
  resetWindowApi();
  const el = fakeEl({ 'data-gg-kind': 'branch', 'data-gg-ref-name': 'main' });
  const ctx = { projectId: 'p', folderPath: '/repo', head: { hash: 'h', branch: 'other' }, localBranch: { name: 'main', hash: 'h' }, remotes: [], selectedBranchKeys: new Set() };
  const items = menus.gitGraphBuildMenuItems(el, ctx);
  assert.equal(labels(items).includes('Rename Branch…'), true);
});

test('double-click checkout routes through the same immediate action regardless of which pill region was clicked', () => {
  resetWindowApi();
  const calls = [];
  global.window.api.runGitGraphAction = async (...args) => { calls.push(args); return { ok: true }; };
  const ctx = { projectId: 'p', folderPath: '/repo', head: { hash: 'h', branch: 'other' }, localBranch: { name: 'main', hash: 'h' }, remotes: [], selectedBranchKeys: new Set() };
  menus.gitGraphRunImmediateAction(ctx, 'checkoutBranchImmediate', { name: 'main' });
  assert.deepEqual(calls, [['p', '/repo', 'checkoutBranchImmediate', { name: 'main' }]]);
});

test('gitGraphShowContextMenu opens the resolved item list via the shared showContextMenu', () => {
  resetWindowApi();
  const el = fakeEl({ 'data-gg-kind': 'link' });
  const items = menus.gitGraphShowContextMenu(el, { link: { url: 'https://x' } }, { x: 1, y: 2 });
  assert.equal(global.showContextMenu.calls.length, 1);
  assert.deepEqual(global.showContextMenu.calls[0].items, items);
  assert.deepEqual(global.showContextMenu.calls[0].position, { x: 1, y: 2 });
});

test('an unknown data-gg-kind resolves to no menu and calls showContextMenu zero times', () => {
  resetWindowApi();
  const el = fakeEl({ 'data-gg-kind': 'something-new' });
  const items = menus.gitGraphShowContextMenu(el, {}, { x: 0, y: 0 });
  assert.equal(items, null);
  assert.equal(global.showContextMenu.calls.length, 0);
});

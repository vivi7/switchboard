// Tests for public/git-graph-settings.js: the Repository Settings drawer's
// logic, Global Preferences application, the repo-committed-config trust
// flow, and Code Review session bookkeeping. Same house style as
// test/git-graph-menus.test.js — a plain browser-global script, `require()`d
// directly with the handful of globals it reads stubbed on Node's `global`.
// project-git-graph-view.js's own globals (gitGraphApi, gitGraphPaint,
// gitGraphPaintDetailsOnly, gitGraphLoadGraph, gitGraphStillActive,
// gitGraphToggleSettings) are stubbed here rather than loaded, exactly like
// this file stubs window.api calls elsewhere — this suite is about
// git-graph-settings.js's own logic, not a second copy of the view file's.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

global.escapeHtml = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
global.escapeAttr = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
global.pathBasename = (p) => String(p || '').split('/').filter(Boolean).pop() || '';
global.gitGraphIcon = () => '';
global.alert = () => {};
global.document = { createElement: () => ({ classList: { add() {} } }), body: { appendChild() {} } };

const settings = require(path.join(__dirname, '../public/git-graph-settings.js'));

function fakeElement() {
  const el = {
    style: {}, dataset: {}, innerHTML: '', textContent: '', isConnected: true,
    appendChild() {}, insertAdjacentElement() {},
    querySelector() { return fakeElement(); },
    querySelectorAll() { return []; },
  };
  return el;
}

function withViewGlobals(overrides = {}) {
  global.gitGraphApi = overrides.gitGraphApi || (async () => ({ error: 'not stubbed' }));
  global.gitGraphPaint = overrides.gitGraphPaint || (() => {});
  global.gitGraphPaintDetailsOnly = overrides.gitGraphPaintDetailsOnly || (() => {});
  global.gitGraphLoadGraph = overrides.gitGraphLoadGraph || (() => {});
  global.gitGraphStillActive = overrides.gitGraphStillActive || (() => true);
  global.gitGraphToggleSettings = overrides.gitGraphToggleSettings || (() => {});
}

// === Pure helpers ===

test('gitGraphSortRepositories: name/fullPath sort, attachmentOrder leaves order alone', () => {
  const repos = [{ path: '/z/beta' }, { path: '/a/alpha' }];
  assert.deepEqual(settings.gitGraphSortRepositories(repos, 'attachmentOrder').map(r => r.path), ['/z/beta', '/a/alpha']);
  assert.deepEqual(settings.gitGraphSortRepositories(repos, 'name').map(r => r.path), ['/a/alpha', '/z/beta']);
  assert.deepEqual(settings.gitGraphSortRepositories(repos, 'fullPath').map(r => r.path), ['/a/alpha', '/z/beta']);
});

test('gitGraphVisibleRemotes hides a remote only when perRemoteVisibility explicitly sets it false', () => {
  const remotes = [{ remote: 'origin', name: 'main' }, { remote: 'fork', name: 'main' }];
  assert.equal(settings.gitGraphVisibleRemotes(remotes, {}).length, 2);
  assert.equal(settings.gitGraphVisibleRemotes(remotes, { fork: false }).length, 1);
  assert.equal(settings.gitGraphVisibleRemotes(remotes, { fork: false })[0].remote, 'origin');
});

test('gitGraphApplyOnLoadSelection: specific branches beat checked-out-only, which beats leaving selection alone', () => {
  const state1 = { branchSelection: 'all' };
  settings.gitGraphApplyOnLoadSelection(state1, { onLoadShowSpecificBranches: ['dev', 'release'] }, 'main');
  assert.deepEqual(state1.branchSelection, ['dev', 'release']);

  const state2 = { branchSelection: 'all' };
  settings.gitGraphApplyOnLoadSelection(state2, { onLoadShowCheckedOutBranch: true, onLoadShowSpecificBranches: [] }, 'main');
  assert.deepEqual(state2.branchSelection, ['main']);

  const state3 = { branchSelection: 'all' };
  settings.gitGraphApplyOnLoadSelection(state3, { onLoadShowSpecificBranches: [] }, 'main');
  assert.equal(state3.branchSelection, 'all');
});

test('gitGraphSummarizeExternalConfig picks only the allow-listed fields, and returns null when none are present', () => {
  assert.equal(settings.gitGraphSummarizeExternalConfig({ someOtherKey: 1 }), null);
  assert.equal(settings.gitGraphSummarizeExternalConfig(null), null);
  const summary = settings.gitGraphSummarizeExternalConfig({ customDisplayName: 'Foo', issueLinking: { regex: '#(\\d+)' }, unrelated: true });
  assert.deepEqual(summary, { customDisplayName: 'Foo', issueLinking: { regex: '#(\\d+)' } });
});

test('gitGraphCodeReviewKeyFor: commit hash for a single commit, from..to for a comparison, null for Uncommitted alone', () => {
  assert.equal(settings.gitGraphCodeReviewKeyFor({ mode: 'single', kind: 'commit', hash: 'abc' }), 'abc');
  assert.equal(settings.gitGraphCodeReviewKeyFor({ mode: 'single', kind: 'uncommitted', hash: '#uncommitted' }), null);
  assert.equal(settings.gitGraphCodeReviewKeyFor({ mode: 'compare', fromHash: 'a', toHash: 'b' }), 'a..b');
  assert.equal(settings.gitGraphCodeReviewKeyFor(null), null);
});

test('gitGraphHydrateCodeReviewForDetails rehydrates a stored review record into a live Set, or clears it when none exists', () => {
  const state = {
    detailsData: { mode: 'single', kind: 'commit', hash: 'abc' },
    repoConfig: { codeReview: { abc: { reviewedPaths: ['a.js', 'b.js'], startedAt: 111 } } },
  };
  settings.gitGraphHydrateCodeReviewForDetails(state);
  assert.equal(state.codeReview.key, 'abc');
  assert.ok(state.codeReview.reviewedPaths instanceof Set);
  assert.ok(state.codeReview.reviewedPaths.has('a.js'));
  assert.equal(state.codeReview.startedAt, 111);

  const state2 = { detailsData: { mode: 'single', kind: 'commit', hash: 'zzz' }, repoConfig: { codeReview: {} } };
  settings.gitGraphHydrateCodeReviewForDetails(state2);
  assert.equal(state2.codeReview, null);
});

test('gitGraphApplyRepoConfigToState copies the filter-affecting fields onto working state', () => {
  const state = { branchSelection: 'all', showRemoteBranches: true, order: 'date', firstParentOnly: false, muteMergeCommits: true, muteNonAncestors: false, columnWidths: {} };
  settings.gitGraphApplyRepoConfigToState(state, {
    branchDropdownSelection: ['main'], showRemoteBranches: false, commitsOrder: 'topo',
    onlyFollowFirstParent: true, muteMergeCommits: false, muteNonAncestors: true,
    columnWidths: { date: 90 }, showTags: false, showStashes: false, showUncommittedChanges: false,
    includeCommitsMentionedByReflogs: true,
  });
  assert.deepEqual(state.branchSelection, ['main']);
  assert.equal(state.showRemoteBranches, false);
  assert.equal(state.order, 'topo');
  assert.equal(state.firstParentOnly, true);
  assert.equal(state.muteMergeCommits, false);
  assert.equal(state.muteNonAncestors, true);
  assert.deepEqual(state.columnWidths, { date: 90 });
  assert.equal(state.showTags, false);
  assert.equal(state.showStashesPref, false);
  assert.equal(state.showUncommittedChangesPref, false);
  assert.equal(state.includeReflogCommits, true);
  assert.equal(state.repoConfig.commitsOrder, 'topo');
});

test('gitGraphApplyGlobalPrefsToState copies date/graph/columns/loading preferences onto working state', () => {
  const state = { columns: { date: true, author: true, commit: true } };
  settings.gitGraphApplyGlobalPrefsToState(state, {
    dateFormat: 'iso', dateType: 'commit', graphStyle: 'angular', graphColours: ['#111', '#222'],
    columnVisibility: { date: false, author: true, commit: true }, combineLocalAndRemoteBranchLabels: false,
    fileViewType: 'list', compactFolders: false, initialLoad: 500, loadMore: 50, loadMoreAutomatically: false,
    markdownRendering: false, enhancedAccessibility: true, fetchAvatars: true,
  });
  assert.equal(state.dateFormat, 'iso');
  assert.equal(state.dateType, 'commit');
  assert.equal(state.graphStyle, 'angular');
  assert.deepEqual(state.graphColours, ['#111', '#222']);
  assert.deepEqual(state.columns, { date: false, author: true, commit: true });
  assert.equal(state.combineLocalAndRemote, false);
  assert.equal(state.fileViewType, 'list');
  assert.equal(state.compactFolders, false);
  assert.equal(state.initialLoad, 500);
  assert.equal(state.loadMore, 50);
  assert.equal(state.loadMoreAutomatically, false);
  assert.equal(state.markdownRendering, false);
  assert.equal(state.enhancedAccessibility, true);
  assert.equal(state.globalFetchAvatars, true);
});

test('gitGraphAdvancedPrefsJson serializes exactly the five advanced fields', () => {
  const parsed = JSON.parse(settings.gitGraphAdvancedPrefsJson({
    dialogDefaults: { addTag: { type: 'annotated' } }, contextMenuActionsVisibility: {},
    customBranchGlobPatterns: [], customPullRequestProviders: [], customEmojiShortcodeMappings: {},
    dateFormat: 'iso', // not one of the five — must not leak into the advanced blob
  }));
  assert.deepEqual(Object.keys(parsed).sort(), ['contextMenuActionsVisibility', 'customBranchGlobPatterns', 'customEmojiShortcodeMappings', 'customPullRequestProviders', 'dialogDefaults']);
});

// === Persistence helpers (stubbed window.api / view globals) ===

test('gitGraphPatchRepoConfig calls setGitGraphRepoConfig for the selected repo and applies the returned config', async () => {
  const calls = [];
  withViewGlobals({
    gitGraphApi: async (name, ...args) => {
      calls.push([name, ...args]);
      return { ok: true, config: { showTags: false } };
    },
  });
  const state = { repositories: [{ path: '/repo' }], selectedRepo: '/repo' };
  const result = await settings.gitGraphPatchRepoConfig({ id: 'p1' }, state, { showTags: false });
  assert.deepEqual(calls[0], ['setGitGraphRepoConfig', 'p1', '/repo', { showTags: false }]);
  assert.equal(result.ok, true);
  assert.equal(state.repoConfig.showTags, false);
});

test('gitGraphPatchRepoConfig is a no-op when no repository is selected', async () => {
  withViewGlobals();
  const state = { repositories: [], selectedRepo: null };
  const result = await settings.gitGraphPatchRepoConfig({ id: 'p1' }, state, { showTags: false });
  assert.equal(result, null);
});

test('gitGraphClearAvatarCache empties the local avatar cache and repaints', async () => {
  let painted = false;
  withViewGlobals({
    gitGraphApi: async () => ({ ok: true }),
    gitGraphPaint: () => { painted = true; },
  });
  const state = { avatarCache: new Map([['a@b.com', 'url']]) };
  await settings.gitGraphClearAvatarCache({ id: 'p1' }, state, fakeElement());
  assert.equal(state.avatarCache.size, 0);
  assert.equal(painted, true);
});

// === Code Review session lifecycle ===

test('gitGraphStartCodeReview creates an empty review, persists it, and repaints details', async () => {
  const persisted = [];
  withViewGlobals({
    gitGraphApi: async (name, ...args) => {
      if (name === 'setGitGraphRepoConfig') persisted.push(args[2]);
      return { ok: true, config: { codeReview: args[2] && args[2].codeReview } };
    },
  });
  const state = { detailsData: { mode: 'single', kind: 'commit', hash: 'abc' }, repositories: [{ path: '/repo' }], selectedRepo: '/repo', repoConfig: { codeReview: {} } };
  await settings.gitGraphStartCodeReview({ id: 'p1' }, state, fakeElement());
  assert.equal(state.codeReview.key, 'abc');
  assert.equal(state.codeReview.reviewedPaths.size, 0);
  assert.ok(persisted[0].codeReview.abc);
});

test('gitGraphSetFileReviewed adds/removes a path from the active review and persists the updated map', async () => {
  const persisted = [];
  withViewGlobals({
    gitGraphApi: async (name, ...args) => {
      if (name === 'setGitGraphRepoConfig') persisted.push(args[2].codeReview);
      return { ok: true, config: { codeReview: args[2] && args[2].codeReview } };
    },
  });
  const state = { repositories: [{ path: '/repo' }], selectedRepo: '/repo', repoConfig: { codeReview: {} }, codeReview: { key: 'abc', reviewedPaths: new Set(), startedAt: 1 } };
  await settings.gitGraphSetFileReviewed({ id: 'p1' }, state, fakeElement(), 'a.js', true);
  assert.ok(state.codeReview.reviewedPaths.has('a.js'));
  assert.deepEqual(persisted[0].abc.reviewedPaths, ['a.js']);
  await settings.gitGraphSetFileReviewed({ id: 'p1' }, state, fakeElement(), 'a.js', false);
  assert.equal(state.codeReview.reviewedPaths.has('a.js'), false);
});

test('gitGraphMarkFileReviewedIfActive is a no-op with no active review or an already-reviewed path', () => {
  withViewGlobals({ gitGraphApi: async () => { throw new Error('should not be called'); } });
  settings.gitGraphMarkFileReviewedIfActive({ id: 'p1' }, { codeReview: null }, fakeElement(), 'a.js'); // no active review
  const reviewedState = { codeReview: { key: 'abc', reviewedPaths: new Set(['a.js']) } };
  settings.gitGraphMarkFileReviewedIfActive({ id: 'p1' }, reviewedState, fakeElement(), 'a.js'); // already reviewed
});

test('gitGraphCodeReviewControlsHtml offers Start when no review is active, End when one is, and nothing for Uncommitted alone', () => {
  assert.equal(settings.gitGraphCodeReviewControlsHtml({ detailsData: { mode: 'single', kind: 'uncommitted', hash: '#uncommitted' }, codeReview: null }), '');
  const startHtml = settings.gitGraphCodeReviewControlsHtml({ detailsData: { mode: 'single', kind: 'commit', hash: 'abc' }, codeReview: null });
  assert.match(startHtml, /Start Code Review/);
  const endHtml = settings.gitGraphCodeReviewControlsHtml({ detailsData: { mode: 'single', kind: 'commit', hash: 'abc' }, codeReview: { key: 'abc' } });
  assert.match(endHtml, /End Code Review/);
});

// === Trust flow ===

test('gitGraphMaybePromptTrust asks at most once per repository, and never when already trusted', async () => {
  let dialogCalls = 0;
  global.gitGraphShowTrustRepoConfigDialog = async () => { dialogCalls++; return false; };
  withViewGlobals({
    gitGraphApi: async (name) => {
      if (name === 'readProjectFile') return { ok: true, content: JSON.stringify({ customDisplayName: 'Shared Name' }) };
      if (name === 'trustGitGraphRepoConfig') return { ok: true };
      return { error: 'unused' };
    },
  });
  const state = { repoConfig: { trustedExternalConfig: false }, trustPromptShownFor: new Set(), selectedRepo: '/repo' };
  const repo = { path: '/repo' };
  await settings.gitGraphMaybePromptTrust({ id: 'p1' }, state, fakeElement(), repo);
  await settings.gitGraphMaybePromptTrust({ id: 'p1' }, state, fakeElement(), repo);
  assert.equal(dialogCalls, 1);
  delete global.gitGraphShowTrustRepoConfigDialog;
});

test('gitGraphMaybePromptTrust never prompts once trustedExternalConfig is already true', async () => {
  let dialogCalls = 0;
  global.gitGraphShowTrustRepoConfigDialog = async () => { dialogCalls++; return true; };
  withViewGlobals({ gitGraphApi: async () => ({ ok: true, content: '{}' }) });
  const state = { repoConfig: { trustedExternalConfig: true }, trustPromptShownFor: new Set(), selectedRepo: '/repo' };
  await settings.gitGraphMaybePromptTrust({ id: 'p1' }, state, fakeElement(), { path: '/repo' });
  assert.equal(dialogCalls, 0);
  delete global.gitGraphShowTrustRepoConfigDialog;
});

test('gitGraphMaybePromptTrust never prompts when no external config file is present', async () => {
  let dialogCalls = 0;
  global.gitGraphShowTrustRepoConfigDialog = async () => { dialogCalls++; return true; };
  withViewGlobals({ gitGraphApi: async (name) => (name === 'readProjectFile' ? { ok: false, error: 'ENOENT' } : { ok: true }) });
  const state = { repoConfig: { trustedExternalConfig: false }, trustPromptShownFor: new Set(), selectedRepo: '/repo' };
  await settings.gitGraphMaybePromptTrust({ id: 'p1' }, state, fakeElement(), { path: '/repo' });
  assert.equal(dialogCalls, 0);
  delete global.gitGraphShowTrustRepoConfigDialog;
});

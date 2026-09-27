// "Git Graph" project tab: a mutating, interactive commit graph for the
// project's attached repositories, sitting immediately after the existing
// read-only "Git" tab (which this file never touches). Layout and painting
// (this file + git-graph-render.js) are self-contained; menu item lists and
// dialogs are built by git-graph-menus.js / git-graph-dialogs.js and only
// ever called through the small set of guarded globals below, so this tab
// still renders and its own tests still pass before those files exist.
//
// Depends on globals: escapeHtml, formatDate (utils.js), PICONS (projects-view.js),
// showContextMenu (projects-view.js), createUnifiedMergeViewer (codemirror-setup.js),
// selectedProject/projectTab (projects-view.js), and the render helpers in
// git-graph-render.js (gitGraphFormatDate, gitGraphBuildLayoutInput,
// gitGraphResolveLayoutFn, gitGraphRenderGraphSvg, gitGraphRenderRefPills,
// gitGraphRowClasses, gitGraphDiffStatHtml, gitGraphAccessibilityBadge,
// gitGraphBuildFileTree, gitGraphIcon).

const GG_INITIAL_LOAD = 300;
const GG_LOAD_MORE = 100;

const gitGraphTabState = new Map();

function gitGraphState(projectId) {
  if (!gitGraphTabState.has(projectId)) {
    gitGraphTabState.set(projectId, {
      repositories: null,
      selectedRepo: null,
      request: 0,
      detailsRequest: 0,
      error: '',
      loading: false,
      rows: [],           // merged Commit[]+pseudo-commits, render order
      layout: [],          // parallel lane assignments
      refs: null,
      remotes: [],
      skip: 0,
      hasMore: false,
      loadingMore: false,
      branchSelection: 'all',
      tagSelection: 'all',
      showRemoteBranches: true,
      order: 'date',
      firstParentOnly: false,
      columns: { date: true, author: true, commit: true },
      columnWidths: {},
      muteMergeCommits: true,
      muteNonAncestors: false,
      dateFormat: 'date-time',
      dateType: 'author',
      graphStyle: 'rounded',
      uncommittedChangesStyle: 'openAtUncommitted',
      combineLocalAndRemote: true,
      selectedHash: null,
      compareHash: null,
      detailsLocation: 'inline',
      detailsData: null,
      detailsLoading: false,
      fileViewType: 'tree',
      compactFolders: true,
      selectedFilePath: null,
      findOpen: false,
      findQuery: '',
      findCaseSensitive: false,
      findAlsoOpenDetails: false,
      findMatches: [],
      findIndex: -1,
      settingsOpen: false,
      settingsTab: 'repository',
      progress: null,
      keydownHandler: null,
      watcherUnsub: null,
      // Repository-scoped fields loaded from RepoConfig (git-graph-settings.js's
      // gitGraphApplyRepoConfigToState) once a repo's config is read.
      repoConfig: null,
      showTags: true,
      showStashesPref: true,
      showUncommittedChangesPref: true,
      includeReflogCommits: false,
      trustPromptShownFor: new Set(),
      // App-wide fields loaded from GlobalPrefs (gitGraphApplyGlobalPrefsToState).
      globalPrefs: null,
      graphColours: null,
      initialLoad: GG_INITIAL_LOAD,
      loadMore: GG_LOAD_MORE,
      loadMoreAutomatically: true,
      repositoryDropdownOrder: 'attachmentOrder',
      markdownRendering: true,
      enhancedAccessibility: false,
      referenceLabelAlignment: 'normal',
      globalFetchAvatars: false,
      autoCenterDetails: true,
      // Avatars and Code Review.
      avatarCache: new Map(),
      avatarPending: new Set(),
      codeReview: null,
      lastViewedFilePath: null,
    });
  }
  return gitGraphTabState.get(projectId);
}

// --- window.api wrapper: degrades gracefully if the preload bridge doesn't expose a given call yet ---

function gitGraphApi(name, ...args) {
  if (!window.api || typeof window.api[name] !== 'function') {
    return Promise.resolve({ error: `${name} is not available yet` });
  }
  return window.api[name](...args);
}

// --- Per-viewer ephemeral UI-state persistence: localStorage, not server-side
// — resets are acceptable, matching the existing tab-memory idiom. ---

function gitGraphUiKey(projectId) { return `gitGraph.ui.${projectId}`; }

function gitGraphLoadUiPrefs(projectId) {
  try {
    const raw = localStorage.getItem(gitGraphUiKey(projectId));
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function gitGraphSaveUiPrefs(projectId, state) {
  try {
    localStorage.setItem(gitGraphUiKey(projectId), JSON.stringify({
      selectedRepo: state.selectedRepo,
      columns: state.columns,
      columnWidths: state.columnWidths,
      branchSelection: state.branchSelection,
      tagSelection: state.tagSelection,
      showRemoteBranches: state.showRemoteBranches,
      order: state.order,
      findOpen: state.findOpen,
      fileViewType: state.fileViewType,
    }));
  } catch { /* private-browsing / disabled storage: ephemeral state only */ }
}

// --- Pure helpers (unit-tested directly; no DOM) ---

/** Case-sensitive/-insensitive substring match across message/date/author/hash/branch/tag. */
function gitGraphFindMatches(rows, query, caseSensitive) {
  if (!query) return [];
  const q = caseSensitive ? query : query.toLowerCase();
  const norm = (v) => (caseSensitive ? String(v || '') : String(v || '').toLowerCase());
  const matches = [];
  const refName = (typeof gitGraphRefName === 'function') ? gitGraphRefName : (entry => (typeof entry === 'string' ? entry : entry && entry.name));
  rows.forEach((row, index) => {
    const refNames = [
      ...(row.refs?.heads || []).map(refName),
      ...(row.refs?.remotes || []).map(r => r.name),
      ...(row.refs?.tags || []).map(refName),
    ];
    const haystacks = [row.subject, row.authorDate, row.commitDate, row.authorName, row.hash, ...refNames];
    if (haystacks.some(h => norm(h).includes(q))) matches.push(index);
  });
  return matches;
}

/**
 * Escape → dialog, then context menu, then Commit Details/Comparison view, in
 * that priority order. `hooks` are the closers for whichever
 * of those is actually open; each returns true if it closed something.
 */
function gitGraphHandleEscapePriority(hooks) {
  if (hooks.closeDialog && hooks.closeDialog()) return 'dialog';
  if (hooks.closeMenu && hooks.closeMenu()) return 'menu';
  if (hooks.closeDetails && hooks.closeDetails()) return 'details';
  if (hooks.closeFind && hooks.closeFind()) return 'find';
  return null;
}

function gitGraphIsEditableTarget(target) {
  if (!target) return false;
  const tag = (target.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || target.isContentEditable;
}

/** Reads the frozen data-gg-* contract off the closest carrying element. */
function gitGraphReadTargetData(target) {
  const el = target && typeof target.closest === 'function' ? target.closest('[data-gg-kind]') : null;
  if (!el) return null;
  const ds = el.dataset || {};
  return {
    el,
    kind: ds.ggKind || null,
    hash: ds.ggHash || null,
    refName: ds.ggRefName || null,
    remote: ds.ggRemote || null,
    refType: ds.ggRefType || null,
    filePath: ds.ggFilePath || null,
  };
}

/** kind -> which of git-graph-menus.js's real gitGraphBuild*Menu functions to call. */
const GG_MENU_BUILDERS = {
  commit: 'gitGraphBuildCommitMenu',
  uncommitted: 'gitGraphBuildUncommittedMenu',
  branch: 'gitGraphBuildLocalBranchMenu',
  'remote-branch': 'gitGraphBuildRemoteBranchMenu',
  tag: 'gitGraphBuildTagMenu',
  stash: 'gitGraphBuildStashMenu',
  file: 'gitGraphBuildFileMenu',
  'column-header': 'gitGraphBuildColumnHeaderMenu',
  link: 'gitGraphBuildLinkMenu',
};

/**
 * Own fallback dispatch, used only when git-graph-menus.js's real
 * `gitGraphShowContextMenu(el, ctx, position)` (which does the same
 * data-gg-* routing plus the combined-pill dual-hit-region case) has not
 * been loaded — keeps this tab's own logic working (and its own tests
 * self-sufficient) even without that file present.
 */
function gitGraphDispatchContextMenu(el, ctx, position, target) {
  const data = target || gitGraphReadTargetData(el);
  if (!data) return false;
  const builderName = data.kind === 'branch' && data.refType === 'remote' ? GG_MENU_BUILDERS['remote-branch'] : GG_MENU_BUILDERS[data.kind];
  const builder = builderName ? globalThis[builderName] : null;
  if (typeof builder !== 'function' || typeof showContextMenu !== 'function') return false;
  showContextMenu(builder(ctx), position);
  return true;
}

function gitGraphAllBranchKeys(state) {
  const heads = ((state.refs && state.refs.heads) || []).map(h => h.name);
  const visibleRemotes = gitGraphVisibleRemotes((state.refs && state.refs.remotes) || [], state.repoConfig && state.repoConfig.perRemoteVisibility);
  const remotes = visibleRemotes.map(r => `${r.remote}/${r.name}`);
  return [...heads, ...remotes];
}

function gitGraphToggleBranchKey(project, state, body, key, select) {
  const current = state.branchSelection === 'all' ? new Set(gitGraphAllBranchKeys(state)) : new Set(state.branchSelection);
  if (select) current.add(key); else current.delete(key);
  state.branchSelection = [...current];
  gitGraphSaveUiPrefs(project.id, state);
  gitGraphPatchRepoConfig(project, state, { branchDropdownSelection: state.branchSelection });
  gitGraphLoadGraph(project, state, body, { reset: true });
}

function gitGraphDefaultRemoteName(remotes) {
  if (!remotes || !remotes.length) return null;
  return (remotes.find(r => r.name === 'origin') || remotes[0]).name;
}

function gitGraphRemoteBranchesByLocalName(refs) {
  const map = {};
  for (const remote of (refs && refs.remotes) || []) {
    if (!map[remote.name]) map[remote.name] = [];
    map[remote.name].push(remote);
  }
  return map;
}

/** Builds the file-menu target object git-graph-menus.js's gitGraphBuildFileMenu expects. */
function gitGraphBuildFileCtx(state, filePath) {
  const data = state.detailsData || {};
  const file = (data.files || []).find(f => f.path === filePath) || { path: filePath, status: 'modified' };
  const repo = (state.repositories || []).find(r => r.path === state.selectedRepo);
  const isUncommittedSide = (data.mode === 'single' && data.kind === 'uncommitted') || (data.mode === 'compare' && data.toHash === '#uncommitted');
  const isSingleHistorical = data.mode === 'single' && data.kind !== 'uncommitted';
  return {
    path: file.path,
    relativePath: file.path,
    absolutePath: repo ? `${repo.path}/${file.path}` : file.path,
    status: file.status,
    existsOnDisk: file.status !== 'deleted',
    isWorkingTreeSide: isUncommittedSide,
    isHistoricalSingleCommit: isSingleHistorical,
    revisionHash: isSingleHistorical ? data.hash : null,
    revisionShortHash: isSingleHistorical ? (data.commit && data.commit.shortHash) : null,
  };
}

/** Fills in the one target-specific field (commit/localBranch/remoteBranch/tag/stash/file/columnHeader/link) git-graph-menus.js's ctx contract expects, from the frozen data-gg-* attributes. */
function gitGraphPopulateTargetField(ctx, state, target) {
  if (!target) return;
  if (target.kind === 'commit' || target.kind === 'uncommitted') {
    const row = state.rows.find(r => r.hash === target.hash);
    if (row) ctx.commit = { hash: row.hash, shortHash: row.shortHash, subject: row.subject, parents: row.parents || [], children: (state.childrenByHash && state.childrenByHash.get(row.hash)) || [] };
  } else if (target.kind === 'branch' && target.refType !== 'remote') {
    ctx.localBranch = { name: target.refName, hash: target.hash };
  } else if (target.kind === 'remote-branch' || (target.kind === 'branch' && target.refType === 'remote')) {
    ctx.remoteBranch = { remote: target.remote, name: target.refName, hash: target.hash };
  } else if (target.kind === 'tag') {
    const known = ((state.refs && state.refs.tags) || []).find(t => t.name === target.refName);
    ctx.tag = { name: target.refName, hash: target.hash, annotated: !!(known && known.annotated) };
  } else if (target.kind === 'stash') {
    const stash = (state.stashes || []).find(s => s.hash === target.hash);
    ctx.stash = stash ? { hash: stash.hash, index: stash.index, branch: stash.branch, message: stash.message } : { hash: target.hash };
  } else if (target.kind === 'file') {
    ctx.file = gitGraphBuildFileCtx(state, target.filePath);
  } else if (target.kind === 'column-header') {
    ctx.columnHeader = { columnVisibility: state.columns, commitsOrder: state.order };
  } else if (target.kind === 'link') {
    ctx.link = { url: (target.el && (target.el.getAttribute('href') || target.el.href)) || '' };
  }
}

/** Assembles the full ctx object git-graph-menus.js's gitGraphBuild*Menu functions read (see that file's own header comment for the contract). */
function gitGraphBuildMenuCtx(project, state, body, repo, target) {
  const ctx = {
    projectId: project.id,
    folderPath: repo.path,
    refresh: () => gitGraphLoadGraph(project, state, body, { reset: true }),
    head: { hash: state.headHash || null, branch: state.headBranchName || null },
    remotes: state.remotes || [],
    localBranches: ((state.refs && state.refs.heads) || []).map(h => ({ name: h.name, hash: h.hash })),
    selectedBranchKeys: state.branchSelection,
    onSelectBranch: (key) => gitGraphToggleBranchKey(project, state, body, key, true),
    onUnselectBranch: (key) => gitGraphToggleBranchKey(project, state, body, key, false),
    issueLinking: (state.repoConfig && state.repoConfig.issueLinking) || null,
    pullRequestProvider: (state.repoConfig && state.repoConfig.pullRequestProvider) || null,
    defaultBranch: state.headBranchName || 'main',
    defaultRemoteName: gitGraphDefaultRemoteName(state.remotes),
    dialogDefaults: (state.globalPrefs && state.globalPrefs.dialogDefaults) || {},
    contextMenuActionsVisibility: (state.globalPrefs && state.globalPrefs.contextMenuActionsVisibility) || {},
    remoteBranchesByLocalName: gitGraphRemoteBranchesByLocalName(state.refs),
    tags: ((state.refs && state.refs.tags) || []).map(t => (typeof t === 'string' ? t : t && t.name)).filter(Boolean),
    onColumnVisibilityChange: (col, visible) => {
      state.columns[col] = visible;
      gitGraphPatchGlobalPrefs(state, { columnVisibility: { ...state.columns } });
      gitGraphPaint(project, state, body);
    },
    onCommitsOrderChange: (order) => {
      state.order = order;
      gitGraphPatchRepoConfig(project, state, { commitsOrder: order });
      gitGraphLoadGraph(project, state, body, { reset: true });
    },
    onOpenSourceControlView: () => { if (typeof setProjectTab === 'function') setProjectTab(project, 'git'); if (typeof renderOverview === 'function') renderOverview(); },
    hasUntrackedFiles: !!(state.uncommitted && (state.uncommitted.changes || []).some(f => f.status === 'untracked')),
    codeReview: state.codeReview ? { key: state.codeReview.key, reviewedPaths: state.codeReview.reviewedPaths } : null,
    onMarkFileReviewed: (path, reviewed) => gitGraphSetFileReviewed(project, state, body, path, reviewed),
    onViewDiff: (file) => gitGraphOpenFileDiff(project, state, body, repo, file.path),
    onViewFileAtRevision: (file) => gitGraphViewFileAtRevision(project, state, body, repo, file),
    onViewDiffWithWorkingFile: (file) => gitGraphOpenFileDiff(project, state, body, repo, file.path, { forceWorkingTree: true }),
    // 'openPath' is the reveal-in-file-manager channel and only accepts a
    // directory; opening a file with its OS-default application goes through
    // 'openFileExternally' instead, the same channel every other "open this
    // file externally" call in the app uses.
    onOpenFile: (file) => { gitGraphMarkFileReviewedIfActive(project, state, body, file.path); return gitGraphApi('openFileExternally', file.absolutePath || file.path, repo.path); },
  };
  gitGraphPopulateTargetField(ctx, state, target);
  return ctx;
}

/** One call site for every right-click: prefers git-graph-menus.js's real dispatcher, falls back to this file's own when it is not loaded (pre-integration/tests). */
function gitGraphOpenContextMenu(project, state, body, el, position) {
  const repo = (state.repositories || []).find(r => r.path === state.selectedRepo);
  if (!repo) return;
  const attrReader = typeof gitGraphReadTargetAttrs === 'function' ? gitGraphReadTargetAttrs : null;
  const target = attrReader ? { ...attrReader(el), el } : gitGraphReadTargetData(el);
  if (!target || !target.kind) return;
  const ctx = gitGraphBuildMenuCtx(project, state, body, repo, target);
  if (typeof gitGraphShowContextMenu === 'function') gitGraphShowContextMenu(el, ctx, position);
  else gitGraphDispatchContextMenu(el, ctx, position, target);
}

/** Double-click checks out immediately, with no confirmation. */
function gitGraphHandleDoubleClick(target, ctx) {
  const data = gitGraphReadTargetData(target);
  if (!data) return null;
  if (data.kind === 'commit' && data.hash) {
    gitGraphApi('runGitGraphAction', ctx.projectId, ctx.repoPath, 'checkoutCommit', { commit: data.hash });
    return 'checkoutCommit';
  }
  if (data.kind === 'branch' && data.refName) {
    gitGraphApi('runGitGraphAction', ctx.projectId, ctx.repoPath, 'checkoutBranchImmediate', { name: data.refName });
    return 'checkoutBranchImmediate';
  }
  // Either half of a combined local+remote pill checks out the local branch
  // (the remote half carries data-gg-kind="remote-branch"); a standalone
  // remote pill with no matching local branch has nothing to check out.
  if (data.kind === 'remote-branch' && data.refName && ctx.localBranchNames && ctx.localBranchNames.has(data.refName)) {
    gitGraphApi('runGitGraphAction', ctx.projectId, ctx.repoPath, 'checkoutBranchImmediate', { name: data.refName });
    return 'checkoutBranchImmediate';
  }
  return null;
}

// --- Layout / row assembly ---

function gitGraphMergedRows(state) {
  return gitGraphBuildLayoutInput(state.rawCommits || [], state.stashes || [], state.uncommitted, state.headHash);
}

function gitGraphRecomputeLayout(state) {
  state.rows = gitGraphMergedRows(state);
  const layoutFn = gitGraphResolveLayoutFn();
  state.layout = layoutFn(state.rows, state.order, { firstParentOnly: state.firstParentOnly });
}

/** hash -> [{hash, parents}] for every commit that names it as a parent (git-graph-menus.js's Drop… visibility rule needs this; git log alone only gives parents, never children). */
function gitGraphComputeChildren(rawCommits) {
  const map = new Map();
  for (const commit of rawCommits || []) {
    for (const parentHash of commit.parents || []) {
      if (!map.has(parentHash)) map.set(parentHash, []);
      map.get(parentHash).push({ hash: commit.hash, parents: commit.parents || [] });
    }
  }
  return map;
}

// --- Data loading ---

function gitGraphRepoList(project) {
  const seen = new Set();
  const list = [];
  for (const path of [project.root, ...((project.folders || []).map(f => f.path))]) {
    if (path && !seen.has(path)) { seen.add(path); list.push({ path }); }
  }
  return list;
}

function gitGraphLoadRepositories(project, state) {
  return gitGraphApi('getProjectGitInfo', project.id).then((result) => {
    const list = (result && result.ok && result.repositories) ? result.repositories : gitGraphRepoList(project);
    state.repositories = list.filter(r => r.git !== false);
    if (!state.repositories.length) state.repositories = list;
    return state.repositories;
  });
}

function gitGraphLoadGraph(project, state, body, opts = {}) {
  const repo = (state.repositories || []).find(r => r.path === state.selectedRepo) || (state.repositories || [])[0];
  if (!repo) return Promise.resolve();
  state.selectedRepo = repo.path;
  const reset = opts.reset !== false;
  if (reset) { state.skip = 0; state.rawCommits = []; }
  const limit = reset ? (state.initialLoad || GG_INITIAL_LOAD) : (state.loadMore || GG_LOAD_MORE);
  const request = ++state.request;
  if (reset) { state.loading = true; state.error = ''; } else { state.loadingMore = true; }
  gitGraphPaint(project, state, body);

  return gitGraphApi('getProjectGitGraph', project.id, repo.path, {
    branches: state.branchSelection,
    tags: state.tagSelection,
    order: state.order,
    limit,
    skip: state.skip,
    firstParentOnly: state.firstParentOnly,
    includeReflogCommits: state.includeReflogCommits,
    showRemote: state.showRemoteBranches,
    showTags: state.showTags,
    showStashes: state.showStashesPref,
    refsUnchanged: !reset,
  }).then((result) => {
    if (request !== state.request) return;
    state.loading = false;
    state.loadingMore = false;
    if (!result || !result.ok) {
      state.error = (result && result.error) || 'Could not load the commit graph.';
      gitGraphPaint(project, state, body);
      return;
    }
    const incoming = result.commits || [];
    state.rawCommits = reset ? incoming : [...(state.rawCommits || []), ...incoming];
    if (result.refs) state.refs = result.refs;
    state.stashes = result.stashes || [];
    state.uncommitted = state.showUncommittedChangesPref !== false ? (result.uncommitted || null) : null;
    state.headHash = (state.rawCommits.find(c => c.isHead) || {}).hash || state.headHash;
    state.headBranchName = ((state.refs && state.refs.heads || []).find(h => h.isHead) || {}).name || null;
    state.childrenByHash = gitGraphComputeChildren(state.rawCommits);
    state.hasMore = !!result.hasMore;
    state.skip = state.rawCommits.length;
    gitGraphRecomputeLayout(state);
    if (reset) {
      gitGraphApi('getGitGraphRemotes', project.id, repo.path).then((r) => {
        state.remotes = (r && r.ok && r.remotes) || [];
        if (body.isConnected && gitGraphStillActive(project)) gitGraphPaint(project, state, body);
      });
      gitGraphApi('getGitGraphRepoConfig', project.id, repo.path).then((r) => {
        if (!(r && r.ok)) return;
        gitGraphApplyRepoConfigToState(state, r.config);
        gitGraphMaybePromptTrust(project, state, body, repo);
      });
      gitGraphApi('getGitGraphGlobalPreferences').then((r) => {
        if (r && r.ok) gitGraphApplyGlobalPrefsToState(state, r.preferences);
      });
    }
    gitGraphPaint(project, state, body);
  }).catch((err) => {
    if (request !== state.request) return;
    state.loading = false;
    state.loadingMore = false;
    state.error = err?.message || 'Could not load the commit graph.';
    gitGraphPaint(project, state, body);
  });
}

function gitGraphStillActive(project) {
  return typeof selectedProject === 'function' && selectedProject()?.id === project.id &&
    typeof projectTab === 'function' && projectTab(project) === 'gitgraph';
}

// --- Entry point ---

function renderProjectGitGraphTab(project, body) {
  const state = gitGraphState(project.id);
  const prefs = gitGraphLoadUiPrefs(project.id);
  Object.assign(state, {
    selectedRepo: state.selectedRepo || prefs.selectedRepo || null,
    columns: prefs.columns || state.columns,
    columnWidths: prefs.columnWidths || state.columnWidths,
    branchSelection: prefs.branchSelection || state.branchSelection,
    tagSelection: prefs.tagSelection || state.tagSelection,
    showRemoteBranches: prefs.showRemoteBranches !== undefined ? prefs.showRemoteBranches : state.showRemoteBranches,
    order: prefs.order || state.order,
    fileViewType: prefs.fileViewType || state.fileViewType,
  });
  body.className = 'ws-body gg-tab-body';
  gitGraphBindKeyboard(project, state, body);
  gitGraphBindWatcher(project, state, body);
  gitGraphBindProgress(project, state, body);

  // project.folders can change while this tab isn't the one being painted
  // (e.g. Attach Folder… from the Settings tab) — state.repositories is
  // cached per project id across tab switches, so without this check a
  // newly-attached folder would never appear here until the app restarts.
  const freshPaths = gitGraphRepoList(project).map(r => r.path);
  const cachedPaths = (state.repositories || []).map(r => r.path);
  const repositoriesStale = !!state.repositories && !gitGraphSameStringSet(cachedPaths, freshPaths);

  if (state.repositories && !repositoriesStale) { gitGraphPaint(project, state, body); return; }
  const firstLoad = !state.repositories;
  if (firstLoad) body.innerHTML = '<div class="gg-loading"><span class="gg-loading-dot"></span>Reading repository…</div>';
  gitGraphLoadRepositories(project, state).then(() => {
    if (!body.isConnected || !gitGraphStillActive(project)) return;
    if (!state.repositories.length) { gitGraphPaint(project, state, body); return; }
    if (!firstLoad) {
      // Only the repo list itself was stale — the currently selected repo's
      // own loaded graph is still valid, so just refresh the picker rather
      // than re-running the whole first-load sequence (preferences + graph)
      // and losing the user's place.
      state.repositories = gitGraphSortRepositories(state.repositories, state.repositoryDropdownOrder);
      gitGraphPaint(project, state, body);
      return;
    }
    const repo = state.repositories.find(r => r.path === state.selectedRepo) || state.repositories[0];
    // Reading RepoConfig/GlobalPrefs before the very first commit query (rather
    // than only after it, as every later reload still does below) is what
    // makes a stored branch selection/order/mute-rule correct on the tab's
    // first paint instead of only after a second, corrective reload.
    gitGraphLoadInitialPreferences(project, state, repo).then(() => {
      if (!body.isConnected || !gitGraphStillActive(project)) return;
      state.repositories = gitGraphSortRepositories(state.repositories, state.repositoryDropdownOrder);
      gitGraphLoadGraph(project, state, body, { reset: true });
    });
  });
}

function gitGraphSameStringSet(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

// --- Painting ---

function gitGraphPaint(project, state, body) {
  const repos = state.repositories || [];
  if (!repos.length) {
    body.innerHTML = '<div class="gg-empty-state"><div class="gg-empty-title">No folders attached</div><div>Attach a repository to this project to see its history here.</div></div>';
    return;
  }
  const repo = repos.find(r => r.path === state.selectedRepo) || repos[0];
  state.selectedRepo = repo.path;

  if (repo.git === false) {
    body.innerHTML = `<div class="gg-tab-shell">${gitGraphRepoPickerHtml(repos, repo)}<div class="gg-empty-state"><div class="gg-empty-title">Not a Git repository</div><div>${escapeHtml(repo.path)}</div></div></div>`;
    gitGraphWireRepoPicker(project, state, body);
    return;
  }

  if (state.error) {
    body.innerHTML = `<div class="gg-tab-shell">${gitGraphRepoPickerHtml(repos, repo)}<div class="gg-error-state"><div class="gg-empty-title">Git Graph could not load this repository</div><div>${escapeHtml(state.error)}</div><button type="button" class="ws-btn" id="gg-retry">Retry</button></div></div>`;
    body.querySelector('#gg-retry').onclick = () => gitGraphLoadGraph(project, state, body, { reset: true });
    gitGraphWireRepoPicker(project, state, body);
    return;
  }

  if (state.loading && !state.rows.length) {
    body.innerHTML = `<div class="gg-tab-shell">${gitGraphRepoPickerHtml(repos, repo)}<div class="gg-loading"><span class="gg-loading-dot"></span>Loading commits…</div></div>`;
    gitGraphWireRepoPicker(project, state, body);
    return;
  }

  body.innerHTML = `
    <div class="gg-tab-shell gg-ref-align-${escapeHtml(state.referenceLabelAlignment || 'normal')}">
      ${gitGraphRepoPickerHtml(repos, repo)}
      ${gitGraphControlBarHtml(project, state)}
      ${gitGraphFindWidgetHtml(state)}
      <div class="gg-table-wrap">
        ${gitGraphHeaderHtml(state)}
        <div class="gg-tbody" id="gg-tbody">${gitGraphRowsHtml(project, state)}</div>
        ${state.hasMore ? '<button type="button" class="gg-load-more" id="gg-load-more">Load More Commits</button>' : ''}
      </div>
      <div class="gg-details-docked" id="gg-details-docked" style="display:none"></div>
      <div class="gg-settings-drawer" id="gg-settings-drawer" style="display:none"></div>
    </div>`;

  gitGraphWireRepoPicker(project, state, body);
  gitGraphWireControlBar(project, state, body);
  gitGraphWireFindWidget(project, state, body);
  gitGraphWireHeader(project, state, body);
  gitGraphWireRows(project, state, body);
  if (state.detailsData && state.detailsLocation === 'docked') {
    gitGraphRenderDetailsPanel(project, state, body);
  } else if (state.detailsData) {
    // Inline mode's markup already came back inside #gg-tbody's own innerHTML
    // (gitGraphRowsHtml/gitGraphInlineDetailsHtml), so only the event wiring
    // — not a second render — is needed here.
    const inline = body.querySelector('#gg-details-inline');
    if (inline) { gitGraphWireDetailsPanel(project, state, body, inline); gitGraphMaybeAutoCenterDetails(state, inline); }
  }
  if (state.settingsOpen) gitGraphRenderSettingsDrawer(project, state, body);
  if (state.progress) gitGraphRenderProgress(project, state, body);
}

function gitGraphRepoPickerHtml(repos, active) {
  if (repos.length <= 1) return '';
  return `<div class="gg-repo-picker" role="tablist" aria-label="Repositories">${repos.map((r, i) => `<button type="button" class="gg-repo-option ${r.path === active.path ? 'active' : ''}" data-index="${i}" title="${escapeAttr(r.path)}">${escapeHtml(pathBasename(r.path) || r.path)}</button>`).join('')}</div>`;
}

function gitGraphWireRepoPicker(project, state, body) {
  body.querySelectorAll('.gg-repo-option').forEach((btn) => {
    const repo = (state.repositories || [])[Number(btn.dataset.index)];
    if (!repo) return;
    btn.onclick = () => {
      state.selectedRepo = repo.path;
      state.selectedHash = null;
      state.detailsData = null;
      gitGraphSaveUiPrefs(project.id, state);
      gitGraphLoadGraph(project, state, body, { reset: true });
    };
  });
}

// --- Control bar ---

function gitGraphControlBarHtml(project, state) {
  const branchCount = (state.refs?.heads?.length || 0) + (state.refs?.remotes?.length || 0);
  const branchLabel = state.branchSelection === 'all' ? 'Show All'
    : Array.isArray(state.branchSelection) && state.branchSelection.length
      ? `${state.branchSelection.length} branch${state.branchSelection.length === 1 ? '' : 'es'}`
      : 'Show All';
  const tagCount = Array.isArray(state.tagSelection) ? state.tagSelection.length : null;
  const tagLabel = tagCount === null ? '' : ` · ${tagCount} tag${tagCount === 1 ? '' : 's'}`;
  return `
    <div class="gg-toolbar">
      <div class="gg-toolbar-left">
        <div class="gg-branches-dropdown">
          <button type="button" class="gg-toolbar-btn" id="gg-branches-btn">${gitGraphIcon('branch', 13)}<span>Branches: ${escapeHtml(branchLabel + tagLabel)}</span>${gitGraphIcon('chevronDown', 10)}</button>
        </div>
        <label class="gg-checkbox"><input type="checkbox" id="gg-show-remote" ${state.showRemoteBranches ? 'checked' : ''}> Show Remote</label>
      </div>
      <div class="gg-toolbar-right">
        <button type="button" class="gg-icon-btn" id="gg-find-btn" title="Find (Ctrl/Cmd+F)">${gitGraphIcon('search', 14)}</button>
        <button type="button" class="gg-icon-btn" id="gg-settings-btn" title="Repository Settings">${gitGraphIcon('gear', 14)}</button>
        ${state.remotes.length ? `<button type="button" class="gg-icon-btn" id="gg-fetch-btn" title="Fetch from Remote(s)">${gitGraphIcon('fetch', 14)}</button>` : ''}
        <button type="button" class="gg-icon-btn ${state.loading ? 'gg-spin' : ''}" id="gg-refresh-btn" title="Refresh (Ctrl/Cmd+R)">${gitGraphIcon('refresh', 14)}</button>
        <button type="button" class="gg-icon-btn" id="gg-terminal-btn" title="Open a Terminal for this Repository">${gitGraphIcon('terminal', 14)}</button>
      </div>
    </div>
    <div class="gg-branches-menu" id="gg-branches-menu" style="display:none"></div>`;
}

function gitGraphWireControlBar(project, state, body) {
  const repo = (state.repositories || []).find(r => r.path === state.selectedRepo);
  body.querySelector('#gg-show-remote').onchange = (e) => {
    state.showRemoteBranches = e.target.checked;
    gitGraphSaveUiPrefs(project.id, state);
    gitGraphPatchRepoConfig(project, state, { showRemoteBranches: e.target.checked });
    gitGraphLoadGraph(project, state, body, { reset: true });
  };
  body.querySelector('#gg-find-btn').onclick = () => { state.findOpen = !state.findOpen; gitGraphPaint(project, state, body); };
  body.querySelector('#gg-settings-btn').onclick = () => gitGraphToggleSettings(project, state, body);
  const fetchBtn = body.querySelector('#gg-fetch-btn');
  if (fetchBtn) {
    fetchBtn.onclick = () => gitGraphRunNetworkAction(project, state, body, 'fetchAllRemotes', {
      prune: !!(state.repoConfig && state.repoConfig.fetchAndPrune),
      pruneTags: !!(state.repoConfig && state.repoConfig.fetchAndPruneTags),
    });
  }
  body.querySelector('#gg-refresh-btn').onclick = () => gitGraphLoadGraph(project, state, body, { reset: true });
  body.querySelector('#gg-terminal-btn').onclick = () => {
    if (typeof launchTerminalSession === 'function' && repo) launchTerminalSession({ projectPath: repo.path, projectId: project.id });
  };
  const branchesBtn = body.querySelector('#gg-branches-btn');
  if (branchesBtn) {
    branchesBtn.onclick = () => gitGraphToggleBranchesMenu(project, state, body, branchesBtn);
    // Picking a branch reloads (and repaints) the graph; keep the menu open across that.
    if (state.branchesMenuOpen) gitGraphOpenBranchesMenu(project, state, body, branchesBtn);
  }
}

function gitGraphCloseBranchesMenu(state) {
  state.branchesMenuOpen = false;
  if (state.branchesMenuCleanup) state.branchesMenuCleanup();
  state.branchesMenuCleanup = null;
}

function gitGraphToggleBranchesMenu(project, state, body, anchor) {
  if (state.branchesMenuOpen) {
    gitGraphCloseBranchesMenu(state);
    const menu = body.querySelector('#gg-branches-menu');
    if (menu) menu.style.display = 'none';
    return;
  }
  gitGraphOpenBranchesMenu(project, state, body, anchor);
}

function gitGraphOpenBranchesMenu(project, state, body, anchor) {
  const menu = body.querySelector('#gg-branches-menu');
  if (!menu) return;
  if (state.branchesMenuCleanup) state.branchesMenuCleanup();
  state.branchesMenuOpen = true;
  const tab = state.branchesMenuTab === 'tags' ? 'tags' : 'branches';
  const selKey = tab === 'tags' ? 'tagSelection' : 'branchSelection';
  let allNames;
  if (tab === 'tags') {
    allNames = (state.refs?.tags || []).map(t => t.name);
  } else {
    const heads = state.refs?.heads || [];
    const remotes = state.showRemoteBranches ? gitGraphVisibleRemotes(state.refs?.remotes || [], state.repoConfig && state.repoConfig.perRemoteVisibility) : [];
    allNames = [...heads.map(h => h.name), ...remotes.map(r => `${r.remote}/${r.name}`)];
  }
  const selection = state[selKey] || 'all';
  const selected = selection === 'all' ? new Set(allNames) : new Set(selection);
  menu.innerHTML = `
    <div class="gg-branches-tabs">
      <button type="button" class="gg-branches-tab ${tab === 'branches' ? 'active' : ''}" data-tab="branches">Branches</button>
      <button type="button" class="gg-branches-tab ${tab === 'tags' ? 'active' : ''}" data-tab="tags">Tags</button>
    </div>
    <div class="gg-branches-search"><input type="text" id="gg-branches-filter" placeholder="Filter ${tab}…"></div>
    <label class="gg-branches-row gg-branches-show-all"><input type="checkbox" id="gg-branches-all" ${selection === 'all' ? 'checked' : ''}> Show All</label>
    <div class="gg-branches-list">${allNames.length ? allNames.map(name => `<label class="gg-branches-row" data-name="${escapeAttr(name)}"><input type="checkbox" data-name="${escapeAttr(name)}" ${selected.has(name) ? 'checked' : ''}> ${escapeHtml(name)}</label>`).join('') : `<div class="gg-empty-row">No ${tab}.</div>`}</div>`;
  menu.style.display = 'block';
  // Fixed to the button so it floats above the graph instead of sitting in the page flow.
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.left}px`;
  menu.style.maxHeight = `${Math.max(200, window.innerHeight - rect.bottom - 24)}px`;
  const dismiss = (e) => {
    if (e.type === 'keydown' ? e.key !== 'Escape' : (menu.contains(e.target) || anchor.contains(e.target))) return;
    gitGraphCloseBranchesMenu(state);
    menu.style.display = 'none';
  };
  document.addEventListener('pointerdown', dismiss, true);
  document.addEventListener('keydown', dismiss, true);
  state.branchesMenuCleanup = () => {
    document.removeEventListener('pointerdown', dismiss, true);
    document.removeEventListener('keydown', dismiss, true);
  };
  menu.querySelectorAll('.gg-branches-tab').forEach((btn) => {
    btn.onclick = () => { state.branchesMenuTab = btn.dataset.tab; state.branchesFilter = ''; gitGraphOpenBranchesMenu(project, state, body, anchor); };
  });
  const filter = menu.querySelector('#gg-branches-filter');
  filter.value = state.branchesFilter || '';
  const applyFilter = () => {
    const q = filter.value.toLowerCase();
    menu.querySelectorAll('.gg-branches-list .gg-branches-row').forEach((row) => {
      row.style.display = row.dataset.name.toLowerCase().includes(q) ? '' : 'none';
    });
  };
  applyFilter();
  const commit = (next) => {
    state[selKey] = next;
    gitGraphSaveUiPrefs(project.id, state);
    if (selKey === 'branchSelection') gitGraphPatchRepoConfig(project, state, { branchDropdownSelection: next });
    gitGraphLoadGraph(project, state, body, { reset: true });
  };
  const showAll = menu.querySelector('#gg-branches-all');
  showAll.onclick = () => commit('all');
  showAll.ondblclick = () => commit(state[selKey] === 'all' ? [] : 'all');
  menu.querySelectorAll('.gg-branches-list input[type="checkbox"]').forEach((cb) => {
    cb.onchange = () => {
      const current = state[selKey] === 'all' ? new Set(allNames) : new Set(state[selKey]);
      if (cb.checked) current.add(cb.dataset.name); else current.delete(cb.dataset.name);
      commit([...current]);
    };
  });
  filter.oninput = () => { state.branchesFilter = filter.value; applyFilter(); };
}

function gitGraphRunNetworkAction(project, state, body, actionId, params) {
  const repo = (state.repositories || []).find(r => r.path === state.selectedRepo);
  if (!repo) return;
  state.progress = { actionId, text: `Running ${actionId}…` };
  gitGraphPaint(project, state, body);
  gitGraphApi('runGitGraphAction', project.id, repo.path, actionId, params).then((result) => {
    state.progress = null;
    if (!result || !result.ok) { state.error = (result && result.error) || `${actionId} failed.`; }
    gitGraphLoadGraph(project, state, body, { reset: true });
  });
}

function gitGraphRenderProgress(project, state, body) {
  const bar = document.createElement('div');
  bar.className = 'gg-progress';
  bar.innerHTML = `<span class="gg-progress-text">${escapeHtml(state.progress.text)}</span><button type="button" class="gg-progress-cancel">Cancel</button>`;
  bar.querySelector('.gg-progress-cancel').onclick = () => {
    const repo = (state.repositories || []).find(r => r.path === state.selectedRepo);
    if (repo) gitGraphApi('cancelGitGraphAction', project.id, repo.path, state.progress.actionId);
  };
  body.querySelector('.gg-tab-shell').prepend(bar);
}

// --- Table header ---

const GG_COLUMNS = [
  { key: 'graph', label: 'Graph', hideable: false },
  { key: 'description', label: 'Description', hideable: false },
  { key: 'date', label: 'Date', hideable: true },
  { key: 'author', label: 'Author', hideable: true },
  { key: 'commit', label: 'Commit', hideable: true },
];

function gitGraphHeaderHtml(state) {
  const cells = GG_COLUMNS.filter(col => !col.hideable || state.columns[col.key]).map((col) => {
    const width = state.columnWidths[col.key] ? ` style="width:${state.columnWidths[col.key]}px"` : '';
    return `<div class="gg-th" data-col="${col.key}"${width}>${escapeHtml(col.label)}<span class="gg-col-resizer" data-col="${col.key}"></span></div>`;
  }).join('');
  return `<div class="gg-thead" id="gg-thead" data-gg-kind="column-header">${cells}</div>`;
}

function gitGraphWireHeader(project, state, body) {
  const thead = body.querySelector('#gg-thead');
  if (!thead) return;
  thead.oncontextmenu = (e) => {
    e.preventDefault();
    gitGraphOpenContextMenu(project, state, body, thead, { x: e.clientX, y: e.clientY });
  };
  thead.querySelectorAll('.gg-col-resizer').forEach((handle) => {
    handle.onpointerdown = (e) => {
      e.preventDefault();
      const col = handle.dataset.col;
      const cell = handle.closest('.gg-th');
      const startX = e.clientX;
      const startWidth = cell.getBoundingClientRect().width;
      const onMove = (moveEvent) => {
        const next = Math.max(30, startWidth + (moveEvent.clientX - startX));
        cell.style.width = `${next}px`;
        state.columnWidths[col] = next;
        if (col === 'graph') thead.closest('.gg-table-wrap')?.style.setProperty('--gg-graph-width', `${next}px`);
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        gitGraphSaveUiPrefs(project.id, state);
        gitGraphPatchRepoConfig(project, state, { columnWidths: { ...state.columnWidths } });
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    };
  });
}

// --- Rows ---

function gitGraphRowsHtml(project, state) {
  if (!state.rows.length) return '<div class="gg-empty-row">No commits yet.</div>';
  const showCols = { date: state.columns.date, author: state.columns.author, commit: state.columns.commit };
  return state.rows.map((row, index) => gitGraphRowHtml(row, state.layout[index], state, showCols, index)).join('') +
    (state.detailsData && state.detailsLocation === 'inline' ? gitGraphInlineDetailsHtml(state) : '');
}

function gitGraphRowHtml(row, layoutEntry, state, showCols, index) {
  const kind = row.kind === 'uncommitted' ? 'uncommitted' : (row.kind === 'stash' ? 'stash' : 'commit');
  const selected = row.hash === state.selectedHash || row.hash === state.compareHash;
  const classes = gitGraphRowClasses({ ...row, selected }, state);
  const dateValue = state.dateType === 'commit' ? row.commitDate : row.authorDate;
  const dateText = kind === 'uncommitted' ? gitGraphFormatDate(new Date().toISOString(), state.dateFormat) : gitGraphFormatDate(dateValue, state.dateFormat);
  const avatarHtml = (kind === 'commit' && gitGraphAvatarsEnabled(state)) ? gitGraphAvatarHtml(row.authorEmail, gitGraphAvatarUrlFor(state, row.authorEmail)) : '';
  const authorText = kind === 'uncommitted' ? '*' : `${avatarHtml}${escapeHtml(row.authorName || '')}`;
  const commitText = kind === 'uncommitted' ? '*' : escapeHtml(row.shortHash || (row.hash || '').slice(0, 8));
  const pills = kind === 'commit' || kind === 'stash' ? gitGraphRenderRefPills(row, { combineLocalAndRemote: state.combineLocalAndRemote, headBranchName: state.headBranchName }) : '';
  const stashBadge = kind === 'stash' ? `<span class="gg-stash-badge" data-gg-kind="stash" data-gg-hash="${escapeAttr(row.hash)}" title="Stash">stash@{${row.stashIndex}}</span>` : '';
  return `
    <div class="${classes}" data-gg-kind="${kind}" data-gg-hash="${escapeAttr(row.hash)}" data-row-index="${index}">
      <div class="gg-cell gg-cell-graph"></div>
      <div class="gg-cell gg-cell-description">${pills}${stashBadge}<span class="gg-subject">${gitGraphLinkifySubject(row.subject || '', state.repoConfig && state.repoConfig.issueLinking)}</span></div>
      ${showCols.date ? `<div class="gg-cell gg-cell-date">${escapeHtml(dateText)}</div>` : ''}
      ${showCols.author ? `<div class="gg-cell gg-cell-author">${authorText}</div>` : ''}
      ${showCols.commit ? `<div class="gg-cell gg-cell-commit mono">${commitText}</div>` : ''}
    </div>`;
}

function gitGraphWireRows(project, state, body) {
  const tbody = body.querySelector('#gg-tbody');
  if (!tbody) return;
  const graphColumns = tbody.querySelectorAll('.gg-cell-graph');
  if (graphColumns.length) {
    // One <svg> for the whole loaded window, absolutely positioned over
    // .gg-tbody (already `position: relative`) so it lines up with every
    // row's graph cell at once — each individual .gg-cell-graph stays an
    // empty placeholder that only reserves the column's width. Building a
    // second, separately-clipped copy of the full svg's markup per row
    // (every row repeating every other row's paths/circles) was O(rows²)
    // DOM nodes; this is O(rows).
    const svg = gitGraphRenderGraphSvg(state.rows, state.layout, {
      style: state.graphStyle, uncommittedChangesStyle: state.uncommittedChangesStyle, palette: state.graphColours,
    });
    const clip = document.createElement('div');
    clip.className = 'gg-graph-clip'; // decorative only — clicks/right-clicks fall through to the row underneath
    clip.innerHTML = svg;
    const svgEl = clip.firstChild;
    clip.style.height = `${svgEl.getAttribute('height')}px`;
    // The column fits the graph unless the user has resized it; either way the
    // clip keeps the lanes from ever drawing over the description text.
    const graphWidth = state.columnWidths.graph || Math.max(60, Number(svgEl.getAttribute('width')) + 6);
    body.querySelector('.gg-table-wrap')?.style.setProperty('--gg-graph-width', `${graphWidth}px`);
    tbody.insertBefore(clip, tbody.firstChild);
  }

  const repo = (state.repositories || []).find(r => r.path === state.selectedRepo);
  const localBranchNames = new Set(((state.refs && state.refs.heads) || []).map(h => h.name));
  const clickCtx = { projectId: project.id, repoPath: repo?.path, localBranchNames };

  tbody.querySelectorAll('[data-gg-kind]').forEach((el) => {
    // Every ref pill/stash badge nested inside a row also carries its own
    // data-gg-kind, so this same querySelectorAll matches both a pill and
    // its enclosing row. Without stopPropagation, a click/right-click on the
    // pill would fire its own handler and then bubble to the row's, whose
    // showContextMenu() call replaces (rather than coexists with) whatever
    // the pill just opened.
    el.onclick = (e) => { e.stopPropagation(); gitGraphHandleRowClick(project, state, body, el, e); };
    el.ondblclick = (e) => { e.stopPropagation(); gitGraphHandleDoubleClick(el, clickCtx); };
    el.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      gitGraphOpenContextMenu(project, state, body, el, { x: e.clientX, y: e.clientY });
    };
    el.onmouseenter = () => gitGraphShowTooltip(el, state);
    el.onmouseleave = () => gitGraphHideTooltip();
  });

  const loadMoreBtn = body.querySelector('#gg-load-more');
  if (loadMoreBtn) loadMoreBtn.onclick = () => gitGraphLoadGraph(project, state, body, { reset: false });
  gitGraphBindScrollAutoLoad(project, state, body);

  if (gitGraphAvatarsEnabled(state)) {
    const emails = new Set(state.rows.filter(r => r.kind === 'commit' && r.authorEmail).map(r => r.authorEmail));
    emails.forEach(email => gitGraphQueueAvatarFetch(project, state, body, email));
  }
}

function gitGraphBindScrollAutoLoad(project, state, body) {
  const wrap = body.querySelector('.gg-table-wrap');
  if (!wrap) return;
  if (state.loadMoreAutomatically === false) { wrap.onscroll = null; return; }
  wrap.onscroll = () => {
    if (state.loadingMore || !state.hasMore) return;
    if (wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 80) {
      gitGraphLoadGraph(project, state, body, { reset: false });
    }
  };
}

// --- Avatars ---
//
// git-graph-render.js only turns an already-known URL into markup
// (gitGraphAvatarHtml); this file owns the actual fetch-and-cache, exactly
// like every other window.api call in this file.

function gitGraphAvatarsEnabled(state) {
  const repoOverride = state.repoConfig && state.repoConfig.fetchAvatars;
  if (repoOverride === true || repoOverride === false) return repoOverride;
  return !!state.globalFetchAvatars;
}

function gitGraphAvatarUrlFor(state, email) {
  if (!email || !state.avatarCache) return null;
  const key = email.trim().toLowerCase();
  return state.avatarCache.has(key) ? state.avatarCache.get(key) : null;
}

/** Fetches an avatar URL at most once per email per tab session, then swaps
 * every placeholder already in the DOM for that email in place — cheaper and
 * less disruptive than a full gitGraphPaint() for what's normally a handful
 * of small image loads trickling in after the row/detail markup is already
 * on screen. */
function gitGraphQueueAvatarFetch(project, state, body, email) {
  if (!email) return;
  const key = email.trim().toLowerCase();
  if (!state.avatarCache) state.avatarCache = new Map();
  if (!state.avatarPending) state.avatarPending = new Set();
  if (state.avatarCache.has(key) || state.avatarPending.has(key)) return;
  const repo = (state.repositories || []).find(r => r.path === state.selectedRepo);
  if (!repo) return;
  state.avatarPending.add(key);
  gitGraphApi('getGitGraphAvatarUrl', project.id, repo.path, email).then((r) => {
    state.avatarPending.delete(key);
    const url = (r && r.ok && r.url) || null;
    state.avatarCache.set(key, url);
    if (!body.isConnected || !gitGraphStillActive(project)) return;
    body.querySelectorAll(`[data-gg-avatar-email="${key}"]`).forEach((el) => {
      const size = parseInt(el.getAttribute('width'), 10) || parseInt(el.style && el.style.width, 10) || 16;
      el.outerHTML = gitGraphAvatarHtml(email, url, { size });
    });
  });
}

/**
 * Whether `ancestorHash` is a (possibly indirect) parent of `descendantHash`,
 * walking `.parents` through whichever commits are currently loaded — the
 * only history available client-side. A pseudo-row (Uncommitted, a stash)
 * has its own single-parent link into the real graph, so it walks the same
 * way as any real commit.
 */
function gitGraphIsAncestor(rows, ancestorHash, descendantHash) {
  const byHash = new Map((rows || []).map(r => [r.hash, r]));
  const seen = new Set();
  const stack = [descendantHash];
  while (stack.length) {
    const current = stack.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    const row = byHash.get(current);
    if (!row) continue;
    for (const parentHash of row.parents || []) {
      if (parentHash === ancestorHash) return true;
      stack.push(parentHash);
    }
  }
  return false;
}

function gitGraphHandleRowClick(project, state, body, el, event) {
  const hash = el.dataset.ggHash;
  if (!hash) return;
  const row = state.rows.find(r => r.hash === hash);
  if (event.ctrlKey || event.metaKey) {
    if (state.selectedHash && state.selectedHash !== hash) {
      const first = state.selectedHash, second = hash;
      // Order-independent: the comparison always reads from whichever side
      // is actually the ancestor toward the descendant. Click order only
      // decides it when neither is reachable from the other within the
      // loaded window (e.g. unrelated histories) — the default below.
      let fromHash = first, toHash = second;
      if (gitGraphIsAncestor(state.rows, second, first)) { fromHash = second; toHash = first; }
      state.compareHash = hash;
      gitGraphOpenComparison(project, state, body, fromHash, toHash);
      return;
    }
  }
  state.selectedHash = hash;
  state.compareHash = null;
  gitGraphOpenDetails(project, state, body, row);
}

function gitGraphShowTooltip(el, state) {
  const hash = el.dataset.ggHash;
  const row = state.rows.find(r => r.hash === hash);
  if (!row) return;
  el.title = row.isHead ? 'HEAD — the currently checked-out commit' : (row.subject || '');
}

function gitGraphHideTooltip() { /* native title tooltip needs no teardown */ }

// --- Commit Details / Comparison ---

function gitGraphOpenDetails(project, state, body, row) {
  if (!row) return;
  const repo = (state.repositories || []).find(r => r.path === state.selectedRepo);
  const request = ++state.detailsRequest;
  state.detailsLoading = true;
  state.detailsData = { mode: 'single', hash: row.hash, kind: row.kind };
  state.lastViewedFilePath = null;
  state.detailsJustOpened = true;
  gitGraphHydrateCodeReviewForDetails(state);
  gitGraphPaintDetailsOnly(project, state, body);
  const fetch = row.kind === 'uncommitted'
    ? gitGraphApi('getGitGraphCompareDetail', project.id, repo.path, state.headHash, null)
    : gitGraphApi('getGitGraphCommitDetail', project.id, repo.path, row.hash);
  fetch.then((result) => {
    if (request !== state.detailsRequest) return;
    state.detailsLoading = false;
    if (result && result.ok) {
      state.detailsData = { mode: 'single', hash: row.hash, kind: row.kind, commit: result.commit, files: result.files || [] };
      if (result.commit && result.commit.authorEmail) gitGraphQueueAvatarFetch(project, state, body, result.commit.authorEmail);
    } else {
      state.detailsData = { mode: 'single', hash: row.hash, kind: row.kind, error: (result && result.error) || 'Could not load commit details.' };
    }
    gitGraphPaintDetailsOnly(project, state, body);
  });
}

function gitGraphOpenComparison(project, state, body, fromHash, toHash) {
  const repo = (state.repositories || []).find(r => r.path === state.selectedRepo);
  const request = ++state.detailsRequest;
  state.detailsLoading = true;
  state.detailsData = { mode: 'compare', fromHash, toHash };
  state.lastViewedFilePath = null;
  state.detailsJustOpened = true;
  gitGraphHydrateCodeReviewForDetails(state);
  gitGraphPaintDetailsOnly(project, state, body);
  const toArg = toHash === '#uncommitted' ? null : toHash;
  gitGraphApi('getGitGraphCompareDetail', project.id, repo.path, fromHash === '#uncommitted' ? toHash : fromHash, fromHash === '#uncommitted' ? null : toArg)
    .then((result) => {
      if (request !== state.detailsRequest) return;
      state.detailsLoading = false;
      if (result && result.ok) state.detailsData = { mode: 'compare', fromHash, toHash, files: result.files || [] };
      else state.detailsData = { mode: 'compare', fromHash, toHash, error: (result && result.error) || 'Could not load comparison.' };
      gitGraphPaintDetailsOnly(project, state, body);
    });
}

function gitGraphPaintDetailsOnly(project, state, body) {
  if (state.detailsLocation === 'docked') {
    const dock = body.querySelector('#gg-details-docked');
    if (dock) { dock.style.display = 'block'; gitGraphRenderDetailsPanel(project, state, body); return; }
  }
  gitGraphPaint(project, state, body);
}

function gitGraphInlineDetailsHtml(state) {
  return `<div class="gg-details gg-details-inline" id="gg-details-inline">${gitGraphDetailsBodyHtml(state)}</div>`;
}

function gitGraphRenderDetailsPanel(project, state, body) {
  const container = state.detailsLocation === 'docked' ? body.querySelector('#gg-details-docked') : body.querySelector('#gg-details-inline');
  if (!container) return;
  container.innerHTML = gitGraphDetailsBodyHtml(state);
  gitGraphWireDetailsPanel(project, state, body, container);
  gitGraphMaybeAutoCenterDetails(state, container);
}

/** Scrolls the panel into view exactly once per open — auto-centering it the
 * moment it opens, not on every subsequent repaint of an already-open panel —
 * `state.detailsJustOpened` is set by gitGraphOpenDetails/OpenComparison and
 * cleared the first time this runs after that. */
function gitGraphMaybeAutoCenterDetails(state, container) {
  if (!state.detailsJustOpened || state.autoCenterDetails === false) return;
  state.detailsJustOpened = false;
  if (container && typeof container.scrollIntoView === 'function') container.scrollIntoView({ block: 'center' });
}

function gitGraphDetailsBodyHtml(state) {
  const data = state.detailsData;
  if (!data) return '';
  if (state.detailsLoading) return '<div class="gg-loading"><span class="gg-loading-dot"></span>Loading…</div>';
  if (data.error) return `<div class="gg-error-state">${escapeHtml(data.error)}</div>`;
  const header = data.mode === 'compare'
    ? `<div class="gg-details-header">Displaying all changes from <span class="mono">${escapeHtml((data.fromHash || '').replace('#uncommitted', 'the working tree'))}</span> to <span class="mono">${escapeHtml((data.toHash || '').replace('#uncommitted', 'the working tree'))}</span>.</div>`
    : gitGraphSingleCommitHeaderHtml(data.commit, data.kind, state);
  const files = data.files || [];
  const reviewControls = gitGraphCodeReviewControlsHtml(state);
  return `
    <button type="button" class="gg-details-close" id="gg-details-close">×</button>
    ${reviewControls ? `<div class="gg-details-review-bar">${reviewControls}</div>` : ''}
    <div class="gg-details-grid">
      <div class="gg-details-text">${header}</div>
      <div class="gg-details-files">
        <div class="gg-file-view-toggle">
          <button type="button" class="gg-toggle-btn${state.fileViewType !== 'list' ? ' active' : ''}" data-view="tree">Tree</button>
          <button type="button" class="gg-toggle-btn${state.fileViewType === 'list' ? ' active' : ''}" data-view="list">List</button>
        </div>
        ${gitGraphFileListHtml(files, {
          fileViewType: state.fileViewType, compactFolders: state.compactFolders,
          codeReview: state.codeReview, enhancedAccessibility: state.enhancedAccessibility,
          lastViewedFilePath: state.lastViewedFilePath,
        })}
      </div>
    </div>`;
}

function gitGraphSingleCommitHeaderHtml(commit, kind, state) {
  if (kind === 'uncommitted' || !commit) return '<div class="gg-details-header">Working tree changes</div>';
  const parentsHtml = (commit.parents || []).map(p => `<a class="gg-link mono" data-gg-kind="link" data-gg-hash="${escapeAttr(p)}" href="#">${escapeHtml(p)}</a>`).join(', ') || 'none (root commit)';
  const authorDate = gitGraphFormatFullDate(commit.authorDate);
  const commitDate = gitGraphFormatFullDate(commit.commitDate);
  const bothDates = commit.authorDate !== commit.commitDate;
  const avatarsOn = state && gitGraphAvatarsEnabled(state);
  const avatarHtml = avatarsOn ? gitGraphAvatarHtml(commit.authorEmail, gitGraphAvatarUrlFor(state, commit.authorEmail), { size: 18 }) : '';
  const showSignature = state && state.repoConfig && state.repoConfig.showSignatureStatus;
  const signatureHtml = showSignature ? gitGraphSignatureBadgeHtml(commit.signature) : '';
  const markdownOn = !state || state.markdownRendering !== false;
  const issueLinking = state && state.repoConfig && state.repoConfig.issueLinking;
  return `
    <div class="gg-detail-field"><span class="gg-detail-label">Commit:</span> <span class="mono">${escapeHtml(commit.hash)}</span></div>
    <div class="gg-detail-field"><span class="gg-detail-label">Subject:</span> ${gitGraphLinkifySubject(commit.subject || '', issueLinking)}</div>
    <div class="gg-detail-field"><span class="gg-detail-label">Parents:</span> ${parentsHtml}</div>
    <div class="gg-detail-field"><span class="gg-detail-label">Author:</span> ${avatarHtml}${escapeHtml(commit.authorName)} &lt;<a class="gg-link" href="mailto:${escapeAttr(commit.authorEmail)}">${escapeHtml(commit.authorEmail)}</a>&gt;</div>
    <div class="gg-detail-field"><span class="gg-detail-label">Date:</span> ${escapeHtml(authorDate)}${bothDates ? ` <span class="gg-detail-secondary">(committed ${escapeHtml(commitDate)})</span>` : ''}</div>
    <div class="gg-detail-field"><span class="gg-detail-label">Committer:</span> ${escapeHtml(commit.committerName)}${signatureHtml}</div>
    <div class="gg-detail-body">${gitGraphLinkifyBody(commit.body || '', markdownOn)}</div>`;
}

/**
 * Wraps every substring of `subject` that matches the repo's configured
 * Issue Regex in a clickable link to the built issue URL — the same
 * substitution gitGraphBuildIssueUrl (git-graph-menus.js) does for a whole
 * branch name, just applied in place at each match's own position instead of
 * requiring the whole string to match. Used everywhere a commit subject is
 * shown (the graph row and the Commit Details header), per Issue Linking's
 * own documented scope.
 */
function gitGraphLinkifySubject(subject, issueLinking) {
  const text = subject || '';
  if (!issueLinking || !issueLinking.regex || !issueLinking.url) return escapeHtml(text);
  let re;
  try { re = new RegExp(issueLinking.regex, 'g'); } catch { return escapeHtml(text); }
  let result = '';
  let lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m[0] === '') { re.lastIndex += 1; continue; } // never loop forever on a zero-width match
    const url = issueLinking.url.replace(/\$([1-8])/g, (_, n) => (m[Number(n)] != null ? m[Number(n)] : ''));
    result += escapeHtml(text.slice(lastIndex, m.index));
    result += `<a class="gg-link" data-gg-kind="link" href="${escapeAttr(url)}" target="_blank" rel="noopener">${escapeHtml(m[0])}</a>`;
    lastIndex = m.index + m[0].length;
  }
  result += escapeHtml(text.slice(lastIndex));
  return result;
}

function gitGraphLinkifyBody(body, markdownEnabled) {
  let escaped = escapeHtml(body);
  if (markdownEnabled) escaped = gitGraphRenderMarkdownInline(escaped);
  return escaped
    .replace(/\n/g, '<br>')
    // Excludes '"'/"'" from the match itself (on top of the '<' escapeHtml
    // already turned into an entity): a commit body is attacker-controlled
    // text, and without this a quote character could close the href
    // attribute early and start a new, live one (e.g. an onmouseover=...)
    // right where the match ends. The matched text has already been through
    // escapeHtml above, so once quotes can't appear in it, it's already
    // fully safe to drop straight into this attribute.
    .replace(/https?:\/\/[^\s<>"']+/g, (url) => `<a class="gg-link" data-gg-kind="link" href="${url}" target="_blank" rel="noopener">${url}</a>`);
}

function gitGraphFileListHtml(files, opts) {
  if (!files.length) return '<div class="gg-empty-row">No files changed.</div>';
  if (opts.fileViewType === 'list') {
    return `<div class="gg-file-flat-list">${files.map(f => gitGraphFileRowHtml(f, opts)).join('')}</div>`;
  }
  const tree = gitGraphBuildFileTree(files, { compactFolders: opts.compactFolders !== false });
  return `<div class="gg-file-tree">${gitGraphFileTreeNodeHtml(tree, opts)}</div>`;
}

function gitGraphFileTreeNodeHtml(node, opts) {
  const children = [...node.children.values()];
  return children.map((child) => {
    if (child.type === 'folder') {
      return `<div class="gg-tree-folder"><div class="gg-tree-folder-label">${gitGraphIcon('folder', 11)}<span>${escapeHtml(child.name)}</span></div><div class="gg-tree-children">${gitGraphFileTreeNodeHtml(child, opts)}</div></div>`;
    }
    return gitGraphFileRowHtml(child.file, opts);
  }).join('');
}

/** `opts.codeReview` (`{key, reviewedPaths: Set}` or null/undefined) drives
 * the "still needs review" bold styling; `opts.enhancedAccessibility`
 * gates the A/M/D/R/U letter, whose documented default is colour-only. */
function gitGraphFileRowHtml(file, opts = {}) {
  const codeReview = opts.codeReview;
  const reviewed = !!(codeReview && codeReview.reviewedPaths.has(file.path));
  const rowClass = codeReview && !reviewed ? ' gg-file-unreviewed' : '';
  const eyeHtml = opts.lastViewedFilePath === file.path ? '<span class="gg-file-eye" title="Most recently viewed">◉</span>' : '';
  const glyph = gitGraphFileStatusGlyph(file.status, opts.enhancedAccessibility);
  return `
    <div class="gg-file-row${rowClass}" data-gg-kind="file" data-gg-file-path="${escapeHtml(file.path)}">
      <span class="gg-file-status gg-file-status-${escapeHtml(file.status)}">${escapeHtml(glyph)}</span>
      <span class="gg-file-name">${escapeHtml(file.path.split('/').pop())}</span>
      ${eyeHtml}
      ${gitGraphDiffStatHtml(file)}
    </div>`;
}

function gitGraphWireDetailsPanel(project, state, body, container) {
  const closeBtn = container.querySelector('#gg-details-close');
  if (closeBtn) closeBtn.onclick = () => gitGraphCloseDetails(project, state, body);
  container.querySelectorAll('[data-view]').forEach((btn) => {
    btn.onclick = () => { state.fileViewType = btn.dataset.view; gitGraphPatchGlobalPrefs(state, { fileViewType: btn.dataset.view }); gitGraphRenderDetailsPanel(project, state, body); };
  });
  gitGraphWireCodeReviewControls(project, state, body, container);
  const repo = (state.repositories || []).find(r => r.path === state.selectedRepo);
  container.querySelectorAll('[data-gg-kind="file"]').forEach((row) => {
    row.onclick = () => gitGraphOpenFileDiff(project, state, body, repo, row.dataset.ggFilePath);
    row.oncontextmenu = (e) => {
      e.preventDefault();
      gitGraphOpenContextMenu(project, state, body, row, { x: e.clientX, y: e.clientY });
    };
  });
  container.querySelectorAll('[data-gg-kind="link"][href]').forEach((link) => {
    link.oncontextmenu = (e) => {
      e.preventDefault();
      gitGraphOpenContextMenu(project, state, body, link, { x: e.clientX, y: e.clientY });
    };
  });
  container.querySelectorAll('[data-gg-kind="link"][data-gg-hash]').forEach((link) => {
    link.onclick = (e) => {
      e.preventDefault();
      const target = state.rows.find(r => r.hash === link.dataset.ggHash);
      if (target) { state.selectedHash = target.hash; gitGraphOpenDetails(project, state, body, target); }
    };
  });
}

function gitGraphCloseDetails(project, state, body) {
  state.detailsData = null;
  state.selectedHash = null;
  state.compareHash = null;
  state.codeReview = null;
  state.lastViewedFilePath = null;
  const dock = body.querySelector('#gg-details-docked');
  if (dock) dock.style.display = 'none';
  gitGraphPaint(project, state, body);
}

function gitGraphOpenFileDiff(project, state, body, repo, filePath, opts = {}) {
  if (!repo || !filePath || typeof createUnifiedMergeViewer !== 'function') return;
  gitGraphNoteFileViewed(project, state, body, filePath);
  const data = state.detailsData;
  const fromRev = data.mode === 'compare' ? (data.fromHash === '#uncommitted' ? null : data.fromHash) : `${data.hash}^`;
  const toRev = opts.forceWorkingTree ? null : (data.mode === 'compare' ? (data.toHash === '#uncommitted' ? null : data.toHash) : (data.kind === 'uncommitted' ? null : data.hash));
  gitGraphApi('getGitGraphFileDiffBetween', project.id, repo.path, fromRev, toRev, filePath).then((result) => {
    if (!result || !result.ok) return;
    const host = gitGraphEnsureDiffHost();
    host.innerHTML = '';
    createUnifiedMergeViewer(host, result.oldContent || '', result.newContent || '', filePath);
  });
}

/** "View File at this Revision" (file-menu item) — read-only single-pane view of the blob. */
function gitGraphViewFileAtRevision(project, state, body, repo, file) {
  const data = state.detailsData || {};
  const rev = data.mode === 'single' ? data.hash : data.toHash;
  if (!repo || !rev || rev === '#uncommitted') return;
  gitGraphNoteFileViewed(project, state, body, file.path);
  gitGraphApi('getGitGraphFileAtRevision', project.id, repo.path, rev, file.path).then((result) => {
    if (!result || !result.ok) return;
    const host = gitGraphEnsureDiffHost();
    host.innerHTML = '';
    if (typeof createReadOnlyViewer === 'function') createReadOnlyViewer(host, result.content || '', file.path);
    else if (typeof createUnifiedMergeViewer === 'function') createUnifiedMergeViewer(host, result.content || '', result.content || '', file.path);
  });
}

/** Records the "eye" last-viewed marker and auto-un-bolds the file
 * if a Code Review is active on the open commit/comparison — shared
 * by every way a file's content can be viewed (diff, at-revision, or the
 * plain working-tree open). */
function gitGraphNoteFileViewed(project, state, body, filePath) {
  state.lastViewedFilePath = filePath;
  gitGraphMarkFileReviewedIfActive(project, state, body, filePath);
}

/** Returns the *content* element for the diff/file overlay — the close
 * button lives on its permanent sibling, so callers are free to reset this
 * div's innerHTML on every open without wiping the close affordance out. */
function gitGraphEnsureDiffHost() {
  let host = document.getElementById('gg-diff-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'gg-diff-host';
    host.className = 'gg-diff-host';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'gg-details-close';
    close.textContent = '×';
    close.onclick = () => gitGraphCloseDiffHost();
    const content = document.createElement('div');
    content.className = 'gg-diff-host-content';
    host.appendChild(close);
    host.appendChild(content);
    document.body.appendChild(host);
  }
  return host.querySelector('.gg-diff-host-content');
}

function gitGraphCloseDiffHost() {
  const host = document.getElementById('gg-diff-host');
  if (host) host.remove();
}

// --- Find widget ---

function gitGraphFindWidgetHtml(state) {
  if (!state.findOpen) return '';
  return `
    <div class="gg-find-widget">
      <input type="text" id="gg-find-input" placeholder="Find in loaded commits…" value="${escapeHtml(state.findQuery)}">
      <span class="gg-find-count">${state.findMatches.length ? `${state.findIndex + 1}/${state.findMatches.length}` : '0/0'}</span>
      <button type="button" id="gg-find-prev">‹</button>
      <button type="button" id="gg-find-next">›</button>
      <label class="gg-checkbox"><input type="checkbox" id="gg-find-case" ${state.findCaseSensitive ? 'checked' : ''}>Case</label>
      <label class="gg-checkbox"><input type="checkbox" id="gg-find-open-details" ${state.findAlsoOpenDetails ? 'checked' : ''}>Also open details</label>
      <button type="button" id="gg-find-close">×</button>
    </div>`;
}

function gitGraphWireFindWidget(project, state, body) {
  const input = body.querySelector('#gg-find-input');
  if (!input) return;
  const run = () => {
    state.findMatches = gitGraphFindMatches(state.rows, input.value, state.findCaseSensitive);
    state.findIndex = state.findMatches.length ? 0 : -1;
    state.findQuery = input.value;
    gitGraphApplyFindHighlight(project, state, body);
  };
  input.oninput = run;
  input.focus();
  body.querySelector('#gg-find-case').onchange = (e) => { state.findCaseSensitive = e.target.checked; run(); };
  body.querySelector('#gg-find-open-details').onchange = (e) => { state.findAlsoOpenDetails = e.target.checked; };
  body.querySelector('#gg-find-next').onclick = () => gitGraphFindStep(project, state, body, 1);
  body.querySelector('#gg-find-prev').onclick = () => gitGraphFindStep(project, state, body, -1);
  body.querySelector('#gg-find-close').onclick = () => { state.findOpen = false; gitGraphPaint(project, state, body); };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); gitGraphFindStep(project, state, body, e.shiftKey ? -1 : 1); }
  };
}

function gitGraphFindStep(project, state, body, dir) {
  if (!state.findMatches.length) return;
  state.findIndex = (state.findIndex + dir + state.findMatches.length) % state.findMatches.length;
  gitGraphApplyFindHighlight(project, state, body);
}

function gitGraphApplyFindHighlight(project, state, body) {
  const countEl = body.querySelector('.gg-find-count');
  if (countEl) countEl.textContent = state.findMatches.length ? `${state.findIndex + 1}/${state.findMatches.length}` : '0/0';
  body.querySelectorAll('.gg-tbody [data-gg-kind]').forEach(el => el.classList.remove('gg-find-match', 'gg-find-current'));
  state.findMatches.forEach((rowIndex, i) => {
    const el = body.querySelector(`.gg-tbody [data-row-index="${rowIndex}"]`);
    if (!el) return;
    el.classList.add('gg-find-match');
    if (i === state.findIndex) {
      el.classList.add('gg-find-current');
      el.scrollIntoView({ block: 'nearest' });
      if (state.findAlsoOpenDetails) {
        const row = state.rows[rowIndex];
        state.selectedHash = row.hash;
        gitGraphOpenDetails(project, state, body, row);
      }
    }
  });
}

// --- Repository Settings drawer — full drawer content/wiring lives in
// git-graph-settings.js's gitGraphRenderSettingsDrawer; this file only owns
// the open/close toggle, which the drawer's own close button calls back into. ---

function gitGraphToggleSettings(project, state, body) {
  state.settingsOpen = !state.settingsOpen;
  if (!state.settingsOpen) { body.querySelector('#gg-settings-drawer').style.display = 'none'; return; }
  gitGraphRenderSettingsDrawer(project, state, body);
}

// --- Keyboard shortcuts ---

function gitGraphBindKeyboard(project, state, body) {
  if (state.keydownHandler) document.removeEventListener('keydown', state.keydownHandler);
  const handler = (e) => {
    if (!gitGraphStillActive(project) || !body.isConnected) return;
    if (gitGraphIsEditableTarget(e.target) && e.key !== 'Escape') return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      if (document.getElementById('gg-diff-host')) { gitGraphCloseDiffHost(); e.preventDefault(); return; }
      const closed = gitGraphHandleEscapePriority({
        closeDialog: () => false, // real dialogs manage their own Escape handler
        closeMenu: () => (typeof openCtxMenu !== 'undefined' && openCtxMenu && typeof closeContextMenu === 'function' ? (closeContextMenu(), true) : false),
        closeDetails: () => { if (state.detailsData) { gitGraphCloseDetails(project, state, body); return true; } return false; },
        closeFind: () => { if (state.findOpen) { state.findOpen = false; gitGraphPaint(project, state, body); return true; } return false; },
      });
      if (closed) e.preventDefault();
      return;
    }
    if (mod && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); state.findOpen = true; gitGraphPaint(project, state, body); }
    else if (mod && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); gitGraphLoadGraph(project, state, body, { reset: true }); }
    else if (mod && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); gitGraphScrollToHead(project, state, body); }
    else if (mod && !e.shiftKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); gitGraphScrollToStash(project, state, body, 1); }
    else if (mod && e.shiftKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); gitGraphScrollToStash(project, state, body, -1); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const dir = e.key === 'ArrowDown' ? 1 : -1; // Down toward parents/older, Up toward children/newer
      if (!state.detailsData) {
        // No details panel open — plain arrows scroll the table instead (mod/Shift arrows are a details-only gesture).
        if (!mod) {
          const wrap = body.querySelector('.gg-table-wrap');
          if (wrap) wrap.scrollTop += dir * GG_ROW_HEIGHT;
        }
        return;
      }
      e.preventDefault();
      const mode = mod ? (e.shiftKey ? 'alternate' : 'sameBranch') : 'plain';
      gitGraphMoveDetailsFocus(project, state, body, dir, mode);
    }
  };
  state.keydownHandler = handler;
  document.addEventListener('keydown', handler);
}

/**
 * Same-branch parent/child of `hash`, via the loaded graph's own layout
 * edges rather than a fresh git query — `dir > 0` walks toward the parent
 * (the row's own 'same-lane' outgoing edge), `dir < 0` toward the child (an
 * earlier row whose 'same-lane' edge points back at this hash). Returns null
 * at a fork/merge with no plain same-lane edge in that direction, or when
 * `hash` isn't in the currently loaded window.
 */
function gitGraphSameBranchNeighbor(state, hash, dir) {
  const index = state.rows.findIndex(r => r.hash === hash);
  if (index < 0) return null;
  if (dir > 0) {
    const edge = (state.layout[index] && state.layout[index].edges || []).find(e => e.style === 'same-lane');
    return edge ? edge.parentHash : null;
  }
  for (let i = index - 1; i >= 0; i--) {
    const hasEdge = (state.layout[i] && state.layout[i].edges || []).some(e => e.style === 'same-lane' && e.parentHash === hash);
    if (hasEdge) return state.rows[i].hash;
  }
  return null;
}

/**
 * The *other* branch at a fork/merge touching `hash` — a 'branch-out' or
 * 'merge-in' edge instead of the plain 'same-lane' one gitGraphSameBranchNeighbor
 * follows. Same direction convention: `dir > 0` toward a parent, `dir < 0`
 * toward a child.
 */
function gitGraphAlternateBranchNeighbor(state, hash, dir) {
  const index = state.rows.findIndex(r => r.hash === hash);
  if (index < 0) return null;
  if (dir > 0) {
    const edge = (state.layout[index] && state.layout[index].edges || []).find(e => e.style !== 'same-lane');
    return edge ? edge.parentHash : null;
  }
  for (let i = index - 1; i >= 0; i--) {
    const hasEdge = (state.layout[i] && state.layout[i].edges || []).some(e => e.style !== 'same-lane' && e.parentHash === hash);
    if (hasEdge) return state.rows[i].hash;
  }
  return null;
}

/**
 * Moves the Commit Details/Comparison focus in response to an arrow key.
 * `plain` (no modifier) steps to the row directly above/below regardless of
 * branch; `sameBranch` follows gitGraphSameBranchNeighbor; `alternate`
 * follows gitGraphAlternateBranchNeighbor (the fork/merge's other side).
 * Silently does nothing when there's no current row or no neighbor in that
 * direction — never throws, so a keystroke at either end of the graph is a
 * no-op rather than an error.
 */
function gitGraphMoveDetailsFocus(project, state, body, dir, mode) {
  if (!state.selectedHash) return;
  let targetHash;
  if (mode === 'plain') {
    const index = state.rows.findIndex(r => r.hash === state.selectedHash);
    if (index < 0) return;
    const target = state.rows[index + dir];
    targetHash = target && target.hash;
  } else if (mode === 'alternate') {
    targetHash = gitGraphAlternateBranchNeighbor(state, state.selectedHash, dir);
  } else {
    targetHash = gitGraphSameBranchNeighbor(state, state.selectedHash, dir);
  }
  if (!targetHash) return;
  const row = state.rows.find(r => r.hash === targetHash);
  if (!row) return;
  state.selectedHash = targetHash;
  state.compareHash = null;
  gitGraphOpenDetails(project, state, body, row);
}

function gitGraphScrollToHead(project, state, body) {
  const headRow = state.rows.findIndex(r => r.isHead);
  if (headRow < 0) return;
  const el = body.querySelector(`.gg-tbody [data-row-index="${headRow}"]`);
  if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('gg-flash'); setTimeout(() => el.classList.remove('gg-flash'), 900); }
}

function gitGraphScrollToStash(project, state, body, dir) {
  const stashRows = state.rows.map((r, i) => (r.kind === 'stash' ? i : -1)).filter(i => i >= 0);
  if (!stashRows.length) return;
  const current = state.rows.findIndex(r => r.hash === state.selectedHash);
  let next = dir > 0 ? stashRows.find(i => i > current) : [...stashRows].reverse().find(i => i < current);
  if (next === undefined) next = dir > 0 ? stashRows[0] : stashRows[stashRows.length - 1];
  const el = body.querySelector(`.gg-tbody [data-row-index="${next}"]`);
  if (el) el.scrollIntoView({ block: 'center' });
}

// --- Auto-refresh ---

function gitGraphBindWatcher(project, state, body) {
  if (state.watcherUnsub || typeof window.api?.onGitGraphRepoChanged !== 'function') return;
  window.api.onGitGraphRepoChanged((folderPath) => {
    if (!gitGraphStillActive(project) || !body.isConnected) return;
    if (folderPath !== state.selectedRepo) return;
    gitGraphLoadGraph(project, state, body, { reset: true });
  });
  state.watcherUnsub = true;
}

// Streams the fetch/push/pull progress text into the
// already-rendered progress bar. Updates the existing node's textContent
// directly rather than a full gitGraphPaint() re-render, since git can emit
// several \r-terminated progress lines per second and a full innerHTML
// rebuild on every one would be wasteful and would fight the user's scroll
// position.
function gitGraphBindProgress(project, state, body) {
  if (state.progressUnsub || typeof window.api?.onGitGraphActionProgress !== 'function') return;
  window.api.onGitGraphActionProgress(({ folderPath, actionId, text } = {}) => {
    if (!gitGraphStillActive(project) || !body.isConnected) return;
    if (!state.progress || folderPath !== state.selectedRepo || actionId !== state.progress.actionId) return;
    state.progress.text = text;
    const el = body.querySelector('.gg-progress-text');
    if (el) el.textContent = text;
  });
  state.progressUnsub = true;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    gitGraphState, gitGraphFindMatches, gitGraphHandleEscapePriority, gitGraphReadTargetData,
    gitGraphDispatchContextMenu, gitGraphHandleDoubleClick, GG_MENU_BUILDERS,
    gitGraphComputeChildren, gitGraphAllBranchKeys, gitGraphToggleBranchKey, gitGraphDefaultRemoteName,
    gitGraphRemoteBranchesByLocalName, gitGraphBuildFileCtx, gitGraphPopulateTargetField,
    gitGraphBuildMenuCtx, gitGraphOpenContextMenu, gitGraphLoadGraph, gitGraphLoadRepositories,
    gitGraphPaint, gitGraphApi, renderProjectGitGraphTab,
    gitGraphAvatarsEnabled, gitGraphAvatarUrlFor, gitGraphQueueAvatarFetch,
    gitGraphSingleCommitHeaderHtml, gitGraphLinkifyBody, gitGraphLinkifySubject, gitGraphFileRowHtml, gitGraphFileListHtml,
    gitGraphOpenDetails, gitGraphOpenComparison, gitGraphCloseDetails, gitGraphNoteFileViewed,
    gitGraphMaybeAutoCenterDetails, gitGraphIsAncestor, gitGraphHandleRowClick, gitGraphBindKeyboard,
    gitGraphSameBranchNeighbor, gitGraphAlternateBranchNeighbor, gitGraphMoveDetailsFocus,
    gitGraphSameStringSet, gitGraphRepoList,
  };
}

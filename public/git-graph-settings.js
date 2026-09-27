// Secondary/administrative UI for the Git Graph tab, split out of
// project-git-graph-view.js purely to keep that file a manageable size: the
// Repository Settings drawer (remotes, user details, issue linking, pull
// request configuration, per-repo display toggles, export), the Global
// Preferences panel (the app-wide equivalent of the extension's own
// editor-level settings), the repo-committed-config trust prompt, and Code
// Review session bookkeeping. None of this file talks to git directly —
// everything here either renders markup or round-trips through
// window.api.{get,set}GitGraphRepoConfig / GlobalPreferences, the same as
// project-git-graph-view.js's own persistence calls.
//
// The four dialogs this drawer opens for remote/user-details management
// (gitGraphShowAddRemoteDialog, ShowEditRemoteDialog, ShowDeleteRemoteDialog,
// ShowFetchRemoteDialog) and the three for issue linking / pull requests /
// trusting a repo-committed config (ShowUserDetailsDialog,
// ShowIssueLinkingDialog, ShowPullRequestConfigDialog,
// ShowTrustRepoConfigDialog) live in git-graph-dialogs.js and are always
// called through gitGraphOptionalDialog() below, which degrades gracefully
// if a given one isn't loaded yet — the same discipline
// project-git-graph-view.js already uses for every optional cross-file call.
//
// Depends on globals: escapeHtml (utils.js), and from project-git-graph-view.js:
// gitGraphApi, gitGraphSaveUiPrefs, gitGraphLoadGraph, gitGraphPaint,
// gitGraphPaintDetailsOnly, gitGraphStillActive. Those are only ever called
// from inside a function body here, never at parse time, so load order
// relative to that file doesn't matter (it's loaded after this one, purely
// so this file's own <script> tag reads naturally before the tab that uses
// it — see index.html).

// --- Small shared helpers ---

function gitGraphOptionalDialog(name, ...args) {
  const fn = (typeof globalThis !== 'undefined') ? globalThis[name] : undefined;
  if (typeof fn !== 'function') {
    if (typeof alert === 'function') alert('This part of the Repository Settings drawer is not available in this build yet.');
    return Promise.resolve(null);
  }
  return fn(...args);
}

function gitGraphSettingsField(id, label, controlHtml, hint) {
  return `<div class="gg-settings-field"><label class="gg-settings-field-label" for="${id}">${escapeHtml(label)}</label>${controlHtml}${hint ? `<div class="gg-field-hint">${escapeHtml(hint)}</div>` : ''}</div>`;
}

function gitGraphSettingsSelect(id, options, selected) {
  const opts = options.map(o => `<option value="${escapeAttr(o.value)}"${o.value === selected ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
  return `<select id="${id}" class="gg-field-input">${opts}</select>`;
}

function gitGraphSettingsText(id, value, placeholder) {
  return `<input type="text" id="${id}" class="gg-field-input" value="${escapeAttr(value == null ? '' : value)}" placeholder="${escapeAttr(placeholder || '')}" autocomplete="off" spellcheck="false">`;
}

function gitGraphSettingsNumber(id, value, min) {
  return `<input type="number" id="${id}" class="gg-field-input gg-field-input-number" value="${Number.isFinite(value) ? value : ''}" min="${min || 0}">`;
}

function gitGraphSettingsCheckboxRow(id, label, checked) {
  return `<label class="gg-checkbox gg-settings-checkbox-row"><input type="checkbox" id="${id}"${checked ? ' checked' : ''}> ${escapeHtml(label)}</label>`;
}

function gitGraphSettingsTextarea(id, value, placeholder) {
  return `<textarea id="${id}" class="gg-field-input" placeholder="${escapeAttr(placeholder || '')}">${escapeHtml(value == null ? '' : value)}</textarea>`;
}

// --- Repository picker ordering ---

function gitGraphSortRepositories(repos, order) {
  const list = [...(repos || [])];
  if (order === 'name') {
    list.sort((a, b) => (pathBasename(a.path) || a.path).localeCompare(pathBasename(b.path) || b.path));
  } else if (order === 'fullPath') {
    list.sort((a, b) => a.path.localeCompare(b.path));
  }
  // 'attachmentOrder' (the default): leave in the order the project already lists them.
  return list;
}

// --- Per-remote branch visibility ---

function gitGraphVisibleRemotes(remotes, perRemoteVisibility) {
  const hidden = perRemoteVisibility || {};
  return (remotes || []).filter(r => hidden[r.remote || r.name] !== false);
}

// --- On-load behaviour — applied once, right after a repo's
// config is first read for this tab-open, before the first commit query. ---

function gitGraphApplyOnLoadSelection(state, repoConfig, headBranchName) {
  if (repoConfig.onLoadShowSpecificBranches && repoConfig.onLoadShowSpecificBranches.length) {
    state.branchSelection = [...repoConfig.onLoadShowSpecificBranches];
  } else if (repoConfig.onLoadShowCheckedOutBranch && headBranchName) {
    state.branchSelection = [headBranchName];
  }
}

// --- Repo-committed external config summary, for the trust dialog ---

const GG_EXTERNAL_CONFIG_FILENAME = '.switchboard-git-graph.json';
const GG_EXTERNAL_CONFIG_FIELDS = ['issueLinking', 'pullRequestProvider', 'customDisplayName'];

function gitGraphSummarizeExternalConfig(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const fields = GG_EXTERNAL_CONFIG_FIELDS.filter(key => key in parsed);
  if (!fields.length) return null;
  // Flat shape, matching what gitGraphSummarizeTrustFields (git-graph-dialogs.js)
  // reads straight off its `summary` argument.
  return Object.fromEntries(fields.map(k => [k, parsed[k]]));
}

/**
 * getGitGraphRepoConfig() deliberately never reveals an untrusted file's
 * contents (that's the whole point of "not applied until trusted"), so
 * there's no signal in that endpoint's reply for "a file exists but isn't
 * trusted yet" vs. the ordinary case of no such file at all. The generic
 * project-file reader (already used by the Files tab, not something this
 * tab introduces) doubles as that missing signal here: it just reads bytes
 * within the repo folder with no opinion on trust.
 */
async function gitGraphDetectExternalConfigSummary(repo) {
  const result = await gitGraphApi('readProjectFile', repo.path, GG_EXTERNAL_CONFIG_FILENAME);
  if (!result || !result.ok || typeof result.content !== 'string') return null;
  let parsed;
  try { parsed = JSON.parse(result.content); } catch { return null; }
  return gitGraphSummarizeExternalConfig(parsed);
}

async function gitGraphMaybePromptTrust(project, state, body, repo) {
  if (!repo || !state.repoConfig || state.repoConfig.trustedExternalConfig) return;
  if (!state.trustPromptShownFor) state.trustPromptShownFor = new Set();
  if (state.trustPromptShownFor.has(repo.path)) return;
  state.trustPromptShownFor.add(repo.path);
  const summary = await gitGraphDetectExternalConfigSummary(repo);
  if (!summary) return;
  if (!gitGraphStillActive(project) || !body.isConnected || state.selectedRepo !== repo.path) return;
  const ctx = { projectId: project.id, folderPath: repo.path };
  const decision = await gitGraphOptionalDialog('gitGraphShowTrustRepoConfigDialog', ctx, summary);
  if (decision === null || decision === undefined) return; // dismissed without a decision; asked once, leave it
  await gitGraphApi('trustGitGraphRepoConfig', project.id, repo.path, !!decision);
  if (gitGraphStillActive(project) && body.isConnected) gitGraphLoadGraph(project, state, body, { reset: true });
}

// --- Applying loaded RepoConfig / GlobalPrefs onto the tab's working state ---

function gitGraphApplyRepoConfigToState(state, config) {
  if (!config) return;
  state.repoConfig = config;
  state.branchSelection = config.branchDropdownSelection || state.branchSelection;
  state.showRemoteBranches = config.showRemoteBranches !== undefined ? config.showRemoteBranches : state.showRemoteBranches;
  state.order = config.commitsOrder || state.order;
  state.firstParentOnly = !!config.onlyFollowFirstParent;
  state.muteMergeCommits = config.muteMergeCommits !== undefined ? config.muteMergeCommits : state.muteMergeCommits;
  state.muteNonAncestors = !!config.muteNonAncestors;
  state.columnWidths = config.columnWidths || state.columnWidths;
  state.includeReflogCommits = !!config.includeCommitsMentionedByReflogs;
  state.showTags = config.showTags !== undefined ? config.showTags : true;
  state.showStashesPref = config.showStashes !== undefined ? config.showStashes : true;
  state.showUncommittedChangesPref = config.showUncommittedChanges !== undefined ? config.showUncommittedChanges : true;
}

function gitGraphApplyGlobalPrefsToState(state, prefs) {
  if (!prefs) return;
  state.globalPrefs = prefs;
  state.dateFormat = prefs.dateFormat || state.dateFormat;
  state.dateType = prefs.dateType === 'commit' ? 'commit' : 'author';
  state.graphStyle = prefs.graphStyle || state.graphStyle;
  state.graphColours = prefs.graphColours || state.graphColours;
  state.columns = prefs.columnVisibility || state.columns;
  state.combineLocalAndRemote = prefs.combineLocalAndRemoteBranchLabels !== false;
  state.uncommittedChangesStyle = prefs.graphUncommittedChangesStyle || state.uncommittedChangesStyle;
  state.detailsLocation = (prefs.commitDetailsView && prefs.commitDetailsView.location) || state.detailsLocation;
  state.autoCenterDetails = !prefs.commitDetailsView || prefs.commitDetailsView.autoCenter !== false;
  state.fileViewType = prefs.fileViewType || state.fileViewType;
  state.compactFolders = prefs.compactFolders !== false;
  state.initialLoad = prefs.initialLoad || state.initialLoad;
  state.loadMore = prefs.loadMore || state.loadMore;
  state.loadMoreAutomatically = prefs.loadMoreAutomatically !== false;
  state.repositoryDropdownOrder = prefs.repositoryDropdownOrder || 'attachmentOrder';
  state.markdownRendering = prefs.markdownRendering !== false;
  state.enhancedAccessibility = !!prefs.enhancedAccessibility;
  state.referenceLabelAlignment = prefs.referenceLabelAlignment || 'normal';
  state.globalFetchAvatars = !!prefs.fetchAvatars;
}

/** Fetches RepoConfig + GlobalPrefs once, up front, and applies both before
 * the tab's very first commit query — this is what makes filter-affecting
 * fields (branch selection, order, mute rules, …) correct on the very first
 * paint of a freshly opened tab rather than only after a reload triggered by
 * whatever arrived late. Never rejects: a missing/erroring endpoint just
 * means the tab opens with its built-in defaults, exactly as before this
 * function existed. */
async function gitGraphLoadInitialPreferences(project, state, repo) {
  if (!repo) return;
  const [configResult, prefsResult] = await Promise.all([
    gitGraphApi('getGitGraphRepoConfig', project.id, repo.path).catch(() => null),
    gitGraphApi('getGitGraphGlobalPreferences').catch(() => null),
  ]);
  if (configResult && configResult.ok) gitGraphApplyRepoConfigToState(state, configResult.config);
  if (prefsResult && prefsResult.ok) gitGraphApplyGlobalPrefsToState(state, prefsResult.preferences);
  if (state.repoConfig) gitGraphApplyOnLoadSelection(state, state.repoConfig, null);
}

// --- Persisting a RepoConfig / GlobalPrefs patch, live ---

function gitGraphSelectedRepo(state) {
  return (state.repositories || []).find(r => r.path === state.selectedRepo);
}

async function gitGraphPatchRepoConfig(project, state, patch) {
  const repo = gitGraphSelectedRepo(state);
  if (!repo) return null;
  const result = await gitGraphApi('setGitGraphRepoConfig', project.id, repo.path, patch);
  if (result && result.ok) gitGraphApplyRepoConfigToState(state, result.config);
  return result;
}

async function gitGraphPatchGlobalPrefs(state, patch) {
  const result = await gitGraphApi('setGitGraphGlobalPreferences', patch);
  if (result && result.ok) gitGraphApplyGlobalPrefsToState(state, result.preferences);
  return result;
}

async function gitGraphClearAvatarCache(project, state, body) {
  await gitGraphApi('clearGitGraphAvatarCache');
  if (state.avatarCache) state.avatarCache.clear();
  gitGraphPaint(project, state, body);
}

async function gitGraphExportRepoConfig(project, state, body) {
  const repo = gitGraphSelectedRepo(state);
  if (!repo) return;
  const result = await gitGraphApi('exportGitGraphRepoConfig', project.id, repo.path);
  const banner = body.querySelector('#gg-settings-drawer');
  if (!banner) return;
  const note = document.createElement('div');
  note.className = result && result.ok ? 'gg-dialog-hint' : 'gg-dialog-error';
  note.textContent = result && result.ok
    ? `Wrote ${GG_EXTERNAL_CONFIG_FILENAME} to the repository root.`
    : (result && result.error) || 'Exporting the repository configuration is not available in this build yet.';
  banner.appendChild(note);
}

// --- Code Review ---
//
// Keyed by commit hash for a single commit, or a `from..to` range for a
// comparison — the Uncommitted Changes row alone has no key and is simply
// never eligible, matching the extension's own scoping.

function gitGraphCodeReviewKeyFor(data) {
  if (!data) return null;
  if (data.mode === 'compare' && data.fromHash && data.toHash) return `${data.fromHash}..${data.toHash}`;
  if (data.mode === 'single' && data.kind !== 'uncommitted' && data.hash) return data.hash;
  return null;
}

function gitGraphHydrateCodeReviewForDetails(state) {
  const key = gitGraphCodeReviewKeyFor(state.detailsData);
  if (!key) { state.codeReview = null; return; }
  const record = state.repoConfig && state.repoConfig.codeReview && state.repoConfig.codeReview[key];
  state.codeReview = record
    ? { key, reviewedPaths: new Set(record.reviewedPaths || []), startedAt: record.startedAt }
    : null;
}

async function gitGraphPersistCodeReview(project, state, key, record) {
  const current = (state.repoConfig && state.repoConfig.codeReview) || {};
  const next = { ...current };
  if (record) next[key] = record; else delete next[key];
  return gitGraphPatchRepoConfig(project, state, { codeReview: next });
}

async function gitGraphStartCodeReview(project, state, body) {
  const key = gitGraphCodeReviewKeyFor(state.detailsData);
  if (!key) return;
  const startedAt = Date.now();
  state.codeReview = { key, reviewedPaths: new Set(), startedAt };
  await gitGraphPersistCodeReview(project, state, key, { reviewedPaths: [], startedAt });
  gitGraphPaintDetailsOnly(project, state, body);
}

async function gitGraphEndCodeReview(project, state, body) {
  if (!state.codeReview) return;
  const key = state.codeReview.key;
  state.codeReview = null;
  await gitGraphPersistCodeReview(project, state, key, null);
  gitGraphPaintDetailsOnly(project, state, body);
}

async function gitGraphSetFileReviewed(project, state, body, filePath, reviewed) {
  if (!state.codeReview || !filePath) return;
  if (reviewed) state.codeReview.reviewedPaths.add(filePath); else state.codeReview.reviewedPaths.delete(filePath);
  await gitGraphPersistCodeReview(project, state, state.codeReview.key, {
    reviewedPaths: [...state.codeReview.reviewedPaths], startedAt: state.codeReview.startedAt,
  });
  gitGraphPaintDetailsOnly(project, state, body);
}

/** Auto-un-bolds a file the moment its diff/content is viewed — a
 * no-op whenever no review is active on the open commit/comparison. */
function gitGraphMarkFileReviewedIfActive(project, state, body, filePath) {
  if (state.codeReview && filePath && !state.codeReview.reviewedPaths.has(filePath)) {
    gitGraphSetFileReviewed(project, state, body, filePath, true);
  }
}

function gitGraphCodeReviewControlsHtml(state) {
  const key = gitGraphCodeReviewKeyFor(state.detailsData);
  if (!key) return '';
  if (state.codeReview && state.codeReview.key === key) {
    return `<button type="button" class="gg-toggle-btn gg-code-review-btn" id="gg-code-review-toggle">End Code Review</button>`;
  }
  return `<button type="button" class="gg-toggle-btn gg-code-review-btn" id="gg-code-review-toggle">Start Code Review</button>`;
}

function gitGraphWireCodeReviewControls(project, state, body, container) {
  const btn = container.querySelector('#gg-code-review-toggle');
  if (!btn) return;
  btn.onclick = () => {
    if (state.codeReview) gitGraphEndCodeReview(project, state, body);
    else gitGraphStartCodeReview(project, state, body);
  };
}

// --- Repository Settings drawer ---

const GG_DATE_FORMAT_OPTIONS = [
  { value: 'date-time', label: 'Date & Time' },
  { value: 'date-only', label: 'Date Only' },
  { value: 'iso', label: 'ISO Date & Time' },
  { value: 'iso-date-only', label: 'ISO Date Only' },
  { value: 'relative', label: 'Relative' },
];
const GG_DATE_TYPE_OPTIONS = [{ value: 'author', label: 'Author Date' }, { value: 'commit', label: 'Commit Date' }];
const GG_GRAPH_STYLE_OPTIONS = [{ value: 'rounded', label: 'Rounded' }, { value: 'angular', label: 'Angular' }];
const GG_UNCOMMITTED_STYLE_OPTIONS = [
  { value: 'openAtUncommitted', label: 'Open Circle at the Uncommitted Changes' },
  { value: 'openAtCheckedOutCommit', label: 'Open Circle at the Checked Out Commit' },
];
const GG_ORDER_OPTIONS = [{ value: 'date', label: 'Date' }, { value: 'author-date', label: 'Author Date' }, { value: 'topo', label: 'Topological' }];
const GG_FILE_VIEW_OPTIONS = [{ value: 'tree', label: 'File Tree' }, { value: 'list', label: 'File List' }];
const GG_DETAILS_LOCATION_OPTIONS = [{ value: 'inline', label: 'Inline' }, { value: 'docked', label: 'Docked to Bottom' }];
const GG_DROPDOWN_ORDER_OPTIONS = [
  { value: 'attachmentOrder', label: 'Order Attached' }, { value: 'name', label: 'Name' }, { value: 'fullPath', label: 'Full Path' },
];
const GG_REF_ALIGNMENT_OPTIONS = [
  { value: 'normal', label: 'Normal' }, { value: 'branch-leading', label: 'Branches Leading' }, { value: 'graph-aligned', label: 'Aligned to Graph' },
];
const GG_FETCH_AVATARS_OPTIONS = [
  { value: '', label: 'Inherit Global Preference' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' },
];

function gitGraphSettingsHeaderHtml(state) {
  const tab = state.settingsTab || 'repository';
  return `
    <div class="gg-settings-header">Repository Settings<button type="button" id="gg-settings-close">×</button></div>
    <div class="gg-settings-tabs">
      <button type="button" class="gg-settings-tab${tab === 'repository' ? ' active' : ''}" data-tab="repository">This Repository</button>
      <button type="button" class="gg-settings-tab${tab === 'global' ? ' active' : ''}" data-tab="global">Global Preferences</button>
    </div>`;
}

function gitGraphRepositorySettingsHtml(project, state, repo) {
  const config = state.repoConfig || {};
  const remotes = state.remotes || [];
  const perRemoteVisibility = config.perRemoteVisibility || {};

  const remoteRows = remotes.length ? remotes.map(r => `
    <div class="gg-remote-row" data-remote="${escapeAttr(r.name)}">
      <label class="gg-checkbox"><input type="checkbox" class="gg-remote-visible" data-remote="${escapeAttr(r.name)}" ${perRemoteVisibility[r.name] === false ? '' : 'checked'}></label>
      <span class="mono gg-remote-name">${escapeHtml(r.name)}</span>
      <span class="gg-remote-url">${escapeHtml(r.url || '')}</span>
      <span class="gg-remote-actions">
        <button type="button" class="gg-icon-btn gg-remote-fetch" data-remote="${escapeAttr(r.name)}" title="Fetch this remote">${gitGraphIcon('fetch', 12)}</button>
        <button type="button" class="gg-icon-btn gg-remote-edit" data-remote="${escapeAttr(r.name)}" title="Edit remote">${gitGraphIcon('gear', 12)}</button>
        <button type="button" class="gg-icon-btn gg-remote-delete" data-remote="${escapeAttr(r.name)}" title="Delete remote">×</button>
      </span>
    </div>`).join('') : '<div class="gg-empty-row">No remotes configured.</div>';

  const issueLinking = config.issueLinking;
  const prProvider = config.pullRequestProvider;

  return `
    <section class="gg-settings-section">
      <div class="gg-settings-title">Repository Name</div>
      ${gitGraphSettingsField('gg-setting-display-name', 'Custom display name', gitGraphSettingsText('gg-setting-display-name', config.customDisplayName || '', pathBasename(repo.path) || repo.path))}
    </section>
    <section class="gg-settings-section">
      <div class="gg-settings-title">Remotes</div>
      <div class="gg-remotes-list">${remoteRows}</div>
      <button type="button" class="ws-btn gg-settings-btn" id="gg-remote-add">Add Remote…</button>
    </section>
    <section class="gg-settings-section">
      <div class="gg-settings-title">User Details</div>
      <button type="button" class="ws-btn gg-settings-btn" id="gg-user-details-btn">Configure Git User Name &amp; Email…</button>
    </section>
    <section class="gg-settings-section">
      <div class="gg-settings-title">Issue Linking</div>
      <div class="gg-settings-summary">${issueLinking ? `<span class="mono">${escapeHtml(issueLinking.regex)}</span> → ${escapeHtml(issueLinking.url)}` : 'Not configured.'}</div>
      <button type="button" class="ws-btn gg-settings-btn" id="gg-issue-linking-btn">Configure Issue Linking…</button>
    </section>
    <section class="gg-settings-section">
      <div class="gg-settings-title">Pull Request Creation</div>
      <div class="gg-settings-summary">${prProvider ? `Provider: ${escapeHtml(prProvider.name || prProvider.kind)}` : 'Not configured.'}</div>
      <button type="button" class="ws-btn gg-settings-btn" id="gg-pr-config-btn">Configure Pull Request Creation…</button>
    </section>
    <section class="gg-settings-section">
      <div class="gg-settings-title">Display</div>
      ${gitGraphSettingsCheckboxRow('gg-setting-show-remote', 'Show Remote Branches', config.showRemoteBranches !== false)}
      ${gitGraphSettingsCheckboxRow('gg-setting-show-remote-heads', 'Show Remote HEAD refs', config.showRemoteHeads !== false)}
      ${gitGraphSettingsCheckboxRow('gg-setting-show-stashes', 'Show Stashes', config.showStashes !== false)}
      ${gitGraphSettingsCheckboxRow('gg-setting-show-tags', 'Show Tags', config.showTags !== false)}
      ${gitGraphSettingsCheckboxRow('gg-setting-show-tag-only', 'Show commits only reachable via tags', config.showCommitsOnlyReferencedByTags !== false)}
      ${gitGraphSettingsCheckboxRow('gg-setting-show-uncommitted', 'Show Uncommitted Changes', config.showUncommittedChanges !== false)}
      ${gitGraphSettingsCheckboxRow('gg-setting-show-untracked', 'Show Untracked Files', config.showUntrackedFiles !== false)}
      ${gitGraphSettingsCheckboxRow('gg-setting-reflogs', 'Include commits only mentioned by reflogs', !!config.includeCommitsMentionedByReflogs)}
      ${gitGraphSettingsCheckboxRow('gg-setting-first-parent', 'Only follow first parent', !!config.onlyFollowFirstParent)}
      ${gitGraphSettingsCheckboxRow('gg-setting-mute-non-ancestor', 'Mute commits not ancestors of HEAD', !!config.muteNonAncestors)}
      ${gitGraphSettingsCheckboxRow('gg-setting-mute-merge', 'Mute merge commits', config.muteMergeCommits !== false)}
      ${gitGraphSettingsField('gg-setting-order', 'Commit order', gitGraphSettingsSelect('gg-setting-order', GG_ORDER_OPTIONS, config.commitsOrder || 'date'))}
      ${gitGraphSettingsCheckboxRow('gg-setting-mailmap', 'Use .mailmap', !!config.useMailmap)}
      ${gitGraphSettingsCheckboxRow('gg-setting-sign-commits', 'Sign new commits', !!config.signCommits)}
      ${gitGraphSettingsCheckboxRow('gg-setting-sign-tags', 'Sign new tags', !!config.signTags)}
      ${gitGraphSettingsCheckboxRow('gg-setting-signature-status', 'Show signature status in Commit Details', !!config.showSignatureStatus)}
    </section>
    <section class="gg-settings-section">
      <div class="gg-settings-title">On Repository Open</div>
      ${gitGraphSettingsCheckboxRow('gg-setting-onload-scroll', 'Scroll to HEAD', !!config.onLoadScrollToHead)}
      ${gitGraphSettingsCheckboxRow('gg-setting-onload-checked-out', 'Show only the checked-out branch', !!config.onLoadShowCheckedOutBranch)}
      ${gitGraphSettingsField('gg-setting-onload-specific', 'Show specific branches (comma-separated)', gitGraphSettingsText('gg-setting-onload-specific', (config.onLoadShowSpecificBranches || []).join(', ')))}
    </section>
    <section class="gg-settings-section">
      <div class="gg-settings-title">Remotes: Fetch &amp; Avatars</div>
      ${gitGraphSettingsCheckboxRow('gg-setting-fetch-prune', 'Prune when fetching from Remote(s)', !!config.fetchAndPrune)}
      ${gitGraphSettingsCheckboxRow('gg-setting-fetch-prune-tags', 'Also prune tags', !!config.fetchAndPruneTags)}
      ${gitGraphSettingsField('gg-setting-fetch-avatars', 'Fetch avatars for this repository', gitGraphSettingsSelect('gg-setting-fetch-avatars', GG_FETCH_AVATARS_OPTIONS, config.fetchAvatars === true ? 'on' : config.fetchAvatars === false ? 'off' : ''))}
      <button type="button" class="ws-btn gg-settings-btn" id="gg-clear-avatar-cache-btn">Clear Avatar Cache</button>
    </section>
    <section class="gg-settings-section">
      <button type="button" class="ws-btn gg-settings-btn" id="gg-export-config-btn">Export Repository Configuration</button>
    </section>`;
}

function gitGraphAdvancedPrefsJson(prefs) {
  return JSON.stringify({
    dialogDefaults: prefs.dialogDefaults,
    contextMenuActionsVisibility: prefs.contextMenuActionsVisibility,
    customBranchGlobPatterns: prefs.customBranchGlobPatterns,
    customPullRequestProviders: prefs.customPullRequestProviders,
    customEmojiShortcodeMappings: prefs.customEmojiShortcodeMappings,
  }, null, 2);
}

function gitGraphGlobalPreferencesHtml(state) {
  const prefs = state.globalPrefs || {};
  const colours = (prefs.graphColours || []).join('\n');
  return `
    <section class="gg-settings-section">
      <div class="gg-settings-title">Dates</div>
      ${gitGraphSettingsField('gg-pref-date-format', 'Date format', gitGraphSettingsSelect('gg-pref-date-format', GG_DATE_FORMAT_OPTIONS, prefs.dateFormat || 'date-time'))}
      ${gitGraphSettingsField('gg-pref-date-type', 'Date type', gitGraphSettingsSelect('gg-pref-date-type', GG_DATE_TYPE_OPTIONS, prefs.dateType || 'author'))}
    </section>
    <section class="gg-settings-section">
      <div class="gg-settings-title">Graph</div>
      ${gitGraphSettingsField('gg-pref-graph-style', 'Style', gitGraphSettingsSelect('gg-pref-graph-style', GG_GRAPH_STYLE_OPTIONS, prefs.graphStyle || 'rounded'))}
      ${gitGraphSettingsField('gg-pref-uncommitted-style', 'Uncommitted changes marker', gitGraphSettingsSelect('gg-pref-uncommitted-style', GG_UNCOMMITTED_STYLE_OPTIONS, prefs.graphUncommittedChangesStyle || 'openAtUncommitted'))}
      ${gitGraphSettingsField('gg-pref-colours', 'Lane colours (one hex colour per line)', gitGraphSettingsTextarea('gg-pref-colours', colours))}
    </section>
    <section class="gg-settings-section">
      <div class="gg-settings-title">Columns</div>
      ${gitGraphSettingsCheckboxRow('gg-pref-col-date', 'Date', prefs.columnVisibility ? !!prefs.columnVisibility.date : true)}
      ${gitGraphSettingsCheckboxRow('gg-pref-col-author', 'Author', prefs.columnVisibility ? !!prefs.columnVisibility.author : true)}
      ${gitGraphSettingsCheckboxRow('gg-pref-col-commit', 'Commit', prefs.columnVisibility ? !!prefs.columnVisibility.commit : true)}
    </section>
    <section class="gg-settings-section">
      <div class="gg-settings-title">Reference Labels</div>
      ${gitGraphSettingsField('gg-pref-ref-alignment', 'Alignment', gitGraphSettingsSelect('gg-pref-ref-alignment', GG_REF_ALIGNMENT_OPTIONS, prefs.referenceLabelAlignment || 'normal'))}
      ${gitGraphSettingsCheckboxRow('gg-pref-combine-labels', 'Combine local and remote branch labels', prefs.combineLocalAndRemoteBranchLabels !== false)}
    </section>
    <section class="gg-settings-section">
      <div class="gg-settings-title">Content</div>
      ${gitGraphSettingsCheckboxRow('gg-pref-markdown', 'Render Markdown in commit messages', prefs.markdownRendering !== false)}
      ${gitGraphSettingsCheckboxRow('gg-pref-a11y', 'Enhanced accessibility (A/M/D/R/U file-status letters)', !!prefs.enhancedAccessibility)}
    </section>
    <section class="gg-settings-section">
      <div class="gg-settings-title">Commit Details View</div>
      ${gitGraphSettingsField('gg-pref-details-location', 'Location', gitGraphSettingsSelect('gg-pref-details-location', GG_DETAILS_LOCATION_OPTIONS, (prefs.commitDetailsView && prefs.commitDetailsView.location) || 'inline'))}
      ${gitGraphSettingsCheckboxRow('gg-pref-auto-center', 'Auto-center when opened', !prefs.commitDetailsView || prefs.commitDetailsView.autoCenter !== false)}
      ${gitGraphSettingsField('gg-pref-file-view', 'File list layout', gitGraphSettingsSelect('gg-pref-file-view', GG_FILE_VIEW_OPTIONS, prefs.fileViewType || 'tree'))}
      ${gitGraphSettingsCheckboxRow('gg-pref-compact-folders', 'Compact single-child folders', prefs.compactFolders !== false)}
    </section>
    <section class="gg-settings-section">
      <div class="gg-settings-title">Loading</div>
      ${gitGraphSettingsField('gg-pref-initial-load', 'Initial commits loaded', gitGraphSettingsNumber('gg-pref-initial-load', prefs.initialLoad || 300, 1))}
      ${gitGraphSettingsField('gg-pref-load-more', '"Load More" batch size', gitGraphSettingsNumber('gg-pref-load-more', prefs.loadMore || 100, 1))}
      ${gitGraphSettingsCheckboxRow('gg-pref-load-more-auto', 'Load more automatically on scroll', prefs.loadMoreAutomatically !== false)}
    </section>
    <section class="gg-settings-section">
      <div class="gg-settings-title">Avatars</div>
      ${gitGraphSettingsCheckboxRow('gg-pref-fetch-avatars', 'Fetch avatars by default', !!prefs.fetchAvatars)}
      <button type="button" class="ws-btn gg-settings-btn" id="gg-clear-avatar-cache-btn-global">Clear Avatar Cache</button>
    </section>
    <section class="gg-settings-section">
      <div class="gg-settings-title">Repository Dropdown</div>
      ${gitGraphSettingsField('gg-pref-dropdown-order', 'Order', gitGraphSettingsSelect('gg-pref-dropdown-order', GG_DROPDOWN_ORDER_OPTIONS, prefs.repositoryDropdownOrder || 'attachmentOrder'))}
    </section>
    <section class="gg-settings-section">
      <div class="gg-settings-title">Advanced</div>
      <div class="gg-field-hint">Dialog defaults, per-action context-menu visibility, custom branch globs, custom Pull Request providers, and custom emoji shortcodes, as one JSON object.</div>
      ${gitGraphSettingsTextarea('gg-pref-advanced', gitGraphAdvancedPrefsJson(prefs))}
      <button type="button" class="ws-btn gg-settings-btn" id="gg-pref-advanced-save">Save Advanced Settings</button>
    </section>`;
}

function gitGraphRenderSettingsDrawer(project, state, body) {
  const drawer = body.querySelector('#gg-settings-drawer');
  if (!drawer) return;
  const repo = gitGraphSelectedRepo(state);
  drawer.style.display = 'block';
  const tab = state.settingsTab || 'repository';
  drawer.innerHTML = gitGraphSettingsHeaderHtml(state) +
    (tab === 'global' ? gitGraphGlobalPreferencesHtml(state) : (repo ? gitGraphRepositorySettingsHtml(project, state, repo) : '<div class="gg-empty-row">No repository selected.</div>'));
  gitGraphWireSettingsDrawer(project, state, body, drawer, repo);
}

function gitGraphWireSettingsDrawer(project, state, body, drawer, repo) {
  drawer.querySelector('#gg-settings-close').onclick = () => gitGraphToggleSettings(project, state, body);
  drawer.querySelectorAll('.gg-settings-tab').forEach((tabBtn) => {
    tabBtn.onclick = () => { state.settingsTab = tabBtn.dataset.tab; gitGraphRenderSettingsDrawer(project, state, body); };
  });
  if (state.settingsTab === 'global') gitGraphWireGlobalPreferences(project, state, body, drawer);
  else if (repo) gitGraphWireRepositorySettings(project, state, body, drawer, repo);
}

function gitGraphWireRepositorySettings(project, state, body, drawer, repo) {
  const reloadDrawer = () => gitGraphRenderSettingsDrawer(project, state, body);
  const ctxBase = {
    projectId: project.id, folderPath: repo.path, refresh: () => gitGraphLoadGraph(project, state, body, { reset: true }),
    remotes: state.remotes || [], defaultBranch: state.headBranchName || 'main',
    customProviders: (state.globalPrefs && state.globalPrefs.customPullRequestProviders) || [],
    sampleSubjects: (state.rawCommits || []).slice(0, 40).map(c => c.subject),
  };

  const nameInput = drawer.querySelector('#gg-setting-display-name');
  nameInput.onchange = () => gitGraphPatchRepoConfig(project, state, { customDisplayName: nameInput.value.trim() || null }).then(reloadDrawer);

  drawer.querySelector('#gg-remote-add').onclick = () => gitGraphOptionalDialog('gitGraphShowAddRemoteDialog', ctxBase).then(reloadDrawer);
  drawer.querySelectorAll('.gg-remote-edit').forEach((btn) => {
    btn.onclick = () => {
      const remote = (state.remotes || []).find(r => r.name === btn.dataset.remote);
      gitGraphOptionalDialog('gitGraphShowEditRemoteDialog', ctxBase, remote).then(reloadDrawer);
    };
  });
  drawer.querySelectorAll('.gg-remote-delete').forEach((btn) => {
    btn.onclick = () => {
      const remote = (state.remotes || []).find(r => r.name === btn.dataset.remote);
      gitGraphOptionalDialog('gitGraphShowDeleteRemoteDialog', ctxBase, remote).then(reloadDrawer);
    };
  });
  drawer.querySelectorAll('.gg-remote-fetch').forEach((btn) => {
    btn.onclick = () => {
      const remote = (state.remotes || []).find(r => r.name === btn.dataset.remote);
      gitGraphOptionalDialog('gitGraphShowFetchRemoteDialog', ctxBase, remote).then(reloadDrawer);
    };
  });
  drawer.querySelectorAll('.gg-remote-visible').forEach((cb) => {
    cb.onchange = () => {
      const current = { ...(state.repoConfig && state.repoConfig.perRemoteVisibility) };
      current[cb.dataset.remote] = cb.checked;
      gitGraphPatchRepoConfig(project, state, { perRemoteVisibility: current });
    };
  });

  drawer.querySelector('#gg-user-details-btn').onclick = () => gitGraphApi('getGitGraphUserDetails', project.id, repo.path)
    .then(r => gitGraphOptionalDialog('gitGraphShowUserDetailsDialog', ctxBase, (r && r.ok) ? r.details : null))
    .then(reloadDrawer);
  // Issue Linking / Pull Request Creation are pure configuration dialogs
  //: they resolve the new
  // value for *this* caller to persist, rather than calling
  // runGitGraphAction themselves the way every mutating dialog above does.
  drawer.querySelector('#gg-issue-linking-btn').onclick = () => gitGraphOptionalDialog('gitGraphShowIssueLinkingDialog', ctxBase, state.repoConfig && state.repoConfig.issueLinking)
    .then(result => result && gitGraphPatchRepoConfig(project, state, { issueLinking: { regex: result.regex, url: result.url, useGlobally: result.useGlobally } }))
    .then(reloadDrawer);
  drawer.querySelector('#gg-pr-config-btn').onclick = () => gitGraphOptionalDialog('gitGraphShowPullRequestConfigDialog', ctxBase, state.repoConfig && state.repoConfig.pullRequestProvider)
    .then(result => result && gitGraphPatchRepoConfig(project, state, { pullRequestProvider: result }))
    .then(reloadDrawer);
  drawer.querySelector('#gg-export-config-btn').onclick = () => gitGraphExportRepoConfig(project, state, body);
  drawer.querySelector('#gg-clear-avatar-cache-btn').onclick = () => gitGraphClearAvatarCache(project, state, body).then(reloadDrawer);

  const displayToggle = (id, key) => {
    const el = drawer.querySelector(id);
    el.onchange = () => gitGraphPatchRepoConfig(project, state, { [key]: el.checked });
  };
  displayToggle('#gg-setting-show-remote-heads', 'showRemoteHeads');
  displayToggle('#gg-setting-show-tag-only', 'showCommitsOnlyReferencedByTags');
  displayToggle('#gg-setting-show-untracked', 'showUntrackedFiles');
  displayToggle('#gg-setting-mailmap', 'useMailmap');
  displayToggle('#gg-setting-sign-commits', 'signCommits');
  displayToggle('#gg-setting-sign-tags', 'signTags');
  displayToggle('#gg-setting-signature-status', 'showSignatureStatus');
  displayToggle('#gg-setting-onload-scroll', 'onLoadScrollToHead');
  displayToggle('#gg-setting-onload-checked-out', 'onLoadShowCheckedOutBranch');
  displayToggle('#gg-setting-fetch-prune', 'fetchAndPrune');
  displayToggle('#gg-setting-fetch-prune-tags', 'fetchAndPruneTags');

  // The toggles below also drive the very next commit-graph query (or, for
  // "Show Uncommitted Changes", what gitGraphLoadGraph keeps from the reply
  // it already has). Each one sets its mirrored `state.*` field synchronously
  // — not only via the RepoConfig round trip, which wouldn't resolve until
  // after the reload below already read the (still-stale) old value — then
  // persists and reloads.
  const reloadToggle = (id, repoConfigKey, stateKey) => {
    const el = drawer.querySelector(id);
    el.onchange = () => {
      state[stateKey] = el.checked;
      gitGraphPatchRepoConfig(project, state, { [repoConfigKey]: el.checked });
      gitGraphLoadGraph(project, state, body, { reset: true });
    };
  };
  reloadToggle('#gg-setting-show-remote', 'showRemoteBranches', 'showRemoteBranches');
  reloadToggle('#gg-setting-show-stashes', 'showStashes', 'showStashesPref');
  reloadToggle('#gg-setting-show-tags', 'showTags', 'showTags');
  reloadToggle('#gg-setting-first-parent', 'onlyFollowFirstParent', 'firstParentOnly');
  reloadToggle('#gg-setting-reflogs', 'includeCommitsMentionedByReflogs', 'includeReflogCommits');
  reloadToggle('#gg-setting-show-uncommitted', 'showUncommittedChanges', 'showUncommittedChangesPref');
  // Mute rules affect rendering only (no query re-fetch needed), so they get
  // an immediate repaint instead of the plain-persist-only handling above.
  drawer.querySelector('#gg-setting-mute-merge').onchange = (e) => { gitGraphPatchRepoConfig(project, state, { muteMergeCommits: e.target.checked }); state.muteMergeCommits = e.target.checked; gitGraphPaint(project, state, body); };
  drawer.querySelector('#gg-setting-mute-non-ancestor').onchange = (e) => { gitGraphPatchRepoConfig(project, state, { muteNonAncestors: e.target.checked }); state.muteNonAncestors = e.target.checked; gitGraphPaint(project, state, body); };

  drawer.querySelector('#gg-setting-order').onchange = (e) => { gitGraphPatchRepoConfig(project, state, { commitsOrder: e.target.value }); state.order = e.target.value; gitGraphLoadGraph(project, state, body, { reset: true }); };

  drawer.querySelector('#gg-setting-onload-specific').onchange = (e) => {
    const list = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
    gitGraphPatchRepoConfig(project, state, { onLoadShowSpecificBranches: list });
  };

  drawer.querySelector('#gg-setting-fetch-avatars').onchange = (e) => {
    const value = e.target.value === 'on' ? true : e.target.value === 'off' ? false : null;
    gitGraphPatchRepoConfig(project, state, { fetchAvatars: value }).then(() => gitGraphPaint(project, state, body));
  };
}

function gitGraphWireGlobalPreferences(project, state, body, drawer) {
  // Every field here is a render-time preference (date/graph/column/label/
  // markdown/accessibility/file-view/details-panel choices), so one repaint
  // after the round trip resolves is what "apply live" means for all of them
  // — none needs a fresh commit-graph query the way a RepoConfig filter does.
  const patch = (partial) => gitGraphPatchGlobalPrefs(state, partial).then(() => gitGraphPaint(project, state, body));
  drawer.querySelector('#gg-pref-date-format').onchange = (e) => patch({ dateFormat: e.target.value });
  drawer.querySelector('#gg-pref-date-type').onchange = (e) => patch({ dateType: e.target.value });
  drawer.querySelector('#gg-pref-graph-style').onchange = (e) => patch({ graphStyle: e.target.value });
  drawer.querySelector('#gg-pref-uncommitted-style').onchange = (e) => patch({ graphUncommittedChangesStyle: e.target.value });
  drawer.querySelector('#gg-pref-colours').onchange = (e) => {
    const lines = e.target.value.split('\n').map(s => s.trim()).filter(Boolean);
    if (lines.length) patch({ graphColours: lines });
  };
  drawer.querySelector('#gg-pref-col-date').onchange = (e) => patch({ columnVisibility: { ...(state.globalPrefs && state.globalPrefs.columnVisibility), date: e.target.checked } });
  drawer.querySelector('#gg-pref-col-author').onchange = (e) => patch({ columnVisibility: { ...(state.globalPrefs && state.globalPrefs.columnVisibility), author: e.target.checked } });
  drawer.querySelector('#gg-pref-col-commit').onchange = (e) => patch({ columnVisibility: { ...(state.globalPrefs && state.globalPrefs.columnVisibility), commit: e.target.checked } });
  drawer.querySelector('#gg-pref-ref-alignment').onchange = (e) => patch({ referenceLabelAlignment: e.target.value });
  drawer.querySelector('#gg-pref-combine-labels').onchange = (e) => patch({ combineLocalAndRemoteBranchLabels: e.target.checked });
  drawer.querySelector('#gg-pref-markdown').onchange = (e) => patch({ markdownRendering: e.target.checked });
  drawer.querySelector('#gg-pref-a11y').onchange = (e) => patch({ enhancedAccessibility: e.target.checked });
  drawer.querySelector('#gg-pref-details-location').onchange = (e) => patch({ commitDetailsView: { ...(state.globalPrefs && state.globalPrefs.commitDetailsView), location: e.target.value } });
  drawer.querySelector('#gg-pref-auto-center').onchange = (e) => patch({ commitDetailsView: { ...(state.globalPrefs && state.globalPrefs.commitDetailsView), autoCenter: e.target.checked } });
  drawer.querySelector('#gg-pref-file-view').onchange = (e) => patch({ fileViewType: e.target.value });
  drawer.querySelector('#gg-pref-compact-folders').onchange = (e) => patch({ compactFolders: e.target.checked });
  drawer.querySelector('#gg-pref-initial-load').onchange = (e) => patch({ initialLoad: Math.max(1, Number(e.target.value) || 300) });
  drawer.querySelector('#gg-pref-load-more').onchange = (e) => patch({ loadMore: Math.max(1, Number(e.target.value) || 100) });
  drawer.querySelector('#gg-pref-load-more-auto').onchange = (e) => patch({ loadMoreAutomatically: e.target.checked });
  drawer.querySelector('#gg-pref-fetch-avatars').onchange = (e) => patch({ fetchAvatars: e.target.checked });
  drawer.querySelector('#gg-pref-dropdown-order').onchange = (e) => patch({ repositoryDropdownOrder: e.target.value });
  const clearBtn = drawer.querySelector('#gg-clear-avatar-cache-btn-global');
  if (clearBtn) clearBtn.onclick = () => gitGraphApi('clearGitGraphAvatarCache').then(() => { if (state.avatarCache) state.avatarCache.clear(); });

  drawer.querySelector('#gg-pref-advanced-save').onclick = () => {
    const textarea = drawer.querySelector('#gg-pref-advanced');
    const errorEl = drawer.querySelector('#gg-pref-advanced-error');
    try {
      const parsed = JSON.parse(textarea.value);
      patch(parsed);
      if (errorEl) errorEl.remove();
    } catch (err) {
      if (!drawer.querySelector('#gg-pref-advanced-error')) {
        const div = document.createElement('div');
        div.id = 'gg-pref-advanced-error';
        div.className = 'gg-dialog-error';
        div.textContent = `Could not parse: ${err.message}`;
        textarea.insertAdjacentElement('afterend', div);
      }
    }
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    gitGraphOptionalDialog, gitGraphSortRepositories, gitGraphVisibleRemotes,
    gitGraphApplyOnLoadSelection, gitGraphSummarizeExternalConfig, gitGraphDetectExternalConfigSummary,
    gitGraphMaybePromptTrust, gitGraphApplyRepoConfigToState, gitGraphApplyGlobalPrefsToState,
    gitGraphLoadInitialPreferences, gitGraphPatchRepoConfig, gitGraphPatchGlobalPrefs,
    gitGraphClearAvatarCache, gitGraphExportRepoConfig,
    gitGraphCodeReviewKeyFor, gitGraphHydrateCodeReviewForDetails, gitGraphPersistCodeReview,
    gitGraphStartCodeReview, gitGraphEndCodeReview, gitGraphSetFileReviewed, gitGraphMarkFileReviewedIfActive,
    gitGraphCodeReviewControlsHtml, gitGraphWireCodeReviewControls,
    gitGraphRenderSettingsDrawer, gitGraphWireSettingsDrawer, gitGraphAdvancedPrefsJson,
    gitGraphSelectedRepo,
  };
}

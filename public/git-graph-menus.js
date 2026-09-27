// Context menu builders for the Git Graph tab.
//
// Every gitGraphBuild*Menu(ctx) function is pure: it reads only the fields on
// `ctx` (built by the caller from the frozen data-gg-* attributes,
// plus the view-state object project-git-graph-view.js passes in) and returns
// a `showContextMenu`-shaped item array (projects-view.js:2929-2969's existing
// item shape — no new menu infrastructure). Nothing here re-derives ancestry
// or ref data the view already has, and nothing here talks to window.api
// except from inside an item's own onClick.
//
// ctx contract (fields used depend on which menu; unused fields are ignored):
// {
//   projectId, folderPath,                     // repo identity for every action/dialog call
//   refresh: () => void,                        // reloads the tab after an immediate action succeeds
//   head: { hash: string|null, branch: string|null },
//   remotes: [{ name, url }],
//   localBranches: [{ name, hash }],             // full local-branch list (remote-branch menu's
//                                                 // "Fetch into local branch" needs this)
//   selectedBranchKeys: 'all' | Set<string> | string[],   // Branches-dropdown selection; a remote
//                                                 // branch's key is `${remote}/${name}`
//   onSelectBranch(key), onUnselectBranch(key),  // Branches-dropdown toggles, no git call
//   issueLinking: { regex, url } | null,
//   pullRequestProvider: { kind, name, templateUrl, sourceRemote, destRemote, destBranch } | null,
//   defaultBranch: string,                       // best-guess PR destination branch, e.g. 'main'
//   dialogDefaults: GlobalPrefs.dialogDefaults,   // passed straight through to every dialog
//   onColumnVisibilityChange(column, visible), onCommitsOrderChange(order),
//   onOpenSourceControlView(),
//   hasUntrackedFiles: boolean,                   // uncommitted-changes menu
//   codeReview: { key, reviewedPaths: Set<string> } | null,
//   onMarkFileReviewed(path, reviewed),
//   onViewDiff(file), onViewFileAtRevision(file), onViewDiffWithWorkingFile(file), onOpenFile(file),
//
//   // target-specific:
//   commit: { hash, shortHash, subject, parents: string[], children: [{hash, parents:string[]}] },
//   localBranch: { name, hash },
//   remoteBranch: { remote, name, hash },
//   tag: { name, hash, annotated },
//   stash: { hash, index, branch, message },
//   file: { path, relativePath, absolutePath, status, existsOnDisk,
//            isWorkingTreeSide, isHistoricalSingleCommit },
//   columnHeader: { columnVisibility: {date,author,commit}, commitsOrder },
//   link: { url },
// }

// --- Small shared helpers ---

function gitGraphCopyText(text) {
  if (typeof window !== 'undefined' && window.api && window.api.writeClipboard) window.api.writeClipboard(text == null ? '' : String(text));
}

function gitGraphOpenExternal(url) {
  if (typeof window !== 'undefined' && window.api && window.api.openExternal) window.api.openExternal(url);
}

/** Runs a non-dialog ("immediate") whitelisted action, reports git's stderr, then refreshes. */
async function gitGraphRunImmediateAction(ctx, actionId, params) {
  if (!(typeof window !== 'undefined' && window.api && window.api.runGitGraphAction)) return null;
  const result = await window.api.runGitGraphAction(ctx.projectId, ctx.folderPath, actionId, params);
  if (!result || result.cancelled) return result || null;
  if (result.error) { alert(result.error); return null; }
  if (typeof ctx.refresh === 'function') ctx.refresh();
  return result;
}

/**
 * "Create Archive" never sends a destination path itself — main.js shows the
 * real native Save dialog and only ever hands createArchive the path *that*
 * returned, so a script running in this renderer can never point the write
 * at an arbitrary file. `suggestedName` is only a filename hint for the
 * dialog, not a path.
 */
async function gitGraphRunCreateArchive(ctx, { ref, refType, remote, suggestedName }) {
  if (!(typeof window !== 'undefined' && window.api && window.api.saveGitGraphArchive)) return null;
  const result = await window.api.saveGitGraphArchive(ctx.projectId, ctx.folderPath, { ref, refType, remote, suggestedName });
  if (!result || result.cancelled) return result || null;
  if (result.error) { alert(result.error); return null; }
  return result;
}

function gitGraphIsBranchSelected(selectedBranchKeys, key) {
  if (selectedBranchKeys === 'all') return true;
  if (!selectedBranchKeys) return false;
  if (typeof selectedBranchKeys.has === 'function') return selectedBranchKeys.has(key);
  if (Array.isArray(selectedBranchKeys)) return selectedBranchKeys.includes(key);
  return false;
}

function gitGraphIsHeadCommit(ctx) {
  return !!(ctx.head && ctx.commit && ctx.head.hash && ctx.head.hash === ctx.commit.hash);
}

function gitGraphIsCurrentBranchTip(ctx) {
  return !!(ctx.head && ctx.head.branch && ctx.commit && ctx.head.hash === ctx.commit.hash);
}

/** Drop… needs exactly one non-merge child, and a parent of its own to rebase onto (a root commit has none). */
function gitGraphCommitDropVisible(commit) {
  if (!commit) return false;
  const parents = commit.parents || [];
  if (parents.length === 0) return false; // root commit — nothing to rebase onto
  if (parents.length >= 2) return false; // merge commit
  const children = commit.children || [];
  if (children.length !== 1) return false;
  return (children[0].parents || []).length < 2;
}

/**
 * Best-effort "next tag" suggestion for the Add Tag dialog's Name field: of
 * the existing tag names that start with a leading integer (optionally after
 * a non-digit prefix, e.g. "v2.0"), bumps the highest one's leading number by
 * one and keeps the rest of the name as-is ("v2.0" -> "v3.0"). Returns '' when
 * no tag matches that shape, leaving the field for the user to fill in.
 */
function gitGraphSuggestNextTagName(existingNames) {
  let best = null;
  for (const name of existingNames || []) {
    const m = /^(\D*)(\d+)(.*)$/.exec(name || '');
    if (!m) continue;
    const lead = Number(m[2]);
    if (!best || lead > best.lead) best = { prefix: m[1], lead, rest: m[3] };
  }
  return best ? `${best.prefix}${best.lead + 1}${best.rest}` : '';
}

// --- Issue Linking / Pull Request URL building ---

/** Substitutes a regex's capture groups into an "Issue URL" $1.."$8 template. */
function gitGraphBuildIssueUrl(issueLinking, text) {
  if (!issueLinking || !issueLinking.regex || !issueLinking.url || !text) return null;
  let re;
  try { re = new RegExp(issueLinking.regex); } catch { return null; }
  const m = re.exec(text);
  if (!m) return null;
  return issueLinking.url.replace(/\$([1-8])/g, (_, n) => (m[Number(n)] != null ? m[Number(n)] : ''));
}

/** Best-effort {host, owner, repo} extraction from an https://, ssh://, or git@ remote URL. */
function gitGraphParseRemoteUrl(url) {
  if (!url) return null;
  let m = /^[a-zA-Z][\w+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(url);
  if (!m) m = /^[^@]+@([^:]+):(.+?)(?:\.git)?\/?$/.exec(url);
  if (!m) return null;
  const host = m[1];
  const parts = m[2].split('/').filter(Boolean);
  const repo = parts.pop() || '';
  const owner = parts.join('/');
  return { host, owner, repo };
}

/** Built-in GitHub/GitLab/Bitbucket URL schemes, plus our own $1-$8 custom-provider mapping. */
function gitGraphBuildPullRequestUrl(provider, info) {
  if (!provider) return null;
  const src = gitGraphParseRemoteUrl(info.sourceRemoteUrl) || {};
  const dst = gitGraphParseRemoteUrl(info.destRemoteUrl) || src;
  const sourceBranch = info.sourceBranch, destBranch = info.destBranch;
  if (provider.kind === 'github') {
    return `https://github.com/${dst.owner}/${dst.repo}/compare/${encodeURIComponent(destBranch)}...${encodeURIComponent(sourceBranch)}?expand=1`;
  }
  if (provider.kind === 'gitlab') {
    return `https://gitlab.com/${dst.owner}/${dst.repo}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(sourceBranch)}&merge_request%5Btarget_branch%5D=${encodeURIComponent(destBranch)}`;
  }
  if (provider.kind === 'bitbucket') {
    return `https://bitbucket.org/${dst.owner}/${dst.repo}/pull-requests/new?source=${encodeURIComponent(sourceBranch)}&dest=${encodeURIComponent(destBranch)}`;
  }
  if (provider.kind === 'custom' && provider.templateUrl) {
    const values = [
      info.sourceRemoteName || '', src.owner || '', src.repo || '', sourceBranch || '',
      info.destRemoteName || '', dst.owner || '', dst.repo || '', destBranch || '',
    ];
    return provider.templateUrl.replace(/\$([1-8])/g, (_, n) => values[Number(n) - 1] || '');
  }
  return null;
}

function gitGraphResolvePullRequestUrl(ctx, branchName, remoteName) {
  const provider = ctx.pullRequestProvider;
  if (!provider || !ctx.remotes || !ctx.remotes.length) return null;
  const remotes = ctx.remotes;
  const sourceRemoteName = provider.sourceRemote || remoteName || remotes[0].name;
  const sourceRemote = remotes.find(r => r.name === sourceRemoteName) || remotes[0];
  const destRemoteName = provider.destRemote || sourceRemoteName;
  const destRemote = remotes.find(r => r.name === destRemoteName) || sourceRemote;
  return gitGraphBuildPullRequestUrl(provider, {
    sourceRemoteUrl: sourceRemote.url, sourceRemoteName: sourceRemote.name, sourceBranch: branchName,
    destRemoteUrl: destRemote.url, destRemoteName: destRemote.name,
    destBranch: provider.destBranch || ctx.defaultBranch || 'main',
  });
}

// --- Commit row ---

function gitGraphBuildCommitMenu(ctx) {
  const commit = ctx.commit || {};
  const isHead = gitGraphIsHeadCommit(ctx);
  const isCurrentBranchTip = gitGraphIsCurrentBranchTip(ctx);
  const dropVisible = gitGraphCommitDropVisible(commit);
  const items = [
    { id: 'addTag', label: 'Add Tag…', icon: gitGraphMenuIcon('tag'), onClick: () => gitGraphShowAddTagDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, commitHash: commit.hash, commitShortHash: commit.shortHash, remotes: ctx.remotes, suggestedName: gitGraphSuggestNextTagName(ctx.tags), defaults: ctx.dialogDefaults && ctx.dialogDefaults.addTag }) },
    { id: 'createBranch', label: 'Create Branch…', icon: gitGraphMenuIcon('branch'), onClick: () => gitGraphShowCreateBranchDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, commitHash: commit.hash, defaults: ctx.dialogDefaults && ctx.dialogDefaults.createBranch }) },
    { sep: true },
  ];
  if (!isHead) items.push({ id: 'checkout', label: 'Checkout…', onClick: () => gitGraphShowCheckoutCommitDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, commitHash: commit.hash, commitShortHash: commit.shortHash }) });
  items.push(
    { id: 'cherrypick', label: 'Cherry Pick…', icon: gitGraphMenuIcon('cherryPick'), onClick: () => gitGraphShowCherryPickDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, commitHash: commit.hash, commitShortHash: commit.shortHash, parents: commit.parents, defaults: ctx.dialogDefaults && ctx.dialogDefaults.cherryPick }) },
    { id: 'revert', label: 'Revert…', icon: gitGraphMenuIcon('revert'), onClick: () => gitGraphShowRevertDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, commitHash: commit.hash, commitShortHash: commit.shortHash, parents: commit.parents }) },
  );
  if (dropVisible) items.push({ id: 'drop', label: 'Drop…', danger: true, onClick: () => gitGraphShowDropCommitDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, commitHash: commit.hash, commitShortHash: commit.shortHash }) });
  items.push({ sep: true });
  if (!isCurrentBranchTip) {
    items.push(
      { id: 'merge', label: 'Merge into current branch…', icon: gitGraphMenuIcon('merge'), onClick: () => gitGraphShowMergeDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, currentBranch: ctx.head && ctx.head.branch, ref: commit.hash, refType: 'hash', refLabel: commit.shortHash, defaults: ctx.dialogDefaults && ctx.dialogDefaults.merge }) },
      { id: 'rebase', label: 'Rebase current branch on this Commit…', icon: gitGraphMenuIcon('rebase'), onClick: () => gitGraphShowRebaseDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, currentBranch: ctx.head && ctx.head.branch, upstream: commit.hash, upstreamRefType: 'hash', upstreamLabel: commit.shortHash, defaults: ctx.dialogDefaults && ctx.dialogDefaults.rebase }) },
    );
  }
  items.push(
    { id: 'resetCurrentBranchToCommit', label: 'Reset current branch to this Commit…', icon: gitGraphMenuIcon('reset'), onClick: () => gitGraphShowResetToCommitDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, currentBranch: ctx.head && ctx.head.branch, commitHash: commit.hash, commitShortHash: commit.shortHash, defaults: ctx.dialogDefaults && ctx.dialogDefaults.resetCurrentBranchToCommit }) },
    { sep: true },
    { id: 'copyHash', label: 'Copy Commit Hash to Clipboard', onClick: () => gitGraphCopyText(commit.hash) },
    { id: 'copySubject', label: 'Copy Commit Subject to Clipboard', onClick: () => gitGraphCopyText(commit.subject) },
  );
  return gitGraphApplyMenuVisibility(items, ctx, 'commit');
}

// --- Uncommitted Changes row ---

function gitGraphBuildUncommittedMenu(ctx) {
  const items = [
    { id: 'stash', label: 'Stash uncommitted changes…', icon: gitGraphMenuIcon('stash'), onClick: () => gitGraphShowStashPushDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, defaults: ctx.dialogDefaults && ctx.dialogDefaults.stashUncommittedChanges }) },
    { id: 'reset', label: 'Reset uncommitted changes…', danger: true, onClick: () => gitGraphShowResetUncommittedDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, defaults: ctx.dialogDefaults && ctx.dialogDefaults.resetUncommittedChanges }) },
  ];
  if (ctx.hasUntrackedFiles) items.push({ id: 'clean', label: 'Clean untracked files…', danger: true, onClick: () => gitGraphShowCleanUntrackedDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, defaults: ctx.dialogDefaults && ctx.dialogDefaults.cleanUntracked }) });
  items.push({ sep: true }, { id: 'openSourceControlView', label: 'Open Source Control View', onClick: () => ctx.onOpenSourceControlView && ctx.onOpenSourceControlView() });
  return gitGraphApplyMenuVisibility(items, ctx, 'uncommittedChanges');
}

// --- Local branch label ---

function gitGraphBuildLocalBranchMenu(ctx) {
  const branch = ctx.localBranch || {};
  const isCurrent = !!(ctx.head && ctx.head.branch === branch.name);
  const key = branch.name;
  const selected = gitGraphIsBranchSelected(ctx.selectedBranchKeys, key);
  const items = [];
  if (!isCurrent) items.push({ id: 'checkout', label: 'Checkout Branch', onClick: () => gitGraphRunImmediateAction(ctx, 'checkoutBranchImmediate', { name: branch.name }) });
  items.push({ id: 'rename', label: 'Rename Branch…', onClick: () => gitGraphShowRenameBranchDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, oldName: branch.name }) });
  if (!isCurrent) items.push({ id: 'delete', label: 'Delete Branch…', danger: true, onClick: () => gitGraphShowDeleteBranchDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, name: branch.name, remoteMatches: ((ctx.remoteBranchesByLocalName && ctx.remoteBranchesByLocalName[branch.name]) || []).map(r => ({ name: r.remote })), defaults: ctx.dialogDefaults && ctx.dialogDefaults.deleteBranch }) });
  items.push({ sep: true });
  if (!isCurrent) {
    items.push(
      { id: 'merge', label: 'Merge into current branch…', icon: gitGraphMenuIcon('merge'), onClick: () => gitGraphShowMergeDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, currentBranch: ctx.head && ctx.head.branch, ref: branch.name, refType: 'branch', refLabel: branch.name, defaults: ctx.dialogDefaults && ctx.dialogDefaults.merge }) },
      { id: 'rebase', label: 'Rebase current branch on Branch…', icon: gitGraphMenuIcon('rebase'), onClick: () => gitGraphShowRebaseDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, currentBranch: ctx.head && ctx.head.branch, upstream: branch.name, upstreamRefType: 'branch', upstreamLabel: branch.name, defaults: ctx.dialogDefaults && ctx.dialogDefaults.rebase }) },
    );
  }
  items.push({ id: 'push', label: 'Push Branch…', icon: gitGraphMenuIcon('push'), onClick: () => gitGraphShowPushBranchDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, name: branch.name, remotes: ctx.remotes, defaultRemote: ctx.defaultRemoteName, defaults: ctx.dialogDefaults && ctx.dialogDefaults.pushBranch }) });

  const issueUrl = gitGraphBuildIssueUrl(ctx.issueLinking, branch.name);
  const prUrl = gitGraphResolvePullRequestUrl(ctx, branch.name);
  const hasConditionalBlock = !!issueUrl || !!prUrl || true; // Create Archive + Select/Unselect always shown
  if (hasConditionalBlock) items.push({ sep: true });
  if (issueUrl) items.push({ id: 'viewIssue', label: 'View Issue', onClick: () => gitGraphOpenExternal(issueUrl) });
  if (prUrl) items.push({ id: 'createPullRequest', label: 'Create Pull Request…', onClick: () => gitGraphOpenExternal(prUrl) });
  items.push({ id: 'createArchive', label: 'Create Archive', icon: gitGraphMenuIcon('archive'), onClick: () => gitGraphRunCreateArchive(ctx, { ref: branch.name, refType: 'branch', suggestedName: branch.name }) });
  if (!selected) items.push({ id: 'select', label: 'Select in Branches Dropdown', onClick: () => ctx.onSelectBranch && ctx.onSelectBranch(key) });
  else items.push({ id: 'unselect', label: 'Unselect in Branches Dropdown', onClick: () => ctx.onUnselectBranch && ctx.onUnselectBranch(key) });
  items.push({ sep: true }, { id: 'copyName', label: 'Copy Branch Name to Clipboard', onClick: () => gitGraphCopyText(branch.name) });
  return gitGraphApplyMenuVisibility(items, ctx, 'branch');
}

// --- Remote branch label ---

function gitGraphBuildRemoteBranchMenu(ctx) {
  const rb = ctx.remoteBranch || {};
  const key = `${rb.remote}/${rb.name}`;
  const selected = gitGraphIsBranchSelected(ctx.selectedBranchKeys, key);
  const localMatch = (ctx.localBranches || []).find(b => b.name === rb.name);
  const fetchVisible = !!localMatch && !(ctx.head && ctx.head.branch === localMatch.name);
  const items = [
    { id: 'checkout', label: 'Checkout Branch…', onClick: () => gitGraphShowCheckoutRemoteBranchDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, remote: rb.remote, shortName: rb.name }) },
    { id: 'delete', label: 'Delete Remote Branch…', danger: true, onClick: () => gitGraphShowDeleteRemoteBranchDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, remote: rb.remote, shortName: rb.name }) },
  ];
  if (fetchVisible) items.push({ id: 'fetchIntoLocalBranch', label: 'Fetch into local branch…', onClick: () => gitGraphShowFetchIntoLocalBranchDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, remote: rb.remote, shortName: rb.name, localName: rb.name, defaults: ctx.dialogDefaults && ctx.dialogDefaults.fetchIntoLocalBranch }) });
  items.push(
    { sep: true },
    { id: 'merge', label: 'Merge into current branch…', icon: gitGraphMenuIcon('merge'), onClick: () => gitGraphShowMergeDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, currentBranch: ctx.head && ctx.head.branch, ref: rb.name, refType: 'remote-branch', remote: rb.remote, refLabel: key, defaults: ctx.dialogDefaults && ctx.dialogDefaults.merge }) },
    { id: 'pull', label: 'Pull into current branch…', onClick: () => gitGraphShowPullBranchDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, remote: rb.remote, shortName: rb.name, currentBranch: ctx.head && ctx.head.branch, defaults: ctx.dialogDefaults && ctx.dialogDefaults.pullBranch }) },
  );

  const issueUrl = gitGraphBuildIssueUrl(ctx.issueLinking, rb.name);
  const prUrl = gitGraphResolvePullRequestUrl(ctx, rb.name, rb.remote);
  items.push({ sep: true });
  if (issueUrl) items.push({ id: 'viewIssue', label: 'View Issue', onClick: () => gitGraphOpenExternal(issueUrl) });
  if (prUrl) items.push({ id: 'createPullRequest', label: 'Create Pull Request', onClick: () => gitGraphOpenExternal(prUrl) });
  items.push({ id: 'createArchive', label: 'Create Archive', icon: gitGraphMenuIcon('archive'), onClick: () => gitGraphRunCreateArchive(ctx, { ref: rb.name, refType: 'remote-branch', remote: rb.remote, suggestedName: `${rb.remote}-${rb.name}` }) });
  if (!selected) items.push({ id: 'select', label: 'Select in Branches Dropdown', onClick: () => ctx.onSelectBranch && ctx.onSelectBranch(key) });
  else items.push({ id: 'unselect', label: 'Unselect in Branches Dropdown', onClick: () => ctx.onUnselectBranch && ctx.onUnselectBranch(key) });
  items.push({ sep: true }, { id: 'copyName', label: 'Copy Branch Name to Clipboard', onClick: () => gitGraphCopyText(rb.name) });
  return gitGraphApplyMenuVisibility(items, ctx, 'remoteBranch');
}

// --- Tag label ---

/**
 * `ctx.tag` (built off a ref pill's per-commit data) only ever carries
 * {name, hash, annotated} — the tagger/date/message/objectHash fields the
 * View Details dialog displays live server-side (getGitGraphTagDetails)
 * and are fetched here, once, right before opening the dialog, rather
 * than requiring every menu-ctx builder to pre-fetch them for every tag pill
 * rendered. Falls back to the thin tag object when window.api isn't present
 * (matches every other dialog-open path's degrade-gracefully convention).
 */
async function gitGraphOpenTagDetails(ctx, tag) {
  let full = tag;
  if (typeof window !== 'undefined' && window.api && typeof window.api.getGitGraphTagDetails === 'function') {
    try {
      const result = await window.api.getGitGraphTagDetails(ctx.projectId, ctx.folderPath, tag.name);
      if (result && result.ok && result.tag) full = Object.assign({}, tag, result.tag);
    } catch { /* fall back to the thin tag object below */ }
  }
  return gitGraphShowTagDetailsDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, tag: full });
}

function gitGraphBuildTagMenu(ctx) {
  const tag = ctx.tag || {};
  const items = [];
  if (tag.annotated) items.push({ id: 'viewDetails', label: 'View Details', onClick: () => gitGraphOpenTagDetails(ctx, tag) });
  items.push(
    { id: 'delete', label: 'Delete Tag…', danger: true, onClick: () => gitGraphShowDeleteTagDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, name: tag.name, remoteMatches: ctx.remotes }) },
    { id: 'push', label: 'Push Tag…', icon: gitGraphMenuIcon('push'), onClick: () => gitGraphShowPushTagDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, name: tag.name, remotes: ctx.remotes, defaultRemote: ctx.defaultRemoteName }) },
    { id: 'createArchive', label: 'Create Archive', icon: gitGraphMenuIcon('archive'), onClick: () => gitGraphRunCreateArchive(ctx, { ref: tag.name, refType: 'tag', suggestedName: tag.name }) },
    { sep: true },
    { id: 'copyName', label: 'Copy Tag Name to Clipboard', onClick: () => gitGraphCopyText(tag.name) },
  );
  return gitGraphApplyMenuVisibility(items, ctx, 'tag');
}

// --- Stash row ---

function gitGraphBuildStashMenu(ctx) {
  const stash = ctx.stash || {};
  const stashRef = stash.ref || `stash@{${stash.index}}`;
  const items = [
    { id: 'apply', label: 'Apply Stash…', onClick: () => gitGraphShowApplyStashDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, stashRef, stashLabel: stash.message, defaults: ctx.dialogDefaults && ctx.dialogDefaults.applyStash }) },
    { id: 'createBranch', label: 'Create Branch from Stash…', icon: gitGraphMenuIcon('branch'), onClick: () => gitGraphShowStashCreateBranchDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, stashRef }) },
    { id: 'pop', label: 'Pop Stash…', onClick: () => gitGraphShowPopStashDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, stashRef, stashLabel: stash.message, defaults: ctx.dialogDefaults && ctx.dialogDefaults.popStash }) },
    { id: 'drop', label: 'Drop Stash…', danger: true, onClick: () => gitGraphShowDropStashDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, stashRef, stashLabel: stash.message }) },
    { sep: true },
    { id: 'copyName', label: 'Copy Stash Name to Clipboard', onClick: () => gitGraphCopyText(stash.message) },
    { id: 'copyHash', label: 'Copy Stash Hash to Clipboard', onClick: () => gitGraphCopyText(stash.hash) },
  ];
  return gitGraphApplyMenuVisibility(items, ctx, 'stash');
}

// --- Commit-details file row ---

function gitGraphBuildFileMenu(ctx) {
  const file = ctx.file || {};
  const items = [
    { id: 'viewDiff', label: 'View Diff', onClick: () => ctx.onViewDiff && ctx.onViewDiff(file) },
    { id: 'viewFileAtRevision', label: 'View File at this Revision', onClick: () => ctx.onViewFileAtRevision && ctx.onViewFileAtRevision(file) },
  ];
  if (!file.isWorkingTreeSide) items.push({ id: 'viewDiffWithWorkingFile', label: 'View Diff with Working File', onClick: () => ctx.onViewDiffWithWorkingFile && ctx.onViewDiffWithWorkingFile(file) });
  if (file.existsOnDisk) items.push({ id: 'openFile', label: 'Open File', onClick: () => ctx.onOpenFile && ctx.onOpenFile(file) });
  items.push({ sep: true });
  const reviewed = !!(ctx.codeReview && ctx.codeReview.reviewedPaths && ctx.codeReview.reviewedPaths.has(file.path));
  if (ctx.codeReview && !reviewed) items.push({ id: 'markAsReviewed', label: 'Mark as Reviewed', onClick: () => ctx.onMarkFileReviewed && ctx.onMarkFileReviewed(file.path, true) });
  if (ctx.codeReview && reviewed) items.push({ id: 'markAsReviewed', label: 'Mark as Not Reviewed', onClick: () => ctx.onMarkFileReviewed && ctx.onMarkFileReviewed(file.path, false) });
  items.push({ sep: true });
  if (file.isHistoricalSingleCommit) items.push({ id: 'resetFileToRevision', label: 'Reset File to this Revision…', danger: true, onClick: () => gitGraphShowResetFileToRevisionDialog({ projectId: ctx.projectId, folderPath: ctx.folderPath, refresh: ctx.refresh, commitHash: file.revisionHash, commitShortHash: file.revisionShortHash, relativePath: file.relativePath || file.path }) });
  items.push(
    { sep: true },
    { id: 'copyAbsolutePath', label: 'Copy Absolute File Path to Clipboard', onClick: () => gitGraphCopyText(file.absolutePath) },
    { id: 'copyRelativePath', label: 'Copy Relative File Path to Clipboard', onClick: () => gitGraphCopyText(file.relativePath || file.path) },
  );
  return gitGraphApplyMenuVisibility(items, ctx, 'commitDetailsViewFile');
}

// --- Table column header row ---

function gitGraphBuildColumnHeaderMenu(ctx) {
  const header = ctx.columnHeader || {};
  const visibility = header.columnVisibility || {};
  const order = header.commitsOrder || 'date';
  const checkIcon = (on) => (on ? gitGraphMenuIcon('check', 12) : '');
  // `checked` is an explicit, icon-independent signal (the icon is only the
  // visual rendering of it) so a toggle/radio's active state is testable
  // without depending on a PICONS.check glyph actually being registered yet.
  const toggle = (col, label) => ({ label, icon: checkIcon(!!visibility[col]), checked: !!visibility[col], onClick: () => ctx.onColumnVisibilityChange && ctx.onColumnVisibilityChange(col, !visibility[col]) });
  const radio = (value, label) => ({ label, icon: checkIcon(order === value), checked: order === value, onClick: () => ctx.onCommitsOrderChange && ctx.onCommitsOrderChange(value) });
  return [
    toggle('date', 'Date'),
    toggle('author', 'Author'),
    toggle('commit', 'Commit'),
    { sep: true },
    radio('date', 'Order: Date'),
    radio('author-date', 'Order: Author Date'),
    radio('topo', 'Order: Topological'),
  ];
}

// --- Link element ---

function gitGraphBuildLinkMenu(ctx) {
  const link = ctx.link || {};
  return [{ label: 'Copy Link to Clipboard', onClick: () => gitGraphCopyText(link.url) }];
}

/**
 * Applies GlobalPrefs.contextMenuActionsVisibility (set via the Advanced
 * Settings JSON editor) to a built item list: an item carrying `id: '<key>'`
 * is dropped when ctx.contextMenuActionsVisibility[category][key] is
 * explicitly false. Also collapses any separator left doubled, leading, or
 * trailing by a removed item, so hiding one action never leaves a visibly
 * broken menu.
 */
function gitGraphApplyMenuVisibility(items, ctx, category) {
  const visibility = (ctx.contextMenuActionsVisibility && ctx.contextMenuActionsVisibility[category]) || {};
  const kept = items.filter(item => !(item.id && visibility[item.id] === false));
  const collapsed = [];
  for (const item of kept) {
    if (item.sep && (!collapsed.length || collapsed[collapsed.length - 1].sep)) continue;
    collapsed.push(item);
  }
  while (collapsed.length && collapsed[collapsed.length - 1].sep) collapsed.pop();
  return collapsed;
}

function gitGraphMenuIcon(name, size) {
  if (typeof PICONS !== 'undefined' && typeof PICONS[name] === 'function') return PICONS[name](size || 12);
  return '';
}

// --- Dispatch: reads the B.3.2 data-gg-* attributes off the clicked element
// (or the nearest ancestor carrying them) and picks the right builder. The
// combined local+remote pill's dual hit-region routing lives here:
// a click on the region carrying data-gg-kind="remote-branch", or on a
// data-gg-kind="branch" region whose own data-gg-ref-type is "remote", both
// route to the remote-branch menu; every other "branch" region routes local. ---

function gitGraphClosestAttr(el, attr) {
  let node = el;
  while (node && typeof node.getAttribute === 'function') {
    const value = node.getAttribute(attr);
    if (value != null) return value;
    node = node.parentElement;
  }
  return null;
}

function gitGraphReadTargetAttrs(el) {
  return {
    kind: gitGraphClosestAttr(el, 'data-gg-kind'),
    hash: gitGraphClosestAttr(el, 'data-gg-hash'),
    refName: gitGraphClosestAttr(el, 'data-gg-ref-name'),
    remote: gitGraphClosestAttr(el, 'data-gg-remote'),
    refType: gitGraphClosestAttr(el, 'data-gg-ref-type'),
    filePath: gitGraphClosestAttr(el, 'data-gg-file-path'),
  };
}

/** Pure: returns the item array for whichever target `el` identifies, or null for an unknown kind. */
function gitGraphBuildMenuItems(el, ctx) {
  const target = gitGraphReadTargetAttrs(el);
  switch (target.kind) {
    case 'commit': return gitGraphBuildCommitMenu(ctx);
    case 'uncommitted': return gitGraphBuildUncommittedMenu(ctx);
    case 'branch': return target.refType === 'remote' ? gitGraphBuildRemoteBranchMenu(ctx) : gitGraphBuildLocalBranchMenu(ctx);
    case 'remote-branch': return gitGraphBuildRemoteBranchMenu(ctx);
    case 'tag': return gitGraphBuildTagMenu(ctx);
    case 'stash': return gitGraphBuildStashMenu(ctx);
    case 'file': return gitGraphBuildFileMenu(ctx);
    case 'column-header': return gitGraphBuildColumnHeaderMenu(ctx);
    case 'link': return gitGraphBuildLinkMenu(ctx);
    default: return null;
  }
}

/** Builds the right menu for `el` and opens it via the shared showContextMenu (projects-view.js). */
function gitGraphShowContextMenu(el, ctx, position) {
  const items = gitGraphBuildMenuItems(el, ctx);
  if (items && typeof showContextMenu === 'function') showContextMenu(items, position);
  return items;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    gitGraphCopyText, gitGraphOpenExternal, gitGraphRunImmediateAction, gitGraphRunCreateArchive, gitGraphSuggestNextTagName, gitGraphIsBranchSelected,
    gitGraphIsHeadCommit, gitGraphIsCurrentBranchTip, gitGraphCommitDropVisible,
    gitGraphBuildIssueUrl, gitGraphParseRemoteUrl, gitGraphBuildPullRequestUrl, gitGraphResolvePullRequestUrl,
    gitGraphBuildCommitMenu, gitGraphBuildUncommittedMenu, gitGraphBuildLocalBranchMenu,
    gitGraphBuildRemoteBranchMenu, gitGraphBuildTagMenu, gitGraphBuildStashMenu, gitGraphBuildFileMenu,
    gitGraphBuildColumnHeaderMenu, gitGraphBuildLinkMenu, gitGraphApplyMenuVisibility,
    gitGraphClosestAttr, gitGraphReadTargetAttrs, gitGraphBuildMenuItems, gitGraphShowContextMenu,
  };
}

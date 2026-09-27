// Dialogs for the Git Graph tab — one gitGraphShow*Dialog per context-menu
// action that needs a field or a confirmation before running, plus one extra
// (Reset File to this Revision…) that the commit-details file menu needs.
//
// Every gitGraphShow*Dialog(params) function returns a Promise that resolves
// to the action's result object on success, or null if the user cancelled
// (Escape or the Cancel button). Each one, on its primary action, calls
// window.api.runGitGraphAction(projectId, folderPath, actionId, params) with
// exactly the whitelisted action's id and params, surfaces git's own stderr inline on
// failure (never a raw alert popup — the dialog stays open so the user can
// fix a field and retry), and calls the view-supplied `refresh` callback
// after a successful mutation. Built on the existing bespoke-dialog DOM/
// Escape/Cancel convention (dialogs.js:5-6): a click on the backdrop does
// nothing, Escape and Cancel are the only ways out besides the primary button.
//
// `params` shared across every dialog:
//   projectId, folderPath   — repo identity
//   refresh: () => void      — called once after a successful mutating call
//   defaults: {...}          — this dialog's slice of GlobalPrefs.dialogDefaults;
//                              falls back to GIT_GRAPH_DIALOG_DEFAULTS below when omitted
//   spaceSubstitution: 'none'|'hyphen'|'underscore'   — GlobalPrefs.dialogDefaults
//                              .referenceInputSpaceSubstitution; falls back to 'none'
// Every dialog with its own target/fields documents those in a short comment
// above the function.

// --- Documented defaults (used whenever `params.defaults` omits a field) ---

const GIT_GRAPH_DIALOG_DEFAULTS = {
  referenceInputSpaceSubstitution: 'none',
  addTag: { type: 'annotated', pushToRemote: false },
  createBranch: { checkOut: false },
  cherryPick: { noCommit: false, recordOrigin: false },
  merge: { noFastForward: true, noCommit: false, squashCommits: false, squashMessageFormat: 'default' },
  pullBranch: { noFastForward: false, squashCommits: false, squashMessageFormat: 'default' },
  rebase: { ignoreDate: true, launchInteractiveRebase: false },
  resetCurrentBranchToCommit: { mode: 'mixed' },
  resetUncommittedChanges: { mode: 'mixed' },
  stashUncommittedChanges: { includeUntracked: true },
  applyStash: { reinstateIndex: false },
  popStash: { reinstateIndex: false },
  deleteBranch: { forceDelete: false },
  fetchIntoLocalBranch: { forceFetch: false },
  fetchRemote: { prune: false, pruneTags: false },
  cleanUntracked: { removeDirectories: false },
  pushBranch: { setUpstream: true, force: 'none' },
};

function gitGraphDefaultsFor(key, overrides) {
  return { ...(GIT_GRAPH_DIALOG_DEFAULTS[key] || {}), ...(overrides || {}) };
}

// Checkout Commit's "Always Accept" is deliberately session-only: a
// plain in-memory Map, never persisted, cleared by an app restart like any
// other module-level state.
const gitGraphCheckoutAlwaysAccept = new Map();
function gitGraphCheckoutAlwaysAcceptKey(params) { return `${params.projectId}\u0000${params.folderPath}`; }

// --- Reference-name helpers ---

function gitGraphSubstituteSpaces(text, mode) {
  if (mode === 'hyphen') return text.replace(/ /g, '-');
  if (mode === 'underscore') return text.replace(/ /g, '_');
  return text;
}

/**
 * Best-effort client-side subset of `git check-ref-format --branch` semantics,
 * for fast feedback only — authoritative validation happens server-side in
 * git-actions.js; this never needs to be exhaustive.
 */
function gitGraphValidateRefName(name) {
  if (!name) return 'Name is required.';
  if (/[\x00-\x1f\x7f]/.test(name)) return 'Name cannot contain control characters.';
  if (name.includes('..')) return 'Name cannot contain "..".';
  if (name.includes('//')) return 'Name cannot contain "//".';
  if (/[ ~^:?*[\\]/.test(name)) return 'Name cannot contain a space or any of ~ ^ : ? * [ \\';
  if (name.startsWith('/') || name.endsWith('/')) return 'Name cannot start or end with "/".';
  if (name.startsWith('-')) return 'Name cannot start with "-".';
  if (name.endsWith('.') || name.endsWith('.lock')) return 'Name cannot end with "." or ".lock".';
  if (name === '@') return 'Name cannot be "@".';
  if (name.includes('@{')) return 'Name cannot contain "@{".';
  return null;
}

/**
 * Best-effort client-side subset of git-actions.js's REMOTE_NAME_RE — fast
 * feedback only, same non-authoritative role as gitGraphValidateRefName
 * above; the server re-validates every remote name it's given regardless.
 */
function gitGraphValidateRemoteName(name) {
  if (!name) return 'Name is required.';
  if (name.startsWith('-')) return 'Name cannot start with "-".';
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return 'Name can only contain letters, digits, "." "_" and "-".';
  return null;
}

function gitGraphConfirmDestructive(message) {
  return typeof confirm === 'function' ? confirm(message) : true;
}

// --- Action-call helpers ---

async function gitGraphRunDialogAction(params, actionId, actionParams) {
  if (!(typeof window !== 'undefined' && window.api && window.api.runGitGraphAction)) return { error: 'This build cannot run Git Graph actions yet.' };
  const result = await window.api.runGitGraphAction(params.projectId, params.folderPath, actionId, actionParams);
  if (!result) return { error: 'No response from the action.' };
  if (!result.error && typeof params.refresh === 'function') params.refresh();
  return result;
}

/** Runs the same actionId once per entry in `actionParamsList` (e.g. push to several remotes). */
async function gitGraphRunDialogActionMulti(params, actionId, actionParamsList) {
  const errors = [];
  let anyOk = false;
  for (const actionParams of actionParamsList) {
    const result = (typeof window !== 'undefined' && window.api && window.api.runGitGraphAction)
      ? await window.api.runGitGraphAction(params.projectId, params.folderPath, actionId, actionParams)
      : { error: 'This build cannot run Git Graph actions yet.' };
    if (result && result.error) errors.push(result.error);
    else anyOk = true;
  }
  if (anyOk && typeof params.refresh === 'function') params.refresh();
  if (errors.length) return { error: errors.join('\n'), ok: anyOk };
  return { ok: true };
}

// --- Field markup helpers ---

function gitGraphFieldText(id, label, value = '', placeholder = '') {
  return `<div class="gg-field"><label class="gg-field-label" for="${id}">${escapeHtml(label)}</label><input type="text" id="${id}" class="gg-field-input" value="${escapeAttr(value)}" placeholder="${escapeAttr(placeholder)}" autocomplete="off" spellcheck="false"></div>`;
}

function gitGraphFieldTextarea(id, label, value = '', placeholder = '') {
  return `<div class="gg-field"><label class="gg-field-label" for="${id}">${escapeHtml(label)}</label><textarea id="${id}" class="gg-field-input" placeholder="${escapeAttr(placeholder)}">${escapeHtml(value)}</textarea></div>`;
}

function gitGraphFieldCheckbox(id, label, checked, hint) {
  return `<div class="gg-field gg-field-checkbox"><label><input type="checkbox" id="${id}"${checked ? ' checked' : ''}> ${escapeHtml(label)}</label>${hint ? `<div class="gg-field-hint">${escapeHtml(hint)}</div>` : ''}</div>`;
}

function gitGraphFieldSelect(id, label, options, selected) {
  const opts = (options || []).map(o => `<option value="${escapeAttr(o.value)}"${o.value === selected ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
  return `<div class="gg-field"><label class="gg-field-label" for="${id}">${escapeHtml(label)}</label><select id="${id}" class="gg-field-input">${opts}</select></div>`;
}

function gitGraphFieldRemoteList(idPrefix, remotes, selectedNames) {
  const selected = new Set(selectedNames || []);
  return `<div class="gg-remote-list">${(remotes || []).map(r => `<label class="gg-remote-row"><input type="checkbox" class="${idPrefix}-remote" value="${escapeAttr(r.name)}"${selected.has(r.name) ? ' checked' : ''}> ${escapeHtml(r.name)}</label>`).join('')}</div>`;
}

// --- Dialog scaffold (bespoke-dialog convention, dialogs.js:5-6) ---

/**
 * One shared Enter/Escape/IME-composition handler backs every dialog
 * here — a composing Enter (isComposing, or the legacy keyCode 229 signal)
 * never submits, so confirming a CJK IME candidate can't spuriously trigger
 * the primary action; a plain Enter inside a <textarea> inserts a newline
 * instead of submitting unless Ctrl/Cmd is held.
 */
function gitGraphOpenDialog({ title, bodyHtml, primaryLabel = 'OK', cancelLabel = 'Cancel', primaryDanger = false, singleButton = false, onSubmit, onCancel, focusSelector }) {
  const overlay = document.createElement('div');
  overlay.className = 'add-project-overlay gg-dialog-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'add-project-dialog gg-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.innerHTML = `
    <h3>${escapeHtml(title)}</h3>
    <div class="gg-dialog-body">${bodyHtml}</div>
    <div class="gg-dialog-error" role="alert" hidden></div>
    <div class="add-project-actions">
      ${singleButton ? '' : `<button type="button" class="add-project-cancel-btn gg-dialog-cancel">${escapeHtml(cancelLabel)}</button>`}
      <button type="button" class="add-project-add-btn gg-dialog-primary${primaryDanger ? ' gg-dialog-primary-danger' : ''}">${escapeHtml(primaryLabel)}</button>
    </div>`;
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
  }
  function cancel() { close(); if (onCancel) onCancel(); }
  function submit() { if (onSubmit) onSubmit(); }

  function onKey(e) {
    if (closed) return;
    if (e.key === 'Escape') { e.stopPropagation(); cancel(); return; }
    if (e.key === 'Enter') {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.target && e.target.tagName === 'TEXTAREA' && !(e.metaKey || e.ctrlKey)) return;
      if (e.preventDefault) e.preventDefault();
      submit();
    }
  }
  document.addEventListener('keydown', onKey, true);

  const cancelBtn = dialog.querySelector('.gg-dialog-cancel');
  if (cancelBtn) cancelBtn.onclick = cancel;
  dialog.querySelector('.gg-dialog-primary').onclick = submit;

  const toFocus = dialog.querySelector(focusSelector || 'input,select,textarea');
  if (toFocus) { toFocus.focus(); if (toFocus.select) toFocus.select(); }

  function showError(message) {
    const err = dialog.querySelector('.gg-dialog-error');
    err.textContent = message;
    err.hidden = false;
  }

  return { overlay, dialog, close, cancel, showError };
}

// --- 5.1 Add Tag… (commit) ---

function gitGraphShowAddTagDialog(params) {
  const defaults = gitGraphDefaultsFor('addTag', params.defaults);
  const spaceMode = params.spaceSubstitution || GIT_GRAPH_DIALOG_DEFAULTS.referenceInputSpaceSubstitution;
  const remotes = params.remotes || [];
  return new Promise(resolve => {
    const bodyHtml = `
      ${gitGraphFieldText('gg-addtag-name', 'Name', params.suggestedName || '')}
      ${gitGraphFieldSelect('gg-addtag-type', 'Type', [{ value: 'annotated', label: 'Annotated' }, { value: 'lightweight', label: 'Lightweight' }], defaults.type)}
      ${gitGraphFieldTextarea('gg-addtag-message', 'Message', '', 'Optional')}
      ${gitGraphFieldCheckbox('gg-addtag-push', 'Push to remote', defaults.pushToRemote)}
      ${remotes.length > 1 ? `<div class="gg-addtag-remotes" hidden>${gitGraphFieldRemoteList('gg-addtag', remotes, remotes.map(r => r.name))}</div>` : ''}
    `;
    const { dialog, close, showError } = gitGraphOpenDialog({
      title: `Add tag to commit ${params.commitShortHash || ''}`, bodyHtml, primaryLabel: 'Add Tag',
      onCancel: () => resolve(null), onSubmit: () => submit(), focusSelector: '#gg-addtag-name',
    });
    const typeSelect = dialog.querySelector('#gg-addtag-type');
    const messageField = dialog.querySelector('#gg-addtag-message');
    const pushCheckbox = dialog.querySelector('#gg-addtag-push');
    const remotesBox = dialog.querySelector('.gg-addtag-remotes');
    function syncType() { messageField.disabled = typeSelect.value !== 'annotated'; }
    function syncPush() { if (remotesBox) remotesBox.hidden = !pushCheckbox.checked; }
    typeSelect.onchange = syncType; syncType();
    pushCheckbox.onchange = syncPush; syncPush();

    async function createTag(name) {
      return gitGraphRunDialogAction(params, 'addTag', { name, commit: params.commitHash, type: typeSelect.value, message: messageField.value });
    }
    async function submit() {
      const name = gitGraphSubstituteSpaces(dialog.querySelector('#gg-addtag-name').value.trim(), spaceMode);
      const invalid = gitGraphValidateRefName(name);
      if (invalid) { showError(invalid); return; }
      let result = await createTag(name);
      if (result.error) {
        if (/already exists/i.test(result.error) && gitGraphConfirmDestructive(`A tag named "${name}" already exists. Replace it?`)) {
          const del = await gitGraphRunDialogAction(params, 'deleteTag', { name, remotes: [] });
          if (del.error) { showError(del.error); return; }
          result = await createTag(name);
          if (result.error) { showError(result.error); return; }
        } else { showError(result.error); return; }
      }
      if (pushCheckbox.checked && remotes.length) {
        const selected = remotes.length > 1
          ? Array.from(dialog.querySelectorAll('.gg-addtag-remote:checked')).map(el => el.value)
          : [remotes[0].name];
        if (selected.length) {
          const pushResult = await gitGraphRunDialogActionMulti(params, 'pushTag', selected.map(remote => ({ tagName: name, remotes: [remote] })));
          if (pushResult.error) { showError(pushResult.error); return; }
        }
      }
      close(); resolve(result);
    }
  });
}

// --- 5.2 Create Branch… (from a commit) ---

function gitGraphShowCreateBranchDialog(params) {
  const defaults = gitGraphDefaultsFor('createBranch', params.defaults);
  const spaceMode = params.spaceSubstitution || GIT_GRAPH_DIALOG_DEFAULTS.referenceInputSpaceSubstitution;
  return new Promise(resolve => {
    const bodyHtml = `${gitGraphFieldText('gg-createbranch-name', 'Name', '')}${gitGraphFieldCheckbox('gg-createbranch-checkout', 'Check out', defaults.checkOut)}`;
    const { dialog, close, showError } = gitGraphOpenDialog({
      title: 'Create Branch', bodyHtml, primaryLabel: 'Create Branch',
      onCancel: () => resolve(null), onSubmit: () => submit(), focusSelector: '#gg-createbranch-name',
    });
    async function createBranch(name, checkOut) {
      return gitGraphRunDialogAction(params, 'createBranch', { name, commit: params.commitHash, checkOut });
    }
    async function submit() {
      const name = gitGraphSubstituteSpaces(dialog.querySelector('#gg-createbranch-name').value.trim(), spaceMode);
      const invalid = gitGraphValidateRefName(name);
      if (invalid) { showError(invalid); return; }
      const checkOut = dialog.querySelector('#gg-createbranch-checkout').checked;
      let result = await createBranch(name, checkOut);
      if (result.error) {
        if (/already exists/i.test(result.error) && gitGraphConfirmDestructive(`A branch named "${name}" already exists. Replace it?`)) {
          const del = await gitGraphRunDialogAction(params, 'deleteBranch', { name, forceDelete: true, remotes: [] });
          if (del.error) { showError(del.error); return; }
          result = await createBranch(name, checkOut);
          if (result.error) { showError(result.error); return; }
        } else { showError(result.error); return; }
      }
      close(); resolve(result);
    }
  });
}

// --- 5.3 Checkout… (commit) — detached-HEAD warning + session "Always Accept" ---

function gitGraphShowCheckoutCommitDialog(params) {
  const key = gitGraphCheckoutAlwaysAcceptKey(params);
  if (gitGraphCheckoutAlwaysAccept.get(key)) return gitGraphRunDialogAction(params, 'checkoutCommit', { commit: params.commitHash });
  return new Promise(resolve => {
    const bodyHtml = `
      <p class="gg-dialog-warning">Checking out a specific commit leaves the repository in a detached HEAD state.</p>
      ${gitGraphFieldCheckbox('gg-checkoutcommit-always', 'Always Accept (skip this confirmation for the rest of the session)', false)}
    `;
    const { dialog, close, showError } = gitGraphOpenDialog({
      title: `Checkout Commit ${params.commitShortHash || ''}`, bodyHtml, primaryLabel: 'Checkout Commit',
      onCancel: () => resolve(null), onSubmit: () => submit(),
    });
    async function submit() {
      const alwaysAccept = dialog.querySelector('#gg-checkoutcommit-always').checked;
      const result = await gitGraphRunDialogAction(params, 'checkoutCommit', { commit: params.commitHash });
      if (result.error) { showError(result.error); return; }
      if (alwaysAccept) gitGraphCheckoutAlwaysAccept.set(key, true);
      close(); resolve(result);
    }
  });
}

// --- 5.4 Cherry Pick… (commit) ---

function gitGraphShowCherryPickDialog(params) {
  const defaults = gitGraphDefaultsFor('cherryPick', params.defaults);
  const parents = params.parents || [];
  const isMerge = parents.length >= 2;
  return new Promise(resolve => {
    const bodyHtml = `
      ${isMerge ? gitGraphFieldSelect('gg-cherrypick-parent', 'Parent', parents.map((p, i) => ({ value: String(i + 1), label: `${i + 1}. ${(p || '').slice(0, 8)}` })), '1') : ''}
      ${gitGraphFieldCheckbox('gg-cherrypick-nocommit', 'No Commit', defaults.noCommit)}
      ${gitGraphFieldCheckbox('gg-cherrypick-recordorigin', 'Record Origin', defaults.recordOrigin)}
    `;
    const { dialog, close, showError } = gitGraphOpenDialog({
      title: `Cherry Pick Commit ${params.commitShortHash || ''}`, bodyHtml, primaryLabel: 'Cherry Pick',
      onCancel: () => resolve(null), onSubmit: () => submit(),
    });
    async function submit() {
      const parent = isMerge ? Number(dialog.querySelector('#gg-cherrypick-parent').value) : undefined;
      const noCommit = dialog.querySelector('#gg-cherrypick-nocommit').checked;
      const recordOrigin = dialog.querySelector('#gg-cherrypick-recordorigin').checked;
      const result = await gitGraphRunDialogAction(params, 'cherryPick', { commit: params.commitHash, noCommit, recordOrigin, parent });
      if (result.error) { showError(result.error); return; }
      close(); resolve(result);
    }
  });
}

// --- 5.5 Revert… (commit) ---

function gitGraphShowRevertDialog(params) {
  const parents = params.parents || [];
  const isMerge = parents.length >= 2;
  return new Promise(resolve => {
    const bodyHtml = isMerge
      ? gitGraphFieldSelect('gg-revert-parent', 'Parent', parents.map((p, i) => ({ value: String(i + 1), label: `${i + 1}. ${(p || '').slice(0, 8)}` })), '1')
      : '<p class="gg-dialog-hint">Reverts this commit on top of the current branch.</p>';
    const { dialog, close, showError } = gitGraphOpenDialog({
      title: `Revert Commit ${params.commitShortHash || ''}`, bodyHtml, primaryLabel: 'Revert',
      onCancel: () => resolve(null), onSubmit: () => submit(),
    });
    async function submit() {
      const parent = isMerge ? Number(dialog.querySelector('#gg-revert-parent').value) : undefined;
      const result = await gitGraphRunDialogAction(params, 'revert', { commit: params.commitHash, parent });
      if (result.error) { showError(result.error); return; }
      close(); resolve(result);
    }
  });
}

// --- 5.6 Drop… (commit) ---

function gitGraphShowDropCommitDialog(params) {
  return new Promise(resolve => {
    const bodyHtml = `<p class="gg-dialog-warning">Are you sure you want to drop commit ${params.commitShortHash || ''}? This cannot be undone.</p>`;
    const { close, showError } = gitGraphOpenDialog({
      title: 'Drop Commit', bodyHtml, primaryLabel: 'Drop', primaryDanger: true,
      onCancel: () => resolve(null), onSubmit: () => submit(),
    });
    async function submit() {
      const result = await gitGraphRunDialogAction(params, 'dropCommit', { commit: params.commitHash });
      if (result.error) { showError(result.error); return; }
      close(); resolve(result);
    }
  });
}

// --- 5.7 Merge into current branch… (commit / local branch / remote branch) ---

function gitGraphShowMergeDialog(params) {
  const defaults = gitGraphDefaultsFor('merge', params.defaults);
  return new Promise(resolve => {
    const bodyHtml = `
      ${gitGraphFieldCheckbox('gg-merge-noff', 'Create a new commit even if fast-forward is possible', defaults.noFastForward)}
      ${gitGraphFieldCheckbox('gg-merge-squash', 'Squash Commits', defaults.squashCommits)}
      ${gitGraphFieldCheckbox('gg-merge-nocommit', 'No Commit', defaults.noCommit)}
      <div class="gg-merge-squashformat" hidden>${gitGraphFieldSelect('gg-merge-squashformat', 'Squash Message Format', [{ value: 'default', label: 'Default' }, { value: 'git-squash-msg', label: 'Git SQUASH_MSG' }], defaults.squashMessageFormat)}</div>
    `;
    const { dialog, close, showError } = gitGraphOpenDialog({
      title: `Merge into current branch${params.currentBranch ? ` ${params.currentBranch}` : ''}`,
      bodyHtml, primaryLabel: 'Merge', onCancel: () => resolve(null), onSubmit: () => submit(),
    });
    const squashCheckbox = dialog.querySelector('#gg-merge-squash');
    const squashFormatBox = dialog.querySelector('.gg-merge-squashformat');
    function syncSquash() { squashFormatBox.hidden = !squashCheckbox.checked; }
    squashCheckbox.onchange = syncSquash; syncSquash();
    async function submit() {
      const noFastForward = dialog.querySelector('#gg-merge-noff').checked;
      const squash = squashCheckbox.checked;
      const noCommit = dialog.querySelector('#gg-merge-nocommit').checked;
      const squashMessageFormat = dialog.querySelector('#gg-merge-squashformat').value;
      const result = await gitGraphRunDialogAction(params, 'merge', { ref: params.ref, refType: params.refType, remote: params.remote, noFastForward, squash, noCommit, squashMessageFormat });
      if (result.error) { showError(result.error); return; }
      close(); resolve(result);
    }
  });
}

// --- 5.8 Rebase current branch on Branch… / …on this Commit… ---

function gitGraphShowRebaseDialog(params) {
  const defaults = gitGraphDefaultsFor('rebase', params.defaults);
  return new Promise(resolve => {
    const bodyHtml = `
      ${gitGraphFieldCheckbox('gg-rebase-ignoredate', 'Ignore Date (non-interactive rebase only)', defaults.ignoreDate)}
      ${gitGraphFieldCheckbox('gg-rebase-interactive', 'Launch Interactive Rebase in new Terminal', defaults.launchInteractiveRebase)}
    `;
    const { dialog, close, showError } = gitGraphOpenDialog({
      title: `Rebase current branch${params.currentBranch ? ` ${params.currentBranch}` : ''} on ${params.upstreamLabel || params.upstream || ''}`,
      bodyHtml, primaryLabel: 'Rebase', onCancel: () => resolve(null), onSubmit: () => submit(),
    });
    async function submit() {
      const interactive = dialog.querySelector('#gg-rebase-interactive').checked;
      if (interactive) {
        // rebaseInteractive: no renderer-built ref/command string is ever typed
        // into a shell or PTY — main opens a bare terminal and shows the exact
        // `git rebase -i <upstream>` text read-only, with a Copy Command button.
        const result = await gitGraphRunDialogAction(params, 'rebaseInteractive', { upstream: params.upstream, refType: params.upstreamRefType, remote: params.remote });
        if (result.error) { showError(result.error); return; }
        close();
        if (typeof params.onInteractiveRebase === 'function') params.onInteractiveRebase(result);
        resolve(result);
        return;
      }
      const ignoreDate = dialog.querySelector('#gg-rebase-ignoredate').checked;
      const result = await gitGraphRunDialogAction(params, 'rebase', { upstream: params.upstream, refType: params.upstreamRefType, remote: params.remote, ignoreDate });
      if (result.error) { showError(result.error); return; }
      close(); resolve(result);
    }
  });
}

// --- 5.9 Reset current branch to this Commit… ---

function gitGraphShowResetToCommitDialog(params) {
  const defaults = gitGraphDefaultsFor('resetCurrentBranchToCommit', params.defaults);
  return new Promise(resolve => {
    const bodyHtml = gitGraphFieldSelect('gg-resettocommit-mode', 'Mode', [
      { value: 'soft', label: 'Soft - Keep all changes, but reset head' },
      { value: 'mixed', label: 'Mixed - Keep working tree, but reset index' },
      { value: 'hard', label: 'Hard - Discard all changes' },
    ], defaults.mode);
    const { dialog, close, showError } = gitGraphOpenDialog({
      title: `Reset current branch${params.currentBranch ? ` ${params.currentBranch}` : ''} to this commit`,
      bodyHtml, primaryLabel: 'Reset', onCancel: () => resolve(null), onSubmit: () => submit(),
    });
    async function submit() {
      const mode = dialog.querySelector('#gg-resettocommit-mode').value;
      if (mode === 'hard' && !gitGraphConfirmDestructive('This discards all uncommitted and committed changes since this point. Continue?')) return;
      const result = await gitGraphRunDialogAction(params, 'resetToCommit', { commit: params.commitHash, mode });
      if (result.error) { showError(result.error); return; }
      close(); resolve(result);
    }
  });
}

// --- 5.10 Stash uncommitted changes… ---

function gitGraphShowStashPushDialog(params) {
  const defaults = gitGraphDefaultsFor('stashUncommittedChanges', params.defaults);
  return new Promise(resolve => {
    const bodyHtml = `${gitGraphFieldText('gg-stashpush-message', 'Message', '', 'Optional')}${gitGraphFieldCheckbox('gg-stashpush-untracked', 'Include Untracked', defaults.includeUntracked)}`;
    const { dialog, close, showError } = gitGraphOpenDialog({
      title: 'Stash uncommitted changes', bodyHtml, primaryLabel: 'Stash Changes',
      onCancel: () => resolve(null), onSubmit: () => submit(),
    });
    async function submit() {
      const message = dialog.querySelector('#gg-stashpush-message').value.trim();
      const includeUntracked = dialog.querySelector('#gg-stashpush-untracked').checked;
      const result = await gitGraphRunDialogAction(params, 'stashPush', { message, includeUntracked });
      if (result.error) { showError(result.error); return; }
      close(); resolve(result);
    }
  });
}

// --- 5.11 Reset uncommitted changes… ---

function gitGraphShowResetUncommittedDialog(params) {
  const defaults = gitGraphDefaultsFor('resetUncommittedChanges', params.defaults);
  return new Promise(resolve => {
    const bodyHtml = gitGraphFieldSelect('gg-resetuncommitted-mode', 'Mode', [
      { value: 'mixed', label: 'Mixed - Keep working tree, but reset index' },
      { value: 'hard', label: 'Hard - Discard all changes' },
    ], defaults.mode);
    const { dialog, close, showError } = gitGraphOpenDialog({
      title: 'Reset uncommitted changes', bodyHtml, primaryLabel: 'Reset', primaryDanger: true,
      onCancel: () => resolve(null), onSubmit: () => submit(),
    });
    async function submit() {
      const mode = dialog.querySelector('#gg-resetuncommitted-mode').value;
      if (mode === 'hard' && !gitGraphConfirmDestructive('This discards all uncommitted changes. Continue?')) return;
      const result = await gitGraphRunDialogAction(params, 'resetUncommitted', { mode });
      if (result.error) { showError(result.error); return; }
      close(); resolve(result);
    }
  });
}

// --- 5.12 Clean untracked files… ---

function gitGraphShowCleanUntrackedDialog(params) {
  const defaults = gitGraphDefaultsFor('cleanUntracked', params.defaults);
  return new Promise(resolve => {
    const bodyHtml = gitGraphFieldCheckbox('gg-clean-dirs', 'Also remove directories', defaults.removeDirectories);
    const { dialog, close, showError } = gitGraphOpenDialog({
      title: 'Clean untracked files', bodyHtml, primaryLabel: 'Clean', primaryDanger: true,
      onCancel: () => resolve(null), onSubmit: () => submit(),
    });
    async function submit() {
      if (!gitGraphConfirmDestructive('This permanently deletes untracked files. Continue?')) return;
      const removeDirectories = dialog.querySelector('#gg-clean-dirs').checked;
      const result = await gitGraphRunDialogAction(params, 'cleanUntracked', { removeDirectories });
      if (result.error) { showError(result.error); return; }
      close(); resolve(result);
    }
  });
}

// --- 5.13 Rename Branch… ---

function gitGraphShowRenameBranchDialog(params) {
  const spaceMode = params.spaceSubstitution || GIT_GRAPH_DIALOG_DEFAULTS.referenceInputSpaceSubstitution;
  return new Promise(resolve => {
    const bodyHtml = gitGraphFieldText('gg-renamebranch-name', 'New Name', params.oldName || '');
    const { dialog, close, showError } = gitGraphOpenDialog({
      title: `Rename Branch ${params.oldName || ''}`, bodyHtml, primaryLabel: 'Rename Branch',
      onCancel: () => resolve(null), onSubmit: () => submit(), focusSelector: '#gg-renamebranch-name',
    });
    async function submit() {
      const newName = gitGraphSubstituteSpaces(dialog.querySelector('#gg-renamebranch-name').value.trim(), spaceMode);
      const invalid = gitGraphValidateRefName(newName);
      if (invalid) { showError(invalid); return; }
      const result = await gitGraphRunDialogAction(params, 'renameBranch', { oldName: params.oldName, newName });
      if (result.error) { showError(result.error); return; }
      close(); resolve(result);
    }
  });
}

// --- 5.14 Delete Branch… ---

function gitGraphShowDeleteBranchDialog(params) {
  const defaults = gitGraphDefaultsFor('deleteBranch', params.defaults);
  const remoteMatches = params.remoteMatches || [];
  return new Promise(resolve => {
    const bodyHtml = `
      ${gitGraphFieldCheckbox('gg-deletebranch-force', 'Force Delete', defaults.forceDelete)}
      ${remoteMatches.length ? `<div class="gg-field gg-field-checkbox"><label><input type="checkbox" id="gg-deletebranch-alsoremote"> Also delete the branch on the remote(s) selected below</label></div>${gitGraphFieldRemoteList('gg-deletebranch', remoteMatches, [])}` : ''}
    `;
    const { dialog, close, showError } = gitGraphOpenDialog({
      title: `Delete Branch ${params.name || ''}`, bodyHtml, primaryLabel: 'Delete Branch', primaryDanger: true,
      onCancel: () => resolve(null), onSubmit: () => submit(),
    });
    async function attempt(forceDelete) {
      const alsoRemote = dialog.querySelector('#gg-deletebranch-alsoremote');
      const remotes = (remoteMatches.length && alsoRemote && alsoRemote.checked)
        ? Array.from(dialog.querySelectorAll('.gg-deletebranch-remote:checked')).map(el => el.value)
        : [];
      return gitGraphRunDialogAction(params, 'deleteBranch', { name: params.name, forceDelete, deleteOnRemotes: remotes });
    }
    async function submit() {
      const forceDelete = dialog.querySelector('#gg-deletebranch-force').checked;
      let result = await attempt(forceDelete);
      if (result.error) {
        if (!forceDelete && /not fully merged/i.test(result.error) && gitGraphConfirmDestructive(`Branch "${params.name}" is not fully merged. Force delete anyway?`)) {
          result = await attempt(true);
          if (result.error) { showError(result.error); return; }
        } else { showError(result.error); return; }
      }
      close(); resolve(result);
    }
  });
}

// --- 5.15 Push Branch… ---

function gitGraphShowPushBranchDialog(params) {
  const defaults = gitGraphDefaultsFor('pushBranch', params.defaults);
  const remotes = params.remotes || [];
  const fallbackRemote = (remotes.find(r => r.name === 'origin') || remotes[0] || {}).name;
  const defaultRemote = params.defaultRemote || fallbackRemote;
  return new Promise(resolve => {
    const bodyHtml = `
      ${gitGraphFieldRemoteList('gg-pushbranch', remotes, defaultRemote ? [defaultRemote] : [])}
      ${gitGraphFieldCheckbox('gg-pushbranch-upstream', 'Set Upstream', defaults.setUpstream)}
      ${gitGraphFieldSelect('gg-pushbranch-force', 'Force', [{ value: 'none', label: 'None' }, { value: 'force', label: 'Force' }, { value: 'lease', label: 'Force With Lease' }], defaults.force)}
    `;
    const { dialog, close, showError } = gitGraphOpenDialog({
      title: `Push Branch ${params.name || ''}`, bodyHtml, primaryLabel: 'Push Branch',
      onCancel: () => resolve(null), onSubmit: () => submit(),
    });
    async function submit() {
      const selected = Array.from(dialog.querySelectorAll('.gg-pushbranch-remote:checked')).map(el => el.value);
      if (!selected.length) { showError('Select at least one remote.'); return; }
      const setUpstream = dialog.querySelector('#gg-pushbranch-upstream').checked;
      const force = dialog.querySelector('#gg-pushbranch-force').value;
      const result = await gitGraphRunDialogActionMulti(params, 'pushBranch', selected.map(remote => ({ remotes: [remote], branch: params.name, setUpstream, force })));
      if (result.error) { showError(result.error); return; }
      close(); resolve(result);
    }
  });
}

// --- 5.16 Checkout Branch… (remote branch) ---

function gitGraphShowCheckoutRemoteBranchDialog(params) {
  const spaceMode = params.spaceSubstitution || GIT_GRAPH_DIALOG_DEFAULTS.referenceInputSpaceSubstitution;
  return new Promise(resolve => {
    const bodyHtml = gitGraphFieldText('gg-checkoutremote-name', 'Name', params.shortName || '');
    const { dialog, close, showError } = gitGraphOpenDialog({
      title: `Checkout Branch ${params.remote || ''}/${params.shortName || ''}`, bodyHtml, primaryLabel: 'Checkout Branch',
      onCancel: () => resolve(null), onSubmit: () => submit(), focusSelector: '#gg-checkoutremote-name',
    });
    async function submit() {
      const name = gitGraphSubstituteSpaces(dialog.querySelector('#gg-checkoutremote-name').value.trim(), spaceMode);
      const invalid = gitGraphValidateRefName(name);
      if (invalid) { showError(invalid); return; }
      // The server decides, per name, whether this is a brand-new local branch
      // or an existing-name collision ("checkout the existing branch & pull
      // changes") — both paths share this one actionId.
      const result = await gitGraphRunDialogAction(params, 'checkoutRemoteBranch', { remote: params.remote, shortName: params.shortName, name });
      if (result.error) { showError(result.error); return; }
      close(); resolve(result);
    }
  });
}

// --- 5.17 Delete Remote Branch… ---

function gitGraphShowDeleteRemoteBranchDialog(params) {
  return new Promise(resolve => {
    const bodyHtml = `<p class="gg-dialog-warning">Delete branch ${params.shortName || ''} on remote ${params.remote || ''}?</p>`;
    const { close, showError } = gitGraphOpenDialog({
      title: 'Delete Remote Branch', bodyHtml, primaryLabel: 'Delete Branch', primaryDanger: true,
      onCancel: () => resolve(null), onSubmit: () => submit(),
    });
    async function submit() {
      const result = await gitGraphRunDialogAction(params, 'deleteRemoteBranch', { remote: params.remote, shortName: params.shortName });
      if (result.error) { showError(result.error); return; }
      close(); resolve(result);
    }
  });
}

// --- 5.18 Fetch into Local Branch… ---

function gitGraphShowFetchIntoLocalBranchDialog(params) {
  const defaults = gitGraphDefaultsFor('fetchIntoLocalBranch', params.defaults);
  return new Promise(resolve => {
    const bodyHtml = gitGraphFieldCheckbox('gg-fetchlocal-force', 'Force Fetch', defaults.forceFetch);
    const { dialog, close, showError } = gitGraphOpenDialog({
      title: `Fetch into Local Branch ${params.localName || ''}`, bodyHtml, primaryLabel: 'Fetch',
      onCancel: () => resolve(null), onSubmit: () => submit(),
    });
    async function submit() {
      const forceFetch = dialog.querySelector('#gg-fetchlocal-force').checked;
      const result = await gitGraphRunDialogAction(params, 'fetchIntoLocalBranch', { remote: params.remote, shortName: params.shortName, localName: params.localName, forceFetch });
      if (result.error) { showError(result.error); return; }
      close(); resolve(result);
    }
  });
}

// --- 5.19 Pull into current branch… (remote branch) ---

function gitGraphShowPullBranchDialog(params) {
  const defaults = gitGraphDefaultsFor('pullBranch', params.defaults);
  return new Promise(resolve => {
    const bodyHtml = `
      ${gitGraphFieldCheckbox('gg-pull-noff', 'Create a new commit even if fast-forward is possible', defaults.noFastForward)}
      ${gitGraphFieldCheckbox('gg-pull-squash', 'Squash Commits', defaults.squashCommits)}
      <div class="gg-pull-squashformat" hidden>${gitGraphFieldSelect('gg-pull-squashformat', 'Squash Message Format', [{ value: 'default', label: 'Default' }, { value: 'git-squash-msg', label: 'Git SQUASH_MSG' }], defaults.squashMessageFormat)}</div>
    `;
    const { dialog, close, showError } = gitGraphOpenDialog({
      title: `Pull into current branch${params.currentBranch ? ` ${params.currentBranch}` : ''}`,
      bodyHtml, primaryLabel: 'Pull', onCancel: () => resolve(null), onSubmit: () => submit(),
    });
    const squashCheckbox = dialog.querySelector('#gg-pull-squash');
    const squashFormatBox = dialog.querySelector('.gg-pull-squashformat');
    function syncSquash() { squashFormatBox.hidden = !squashCheckbox.checked; }
    squashCheckbox.onchange = syncSquash; syncSquash();
    async function submit() {
      const noFastForward = dialog.querySelector('#gg-pull-noff').checked;
      const squash = squashCheckbox.checked;
      const squashMessageFormat = dialog.querySelector('#gg-pull-squashformat').value;
      const result = await gitGraphRunDialogAction(params, 'pullBranch', { remote: params.remote, shortName: params.shortName, noFastForward, squash, squashMessageFormat });
      if (result.error) { showError(result.error); return; }
      close(); resolve(result);
    }
  });
}

// --- 5.20 View Details (annotated tag) — read-only ---

function gitGraphShowTagDetailsDialog(params) {
  const tag = params.tag || {};
  return new Promise(resolve => {
    const bodyHtml = `
      <div class="gg-detail-row"><span class="gg-detail-label">Tag Name</span><span>${escapeHtml(tag.name || '')}</span></div>
      <div class="gg-detail-row"><span class="gg-detail-label">Tagger</span><span>${escapeHtml(tag.tagger || '')}${tag.email ? ` &lt;${escapeHtml(tag.email)}&gt;` : ''}</span></div>
      <div class="gg-detail-row"><span class="gg-detail-label">Date</span><span>${escapeHtml(tag.date || '')}</span></div>
      <div class="gg-detail-row"><span class="gg-detail-label">Object Hash</span><span class="gg-mono">${escapeHtml(tag.objectHash || '')}</span></div>
      <div class="gg-detail-row"><span class="gg-detail-label">Commit Hash</span><span class="gg-mono">${escapeHtml(tag.commitHash || '')}</span></div>
      <div class="gg-detail-message">${escapeHtml(tag.message || '')}</div>
    `;
    const { close } = gitGraphOpenDialog({
      title: `Tag ${tag.name || ''}`, bodyHtml, primaryLabel: 'Close', singleButton: true,
      onCancel: () => resolve(null), onSubmit: () => { close(); resolve(null); },
    });
  });
}

// --- 5.21 Delete Tag… ---

function gitGraphShowDeleteTagDialog(params) {
  const remoteMatches = params.remoteMatches || [];
  return new Promise(resolve => {
    const bodyHtml = `
      <p class="gg-dialog-warning">Delete tag ${params.name || ''}?</p>
      ${remoteMatches.length ? `<div class="gg-field gg-field-checkbox"><label><input type="checkbox" id="gg-deletetag-alsoremote"> Also delete this tag on the remote(s) selected below</label></div>${gitGraphFieldRemoteList('gg-deletetag', remoteMatches, [])}` : ''}
    `;
    const { dialog, close, showError } = gitGraphOpenDialog({
      title: 'Delete Tag', bodyHtml, primaryLabel: 'Delete Tag', primaryDanger: true,
      onCancel: () => resolve(null), onSubmit: () => submit(),
    });
    async function submit() {
      const alsoRemote = dialog.querySelector('#gg-deletetag-alsoremote');
      const remotes = (remoteMatches.length && alsoRemote && alsoRemote.checked)
        ? Array.from(dialog.querySelectorAll('.gg-deletetag-remote:checked')).map(el => el.value)
        : [];
      const result = await gitGraphRunDialogAction(params, 'deleteTag', { name: params.name, deleteOnRemotes: remotes });
      if (result.error) { showError(result.error); return; }
      close(); resolve(result);
    }
  });
}

// --- 5.22 Push Tag… ---

function gitGraphShowPushTagDialog(params) {
  const remotes = params.remotes || [];
  const fallbackRemote = (remotes.find(r => r.name === 'origin') || remotes[0] || {}).name;
  const defaultRemote = params.defaultRemote || fallbackRemote;
  return new Promise(resolve => {
    const bodyHtml = gitGraphFieldRemoteList('gg-pushtag', remotes, defaultRemote ? [defaultRemote] : []);
    const { dialog, close, showError } = gitGraphOpenDialog({
      title: `Push Tag ${params.name || ''}`, bodyHtml, primaryLabel: 'Push Tag',
      onCancel: () => resolve(null), onSubmit: () => submit(),
    });
    async function submit() {
      const selected = Array.from(dialog.querySelectorAll('.gg-pushtag-remote:checked')).map(el => el.value);
      if (!selected.length) { showError('Select at least one remote.'); return; }
      const result = await gitGraphRunDialogActionMulti(params, 'pushTag', selected.map(remote => ({ tagName: params.name, remotes: [remote] })));
      if (result.error) { showError(result.error); return; }
      close(); resolve(result);
    }
  });
}

// --- 5.23 Apply Stash… ---

function gitGraphShowApplyStashDialog(params) {
  const defaults = gitGraphDefaultsFor('applyStash', params.defaults);
  return new Promise(resolve => {
    const bodyHtml = gitGraphFieldCheckbox('gg-applystash-index', 'Reinstate Index', defaults.reinstateIndex);
    const { dialog, close, showError } = gitGraphOpenDialog({
      title: `Apply Stash${params.stashLabel ? ` "${params.stashLabel}"` : ''}`, bodyHtml, primaryLabel: 'Apply Stash',
      onCancel: () => resolve(null), onSubmit: () => submit(),
    });
    async function submit() {
      const reinstateIndex = dialog.querySelector('#gg-applystash-index').checked;
      const result = await gitGraphRunDialogAction(params, 'stashApply', { stashRef: params.stashRef, reinstateIndex });
      if (result.error) { showError(result.error); return; }
      close(); resolve(result);
    }
  });
}

// --- 5.24 Create Branch from Stash… ---

function gitGraphShowStashCreateBranchDialog(params) {
  const spaceMode = params.spaceSubstitution || GIT_GRAPH_DIALOG_DEFAULTS.referenceInputSpaceSubstitution;
  return new Promise(resolve => {
    const bodyHtml = gitGraphFieldText('gg-stashbranch-name', 'Branch Name', '');
    const { dialog, close, showError } = gitGraphOpenDialog({
      title: 'Create Branch from Stash', bodyHtml, primaryLabel: 'Create Branch',
      onCancel: () => resolve(null), onSubmit: () => submit(), focusSelector: '#gg-stashbranch-name',
    });
    async function submit() {
      const name = gitGraphSubstituteSpaces(dialog.querySelector('#gg-stashbranch-name').value.trim(), spaceMode);
      const invalid = gitGraphValidateRefName(name);
      if (invalid) { showError(invalid); return; }
      const result = await gitGraphRunDialogAction(params, 'stashCreateBranch', { name, stashRef: params.stashRef });
      if (result.error) { showError(result.error); return; }
      close(); resolve(result);
    }
  });
}

// --- 5.25 Pop Stash… ---

function gitGraphShowPopStashDialog(params) {
  const defaults = gitGraphDefaultsFor('popStash', params.defaults);
  return new Promise(resolve => {
    const bodyHtml = gitGraphFieldCheckbox('gg-popstash-index', 'Reinstate Index', defaults.reinstateIndex);
    const { dialog, close, showError } = gitGraphOpenDialog({
      title: `Pop Stash${params.stashLabel ? ` "${params.stashLabel}"` : ''}`, bodyHtml, primaryLabel: 'Pop Stash',
      onCancel: () => resolve(null), onSubmit: () => submit(),
    });
    async function submit() {
      const reinstateIndex = dialog.querySelector('#gg-popstash-index').checked;
      const result = await gitGraphRunDialogAction(params, 'stashPop', { stashRef: params.stashRef, reinstateIndex });
      if (result.error) { showError(result.error); return; }
      close(); resolve(result);
    }
  });
}

// --- 5.26 Drop Stash… ---

function gitGraphShowDropStashDialog(params) {
  return new Promise(resolve => {
    const bodyHtml = `<p class="gg-dialog-warning">Drop stash${params.stashLabel ? ` "${params.stashLabel}"` : ''}? This cannot be undone.</p>`;
    const { close, showError } = gitGraphOpenDialog({
      title: 'Drop Stash', bodyHtml, primaryLabel: 'Drop', primaryDanger: true,
      onCancel: () => resolve(null), onSubmit: () => submit(),
    });
    async function submit() {
      const result = await gitGraphRunDialogAction(params, 'stashDrop', { stashRef: params.stashRef });
      if (result.error) { showError(result.error); return; }
      close(); resolve(result);
    }
  });
}

// --- Repository Settings Widget — Remotes management ---
//
// All four take `ctx` — the same shared projectId/folderPath/refresh/defaults
// object documented at the top of this file — plus, where there's a target,
// the specific remote `{name, url, pushUrl}` the Settings drawer's Remotes
// list row was already showing (no separate read call from in here: the
// caller already has the full remote list loaded to render that row).

function gitGraphShowAddRemoteDialog(ctx) {
  return new Promise(resolve => {
    const bodyHtml = `
      ${gitGraphFieldText('gg-addremote-name', 'Name', '', 'origin')}
      ${gitGraphFieldText('gg-addremote-url', 'URL', '', 'https://example.com/user/repo.git')}
    `;
    const { dialog, close, showError } = gitGraphOpenDialog({
      title: 'Add Remote', bodyHtml, primaryLabel: 'Add Remote',
      onCancel: () => resolve(null), onSubmit: () => submit(), focusSelector: '#gg-addremote-name',
    });
    async function submit() {
      const name = dialog.querySelector('#gg-addremote-name').value.trim();
      const url = dialog.querySelector('#gg-addremote-url').value.trim();
      const invalidName = gitGraphValidateRemoteName(name);
      if (invalidName) { showError(invalidName); return; }
      if (!url) { showError('URL is required.'); return; }
      const result = await gitGraphRunDialogAction(ctx, 'addRemote', { name, url });
      if (result.error) { showError(result.error); return; }
      close(); resolve(result);
    }
  });
}

function gitGraphShowEditRemoteDialog(ctx, remote) {
  const current = remote || {};
  return new Promise(resolve => {
    const bodyHtml = `
      ${gitGraphFieldText('gg-editremote-name', 'Name', current.name || '')}
      ${gitGraphFieldText('gg-editremote-url', 'URL', current.url || '')}
    `;
    const { dialog, close, showError } = gitGraphOpenDialog({
      title: `Edit Remote ${current.name || ''}`, bodyHtml, primaryLabel: 'Save',
      onCancel: () => resolve(null), onSubmit: () => submit(), focusSelector: '#gg-editremote-name',
    });
    async function submit() {
      const newName = dialog.querySelector('#gg-editremote-name').value.trim();
      const url = dialog.querySelector('#gg-editremote-url').value.trim();
      const invalidName = gitGraphValidateRemoteName(newName);
      if (invalidName) { showError(invalidName); return; }
      if (!url) { showError('URL is required.'); return; }
      const result = await gitGraphRunDialogAction(ctx, 'editRemote', { oldName: current.name, newName, url });
      if (result.error) { showError(result.error); return; }
      close(); resolve(result);
    }
  });
}

function gitGraphShowDeleteRemoteDialog(ctx, remote) {
  const current = remote || {};
  return new Promise(resolve => {
    const bodyHtml = `<p class="gg-dialog-warning">Delete remote "${escapeHtml(current.name || '')}"? This does not delete the remote repository itself, only this local reference to it.</p>`;
    const { close, showError } = gitGraphOpenDialog({
      title: 'Delete Remote', bodyHtml, primaryLabel: 'Delete Remote', primaryDanger: true,
      onCancel: () => resolve(null), onSubmit: () => submit(),
    });
    async function submit() {
      const result = await gitGraphRunDialogAction(ctx, 'deleteRemote', { name: current.name });
      if (result.error) { showError(result.error); return; }
      close(); resolve(result);
    }
  });
}

/** Per-remote Fetch, with Prune / Prune Tags — distinct from the control
 * bar's "Fetch from Remote(s)" (fetchAllRemotes), which this file doesn't dialog for. */
function gitGraphShowFetchRemoteDialog(ctx, remote) {
  const current = remote || {};
  const defaults = gitGraphDefaultsFor('fetchRemote', ctx.defaults);
  return new Promise(resolve => {
    const bodyHtml = `
      ${gitGraphFieldCheckbox('gg-fetchremote-prune', 'Prune', defaults.prune)}
      ${gitGraphFieldCheckbox('gg-fetchremote-prunetags', 'Prune Tags', defaults.pruneTags)}
    `;
    const { dialog, close, showError } = gitGraphOpenDialog({
      title: `Fetch Remote ${current.name || ''}`, bodyHtml, primaryLabel: 'Fetch',
      onCancel: () => resolve(null), onSubmit: () => submit(),
    });
    async function submit() {
      const prune = dialog.querySelector('#gg-fetchremote-prune').checked;
      const pruneTags = dialog.querySelector('#gg-fetchremote-prunetags').checked;
      const result = await gitGraphRunDialogAction(ctx, 'fetchRemote', { remote: current.name, prune, pruneTags });
      if (result.error) { showError(result.error); return; }
      close(); resolve(result);
    }
  });
}

// --- Repository Settings Widget — User Details ---
//
// `current` is { local: {name, email}, global: {name, email} } — each a
// string or null, read separately per scope (git.js's userDetails(), never
// merged) so this dialog can tell "no local override" from "local override
// happens to match global" and show the inherited value as a placeholder
// rather than baking it into the local field's actual value.

/**
 * Decides what (if anything) a scope's setUserDetails call should receive
 * for one field, given that scope's existing value and the field's current
 * (trimmed) text: unchanged text is left untouched (undefined, so the
 * caller omits the key entirely — setUserDetails treats an absent key as
 * "leave alone"), a cleared real override becomes an explicit unset (null),
 * and new/changed text is passed through as-is.
 */
function gitGraphDiffUserDetailsField(existingValue, nextText) {
  const existingText = existingValue || '';
  if (nextText === existingText) return undefined;
  if (nextText === '') return null;
  return nextText;
}

function gitGraphShowUserDetailsDialog(ctx, current) {
  const existing = current || {};
  const local = existing.local || {};
  const globalDetails = existing.global || {};
  return new Promise(resolve => {
    const bodyHtml = `
      <div class="gg-userdetails-section">
        <div class="gg-field-label">Local (this repository)</div>
        ${gitGraphFieldText('gg-userdetails-local-name', 'Name', local.name || '', globalDetails.name || '')}
        ${gitGraphFieldText('gg-userdetails-local-email', 'Email', local.email || '', globalDetails.email || '')}
      </div>
      <div class="gg-userdetails-section">
        <div class="gg-field-label">Global (every repository)</div>
        ${gitGraphFieldText('gg-userdetails-global-name', 'Name', globalDetails.name || '')}
        ${gitGraphFieldText('gg-userdetails-global-email', 'Email', globalDetails.email || '')}
      </div>
    `;
    const { dialog, close, showError } = gitGraphOpenDialog({
      title: 'User Details', bodyHtml, primaryLabel: 'Save',
      onCancel: () => resolve(null), onSubmit: () => submit(), focusSelector: '#gg-userdetails-local-name',
    });
    async function submit() {
      const localParams = {};
      const localName = gitGraphDiffUserDetailsField(local.name, dialog.querySelector('#gg-userdetails-local-name').value.trim());
      if (localName !== undefined) localParams.name = localName;
      const localEmail = gitGraphDiffUserDetailsField(local.email, dialog.querySelector('#gg-userdetails-local-email').value.trim());
      if (localEmail !== undefined) localParams.email = localEmail;

      const globalParams = {};
      const globalName = gitGraphDiffUserDetailsField(globalDetails.name, dialog.querySelector('#gg-userdetails-global-name').value.trim());
      if (globalName !== undefined) globalParams.name = globalName;
      const globalEmail = gitGraphDiffUserDetailsField(globalDetails.email, dialog.querySelector('#gg-userdetails-global-email').value.trim());
      if (globalEmail !== undefined) globalParams.email = globalEmail;

      if (!Object.keys(localParams).length && !Object.keys(globalParams).length) { close(); resolve(null); return; }

      if (Object.keys(localParams).length) {
        const result = await gitGraphRunDialogAction(ctx, 'setUserDetails', { global: false, ...localParams });
        if (result.error) { showError(result.error); return; }
      }
      if (Object.keys(globalParams).length) {
        const result = await gitGraphRunDialogAction(ctx, 'setUserDetails', { global: true, ...globalParams });
        if (result.error) { showError(result.error); return; }
      }
      close(); resolve({ ok: true });
    }
  });
}

// --- Repository Settings Widget — Issue Linking ---
//
// Pure configuration: unlike every dialog above, this one never calls
// runGitGraphAction — it just resolves the new { regex, url, useGlobally }
// value for the caller to persist via setGitGraphRepoConfig (and, when
// "Use Globally" is checked, mirror into GlobalPrefs — also the caller's
// job, not this dialog's).

/**
 * Auto-prefill: a best-effort guess at a repository's issue-tracker
 * convention from a sample of recent commit subjects, used only to suggest
 * a starting Issue Regex when the repo doesn't already have one — it never
 * overwrites an existing value.
 */
function gitGraphGuessIssueRegex(sampleSubjects) {
  const subjects = sampleSubjects || [];
  if (subjects.some((s) => /#\d+/.test(s))) return '#(\\d+)';
  for (const subject of subjects) {
    if (/\b[A-Z][A-Z0-9]+-\d+\b/.test(subject)) return '([A-Z][A-Z0-9]+-\\d+)';
  }
  return '';
}

function gitGraphShowIssueLinkingDialog(ctx, current) {
  const existing = current || {};
  const suggestedRegex = existing.regex || gitGraphGuessIssueRegex(ctx.sampleSubjects);
  return new Promise(resolve => {
    const bodyHtml = `
      ${gitGraphFieldText('gg-issuelinking-regex', 'Issue Regex', suggestedRegex, '#(\\d+)')}
      ${gitGraphFieldText('gg-issuelinking-url', 'Issue URL', existing.url || '', 'https://example.com/issues/$1')}
      ${gitGraphFieldCheckbox('gg-issuelinking-global', 'Use Globally', !!existing.useGlobally, 'Apply this repository’s Issue Regex/URL as the default for every repository that has no override of its own.')}
    `;
    const { dialog, close, showError } = gitGraphOpenDialog({
      title: 'Issue Linking', bodyHtml, primaryLabel: 'Save',
      onCancel: () => resolve(null), onSubmit: () => submit(), focusSelector: '#gg-issuelinking-regex',
    });
    function submit() {
      const regex = dialog.querySelector('#gg-issuelinking-regex').value.trim();
      const url = dialog.querySelector('#gg-issuelinking-url').value.trim();
      const useGlobally = dialog.querySelector('#gg-issuelinking-global').checked;
      if (regex) {
        try { new RegExp(regex); } catch { showError('Issue Regex is not a valid regular expression.'); return; }
      }
      close();
      resolve({ regex: regex || null, url: url || null, useGlobally });
    }
  });
}

// --- Repository Settings Widget — Pull Request Creation configuration ---
//
// Also pure configuration, like Issue Linking above: resolves the new
// RepoConfig.pullRequestProvider value ({kind, name?, templateUrl?,
// sourceRemote?, destRemote?, destBranch?} — the exact shape
// gitGraphResolvePullRequestUrl() in git-graph-menus.js reads at invocation
// time) for the caller to persist. Source Branch is deliberately not part
// of this stored shape — it's usually pre-filled from the branch that was
// right-clicked, so it's supplied at Create-Pull-Request time, not configured
// here. `ctx.customProviders` is GlobalPrefs.customPullRequestProviders,
// the catalogue a Custom selection is drawn from.

function gitGraphShowPullRequestConfigDialog(ctx, current) {
  const existing = current || {};
  const remotes = ctx.remotes || [];
  const customProviders = ctx.customProviders || [];
  const remoteOptions = remotes.map((r) => ({ value: r.name, label: r.name }));
  // A leading placeholder option (empty value) so "Custom" with nothing yet
  // picked is a real, distinguishable state rather than silently defaulting
  // to whichever custom provider happens to be listed first.
  const customOptions = [{ value: '', label: 'Select a custom provider…' }, ...customProviders.map((p) => ({ value: p.name, label: p.name }))];
  const defaultRemote = (remotes[0] && remotes[0].name) || '';
  return new Promise(resolve => {
    const bodyHtml = `
      ${gitGraphFieldSelect('gg-prconfig-provider', 'Provider', [
        { value: 'github', label: 'GitHub' }, { value: 'gitlab', label: 'GitLab' },
        { value: 'bitbucket', label: 'Bitbucket' }, { value: 'custom', label: 'Custom' },
      ], existing.kind || 'github')}
      <div class="gg-prconfig-custom" hidden>${gitGraphFieldSelect('gg-prconfig-customname', 'Custom Provider', customOptions, existing.name || '')}</div>
      ${gitGraphFieldSelect('gg-prconfig-sourceremote', 'Source Remote', remoteOptions, existing.sourceRemote || defaultRemote)}
      ${gitGraphFieldSelect('gg-prconfig-destremote', 'Destination Remote', remoteOptions, existing.destRemote || defaultRemote)}
      ${gitGraphFieldText('gg-prconfig-destbranch', 'Destination Branch', existing.destBranch || ctx.defaultBranch || 'main')}
    `;
    const { dialog, close, showError } = gitGraphOpenDialog({
      title: 'Pull Request Creation', bodyHtml, primaryLabel: 'Save',
      onCancel: () => resolve(null), onSubmit: () => submit(), focusSelector: '#gg-prconfig-provider',
    });
    const providerSelect = dialog.querySelector('#gg-prconfig-provider');
    const customBox = dialog.querySelector('.gg-prconfig-custom');
    function syncProvider() { customBox.hidden = providerSelect.value !== 'custom'; }
    providerSelect.onchange = syncProvider; syncProvider();

    function submit() {
      const kind = providerSelect.value;
      const destBranch = dialog.querySelector('#gg-prconfig-destbranch').value.trim();
      const sourceRemote = dialog.querySelector('#gg-prconfig-sourceremote').value || undefined;
      const destRemote = dialog.querySelector('#gg-prconfig-destremote').value || undefined;
      if (!destBranch) { showError('Destination Branch is required.'); return; }
      const result = { kind, sourceRemote, destRemote, destBranch };
      if (kind === 'custom') {
        const name = dialog.querySelector('#gg-prconfig-customname').value;
        const match = customProviders.find((p) => p.name === name);
        if (!match) { showError('Select a custom provider (configured under Custom Pull Request Providers).'); return; }
        result.name = match.name;
        result.templateUrl = match.templateUrl;
      }
      close(); resolve(result);
    }
  });
}

// --- Trust prompt for a repo-committed .switchboard-git-graph.json ---
//
// Resolves a plain boolean, not an action result — true means the caller
// should now call window.api.trustGitGraphRepoConfig(...,true) (and re-read
// the repo config so the external file's fields take effect); false (Escape,
// "Not Now", or the dialog's own Cancel) leaves the repo untrusted, exactly
// as it already was before this prompt appeared. `summary` previews which
// fields the file would set, so trusting it is an informed decision rather
// than a blind "apply some file I haven't seen" click.

function gitGraphSummarizeTrustFields(summary) {
  const fields = summary || {};
  const lines = [];
  if (fields.customDisplayName) lines.push(`Display name: ${fields.customDisplayName}`);
  if (fields.issueLinking && (fields.issueLinking.regex || fields.issueLinking.url)) {
    lines.push(`Issue Linking: ${fields.issueLinking.regex || '(no regex)'} → ${fields.issueLinking.url || '(no URL)'}`);
  }
  if (fields.pullRequestProvider) {
    lines.push(`Pull Request provider: ${fields.pullRequestProvider.name || fields.pullRequestProvider.kind || '(unnamed)'}`);
  }
  return lines;
}

function gitGraphShowTrustRepoConfigDialog(ctx, summary) {
  const lines = gitGraphSummarizeTrustFields(summary);
  return new Promise(resolve => {
    const bodyHtml = `
      <p class="gg-dialog-warning">This repository defines custom Git Graph settings, committed at its root. Apply them?</p>
      ${lines.length ? `<ul class="gg-trust-summary">${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>` : ''}
    `;
    const { close } = gitGraphOpenDialog({
      title: 'Repository-Defined Settings', bodyHtml, primaryLabel: 'Trust and Apply', cancelLabel: 'Not Now',
      onCancel: () => resolve(false), onSubmit: () => { close(); resolve(true); },
    });
  });
}

// --- Bonus: Reset File to this Revision… — needed by the commit-details
// file menu, not one of the context-menu-action dialogs above. ---

function gitGraphShowResetFileToRevisionDialog(params) {
  return new Promise(resolve => {
    const bodyHtml = `<p class="gg-dialog-warning">Reset "${params.relativePath || ''}" in the working tree to its content at ${params.commitShortHash || params.commitHash || ''}? Uncommitted changes to this file will be lost.</p>`;
    const { close, showError } = gitGraphOpenDialog({
      title: 'Reset File to this Revision', bodyHtml, primaryLabel: 'Reset File', primaryDanger: true,
      onCancel: () => resolve(null), onSubmit: () => submit(),
    });
    async function submit() {
      const result = await gitGraphRunDialogAction(params, 'resetFileToRevision', { commit: params.commitHash, relPath: params.relativePath });
      if (result.error) { showError(result.error); return; }
      close(); resolve(result);
    }
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    GIT_GRAPH_DIALOG_DEFAULTS, gitGraphDefaultsFor, gitGraphCheckoutAlwaysAccept, gitGraphCheckoutAlwaysAcceptKey,
    gitGraphSubstituteSpaces, gitGraphValidateRefName, gitGraphValidateRemoteName, gitGraphConfirmDestructive,
    gitGraphRunDialogAction, gitGraphRunDialogActionMulti,
    gitGraphFieldText, gitGraphFieldTextarea, gitGraphFieldCheckbox, gitGraphFieldSelect, gitGraphFieldRemoteList,
    gitGraphOpenDialog,
    gitGraphShowAddTagDialog, gitGraphShowCreateBranchDialog, gitGraphShowCheckoutCommitDialog,
    gitGraphShowCherryPickDialog, gitGraphShowRevertDialog, gitGraphShowDropCommitDialog,
    gitGraphShowMergeDialog, gitGraphShowRebaseDialog, gitGraphShowResetToCommitDialog,
    gitGraphShowStashPushDialog, gitGraphShowResetUncommittedDialog, gitGraphShowCleanUntrackedDialog,
    gitGraphShowRenameBranchDialog, gitGraphShowDeleteBranchDialog, gitGraphShowPushBranchDialog,
    gitGraphShowCheckoutRemoteBranchDialog, gitGraphShowDeleteRemoteBranchDialog, gitGraphShowFetchIntoLocalBranchDialog,
    gitGraphShowPullBranchDialog, gitGraphShowTagDetailsDialog, gitGraphShowDeleteTagDialog, gitGraphShowPushTagDialog,
    gitGraphShowApplyStashDialog, gitGraphShowStashCreateBranchDialog, gitGraphShowPopStashDialog, gitGraphShowDropStashDialog,
    gitGraphShowResetFileToRevisionDialog,
    gitGraphShowAddRemoteDialog, gitGraphShowEditRemoteDialog, gitGraphShowDeleteRemoteDialog, gitGraphShowFetchRemoteDialog,
    gitGraphDiffUserDetailsField, gitGraphShowUserDetailsDialog,
    gitGraphGuessIssueRegex, gitGraphShowIssueLinkingDialog,
    gitGraphShowPullRequestConfigDialog,
    gitGraphSummarizeTrustFields, gitGraphShowTrustRepoConfigDialog,
  };
}

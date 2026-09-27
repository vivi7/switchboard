const test = require('node:test');
const assert = require('node:assert/strict');

// git-graph-dialogs.js is a plain browser-global script (no bundler/DOM
// library available in this repo) that builds real DOM via
// document.createElement/innerHTML/querySelector. Since there's no jsdom
// dependency here, this file carries its own small, purpose-built fake DOM —
// just the handful of operations git-graph-dialogs.js actually uses
// (createElement, innerHTML parsing, #id/.class/.class:checked selectors,
// value/checked/hidden fields, and a document-level keydown dispatcher for
// the Enter/Escape/IME-composition handling under test).

const VOID_TAGS = new Set(['input', 'br', 'hr', 'img']);

function ggParseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null };
  let node = root;
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)((?:\s+[a-zA-Z0-9_-]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/)?>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === m[1].toLowerCase()) { stack.length = i; node = stack[i - 1] || root; break; }
      }
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      const attrs = {};
      const attrRe = /([a-zA-Z0-9_-]+)(?:=("[^"]*"|'[^']*'|[^\s>]+))?/g;
      let am;
      while ((am = attrRe.exec(m[3] || ''))) {
        let val = am[2];
        if (val === undefined) val = '';
        else val = val.replace(/^["']|["']$/g, '');
        attrs[am[1]] = val;
      }
      const el = { tag, attrs, children: [], parent: node };
      node.children.push(el);
      if (!(m[4] || VOID_TAGS.has(tag))) { stack.push(el); node = el; }
    } else if (m[5] != null) {
      node.children.push({ tag: '#text', text: m[5], attrs: {}, children: [], parent: node });
    }
  }
  return root;
}

function collectText(node) {
  return node.children.map(c => (c.tag === '#text' ? c.text : collectText(c))).join('');
}

function ggMatchesToken(node, token) {
  if (node.tag === '#text') return false;
  let checkedOnly = false;
  if (token.endsWith(':checked')) { checkedOnly = true; token = token.slice(0, -':checked'.length); }
  let ok;
  if (token.startsWith('#')) ok = node.attrs.id === token.slice(1);
  else if (token.startsWith('.')) ok = (node.attrs.class || '').split(/\s+/).includes(token.slice(1));
  else ok = node.tag === token;
  if (ok && checkedOnly) ok = !!wrapEl(node).checked;
  return ok;
}

function ggQuerySelectorAll(root, selector) {
  const tokens = selector.split(',').map(s => s.trim());
  const results = [];
  (function walk(node) {
    for (const child of node.children) {
      if (child.tag === '#text') continue;
      if (tokens.some(t => ggMatchesToken(child, t))) results.push(wrapEl(child));
      walk(child);
    }
  })(root);
  return results;
}

function wrapEl(node) {
  if (node._wrapped) return node;
  node._wrapped = true;
  node.tagName = node.tag.toUpperCase();
  node._hidden = 'hidden' in node.attrs;
  node._disabled = 'disabled' in node.attrs;
  node._checked = 'checked' in node.attrs;
  if (node.tag === 'select') {
    const selectedOpt = node.children.find(c => c.tag === 'option' && 'selected' in c.attrs);
    const firstOpt = node.children.find(c => c.tag === 'option');
    node._value = selectedOpt ? selectedOpt.attrs.value : (firstOpt ? firstOpt.attrs.value : '');
  } else if (node.tag === 'textarea') {
    node._value = collectText(node);
  } else {
    node._value = node.attrs.value !== undefined ? node.attrs.value : '';
  }
  Object.defineProperty(node, 'value', { get() { return node._value; }, set(v) { node._value = v; }, configurable: true });
  Object.defineProperty(node, 'checked', { get() { return node._checked; }, set(v) { node._checked = !!v; }, configurable: true });
  Object.defineProperty(node, 'hidden', { get() { return node._hidden; }, set(v) { node._hidden = !!v; }, configurable: true });
  Object.defineProperty(node, 'disabled', { get() { return node._disabled; }, set(v) { node._disabled = !!v; }, configurable: true });
  Object.defineProperty(node, 'className', { get() { return node.attrs.class || ''; }, set(v) { node.attrs.class = v; }, configurable: true });
  Object.defineProperty(node, 'textContent', {
    get() { return collectText(node); },
    set(v) { node.children = [{ tag: '#text', text: v, attrs: {}, children: [], parent: node }]; },
    configurable: true,
  });
  node.setAttribute = (name, value) => { node.attrs[name] = String(value); };
  node.getAttribute = (name) => (name in node.attrs ? node.attrs[name] : null);
  node.appendChild = (child) => { child.parent = node; node.children.push(child); return child; };
  node.remove = () => { if (node.parent) node.parent.children = node.parent.children.filter(c => c !== node); };
  node.focus = () => {};
  node.select = () => {};
  node.addEventListener = () => {};
  node.querySelector = (sel) => ggQuerySelectorAll(node, sel)[0] || null;
  node.querySelectorAll = (sel) => ggQuerySelectorAll(node, sel);
  Object.defineProperty(node, 'innerHTML', {
    get() { return ''; },
    set(html) {
      const parsed = ggParseHtml(html);
      node.children = parsed.children;
      for (const c of node.children) c.parent = node;
    },
    configurable: true,
  });
  return node;
}

function makeFakeDocument() {
  const listeners = { keydown: [] };
  const bodyNode = wrapEl({ tag: 'body', attrs: {}, children: [], parent: null });
  return {
    createElement(tag) { return wrapEl({ tag: tag.toLowerCase(), attrs: {}, children: [], parent: null }); },
    body: bodyNode,
    addEventListener(type, handler) { (listeners[type] = listeners[type] || []).push(handler); },
    removeEventListener(type, handler) { listeners[type] = (listeners[type] || []).filter(h => h !== handler); },
    _dispatchKeydown(evt) {
      const e = { stopPropagation() {}, preventDefault() {}, ...evt };
      for (const h of listeners.keydown.slice()) h(e);
    },
    _keydownListenerCount() { return listeners.keydown.length; },
  };
}

// --- Global stubs (bare browser globals, matching the codebase's convention) ---

global.escapeHtml = (s) => (s == null ? '' : String(s));
global.escapeAttr = (s) => (s == null ? '' : String(s));
global.confirm = () => true;

const dialogs = require('../public/git-graph-dialogs');

function setup(overrides = {}) {
  global.document = makeFakeDocument();
  const runCalls = [];
  global.window = {
    api: {
      runGitGraphAction: async (projectId, folderPath, actionId, params) => {
        runCalls.push({ projectId, folderPath, actionId, params });
        const handler = overrides.runGitGraphAction;
        return handler ? handler({ projectId, folderPath, actionId, params }, runCalls.length) : { ok: true };
      },
    },
  };
  global.confirm = overrides.confirm || (() => true);
  dialogs.gitGraphCheckoutAlwaysAccept.clear();
  return { runCalls };
}

// Some declined-collision-retry paths never resolve the dialog's outer
// Promise (the dialog stays open for the user to retry), so tests that need
// to observe UI state mutated *after* the internal action-call microtask
// chain settles flush past it with a macrotask tick instead of awaiting a
// Promise that would otherwise hang forever.
function flushAsync() { return new Promise(resolve => setImmediate(resolve)); }

function openDialogNode() {
  const overlay = global.document.body.children[global.document.body.children.length - 1];
  return overlay.querySelector('.gg-dialog');
}

// --- Defaults match GlobalPrefs.dialogDefaults exactly ---

test('Add Tag opens with Annotated type unchecked Push-to-remote, matching the documented default', async () => {
  setup();
  dialogs.gitGraphShowAddTagDialog({ projectId: 'p', folderPath: '/r', commitHash: 'h', commitShortHash: 'h1234' });
  const dialog = openDialogNode();
  assert.equal(dialog.querySelector('#gg-addtag-type').value, 'annotated');
  assert.equal(dialog.querySelector('#gg-addtag-push').checked, false);
  assert.match(dialog.querySelector('h3').textContent, /Add tag to commit h1234/);
});

test('Create Branch opens with Check out unchecked, matching the documented default', async () => {
  setup();
  dialogs.gitGraphShowCreateBranchDialog({ projectId: 'p', folderPath: '/r', commitHash: 'h' });
  const dialog = openDialogNode();
  assert.equal(dialog.querySelector('#gg-createbranch-checkout').checked, false);
});

test('Merge opens with No-Fast-Forward checked, Squash/No-Commit unchecked, matching the documented default', async () => {
  setup();
  dialogs.gitGraphShowMergeDialog({ projectId: 'p', folderPath: '/r', currentBranch: 'main', ref: 'feature' });
  const dialog = openDialogNode();
  assert.equal(dialog.querySelector('#gg-merge-noff').checked, true);
  assert.equal(dialog.querySelector('#gg-merge-squash').checked, false);
  assert.equal(dialog.querySelector('#gg-merge-nocommit').checked, false);
  assert.equal(dialog.querySelector('.gg-merge-squashformat').hidden, true);
  assert.match(dialog.querySelector('h3').textContent, /Merge into current branch main/);
});

test('Pull opens with No-Fast-Forward UNCHECKED (differs from Merge), matching the documented default', async () => {
  setup();
  dialogs.gitGraphShowPullBranchDialog({ projectId: 'p', folderPath: '/r', remote: 'origin', shortName: 'feature', currentBranch: 'main' });
  const dialog = openDialogNode();
  assert.equal(dialog.querySelector('#gg-pull-noff').checked, false);
});

test('Rebase opens with Ignore Date checked and Launch Interactive unchecked, matching the documented default', async () => {
  setup();
  dialogs.gitGraphShowRebaseDialog({ projectId: 'p', folderPath: '/r', currentBranch: 'main', upstream: 'feature', upstreamLabel: 'feature' });
  const dialog = openDialogNode();
  assert.equal(dialog.querySelector('#gg-rebase-ignoredate').checked, true);
  assert.equal(dialog.querySelector('#gg-rebase-interactive').checked, false);
});

test('Merge forwards refType/remote through to the merge action, so qualifyRef can resolve the target', async () => {
  const { runCalls } = setup();
  const promise = dialogs.gitGraphShowMergeDialog({ projectId: 'p', folderPath: '/r', currentBranch: 'main', ref: 'feature', refType: 'remote-branch', remote: 'origin' });
  openDialogNode().querySelector('.gg-dialog-primary').onclick();
  await promise;
  assert.equal(runCalls[0].params.ref, 'feature');
  assert.equal(runCalls[0].params.refType, 'remote-branch');
  assert.equal(runCalls[0].params.remote, 'origin');
});

test('Rebase forwards the upstream\'s refType/remote through to the rebase action', async () => {
  const { runCalls } = setup();
  const promise = dialogs.gitGraphShowRebaseDialog({ projectId: 'p', folderPath: '/r', currentBranch: 'main', upstream: 'feature', upstreamLabel: 'feature', upstreamRefType: 'branch' });
  openDialogNode().querySelector('.gg-dialog-primary').onclick();
  await promise;
  assert.equal(runCalls[0].params.upstream, 'feature');
  assert.equal(runCalls[0].params.refType, 'branch');
});

test('Reset current branch to Commit defaults to Mixed', async () => {
  setup();
  dialogs.gitGraphShowResetToCommitDialog({ projectId: 'p', folderPath: '/r', commitHash: 'h', currentBranch: 'main' });
  const dialog = openDialogNode();
  assert.equal(dialog.querySelector('#gg-resettocommit-mode').value, 'mixed');
});

test('Clean untracked files defaults "Also remove directories" to unchecked', async () => {
  setup();
  dialogs.gitGraphShowCleanUntrackedDialog({ projectId: 'p', folderPath: '/r' });
  const dialog = openDialogNode();
  assert.equal(dialog.querySelector('#gg-clean-dirs').checked, false);
});

test('Push Branch defaults Set Upstream to checked and Force to none', async () => {
  setup();
  dialogs.gitGraphShowPushBranchDialog({ projectId: 'p', folderPath: '/r', name: 'feature', remotes: [{ name: 'origin' }] });
  const dialog = openDialogNode();
  assert.equal(dialog.querySelector('#gg-pushbranch-upstream').checked, true);
  assert.equal(dialog.querySelector('#gg-pushbranch-force').value, 'none');
  assert.equal(dialog.querySelector('.gg-pushbranch-remote').checked, true);
});

test('Stash uncommitted changes defaults Include Untracked to checked', async () => {
  setup();
  dialogs.gitGraphShowStashPushDialog({ projectId: 'p', folderPath: '/r' });
  const dialog = openDialogNode();
  assert.equal(dialog.querySelector('#gg-stashpush-untracked').checked, true);
});

test('Apply Stash / Pop Stash default Reinstate Index to unchecked', async () => {
  setup();
  dialogs.gitGraphShowApplyStashDialog({ projectId: 'p', folderPath: '/r', stashRef: 'stash@{0}' });
  assert.equal(openDialogNode().querySelector('#gg-applystash-index').checked, false);
  dialogs.gitGraphShowPopStashDialog({ projectId: 'p', folderPath: '/r', stashRef: 'stash@{0}' });
  assert.equal(openDialogNode().querySelector('#gg-popstash-index').checked, false);
});

test('Delete Branch defaults Force Delete to unchecked', async () => {
  setup();
  dialogs.gitGraphShowDeleteBranchDialog({ projectId: 'p', folderPath: '/r', name: 'feature' });
  assert.equal(openDialogNode().querySelector('#gg-deletebranch-force').checked, false);
});

test('Fetch into Local Branch defaults Force Fetch to unchecked', async () => {
  setup();
  dialogs.gitGraphShowFetchIntoLocalBranchDialog({ projectId: 'p', folderPath: '/r', remote: 'origin', shortName: 'feature', localName: 'feature' });
  assert.equal(openDialogNode().querySelector('#gg-fetchlocal-force').checked, false);
});

test('Cherry Pick defaults No Commit / Record Origin to unchecked and hides Parent for a non-merge commit', async () => {
  setup();
  dialogs.gitGraphShowCherryPickDialog({ projectId: 'p', folderPath: '/r', commitHash: 'h', parents: ['p1'] });
  const dialog = openDialogNode();
  assert.equal(dialog.querySelector('#gg-cherrypick-nocommit').checked, false);
  assert.equal(dialog.querySelector('#gg-cherrypick-recordorigin').checked, false);
  assert.equal(dialog.querySelector('#gg-cherrypick-parent'), null);
});

test('Cherry Pick shows a Parent selector for a merge commit', async () => {
  setup();
  dialogs.gitGraphShowCherryPickDialog({ projectId: 'p', folderPath: '/r', commitHash: 'h', parents: ['p1', 'p2'] });
  const dialog = openDialogNode();
  assert.notEqual(dialog.querySelector('#gg-cherrypick-parent'), null);
  assert.equal(dialog.querySelector('#gg-cherrypick-parent').value, '1');
});

test('An explicit params.defaults overrides the documented-default fallback', async () => {
  setup();
  dialogs.gitGraphShowAddTagDialog({ projectId: 'p', folderPath: '/r', commitHash: 'h', defaults: { type: 'lightweight', pushToRemote: true } });
  const dialog = openDialogNode();
  assert.equal(dialog.querySelector('#gg-addtag-type').value, 'lightweight');
  assert.equal(dialog.querySelector('#gg-addtag-push').checked, true);
});

test('Add Tag\'s "push to remote" step calls pushTag with tagName/remotes, matching what the action reads', async () => {
  const { runCalls } = setup();
  const promise = dialogs.gitGraphShowAddTagDialog({ projectId: 'p', folderPath: '/r', commitHash: 'h', remotes: [{ name: 'origin' }] });
  const dialog = openDialogNode();
  dialog.querySelector('#gg-addtag-name').value = 'v1';
  dialog.querySelector('#gg-addtag-push').checked = true;
  dialog.querySelector('.gg-dialog-primary').onclick();
  await promise;
  const pushCall = runCalls.find(c => c.actionId === 'pushTag');
  assert.deepEqual(pushCall.params, { tagName: 'v1', remotes: ['origin'] });
});

// --- Enter submits, Escape cancels, IME composition guard ---

test('Enter on a text field submits the dialog and calls runGitGraphAction with the exact actionId/params', async () => {
  const { runCalls } = setup();
  const promise = dialogs.gitGraphShowCreateBranchDialog({ projectId: 'proj-1', folderPath: '/repo', commitHash: 'deadbeef' });
  const dialog = openDialogNode();
  dialog.querySelector('#gg-createbranch-name').value = 'my-branch';
  global.document._dispatchKeydown({ key: 'Enter', target: dialog.querySelector('#gg-createbranch-name') });
  const result = await promise;
  assert.deepEqual(runCalls, [{ projectId: 'proj-1', folderPath: '/repo', actionId: 'createBranch', params: { name: 'my-branch', commit: 'deadbeef', checkOut: false } }]);
  assert.deepEqual(result, { ok: true });
});

test('Escape cancels the dialog and resolves null without calling any action', async () => {
  const { runCalls } = setup();
  const promise = dialogs.gitGraphShowCreateBranchDialog({ projectId: 'p', folderPath: '/r', commitHash: 'h' });
  global.document._dispatchKeydown({ key: 'Escape' });
  const result = await promise;
  assert.equal(result, null);
  assert.equal(runCalls.length, 0);
  // Escape must also detach the document-level keydown listener.
  assert.equal(global.document._keydownListenerCount(), 0);
});

test('an IME-composition Enter does not submit; a plain Enter right after does', async () => {
  const { runCalls } = setup();
  const promise = dialogs.gitGraphShowCreateBranchDialog({ projectId: 'p', folderPath: '/r', commitHash: 'h' });
  const dialog = openDialogNode();
  dialog.querySelector('#gg-createbranch-name').value = 'ok-name';
  global.document._dispatchKeydown({ key: 'Enter', isComposing: true, target: dialog.querySelector('#gg-createbranch-name') });
  assert.equal(runCalls.length, 0, 'a composing Enter must not submit');
  global.document._dispatchKeydown({ key: 'Enter', keyCode: 229, target: dialog.querySelector('#gg-createbranch-name') });
  assert.equal(runCalls.length, 0, 'a legacy keyCode-229 Enter must not submit either');
  global.document._dispatchKeydown({ key: 'Enter', target: dialog.querySelector('#gg-createbranch-name') });
  await promise;
  assert.equal(runCalls.length, 1);
});

test('a plain Enter inside a <textarea> inserts a newline instead of submitting', async () => {
  const { runCalls } = setup();
  dialogs.gitGraphShowAddTagDialog({ projectId: 'p', folderPath: '/r', commitHash: 'h' });
  const dialog = openDialogNode();
  global.document._dispatchKeydown({ key: 'Enter', target: dialog.querySelector('#gg-addtag-message') });
  assert.equal(runCalls.length, 0);
});

// --- Reference-name validation runs before any action call ---

test('an invalid ref name is rejected before runGitGraphAction is ever called', async () => {
  const { runCalls } = setup();
  const promise = dialogs.gitGraphShowCreateBranchDialog({ projectId: 'p', folderPath: '/r', commitHash: 'h' });
  const dialog = openDialogNode();
  dialog.querySelector('#gg-createbranch-name').value = '-oops';
  dialog.querySelector('.gg-dialog-primary').onclick();
  assert.equal(runCalls.length, 0);
  assert.equal(dialog.querySelector('.gg-dialog-error').hidden, false);
  dialog.querySelector('#gg-createbranch-name').value = 'fine-name';
  dialog.querySelector('.gg-dialog-primary').onclick();
  await promise;
  assert.equal(runCalls.length, 1);
});

test('reference-input space substitution turns typed spaces into hyphens/underscores before validation', async () => {
  const { runCalls } = setup();
  const promise = dialogs.gitGraphShowCreateBranchDialog({ projectId: 'p', folderPath: '/r', commitHash: 'h', spaceSubstitution: 'hyphen' });
  const dialog = openDialogNode();
  dialog.querySelector('#gg-createbranch-name').value = 'my new branch';
  dialog.querySelector('.gg-dialog-primary').onclick();
  await promise;
  assert.equal(runCalls[0].params.name, 'my-new-branch');
});

// --- addTag / createBranch collision-guard follow-up ---

test('Add Tag offers to replace an existing tag on collision, then retries', async () => {
  let call = 0;
  const { runCalls } = setup({
    confirm: () => true,
    runGitGraphAction: ({ actionId }) => {
      call++;
      if (actionId === 'addTag' && call === 1) return { error: 'fatal: tag \'v1\' already exists' };
      return { ok: true };
    },
  });
  const promise = dialogs.gitGraphShowAddTagDialog({ projectId: 'p', folderPath: '/r', commitHash: 'h' });
  const dialog = openDialogNode();
  dialog.querySelector('#gg-addtag-name').value = 'v1';
  dialog.querySelector('.gg-dialog-primary').onclick();
  const result = await promise;
  assert.deepEqual(runCalls.map(c => c.actionId), ['addTag', 'deleteTag', 'addTag']);
  assert.deepEqual(result, { ok: true });
});

test('Add Tag leaves the dialog open with an inline error when the user declines to replace', async () => {
  const { runCalls } = setup({
    confirm: () => false,
    runGitGraphAction: () => ({ error: 'fatal: tag \'v1\' already exists' }),
  });
  dialogs.gitGraphShowAddTagDialog({ projectId: 'p', folderPath: '/r', commitHash: 'h' });
  const dialog = openDialogNode();
  dialog.querySelector('#gg-addtag-name').value = 'v1';
  dialog.querySelector('.gg-dialog-primary').onclick();
  await flushAsync();
  assert.equal(runCalls.length, 1);
  assert.equal(dialog.querySelector('.gg-dialog-error').hidden, false);
});

test('Create Branch offers to replace an existing branch on collision via force-delete then retry', async () => {
  const { runCalls } = setup({
    confirm: () => true,
    runGitGraphAction: ({ actionId }, n) => (actionId === 'createBranch' && n === 1) ? { error: 'fatal: A branch named \'x\' already exists.' } : { ok: true },
  });
  const promise = dialogs.gitGraphShowCreateBranchDialog({ projectId: 'p', folderPath: '/r', commitHash: 'h' });
  const dialog = openDialogNode();
  dialog.querySelector('#gg-createbranch-name').value = 'x';
  dialog.querySelector('.gg-dialog-primary').onclick();
  await promise;
  assert.deepEqual(runCalls.map(c => c.actionId), ['createBranch', 'deleteBranch', 'createBranch']);
  assert.equal(runCalls[1].params.forceDelete, true);
});

// --- Delete Branch not-fully-merged retry ---

test('Delete Branch offers a one-click force-delete retry when git reports the branch is not fully merged', async () => {
  const { runCalls } = setup({
    confirm: () => true,
    runGitGraphAction: (_, n) => (n === 1) ? { error: "error: The branch 'x' is not fully merged." } : { ok: true },
  });
  const promise = dialogs.gitGraphShowDeleteBranchDialog({ projectId: 'p', folderPath: '/r', name: 'x' });
  openDialogNode().querySelector('.gg-dialog-primary').onclick();
  const result = await promise;
  assert.deepEqual(runCalls.map(c => c.params.forceDelete), [false, true]);
  assert.deepEqual(result, { ok: true });
});

test('Delete Branch does not retry when the user declines the force-delete offer', async () => {
  const { runCalls } = setup({
    confirm: () => false,
    runGitGraphAction: () => ({ error: "error: The branch 'x' is not fully merged." }),
  });
  dialogs.gitGraphShowDeleteBranchDialog({ projectId: 'p', folderPath: '/r', name: 'x' });
  openDialogNode().querySelector('.gg-dialog-primary').onclick();
  await Promise.resolve();
  assert.equal(runCalls.length, 1);
});

// --- Multi-remote push (Push Branch / Push Tag) ---

test('Push Branch calls pushBranch once per selected remote and refreshes once after they all resolve', async () => {
  const { runCalls } = setup();
  let refreshed = 0;
  const promise = dialogs.gitGraphShowPushBranchDialog({ projectId: 'p', folderPath: '/r', name: 'feature', remotes: [{ name: 'origin' }, { name: 'upstream' }], refresh: () => refreshed++ });
  const dialog = openDialogNode();
  for (const el of dialog.querySelectorAll('.gg-pushbranch-remote')) el.checked = true;
  dialog.querySelector('.gg-dialog-primary').onclick();
  await promise;
  assert.deepEqual(runCalls.map(c => c.actionId), ['pushBranch', 'pushBranch']);
  assert.deepEqual(runCalls.map(c => c.params.remotes[0]).sort(), ['origin', 'upstream']);
  assert.equal(refreshed, 1);
});

test('Push Branch requires at least one selected remote', async () => {
  const { runCalls } = setup();
  dialogs.gitGraphShowPushBranchDialog({ projectId: 'p', folderPath: '/r', name: 'feature', remotes: [{ name: 'origin' }] });
  const dialog = openDialogNode();
  dialog.querySelector('.gg-pushbranch-remote').checked = false;
  dialog.querySelector('.gg-dialog-primary').onclick();
  await Promise.resolve();
  assert.equal(runCalls.length, 0);
  assert.equal(dialog.querySelector('.gg-dialog-error').hidden, false);
});

test('Push Tag defaults to origin when multiple remotes exist and calls pushTag per selected remote', async () => {
  const { runCalls } = setup();
  const promise = dialogs.gitGraphShowPushTagDialog({ projectId: 'p', folderPath: '/r', name: 'v1', remotes: [{ name: 'upstream' }, { name: 'origin' }] });
  const dialog = openDialogNode();
  assert.equal(dialog.querySelectorAll('.gg-pushtag-remote:checked').length, 1);
  assert.equal(dialog.querySelectorAll('.gg-pushtag-remote:checked')[0].value, 'origin');
  dialog.querySelector('.gg-dialog-primary').onclick();
  await promise;
  assert.deepEqual(runCalls, [{ projectId: 'p', folderPath: '/r', actionId: 'pushTag', params: { tagName: 'v1', remotes: ['origin'] } }]);
});

// --- Checkout Commit: detached-HEAD warning + session "Always Accept" ---

test('Checkout Commit shows the detached-HEAD warning and calls checkoutCommit on confirm', async () => {
  const { runCalls } = setup();
  const promise = dialogs.gitGraphShowCheckoutCommitDialog({ projectId: 'p', folderPath: '/r', commitHash: 'h', commitShortHash: 'h123' });
  const dialog = openDialogNode();
  assert.match(dialog.querySelector('.gg-dialog-body').textContent, /detached HEAD/);
  dialog.querySelector('.gg-dialog-primary').onclick();
  await promise;
  assert.deepEqual(runCalls, [{ projectId: 'p', folderPath: '/r', actionId: 'checkoutCommit', params: { commit: 'h' } }]);
});

test('Checkout Commit\'s Always Accept skips the dialog on every subsequent call this session, scoped per (project, repo)', async () => {
  const { runCalls } = setup();
  const promise = dialogs.gitGraphShowCheckoutCommitDialog({ projectId: 'p', folderPath: '/r', commitHash: 'h1' });
  const dialog = openDialogNode();
  dialog.querySelector('#gg-checkoutcommit-always').checked = true;
  dialog.querySelector('.gg-dialog-primary').onclick();
  await promise;

  await dialogs.gitGraphShowCheckoutCommitDialog({ projectId: 'p', folderPath: '/r', commitHash: 'h2' });
  assert.deepEqual(runCalls.map(c => c.params.commit), ['h1', 'h2']);
  // A different repo under the same project never had "Always Accept" set, so it still confirms.
  const otherRepoPromise = dialogs.gitGraphShowCheckoutCommitDialog({ projectId: 'p', folderPath: '/other', commitHash: 'h3' });
  assert.notEqual(openDialogNode().tag, undefined);
  global.document._dispatchKeydown({ key: 'Escape' });
  await otherRepoPromise;
});

// --- Destructive confirmations (Confirm×2) ---

test('a Hard reset asks for an extra confirmation before running, and skips the action when declined', async () => {
  const { runCalls } = setup({ confirm: () => false });
  dialogs.gitGraphShowResetToCommitDialog({ projectId: 'p', folderPath: '/r', commitHash: 'h', currentBranch: 'main' });
  const dialog = openDialogNode();
  dialog.querySelector('#gg-resettocommit-mode').value = 'hard';
  dialog.querySelector('.gg-dialog-primary').onclick();
  await Promise.resolve();
  assert.equal(runCalls.length, 0);
});

test('a Hard reset proceeds once the extra confirmation is accepted', async () => {
  const { runCalls } = setup({ confirm: () => true });
  const promise = dialogs.gitGraphShowResetToCommitDialog({ projectId: 'p', folderPath: '/r', commitHash: 'h', currentBranch: 'main' });
  const dialog = openDialogNode();
  dialog.querySelector('#gg-resettocommit-mode').value = 'hard';
  dialog.querySelector('.gg-dialog-primary').onclick();
  await promise;
  assert.deepEqual(runCalls, [{ projectId: 'p', folderPath: '/r', actionId: 'resetToCommit', params: { commit: 'h', mode: 'hard' } }]);
});

test('Drop Commit and Drop Stash both run their action directly (the dialog itself is the confirmation)', async () => {
  const { runCalls } = setup();
  const dropCommit = dialogs.gitGraphShowDropCommitDialog({ projectId: 'p', folderPath: '/r', commitHash: 'h', commitShortHash: 'h1' });
  openDialogNode().querySelector('.gg-dialog-primary').onclick();
  await dropCommit;
  const dropStash = dialogs.gitGraphShowDropStashDialog({ projectId: 'p', folderPath: '/r', stashRef: 'stash@{0}' });
  openDialogNode().querySelector('.gg-dialog-primary').onclick();
  await dropStash;
  assert.deepEqual(runCalls.map(c => c.actionId), ['dropCommit', 'stashDrop']);
});

// --- rebaseInteractive: no ref/upstream value is ever written to a PTY/terminal call ---

test('Launch Interactive Rebase calls rebaseInteractive (not rebase) and never invokes a terminal-launch/PTY-write function', async () => {
  const { runCalls } = setup();
  const terminalCalls = [];
  global.launchTerminalSession = (...args) => terminalCalls.push(args);
  global.openRawTerminalSession = (...args) => terminalCalls.push(args);
  const promise = dialogs.gitGraphShowRebaseDialog({ projectId: 'p', folderPath: '/r', currentBranch: 'main', upstream: 'origin/main', upstreamLabel: 'origin/main' });
  const dialog = openDialogNode();
  dialog.querySelector('#gg-rebase-interactive').checked = true;
  dialog.querySelector('.gg-dialog-primary').onclick();
  await promise;
  assert.deepEqual(runCalls, [{ projectId: 'p', folderPath: '/r', actionId: 'rebaseInteractive', params: { upstream: 'origin/main', refType: undefined, remote: undefined } }]);
  assert.equal(terminalCalls.length, 0);
  delete global.launchTerminalSession;
  delete global.openRawTerminalSession;
});

test('a non-interactive Rebase calls the rebase action with ignoreDate and upstream', async () => {
  const { runCalls } = setup();
  const promise = dialogs.gitGraphShowRebaseDialog({ projectId: 'p', folderPath: '/r', currentBranch: 'main', upstream: 'origin/main', upstreamLabel: 'origin/main' });
  openDialogNode().querySelector('.gg-dialog-primary').onclick();
  await promise;
  assert.deepEqual(runCalls, [{ projectId: 'p', folderPath: '/r', actionId: 'rebase', params: { upstream: 'origin/main', refType: undefined, remote: undefined, ignoreDate: true } }]);
});

// --- View Details (annotated tag) is read-only: no action call, single Close button ---

test('View Details has no Cancel button (Close only) and never calls any action', async () => {
  const { runCalls } = setup();
  const promise = dialogs.gitGraphShowTagDetailsDialog({ tag: { name: 'v1', tagger: 'A', email: 'a@example.com', date: 'today', objectHash: 'obj', commitHash: 'c', message: 'hello' } });
  const dialog = openDialogNode();
  assert.equal(dialog.querySelector('.gg-dialog-cancel'), null);
  assert.match(dialog.querySelector('.gg-dialog-body').textContent, /v1/);
  dialog.querySelector('.gg-dialog-primary').onclick();
  const result = await promise;
  assert.equal(result, null);
  assert.equal(runCalls.length, 0);
});

// --- Reset File to this Revision (bonus dialog for the file menu) ---

test('Reset File to this Revision calls resetFileToRevision with the commit and relative path', async () => {
  const { runCalls } = setup();
  const promise = dialogs.gitGraphShowResetFileToRevisionDialog({ projectId: 'p', folderPath: '/r', commitHash: 'h', commitShortHash: 'h1', relativePath: 'src/a.js' });
  openDialogNode().querySelector('.gg-dialog-primary').onclick();
  await promise;
  assert.deepEqual(runCalls, [{ projectId: 'p', folderPath: '/r', actionId: 'resetFileToRevision', params: { commit: 'h', relPath: 'src/a.js' } }]);
});

// --- refresh callback ---

test('refresh is called once on a successful mutating action and never on failure', async () => {
  let refreshedOk = 0;
  setup({ runGitGraphAction: () => ({ ok: true }) });
  await dialogs.gitGraphRunDialogAction({ projectId: 'p', folderPath: '/r', refresh: () => refreshedOk++ }, 'stashPush', {});
  assert.equal(refreshedOk, 1);

  let refreshedFail = 0;
  const failParams = { projectId: 'p', folderPath: '/r', refresh: () => refreshedFail++ };
  global.window.api.runGitGraphAction = async () => ({ error: 'boom' });
  await dialogs.gitGraphRunDialogAction(failParams, 'stashPush', {});
  assert.equal(refreshedFail, 0);
});

// --- Repository Settings Widget — Remotes management ---

test('Add Remote validates the name and calls addRemote with name/url', async () => {
  const { runCalls } = setup();
  const promise = dialogs.gitGraphShowAddRemoteDialog({ projectId: 'p', folderPath: '/r' });
  const dialog = openDialogNode();
  dialog.querySelector('#gg-addremote-name').value = 'up stream'; // contains a space — invalid
  dialog.querySelector('.gg-dialog-primary').onclick();
  await flushAsync();
  assert.equal(runCalls.length, 0, 'an invalid name must never reach the action layer');
  assert.match(dialog.querySelector('.gg-dialog-error').textContent, /can only contain/);

  dialog.querySelector('#gg-addremote-name').value = 'upstream';
  dialog.querySelector('#gg-addremote-url').value = 'https://example.com/x/y.git';
  dialog.querySelector('.gg-dialog-primary').onclick();
  await promise;
  assert.deepEqual(runCalls, [{ projectId: 'p', folderPath: '/r', actionId: 'addRemote', params: { name: 'upstream', url: 'https://example.com/x/y.git' } }]);
});

test('Edit Remote pre-fills the current name/url and calls editRemote with oldName/newName/url', async () => {
  const { runCalls } = setup();
  const promise = dialogs.gitGraphShowEditRemoteDialog({ projectId: 'p', folderPath: '/r' }, { name: 'origin', url: 'https://old/repo.git' });
  const dialog = openDialogNode();
  assert.equal(dialog.querySelector('#gg-editremote-name').value, 'origin');
  assert.equal(dialog.querySelector('#gg-editremote-url').value, 'https://old/repo.git');
  dialog.querySelector('#gg-editremote-url').value = 'https://new/repo.git';
  dialog.querySelector('.gg-dialog-primary').onclick();
  await promise;
  assert.deepEqual(runCalls, [{ projectId: 'p', folderPath: '/r', actionId: 'editRemote', params: { oldName: 'origin', newName: 'origin', url: 'https://new/repo.git' } }]);
});

test('Delete Remote is a danger-styled confirmation that calls deleteRemote', async () => {
  const { runCalls } = setup();
  const promise = dialogs.gitGraphShowDeleteRemoteDialog({ projectId: 'p', folderPath: '/r' }, { name: 'origin' });
  const dialog = openDialogNode();
  assert.match(dialog.querySelector('.gg-dialog-body').textContent, /origin/);
  dialog.querySelector('.gg-dialog-primary').onclick();
  await promise;
  assert.deepEqual(runCalls, [{ projectId: 'p', folderPath: '/r', actionId: 'deleteRemote', params: { name: 'origin' } }]);
});

test('Fetch Remote defaults Prune/Prune Tags to unchecked, matching the documented default, and calls fetchRemote', async () => {
  const { runCalls } = setup();
  const promise = dialogs.gitGraphShowFetchRemoteDialog({ projectId: 'p', folderPath: '/r' }, { name: 'origin' });
  const dialog = openDialogNode();
  assert.equal(dialog.querySelector('#gg-fetchremote-prune').checked, false);
  assert.equal(dialog.querySelector('#gg-fetchremote-prunetags').checked, false);
  dialog.querySelector('#gg-fetchremote-prune').checked = true;
  dialog.querySelector('.gg-dialog-primary').onclick();
  await promise;
  assert.deepEqual(runCalls, [{ projectId: 'p', folderPath: '/r', actionId: 'fetchRemote', params: { remote: 'origin', prune: true, pruneTags: false } }]);
});

// --- Repository Settings Widget — User Details ---

test('gitGraphDiffUserDetailsField: unchanged is untouched, cleared is unset, changed is set', () => {
  assert.equal(dialogs.gitGraphDiffUserDetailsField('Alice', 'Alice'), undefined);
  assert.equal(dialogs.gitGraphDiffUserDetailsField('Alice', ''), null);
  assert.equal(dialogs.gitGraphDiffUserDetailsField('', ''), undefined, 'an already-empty field left empty is untouched, not unset again');
  assert.equal(dialogs.gitGraphDiffUserDetailsField(null, ''), undefined);
  assert.equal(dialogs.gitGraphDiffUserDetailsField('Alice', 'Bob'), 'Bob');
});

test('User Details shows the global value as the local field\'s placeholder when there is no local override', async () => {
  setup();
  const current = { local: { name: null, email: null }, global: { name: 'Global Name', email: 'global@example.com' } };
  dialogs.gitGraphShowUserDetailsDialog({ projectId: 'p', folderPath: '/r' }, current);
  const dialog = openDialogNode();
  assert.equal(dialog.querySelector('#gg-userdetails-local-name').getAttribute('placeholder'), 'Global Name');
  assert.equal(dialog.querySelector('#gg-userdetails-local-name').value, '');
});

test('User Details only calls setUserDetails for the scope(s) that actually changed', async () => {
  const { runCalls } = setup();
  const current = { local: { name: 'Old Local', email: 'old-local@example.com' }, global: { name: 'Old Global', email: 'old-global@example.com' } };
  const promise = dialogs.gitGraphShowUserDetailsDialog({ projectId: 'p', folderPath: '/r' }, current);
  const dialog = openDialogNode();
  dialog.querySelector('#gg-userdetails-local-name').value = 'New Local';
  // Global fields left exactly as pre-filled.
  dialog.querySelector('.gg-dialog-primary').onclick();
  await promise;
  assert.deepEqual(runCalls, [{ projectId: 'p', folderPath: '/r', actionId: 'setUserDetails', params: { global: false, name: 'New Local' } }]);
});

test('User Details clearing a local override sends an explicit unset (null), not an empty string', async () => {
  const { runCalls } = setup();
  const current = { local: { name: 'Old Local', email: null }, global: { name: 'Old Global', email: null } };
  const promise = dialogs.gitGraphShowUserDetailsDialog({ projectId: 'p', folderPath: '/r' }, current);
  const dialog = openDialogNode();
  dialog.querySelector('#gg-userdetails-local-name').value = '';
  dialog.querySelector('.gg-dialog-primary').onclick();
  await promise;
  assert.deepEqual(runCalls, [{ projectId: 'p', folderPath: '/r', actionId: 'setUserDetails', params: { global: false, name: null } }]);
});

test('User Details with nothing changed in either scope resolves null without calling any action', async () => {
  const { runCalls } = setup();
  const current = { local: { name: 'Same', email: 'same@example.com' }, global: { name: 'Same Global', email: 'sg@example.com' } };
  const promise = dialogs.gitGraphShowUserDetailsDialog({ projectId: 'p', folderPath: '/r' }, current);
  openDialogNode().querySelector('.gg-dialog-primary').onclick();
  const result = await promise;
  assert.equal(result, null);
  assert.equal(runCalls.length, 0);
});

// --- Repository Settings Widget — Issue Linking: pure config, no action call ---

test('gitGraphGuessIssueRegex prefers a plain #123 convention over a JIRA-style key', () => {
  assert.equal(dialogs.gitGraphGuessIssueRegex(['fix #42', 'PROJ-7: something']), '#(\\d+)');
  assert.equal(dialogs.gitGraphGuessIssueRegex(['PROJ-7: something', 'ABC-99: other']), '([A-Z][A-Z0-9]+-\\d+)');
  assert.equal(dialogs.gitGraphGuessIssueRegex(['just a plain message']), '');
});

test('Issue Linking auto-prefills an empty Issue Regex from sample subjects but never overwrites an existing one', async () => {
  setup();
  dialogs.gitGraphShowIssueLinkingDialog({ projectId: 'p', folderPath: '/r', sampleSubjects: ['fix #42'] }, {});
  assert.equal(openDialogNode().querySelector('#gg-issuelinking-regex').value, '#(\\d+)');

  dialogs.gitGraphShowIssueLinkingDialog({ projectId: 'p', folderPath: '/r', sampleSubjects: ['fix #42'] }, { regex: 'EXISTING-(\\d+)' });
  assert.equal(openDialogNode().querySelector('#gg-issuelinking-regex').value, 'EXISTING-(\\d+)');
});

test('Issue Linking resolves the new config and never calls runGitGraphAction', async () => {
  const { runCalls } = setup();
  const promise = dialogs.gitGraphShowIssueLinkingDialog({ projectId: 'p', folderPath: '/r' }, {});
  const dialog = openDialogNode();
  dialog.querySelector('#gg-issuelinking-regex').value = '#(\\d+)';
  dialog.querySelector('#gg-issuelinking-url').value = 'https://example.com/issues/$1';
  dialog.querySelector('#gg-issuelinking-global').checked = true;
  dialog.querySelector('.gg-dialog-primary').onclick();
  const result = await promise;
  assert.deepEqual(result, { regex: '#(\\d+)', url: 'https://example.com/issues/$1', useGlobally: true });
  assert.equal(runCalls.length, 0);
});

test('Issue Linking rejects an invalid regular expression before resolving', async () => {
  setup();
  const promise = dialogs.gitGraphShowIssueLinkingDialog({ projectId: 'p', folderPath: '/r' }, {});
  const dialog = openDialogNode();
  dialog.querySelector('#gg-issuelinking-regex').value = '(unclosed';
  dialog.querySelector('.gg-dialog-primary').onclick();
  await flushAsync();
  assert.match(dialog.querySelector('.gg-dialog-error').textContent, /not a valid regular expression/);
  dialog.querySelector('#gg-issuelinking-regex').value = '';
  dialog.querySelector('.gg-dialog-primary').onclick();
  await promise;
});

// --- Repository Settings Widget — Pull Request Creation config: pure config ---

test('Pull Request Config resolves provider/remotes/destBranch and never calls runGitGraphAction', async () => {
  const { runCalls } = setup();
  const ctx = { projectId: 'p', folderPath: '/r', remotes: [{ name: 'origin' }, { name: 'fork' }], defaultBranch: 'main' };
  const promise = dialogs.gitGraphShowPullRequestConfigDialog(ctx, {});
  const dialog = openDialogNode();
  assert.equal(dialog.querySelector('#gg-prconfig-destbranch').value, 'main');
  dialog.querySelector('#gg-prconfig-sourceremote').value = 'fork';
  dialog.querySelector('.gg-dialog-primary').onclick();
  const result = await promise;
  assert.equal(result.kind, 'github');
  assert.equal(result.sourceRemote, 'fork');
  assert.equal(result.destBranch, 'main');
  assert.equal(runCalls.length, 0);
});

test('Pull Request Config: choosing Custom requires picking a configured custom provider', async () => {
  setup();
  const ctx = { projectId: 'p', folderPath: '/r', remotes: [{ name: 'origin' }], customProviders: [{ name: 'MyGitea', templateUrl: 'https://gitea.example/$1/$2' }] };
  const promise = dialogs.gitGraphShowPullRequestConfigDialog(ctx, {});
  const dialog = openDialogNode();
  dialog.querySelector('#gg-prconfig-provider').value = 'custom';
  dialog.querySelector('.gg-dialog-primary').onclick();
  await flushAsync();
  assert.match(dialog.querySelector('.gg-dialog-error').textContent, /Select a custom provider/);

  dialog.querySelector('#gg-prconfig-customname').value = 'MyGitea';
  dialog.querySelector('.gg-dialog-primary').onclick();
  const result = await promise;
  assert.equal(result.kind, 'custom');
  assert.equal(result.name, 'MyGitea');
  assert.equal(result.templateUrl, 'https://gitea.example/$1/$2');
});

// --- Trust prompt for a repo-committed .switchboard-git-graph.json ---

test('gitGraphSummarizeTrustFields lists only the fields actually present in the untrusted config', () => {
  assert.deepEqual(dialogs.gitGraphSummarizeTrustFields({}), []);
  assert.deepEqual(
    dialogs.gitGraphSummarizeTrustFields({ customDisplayName: 'Shared', issueLinking: { regex: '#(\\d+)', url: 'https://x/$1' } }),
    ['Display name: Shared', 'Issue Linking: #(\\d+) → https://x/$1'],
  );
});

test('Trust Repo Config resolves true on Trust and Apply, false on Not Now / Escape', async () => {
  setup();
  const trusted = dialogs.gitGraphShowTrustRepoConfigDialog({ projectId: 'p', folderPath: '/r' }, { customDisplayName: 'Shared config' });
  const dialog1 = openDialogNode();
  assert.match(dialog1.querySelector('.gg-dialog-body').textContent, /Shared config/);
  dialog1.querySelector('.gg-dialog-primary').onclick();
  assert.equal(await trusted, true);

  const declined = dialogs.gitGraphShowTrustRepoConfigDialog({ projectId: 'p', folderPath: '/r' }, {});
  openDialogNode().querySelector('.gg-dialog-cancel').onclick();
  assert.equal(await declined, false);

  const escaped = dialogs.gitGraphShowTrustRepoConfigDialog({ projectId: 'p', folderPath: '/r' }, {});
  global.document._dispatchKeydown({ key: 'Escape' });
  assert.equal(await escaped, false);
});

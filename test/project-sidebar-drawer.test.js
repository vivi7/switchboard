const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { parsePlan, parseTodos } = require('../public/plan-parser');

const source = fs.readFileSync(path.join(__dirname, '../public/projects-view.js'), 'utf8');
const between = (from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `markers ${from} … ${to}`);
  return source.slice(start, end);
};

// --- Navigation: the Session tab and the session it remembers ---

function navigation({ open = ['s1'] } = {}) {
  const project = { id: 'p1' };
  const sessions = new Map([['s1', { sessionId: 's1', projectId: 'p1' }], ['s2', { sessionId: 's2', projectId: 'p2' }]]);
  const context = vm.createContext({
    projectsUi: { selectedProjectId: 'p1', navigationByProject: new Map() },
    openSessions: new Map(open.map(id => [id, { session: sessions.get(id) }])),
    sessionMap: sessions,
    projectForSession: session => session ? { project: { id: session.projectId } } : null,
  });
  vm.runInContext(between('const PROJECT_WORKSPACE_TABS', 'const projectViewer = document.getElementById'), context);
  return { context, project };
}

test('opening a session selects the Session tab and leaving it keeps the session', () => {
  const { context, project } = navigation();
  context.rememberProjectSession(project, 's1');
  assert.equal(context.projectTab(project), 'session');
  assert.equal(context.projectTabSession(project)?.sessionId, 's1');

  context.setProjectTab(project, 'plan');
  context.rememberProjectOverview(project);
  assert.equal(context.projectTab(project), 'plan', 'another tab stays where the user put it');
  assert.equal(context.projectNavigation(project).sessionId, 's1', 'the Session tab can bring it back');

  context.setProjectTab(project, 'session');
  context.rememberProjectOverview(project);
  assert.equal(context.projectTab(project), 'overview', 'the page never stays on Session without the terminal');
});

test('a session whose terminal is gone takes the Session tab with it', () => {
  const { context, project } = navigation({ open: [] });
  context.rememberProjectSession(project, 's1');
  assert.equal(context.projectTabSession(project), null, 'no open terminal, nothing to show');

  const live = navigation();
  live.context.rememberProjectSession(live.project, 's1');
  live.context.forgetProjectSessionState('s1');
  assert.equal(live.context.projectTab(live.project), 'overview');
  assert.equal(live.context.projectNavigation(live.project).sessionId, null);
});

test("the Session tab only shows the project's own session", () => {
  const { context, project } = navigation({ open: ['s2'] });
  context.rememberProjectSession(project, 's2');
  assert.equal(context.projectTabSession(project), null);
});

// --- Plan and todo counts on the drawer's bar ---

function stats(files) {
  const context = vm.createContext({
    parsePlan, parseTodos,
    fileContent: (_project, name) => files[name] ?? null,
  });
  vm.runInContext(between('function projectDrawerStats(', '/**\n * Everything the old Sessions column showed'), context);
  return context;
}

test('the drawer shows plan phases done of all and todos open of all', () => {
  const context = stats({
    'plan-tracker.md': '## [x] Phase 1: One\n- [x] a\n\n## Phase 2: Two\n- [ ] b\n\n## Phase 3: Three\n- [ ] c\n',
    'todos.md': '- [ ] first\n- [x] second\n- [ ] third\n',
  });
  const numbers = context.projectDrawerStats({ id: 'p1' });
  assert.deepEqual({ ...numbers }, { planDone: 1, planTotal: 3, todosOpen: 2, todosTotal: 3 });
  const html = context.projectDrawerStatsHtml(numbers);
  assert.match(html, /<span>Plan<\/span> <b>1<\/b>\/3/);
  assert.match(html, /<span>Todos<\/span> <b>2<\/b>\/3 open/);
  assert.match(html, /title="1 of 3 phases done\. Open plan-tracker\.md"/);
  assert.match(html, /title="2 open of 3 todos\. Open todos\.md"/);
  assert.match(html, /data-file="plan-tracker\.md"/);
  assert.match(html, /data-file="todos\.md"/);
});

test('a project with no plan or todos shows a dash, not 0/0', () => {
  const context = stats({ 'plan-tracker.md': '', 'todos.md': '' });
  const html = context.projectDrawerStatsHtml(context.projectDrawerStats({ id: 'p1' }));
  assert.match(html, /<span>Plan<\/span> —/);
  assert.match(html, /<span>Todos<\/span> —/);
  assert.doesNotMatch(html, /0\/0/);
});

// --- Redrawing a drawer ---

function drawer({ current, next, focused = false }) {
  const replaced = [];
  const focus = [];
  const input = { selectionStart: 2, selectionEnd: 4 };
  const fresh = { focus: () => focus.push('focus'), setSelectionRange: (a, b) => focus.push([a, b]) };
  const el = {
    innerHTML: current,
    querySelector: () => (replaced.length ? fresh : input),
    replaceChildren: (...nodes) => replaced.push(nodes),
  };
  const context = vm.createContext({
    document: { activeElement: focused ? input : null },
    fileContent: () => '',
    loadProjectFiles: () => Promise.resolve(),
    refreshProjectDrawer() {},
    buildProjectDrawer: () => ({ innerHTML: next, childNodes: ['bar', 'search', 'list'] }),
  });
  vm.runInContext(between('const drawerFilesLoading', '/** Redraw one project\'s drawer, if it is open. */'), context);
  context.renderProjectDrawer({ id: 'p1' }, el);
  return { replaced, focus };
}

test('a drawer whose rows did not change is left alone', () => {
  const { replaced } = drawer({ current: '<b>same</b>', next: '<b>same</b>' });
  assert.equal(replaced.length, 0);
});

test('a changed drawer is rebuilt and keeps the cursor in its search field', () => {
  const { replaced, focus } = drawer({ current: '<b>old</b>', next: '<b>new</b>', focused: true });
  assert.deepEqual(replaced, [['bar', 'search', 'list']]);
  assert.deepEqual(focus, ['focus', [2, 4]]);
});

// --- Cmd+Shift+[ / ] while a session is open ---

function navRows({ drawerOpen }) {
  const project = { id: 'p1' };
  const context = vm.createContext({
    selectedProject: () => project,
    paneGroupMode: () => 'time',
    groupSessions: () => [{ sessions: [{ sessionId: 'a' }, { sessionId: 'b' }] }, { sessions: [{ sessionId: 'c' }] }],
    document: {
      getElementById: id => (drawerOpen && id === 'proj-drawer-p1'
        ? { querySelectorAll: () => [{ dataset: { sessionId: 'c' } }, { dataset: { sessionId: 'a' } }] }
        : null),
    },
  });
  vm.runInContext(between('function workingSessionNavRows(', 'function selectProject('), context);
  return [...context.workingSessionNavRows()].map(row => row.dataset.sessionId);
}

test('session navigation follows the open drawer, or its grouping when closed', () => {
  assert.deepEqual(navRows({ drawerOpen: true }), ['c', 'a']);
  assert.deepEqual(navRows({ drawerOpen: false }), ['a', 'b', 'c']);
});

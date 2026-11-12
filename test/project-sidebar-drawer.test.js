const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { parsePlan, parseTodos } = require('../public/plan-parser');

// Arrays built inside a vm context have that context's prototypes.
const plain = value => JSON.parse(JSON.stringify(value));

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
  vm.runInContext(between('function projectDrawerStats(', '/**\n * The drawer under a project row'), context);
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

function redraw(current, next) {
  const replaced = [];
  const el = { innerHTML: current, replaceChildren: (...nodes) => replaced.push(nodes) };
  const context = vm.createContext({});
  vm.runInContext(between('function replaceDrawerContent(', 'const drawerFilesLoading'), context);
  const changed = context.replaceDrawerContent(el, { innerHTML: next, childNodes: ['bar', 'list'] });
  return { changed, replaced };
}

test('a drawer whose rows did not change is left alone', () => {
  const { changed, replaced } = redraw('<b>same</b>', '<b>same</b>');
  assert.equal(changed, false);
  assert.equal(replaced.length, 0, 'no flicker under the pointer while a session writes');
});

test('a changed drawer gets the new content', () => {
  const { changed, replaced } = redraw('<b>old</b>', '<b>new</b>');
  assert.equal(changed, true);
  assert.deepEqual(replaced, [['bar', 'list']]);
});

// --- The sidebar search opens the drawers that hold matches ---

function drawers({ matches = null, expanded = {} } = {}) {
  const projects = [
    { id: 'p1', sessions: [{ sessionId: 'a' }], tracks: [{ sessions: [{ sessionId: 'b', archived: 1 }] }] },
    { id: 'p2', sessions: [{ sessionId: 'c' }], tracks: [] },
  ];
  let renders = 0;
  const context = vm.createContext({
    searchMatchIds: matches ? new Set(matches) : null,
    projectsUi: { expandedProjects: { ...expanded }, searchDrawerOverride: new Map() },
    cachedProjectTreeAll: { projects },
    projectSessionsAll: p => [...p.sessions, ...p.tracks.flatMap(t => t.sessions)],
    sessionEventTime: () => 0,
    findTreeProject: id => projects.find(p => p.id === id),
    saveProjectsUi() {},
    renderProjectList: () => renders++,
  });
  vm.runInContext(between('function projectSearchMatches(', '/** Plan phases done of all'), context);
  return { context, projects, renders: () => renders };
}

test('without a search only the chevron opens a drawer', () => {
  const { context, projects } = drawers({ expanded: { p2: true } });
  assert.equal(context.projectDrawerOpen(projects[0]), false);
  assert.equal(context.projectDrawerOpen(projects[1]), true);
  context.toggleProjectDrawer('p1');
  assert.equal(context.projectDrawerOpen(projects[0]), true);
  assert.equal(context.projectsUi.expandedProjects.p1, true);
});

test('a search opens the drawers with matching sessions, archived ones included', () => {
  const { context, projects } = drawers({ matches: ['b'] });
  assert.deepEqual(context.projectSearchMatches(projects[0]).map(s => s.sessionId), ['b']);
  assert.equal(context.projectDrawerOpen(projects[0]), true, 'the archived match counts');
  assert.equal(context.projectDrawerOpen(projects[1]), false, 'no match, still closed');
});

test('closing a drawer during a search keeps it closed for that search only', () => {
  const { context, projects } = drawers({ matches: ['a'], expanded: { p1: true } });
  context.toggleProjectDrawer('p1');
  assert.equal(context.projectDrawerOpen(projects[0]), false, 'the click wins over the match');
  assert.equal(context.projectsUi.expandedProjects.p1, undefined, 'and is remembered after the search');
  context.searchMatchIds = null;
  context.projectsUi.searchDrawerOverride.clear();
  assert.equal(context.projectDrawerOpen(projects[0]), false);
});

// --- "No project": the sessions outside every project ---

function others({ matches = null, archived = false } = {}) {
  const at = t => ({ t });
  const folders = [
    { projectPath: '/w/old', sessions: [{ sessionId: 'o1', ...at(10) }] },
    { projectPath: '/w/app', sessions: [{ sessionId: 'a1', ...at(20) }, { sessionId: 'a2', ...at(50), projectId: 'p1' }, { sessionId: 'a3', ...at(30) }] },
    { projectPath: '/w/filed', sessions: [{ sessionId: 'f1', ...at(99), projectId: 'p1' }] },
  ];
  const all = [...folders, { projectPath: '/w/archive', sessions: [{ sessionId: 'z1', archived: 1, ...at(5) }] }];
  const context = vm.createContext({
    searchMatchIds: matches ? new Set(matches) : null,
    showArchived: archived,
    cachedProjects: folders,
    cachedAllProjects: all,
    projectForSession: s => (s.projectId ? { project: { id: s.projectId } } : null),
    sessionEventTime: s => s.t,
    projectsUi: { otherOpen: false, searchDrawerOverride: new Map() },
  });
  vm.runInContext(between('function sessionsWithoutProject(', 'function toggleOtherSessions('), context);
  return context;
}

test('sessions outside every project, by folder, newest folder and session first', () => {
  const groups = others().sessionsWithoutProject();
  assert.deepEqual(plain(groups.map(g => [g.folder.projectPath, g.sessions.map(s => s.sessionId)])), [
    ['/w/app', ['a3', 'a1']],
    ['/w/old', ['o1']],
  ], 'a session filed in a project and a folder with only those stay out');
});

test('archived sessions follow the Archive switch, and a search narrows the list', () => {
  assert.deepEqual(plain(others({ archived: true }).sessionsWithoutProject().map(g => g.folder.projectPath)), ['/w/app', '/w/old', '/w/archive']);
  const searching = others({ matches: ['o1', 'z1'] });
  assert.deepEqual(plain(searching.sessionsWithoutProject().map(g => g.sessions.map(s => s.sessionId))), [['o1'], ['z1']]);
  assert.equal(searching.otherSessionsOpen(), true, 'a search opens the row');
  assert.equal(others().otherSessionsOpen(), false, 'closed by default');
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

function tabRows({ working = false, active = null, viewerShown = true }) {
  const row = id => ({ dataset: { sessionId: id } });
  const context = vm.createContext({
    projectsUi: { working },
    workingSessionNavRows: () => [row('drawer')],
    activeSessionId: active,
    sessionMap: new Map([['loose', { sessionId: 'loose' }], ['filed', { sessionId: 'filed', projectId: 'p1' }]]),
    projectForSession: s => (s.projectId ? { project: { id: s.projectId } } : null),
    projectViewer: { style: { display: viewerShown ? 'flex' : 'none' }, querySelectorAll: () => [row('card')] },
    document: { getElementById: id => (id === 'proj-drawer-other' ? { querySelectorAll: () => [row('other')] } : null) },
  });
  vm.runInContext(between('function projectsTabNavRows(', 'function workingSessionNavRows('), context);
  return plain(context.projectsTabNavRows().map(r => r.dataset.sessionId));
}

test('in the Projects tab, navigation follows the list the session on screen came from', () => {
  assert.deepEqual(tabRows({ working: true }), ['drawer'], 'Session tab: the project drawer');
  assert.deepEqual(tabRows({ active: 'loose', viewerShown: false }), ['other'], 'a session outside every project: the No project list');
  assert.deepEqual(tabRows({ active: 'filed' }), ['card'], 'the page: its track cards');
});

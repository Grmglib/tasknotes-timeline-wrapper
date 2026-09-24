'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createTaskNotesAdapter, SOURCE, REQUIRED_CAPS } = require('../src/tasknotes-adapter');
const { mapTaskInfo, isStatusCompleted } = require('../src/task-mapper');

function mockApp(plugin) {
  return {
    plugins: {
      getPlugin: (id) => (id === 'tasknotes' ? plugin : null),
      plugins: plugin ? { tasknotes: plugin } : {},
    },
  };
}

function mockApi(overrides = {}) {
  const caps = new Set(overrides.capabilities || ['tasks.read', 'tasks.write', 'query.tasks', 'ui.task-menu', 'lifecycle.events']);
  const tasks = {
    list: async (query) => overrides.listResult || [],
    get: async (path) => overrides.getResult || null,
    create: async (data, context) => ({ path: 'TaskNotes/Tasks/x.md', ...data, _context: context }),
    complete: async (path, options, context) => ({ path, status: 'done', options, _context: context }),
    uncomplete: async (path, options, context) => ({ path, status: (options && options.status) || 'open', options, _context: context }),
    setStatus: async (path, status, context) => ({ path, status, _context: context }),
    ...(overrides.tasks || {}),
  };
  return {
    apiVersion: overrides.apiVersion != null ? overrides.apiVersion : 1,
    hasCapability: (name) => caps.has(name),
    capabilities: [...caps],
    tasks,
    query: {
      tasks: async (q) => overrides.queryResult || { tasks: overrides.listResult || [] },
    },
    ui: {
      taskMenu: {
        show: (opts) => { overrides.lastMenu = opts; },
        populate: () => {},
      },
    },
    lifecycle: {
      on: () => ({}),
    },
    settings: {
      snapshot: () => overrides.settings || {},
    },
    ...(overrides.api || {}),
  };
}

describe('createTaskNotesAdapter compatibility', () => {
  it('fails when TaskNotes is missing', () => {
    const adapter = createTaskNotesAdapter(mockApp(null));
    const compat = adapter.getCompatibility();
    assert.equal(compat.ok, false);
    assert.match(compat.message, /not installed/i);
    assert.deepEqual(compat.missingCaps, REQUIRED_CAPS);
  });

  it('fails when api is missing', () => {
    const adapter = createTaskNotesAdapter(mockApp({}));
    const compat = adapter.getCompatibility();
    assert.equal(compat.ok, false);
    assert.match(compat.message, /Runtime API/i);
  });

  it('fails on unsupported apiVersion', () => {
    const adapter = createTaskNotesAdapter(mockApp({ api: mockApi({ apiVersion: 2 }) }));
    const compat = adapter.getCompatibility();
    assert.equal(compat.ok, false);
    assert.equal(compat.apiVersion, 2);
  });

  it('fails when required capabilities are missing', () => {
    const adapter = createTaskNotesAdapter(mockApp({
      api: mockApi({ capabilities: ['tasks.read'] }),
    }));
    const compat = adapter.getCompatibility();
    assert.equal(compat.ok, false);
    assert.deepEqual(compat.missingCaps, ['tasks.write']);
  });

  it('succeeds for apiVersion 1 with tasks.read and tasks.write', () => {
    const adapter = createTaskNotesAdapter(mockApp({ api: mockApi() }));
    const compat = adapter.getCompatibility();
    assert.equal(compat.ok, true);
    assert.equal(compat.apiVersion, 1);
    assert.deepEqual(compat.missingCaps, []);
  });
});

describe('createTaskNotesAdapter mutations', () => {
  it('passes source context on create/complete/uncomplete', async () => {
    const adapter = createTaskNotesAdapter(mockApp({ api: mockApi() }));
    const created = await adapter.createTask({ title: 'Hello' });
    assert.equal(created._context.source, SOURCE);
    const done = await adapter.complete('a.md');
    assert.equal(done._context.source, SOURCE);
    const open = await adapter.uncomplete('a.md', { status: 'in-progress' });
    assert.equal(open._context.source, SOURCE);
    assert.equal(open.status, 'in-progress');
  });

  it('listTasks uses api.tasks.list without local tag filtering', async () => {
    const listResult = [
      { path: 'Tasks/by-property.md', title: 'Property task', status: 'open', tags: [] },
      { path: 'Tasks/by-tag.md', title: 'Tagged', status: 'open', tags: ['task'] },
    ];
    const adapter = createTaskNotesAdapter(mockApp({ api: mockApi({ listResult }) }));
    const listed = await adapter.listTasks({ scope: { includeArchived: false } });
    assert.equal(listed.length, 2);
    assert.equal(listed[0].path, 'Tasks/by-property.md');
    assert.deepEqual(listed[0].tags, []);
  });
});

describe('createTaskNotesAdapter calendar', () => {
  it('listCalendarEvents merges ICS/Google/Microsoft and skips disabled calendars', () => {
    const plugin = {
      api: mockApi(),
      icsSubscriptionService: {
        getSubscriptions: () => [{ id: 'sub1', name: 'ICS Cal', enabled: true, color: '#111' }],
        getAllEvents: () => [
          { id: 'ics-1', subscriptionId: 'sub1', title: 'ICS event', start: '2026-09-21T10:00:00' },
        ],
      },
      googleCalendarService: {
        getAvailableCalendars: () => [
          { id: 'g1', summary: 'Work', selected: true, backgroundColor: '#4285F4' },
          { id: 'g2', summary: 'Hidden', selected: false },
        ],
        getAllEvents: () => [
          { id: 'g-ok', subscriptionId: 'google-g1', title: 'Google ok', start: '2026-09-21T11:00:00' },
          { id: 'g-skip', subscriptionId: 'google-g2', title: 'Google skip', start: '2026-09-21T12:00:00' },
        ],
      },
      microsoftCalendarService: {
        getAvailableCalendars: () => [{ id: 'm1', name: 'Outlook', enabled: true }],
        getAllEvents: () => {
          throw new Error('provider boom');
        },
      },
    };
    const adapter = createTaskNotesAdapter(mockApp(plugin));
    const events = adapter.listCalendarEvents();
    assert.equal(events.length, 2);
    assert.equal(events[0].title, 'ICS event');
    assert.equal(events[0].calendarName, 'ICS Cal');
    assert.equal(events[1].title, 'Google ok');
    assert.equal(events[1].isEvent, true);
    assert.deepEqual(adapter.getCalendarReadErrors(), [
      { source: 'Microsoft Calendar', message: 'provider boom' },
    ]);
  });

  it('createTaskFromEvent requires icsNoteService and succeeds when present', async () => {
    const missing = createTaskNotesAdapter(mockApp({ api: mockApi() }));
    await assert.rejects(
      () => missing.createTaskFromEvent({ title: 'x' }),
      /calendar integration is not available/i,
    );

    const plugin = {
      api: mockApi(),
      icsNoteService: {
        createTaskFromICS: async (ev) => ({ file: { path: 't.md' }, taskInfo: { title: ev.title } }),
        createNoteFromICS: async () => ({}),
        findRelatedNotes: async () => [{ path: 'n.md', title: 'Related' }],
      },
    };
    const adapter = createTaskNotesAdapter(mockApp(plugin));
    const created = await adapter.createTaskFromEvent({ title: 'From cal' });
    assert.equal(created.taskInfo.title, 'From cal');
    assert.equal(adapter.canCreateFromEvents(), true);
    assert.equal(adapter.canFindRelatedNotes(), true);
    const related = await adapter.findRelatedNotes({ id: '1' });
    assert.equal(related.length, 1);
  });
});

describe('mapTaskInfo', () => {
  const cfg = {
    taskTag: 'task',
    defaultStatus: 'open',
    statusMap: {
      open: { value: 'open', isCompleted: false },
      done: { value: 'done', isCompleted: true },
      waiting: { value: 'waiting', isCompleted: false },
    },
  };

  it('maps TaskInfo including property-identified tasks without the task tag', () => {
    const file = { path: 'x.md', basename: 'x' };
    const mapped = mapTaskInfo({
      path: 'x.md',
      title: 'From property',
      status: 'waiting',
      priority: 'high',
      tags: ['work'],
      due: '2026-09-21',
      projects: ['[[Project A]]'],
    }, cfg, () => file);
    assert.equal(mapped.title, 'From property');
    assert.equal(mapped.status, 'waiting');
    assert.equal(mapped.done, false);
    assert.deepEqual(mapped.tags, ['work']);
    assert.deepEqual(mapped.projects, ['Project A']);
    assert.equal(mapped.file, file);
  });

  it('marks completed statuses as done', () => {
    const file = { path: 'y.md', basename: 'y' };
    const mapped = mapTaskInfo({
      path: 'y.md',
      title: 'Done task',
      status: 'done',
      tags: [],
    }, cfg, () => file);
    assert.equal(mapped.done, true);
    assert.equal(isStatusCompleted('done', cfg), true);
    assert.equal(isStatusCompleted('open', cfg), false);
  });

  it('returns null when the vault file cannot be resolved', () => {
    assert.equal(mapTaskInfo({ path: 'missing.md', title: 'x' }, cfg, () => null), null);
  });
});

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  searchAgendaItems,
  parseSearchQuery,
  toggleCollapsed,
  isCurrentRender,
  findFocusTarget,
  dateWithExistingTime,
  taskPath,
} = require('../src/agenda-model');

const localDateKey = (value) => String(value || '').slice(0, 10) || null;
const cfg = { statusMap: { open: {}, doing: {}, done: {} } };

describe('searchAgendaItems', () => {
  it('preserves the existing catalog scope, including completed and far-future tasks', () => {
    const catalog = [
      { title: 'Report later', status: 'open', scheduled: '2030-01-01', done: false },
      { title: 'Report archived', status: 'done', due: '2020-01-01', done: true },
    ];
    const { tasks } = searchAgendaItems({
      taskCatalog: catalog,
      eventBuckets: new Map(),
      query: 'report',
      filter: null,
      cfg,
      todayKey: '2026-01-01',
      localDateKey,
    });
    assert.deepEqual(tasks.map((task) => task.title), ['Report archived', 'Report later']);
  });

  it('sorts matches by date, then configured status order, and respects active filters', () => {
    const catalog = [
      { title: 'Task B', status: 'doing', scheduled: '2026-05-02', done: false },
      { title: 'Task C', status: 'open', scheduled: '2026-05-01', done: false },
      { title: 'Task A', status: 'open', scheduled: '2026-05-02', done: false },
      { title: 'Task D', status: 'done', scheduled: '2026-05-02', done: true },
    ];
    const { tasks } = searchAgendaItems({
      taskCatalog: catalog,
      eventBuckets: new Map(),
      query: 'task',
      filter: 'todo',
      cfg,
      todayKey: '2026-05-01',
      localDateKey,
    });
    assert.deepEqual(tasks.map((task) => task.title), ['Task C', 'Task A', 'Task B']);
  });

  it('matches calendar event details and deduplicates events across day buckets', () => {
    const event = { id: 'event-1', title: 'Planning', location: 'North room' };
    const { events, results } = searchAgendaItems({
      taskCatalog: [],
      eventBuckets: new Map([['2026-05-01', [event]], ['2026-05-02', [event]]]),
      query: 'north room',
      filter: null,
      cfg,
      todayKey: '2026-05-01',
      localDateKey,
    });
    assert.deepEqual(events, [event]);
    assert.deepEqual(results, [event]);
  });

  it('parses task filters while preserving free-text search', () => {
    assert.deepEqual(parseSearchQuery('project review status:todo tag:"work tasks" due:today'), {
      text: 'project review',
      filters: [
        { field: 'status', value: 'todo' },
        { field: 'tag', value: 'work tasks' },
        { field: 'due', value: 'today' },
      ],
    });
  });

  it('combines status, tag, due-date, and free-text filters', () => {
    const catalog = [
      { title: 'Prepare report', status: 'open', tags: ['work'], due: '2026-05-01', done: false },
      { title: 'Prepare report later', status: 'open', tags: ['work'], due: '2026-05-02', done: false },
      { title: 'Prepare report complete', status: 'done', tags: ['work'], due: '2026-05-01', done: true },
      { title: 'Prepare report home', status: 'open', tags: ['home'], due: '2026-05-01', done: false },
    ];
    const { tasks, results } = searchAgendaItems({
      taskCatalog: catalog,
      eventBuckets: new Map(),
      query: 'prepare report status:todo tag:work due:today',
      filter: null,
      cfg,
      todayKey: '2026-05-01',
      localDateKey,
    });
    assert.deepEqual(tasks.map((task) => task.title), ['Prepare report']);
    assert.deepEqual(results, tasks);
  });

  it('supports overdue, tomorrow, and explicit due dates', () => {
    const catalog = [
      { title: 'Late', due: '2026-04-30', done: false },
      { title: 'Tomorrow', due: '2026-05-02', done: false },
      { title: 'Specific', due: '2026-05-03', done: false },
      { title: 'Completed late', due: '2026-04-30', done: true },
    ];
    const search = (query) => searchAgendaItems({
      taskCatalog: catalog,
      eventBuckets: new Map(),
      query,
      filter: null,
      cfg,
      todayKey: '2026-05-01',
      localDateKey,
    }).tasks.map((task) => task.title);
    assert.deepEqual(search('due:overdue'), ['Late']);
    assert.deepEqual(search('due:tomorrow'), ['Tomorrow']);
    assert.deepEqual(search('due:2026-05-03'), ['Specific']);
  });
});

describe('agenda interaction state', () => {
  it('toggles a section between expanded and collapsed', () => {
    const collapsed = new Set();
    assert.equal(toggleCollapsed(collapsed, '2026-05-01'), true);
    assert.equal(collapsed.has('2026-05-01'), true);
    assert.equal(toggleCollapsed(collapsed, '2026-05-01'), false);
    assert.equal(collapsed.has('2026-05-01'), false);
  });

  it('rejects stale or disposed render results', () => {
    assert.equal(isCurrentRender(3, 3, false), true);
    assert.equal(isCurrentRender(2, 3, false), false);
    assert.equal(isCurrentRender(3, 3, true), false);
  });

  it('restores focus by stable key after list rendering', () => {
    const nodes = ['search', 'draft'].map((key) => ({ getAttribute: () => key }));
    assert.equal(findFocusTarget(nodes, 'draft'), nodes[1]);
    assert.equal(findFocusTarget(nodes, 'missing'), undefined);
  });

  it('keeps a scheduled time when quick-edit changes only the date', () => {
    assert.equal(dateWithExistingTime('2026-05-12', '2026-05-10T14:30'), '2026-05-12T14:30');
    assert.equal(dateWithExistingTime('2026-05-12', '2026-05-10'), '2026-05-12');
    assert.equal(dateWithExistingTime('', '2026-05-10T14:30'), null);
  });

  it('provides the task identity used by drag-and-drop', () => {
    assert.equal(taskPath({ path: 'Tasks/one.md', file: { path: 'fallback.md' } }), 'Tasks/one.md');
    assert.equal(taskPath({ file: { path: 'Tasks/two.md' } }), 'Tasks/two.md');
  });
});

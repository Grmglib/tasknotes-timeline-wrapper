'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  mapTaskInfo,
  normalizeTaskDate,
  isStatusCompleted,
  completionTarget,
  recurringOccurrenceDate,
} = require('../src/task-mapper');

describe('normalizeTaskDate', () => {
  it('returns null for empty values', () => {
    assert.equal(normalizeTaskDate(null), null);
    assert.equal(normalizeTaskDate(''), null);
  });

  it('stringifies date-like values', () => {
    assert.equal(normalizeTaskDate('2026-09-21'), '2026-09-21');
    assert.equal(normalizeTaskDate('2026-09-21T15:00'), '2026-09-21T15:00');
  });
});

describe('isStatusCompleted', () => {
  it('uses statusMap isCompleted flags', () => {
    const cfg = {
      statusMap: {
        open: { isCompleted: false },
        done: { isCompleted: true },
      },
    };
    assert.equal(isStatusCompleted('open', cfg), false);
    assert.equal(isStatusCompleted('done', cfg), true);
    assert.equal(isStatusCompleted('unknown', cfg), false);
  });
});

describe('mapTaskInfo defaults', () => {
  it('falls back to defaultStatus and basename title', () => {
    const cfg = {
      taskTag: 'task',
      defaultStatus: 'open',
      statusMap: { open: { isCompleted: false } },
    };
    const file = { path: 'n.md', basename: 'Note' };
    const mapped = mapTaskInfo({ path: 'n.md', tags: ['task'] }, cfg, () => file);
    assert.equal(mapped.title, 'Note');
    assert.equal(mapped.status, 'open');
    assert.equal(mapped.priority, 'none');
    assert.equal(mapped.recurrence, null);
  });

  it('keeps the recurrence rule and anchor', () => {
    const cfg = {
      taskTag: 'task',
      defaultStatus: 'open',
      statusMap: { open: { isCompleted: false } },
    };
    const file = { path: 'n.md', basename: 'Standup' };
    const mapped = mapTaskInfo({
      path: 'n.md',
      title: 'Standup',
      status: 'open',
      recurrence: 'FREQ=DAILY',
      recurrence_anchor: 'scheduled',
      scheduled: '2026-09-25T09:00',
    }, cfg, () => file);
    assert.equal(mapped.recurrence, 'FREQ=DAILY');
    assert.equal(mapped.recurrenceAnchor, 'scheduled');
  });
});

describe('completionTarget', () => {
  it('completes only the scheduled occurrence of a recurring series', () => {
    const task = {
      done: false,
      recurrence: 'FREQ=WEEKLY',
      recurrenceAnchor: 'scheduled',
      scheduled: '2026-09-21T09:30',
      due: '2026-09-25',
    };
    assert.deepEqual(completionTarget(task, '2026-09-25'), {
      kind: 'instance',
      date: '2026-09-21',
    });
    assert.equal(recurringOccurrenceDate(task, '2026-09-25'), '2026-09-21');
  });

  it('uses today for completion-anchored recurrence', () => {
    const task = {
      done: false,
      recurrence: 'FREQ=DAILY',
      recurrenceAnchor: 'completion',
      scheduled: '2026-09-20',
    };
    assert.deepEqual(completionTarget(task, '2026-09-25'), {
      kind: 'instance',
      date: '2026-09-25',
    });
  });

  it('closes a non-recurring task, and a finished series, as a whole task', () => {
    assert.deepEqual(completionTarget({ done: false, recurrence: null }, '2026-09-25'), {
      kind: 'task',
      date: null,
    });
    assert.deepEqual(completionTarget({
      done: true,
      recurrence: 'FREQ=DAILY',
      scheduled: '2026-09-25',
    }, '2026-09-25'), {
      kind: 'task',
      date: null,
    });
  });
});

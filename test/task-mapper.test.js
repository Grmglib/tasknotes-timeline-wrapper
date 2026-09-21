'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mapTaskInfo, normalizeTaskDate, isStatusCompleted } = require('../src/task-mapper');

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
  });
});

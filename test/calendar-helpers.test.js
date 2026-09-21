'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const moment = require('moment');
const { createCalendarHelpers } = require('../src/calendar-helpers');

const {
  eventDateKeys,
  eventHasEnded,
  itemSortTime,
  sortMixedItems,
  hasClockTime,
  indexAgendaTasks,
  limitRecurringOccurrences,
  collectAgendaDayKeys,
  withinLookahead,
  seriesKey,
} = createCalendarHelpers(moment, { maxRecurringOccurrences: 3 });

describe('eventDateKeys — exclusive all-day ends', () => {
  it('single-day all-day: end is exclusive so only start day is included', () => {
    const keys = eventDateKeys({
      allDay: true,
      start: '2026-03-10',
      end: '2026-03-11',
    });
    assert.deepEqual(keys, ['2026-03-10']);
  });

  it('multi-day all-day spans inclusive start through day before exclusive end', () => {
    const keys = eventDateKeys({
      allDay: true,
      start: '2026-03-10',
      end: '2026-03-13',
    });
    assert.deepEqual(keys, ['2026-03-10', '2026-03-11', '2026-03-12']);
  });

  it('all-day without end returns only the start day', () => {
    assert.deepEqual(eventDateKeys({ allDay: true, start: '2026-03-10' }), ['2026-03-10']);
  });

  it('timed event ending at midnight is exclusive of the next calendar day', () => {
    const keys = eventDateKeys({
      allDay: false,
      start: '2026-03-10T22:00:00',
      end: '2026-03-11T00:00:00',
    });
    assert.deepEqual(keys, ['2026-03-10']);
  });

  it('timed multi-day event includes every local day it covers', () => {
    const keys = eventDateKeys({
      allDay: false,
      start: '2026-03-10T22:00:00',
      end: '2026-03-12T01:00:00',
    });
    assert.deepEqual(keys, ['2026-03-10', '2026-03-11', '2026-03-12']);
  });
});

describe('eventHasEnded', () => {
  const noon = moment('2026-03-10T12:00:00');

  it('timed event with end before now has ended', () => {
    assert.equal(eventHasEnded({
      start: '2026-03-10T09:00:00',
      end: '2026-03-10T10:00:00',
    }, noon), true);
  });

  it('timed event still in progress has not ended', () => {
    assert.equal(eventHasEnded({
      start: '2026-03-10T11:00:00',
      end: '2026-03-10T13:00:00',
    }, noon), false);
  });

  it('timed event without end assumes 1h duration', () => {
    assert.equal(eventHasEnded({ start: '2026-03-10T10:30:00' }, noon), true);
    assert.equal(eventHasEnded({ start: '2026-03-10T11:30:00' }, noon), false);
  });

  it('all-day exclusive end: still active on the last covered day', () => {
    // Covers Mar 10 only (end Mar 11 exclusive)
    assert.equal(eventHasEnded({
      allDay: true,
      start: '2026-03-10',
      end: '2026-03-11',
    }, noon), false);
  });

  it('all-day exclusive end: ended once the exclusive end day arrives', () => {
    const nextMorning = moment('2026-03-11T08:00:00');
    assert.equal(eventHasEnded({
      allDay: true,
      start: '2026-03-10',
      end: '2026-03-11',
    }, nextMorning), true);
  });

  it('all-day without clock time and no end never counts as ended', () => {
    assert.equal(eventHasEnded({ allDay: true, start: '2026-03-10' }, noon), false);
  });
});

describe('sortMixedItems — mixed task/event sort', () => {
  const cfg = {
    prioMap: {
      high: { weight: 3 },
      normal: { weight: 2 },
      low: { weight: 1 },
    },
  };

  it('puts untimed items before timed ones', () => {
    const items = [
      { isEvent: true, title: 'Standup', start: '2026-03-10T10:00:00' },
      { isEvent: false, title: 'Write docs', priority: 'normal' },
    ];
    const titles = sortMixedItems(items, cfg).map((i) => i.title);
    assert.deepEqual(titles, ['Write docs', 'Standup']);
  });

  it('among untimed, tasks come before all-day events', () => {
    const items = [
      { isEvent: true, allDay: true, title: 'Holiday', start: '2026-03-10' },
      { isEvent: false, title: 'Inbox zero', priority: 'low' },
      { isEvent: false, title: 'Ship it', priority: 'high' },
    ];
    const titles = sortMixedItems(items, cfg).map((i) => i.title);
    assert.deepEqual(titles, ['Ship it', 'Inbox zero', 'Holiday']);
  });

  it('sorts timed items by clock ascending; tasks before events at same time', () => {
    const items = [
      { isEvent: true, title: 'Call', start: '2026-03-10T11:00:00' },
      { isEvent: false, title: 'Deep work', scheduled: '2026-03-10T09:00' },
      { isEvent: true, title: 'Sync', start: '2026-03-10T09:00:00' },
      { isEvent: false, title: 'Review PR', scheduled: '2026-03-10T11:00' },
    ];
    const titles = sortMixedItems(items, cfg).map((i) => i.title);
    assert.deepEqual(titles, ['Deep work', 'Sync', 'Review PR', 'Call']);
  });

  it('itemSortTime is null for all-day and date-only values', () => {
    assert.equal(itemSortTime({ isEvent: true, allDay: true, start: '2026-03-10' }), null);
    assert.equal(itemSortTime({ isEvent: false, due: '2026-03-10' }), null);
    assert.ok(itemSortTime({ isEvent: true, start: '2026-03-10T14:30:00' }) > 0);
  });
});

describe('hasClockTime', () => {
  it('detects ISO and space-separated times', () => {
    assert.equal(hasClockTime('2026-03-10'), false);
    assert.equal(hasClockTime('2026-03-10T09:00'), true);
    assert.equal(hasClockTime('2026-03-10 09:00'), true);
  });
});

describe('indexAgendaTasks', () => {
  it('buckets by scheduled/due, overdue, and unplanned', () => {
    const { byDay, overdue, unplanned } = indexAgendaTasks([
      { title: 'Today due', due: '2026-03-10' },
      { title: 'Late', due: '2026-03-08' },
      { title: 'Inbox', due: null, scheduled: null },
      { title: 'Tomorrow', scheduled: '2026-03-11' },
    ], '2026-03-10');

    assert.equal(overdue.map((t) => t.title).join(), 'Late');
    assert.equal(unplanned.map((t) => t.title).join(), 'Inbox');
    assert.deepEqual(
      (byDay.get('2026-03-10') || []).map((t) => t.title),
      ['Today due'],
    );
    assert.deepEqual(
      (byDay.get('2026-03-11') || []).map((t) => t.title),
      ['Tomorrow'],
    );
  });

  it('carries unfinished past-scheduled work into today', () => {
    const { byDay, overdue } = indexAgendaTasks([
      { title: 'Carry', scheduled: '2026-03-08', due: null },
    ], '2026-03-10');
    assert.equal(overdue.length, 0);
    assert.deepEqual(
      (byDay.get('2026-03-10') || []).map((t) => t.title),
      ['Carry'],
    );
  });
});

describe('limitRecurringOccurrences', () => {
  it('caps upcoming occurrences per series and keeps past ones', () => {
    const today = moment('2026-03-10').startOf('day');
    const events = [
      { id: 'series_20260308', title: 'Standup', start: '2026-03-08T09:00:00', recurringEventId: 'series' },
      { id: 'series_20260310', title: 'Standup', start: '2026-03-10T09:00:00', recurringEventId: 'series' },
      { id: 'series_20260311', title: 'Standup', start: '2026-03-11T09:00:00', recurringEventId: 'series' },
      { id: 'series_20260312', title: 'Standup', start: '2026-03-12T09:00:00', recurringEventId: 'series' },
      { id: 'once', title: 'One-off', start: '2026-03-10T15:00:00' },
    ];
    const limited = limitRecurringOccurrences(events, 2, today);
    const standup = limited.filter((e) => e.title === 'Standup');
    assert.equal(standup.length, 3); // 1 past + 2 upcoming
    assert.ok(limited.some((e) => e.id === 'once'));
  });

  it('max 0 keeps every occurrence', () => {
    const today = moment('2026-03-10').startOf('day');
    const events = [
      { id: 'a_20260310', start: '2026-03-10T09:00:00', recurringEventId: 'a' },
      { id: 'a_20260311', start: '2026-03-11T09:00:00', recurringEventId: 'a' },
      { id: 'a_20260312', start: '2026-03-12T09:00:00', recurringEventId: 'a' },
    ];
    assert.equal(limitRecurringOccurrences(events, 0, today).length, 3);
  });
});

describe('collectAgendaDayKeys / withinLookahead', () => {
  it('unions task and event day keys within each lookahead', () => {
    const today = moment('2026-03-10');
    const taskBuckets = new Map([
      ['2026-03-10', []],
      ['2026-03-12', []],
      ['2026-03-20', []],
    ]);
    const eventBuckets = new Map([
      ['2026-03-11', []],
      ['2026-03-15', []],
    ]);
    assert.deepEqual(
      collectAgendaDayKeys(today, 3, 5, taskBuckets, eventBuckets),
      ['2026-03-10', '2026-03-11', '2026-03-12'],
    );
  });

  it('withinLookahead treats 0 as unlimited', () => {
    assert.equal(withinLookahead(99, 0), true);
    assert.equal(withinLookahead(2, 2), false);
    assert.equal(withinLookahead(1, 2), true);
  });
});

describe('seriesKey', () => {
  it('groups Google-style occurrence ids under the same series', () => {
    assert.equal(
      seriesKey({ id: 'abc_20260310', subscriptionId: 'g' }),
      seriesKey({ id: 'abc_20260311T090000Z', subscriptionId: 'g' }),
    );
  });
});

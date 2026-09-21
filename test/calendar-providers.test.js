'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  findProviderCalendar,
  calendarLabel,
  calendarColor,
  calendarIsEnabled,
} = require('../src/calendar-providers');

describe('findProviderCalendar', () => {
  it('finds by id or calendarId in arrays', () => {
    const list = [{ id: 'a', name: 'A' }, { calendarId: 'b', name: 'B' }];
    assert.equal(findProviderCalendar(list, 'a').name, 'A');
    assert.equal(findProviderCalendar(list, 'b').name, 'B');
    assert.equal(findProviderCalendar(list, 'missing'), null);
  });

  it('supports Map and plain object lookups', () => {
    const map = new Map([['x', { id: 'x', name: 'X' }]]);
    assert.equal(findProviderCalendar(map, 'x').name, 'X');
    assert.equal(findProviderCalendar({ y: { name: 'Y' } }, 'y').name, 'Y');
  });
});

describe('calendar metadata helpers', () => {
  it('resolves label and color with fallbacks', () => {
    assert.equal(calendarLabel({ summary: 'Work' }, 'Fallback'), 'Work');
    assert.equal(calendarLabel(null, 'Fallback'), 'Fallback');
    assert.equal(calendarColor({ backgroundColor: '#111' }, '#000'), '#111');
    assert.equal(calendarColor({ color: '#222' }, '#000'), '#222');
    assert.equal(calendarColor(null, '#000'), '#000');
  });

  it('treats enabled/selected/hidden flags', () => {
    assert.equal(calendarIsEnabled(null), true);
    assert.equal(calendarIsEnabled({}), true);
    assert.equal(calendarIsEnabled({ enabled: false }), false);
    assert.equal(calendarIsEnabled({ selected: false }), false);
    assert.equal(calendarIsEnabled({ hidden: true }), false);
  });
});

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseOptions } = require('../src/block-options');

describe('parseOptions', () => {
  it('defaults to Today\'s Timeline with no source', () => {
    assert.deepEqual(parseOptions(''), { title: "Today's Timeline" });
  });

  it('parses title, days shortcut, and boolean events', () => {
    const opts = parseOptions(`
title: This Week
days: 7
events: yes
`);
    assert.equal(opts.title, 'This Week');
    assert.equal(opts.days, 7);
    assert.equal(opts.taskDays, 7);
    assert.equal(opts.eventDays, 7);
    assert.equal(opts.events, true);
  });

  it('parses separate taskDays / eventDays and base/view', () => {
    const opts = parseOptions(`
taskDays: 3
eventDays: 10
base: TaskNotes/Views/work.base
view: Work Context
events: false
`);
    assert.equal(opts.taskDays, 3);
    assert.equal(opts.eventDays, 10);
    assert.equal(opts.base, 'TaskNotes/Views/work.base');
    assert.equal(opts.view, 'Work Context');
    assert.equal(opts.events, false);
  });

  it('treats days: 0 as unlimited', () => {
    const opts = parseOptions('days: 0');
    assert.equal(opts.days, 0);
    assert.equal(opts.taskDays, 0);
    assert.equal(opts.eventDays, 0);
  });
});

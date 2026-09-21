'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const moment = require('moment');
const {
  collectTags,
  orderTags,
  linkText,
  linkNames,
  createFrontmatterHelpers,
} = require('../src/frontmatter');

const { normDate } = createFrontmatterHelpers(moment);

describe('collectTags', () => {
  it('collects frontmatter array and inline cache tags without hashes', () => {
    const tags = collectTags(
      { tags: ['#task', 'work'] },
      { tags: [{ tag: '#home' }] },
    );
    assert.deepEqual([...tags].sort(), ['home', 'task', 'work']);
  });

  it('splits comma/space separated frontmatter tag strings', () => {
    const tags = collectTags({ tags: 'task, work home' }, null);
    assert.deepEqual([...tags].sort(), ['home', 'task', 'work']);
  });
});

describe('orderTags', () => {
  it('anchors the task tag first when present', () => {
    assert.deepEqual(orderTags(new Set(['b', 'task', 'a']), 'task'), ['task', 'b', 'a']);
  });

  it('keeps order when task tag is missing', () => {
    assert.deepEqual(orderTags(new Set(['b', 'a']), 'task'), ['b', 'a']);
  });
});

describe('linkText / linkNames', () => {
  it('extracts display names from wikilinks and markdown links', () => {
    assert.equal(linkText('[[Projects/Alpha|Alpha]]'), 'Alpha');
    assert.equal(linkText('[[Projects/Beta]]'), 'Beta');
    assert.equal(linkText('[Gamma](Projects/Gamma.md)'), 'Gamma');
    assert.equal(linkText(''), null);
  });

  it('maps arrays of project links', () => {
    assert.deepEqual(
      linkNames(['[[A]]', '[[path/B|Bee]]', null]),
      ['A', 'Bee'],
    );
  });
});

describe('normDate', () => {
  it('normalizes Date instances and leaves strings as-is', () => {
    assert.equal(normDate(new Date('2026-03-10T12:00:00Z')), moment(new Date('2026-03-10T12:00:00Z')).format('YYYY-MM-DD'));
    assert.equal(normDate('2026-03-10'), '2026-03-10');
    assert.equal(normDate(null), null);
    assert.equal(normDate(''), null);
  });
});

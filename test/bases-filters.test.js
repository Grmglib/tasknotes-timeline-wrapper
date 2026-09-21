'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  mapBasesField,
  convertBasesExpression,
  convertBasesFiltersToWhere,
  mergeBasesFilters,
  parseBaseDocument,
  viewsFromBaseDoc,
  findViewInDoc,
  unquoteBasesLiteral,
} = require('../src/bases-filters');

describe('mapBasesField', () => {
  it('maps known note/file fields and bare names', () => {
    assert.equal(mapBasesField('note.status'), 'task.status');
    assert.equal(mapBasesField('status'), 'task.status');
    assert.equal(mapBasesField('file.path'), 'file.path');
    assert.equal(mapBasesField('note.customThing'), 'task.customThing');
    assert.equal(mapBasesField('note["Sprint"]'), 'user.Sprint');
  });

  it('rejects formulas and unknown bare keys', () => {
    assert.equal(mapBasesField('formula.x'), null);
    assert.equal(mapBasesField('file.tasks'), null);
    assert.equal(mapBasesField('notARealField'), null);
  });
});

describe('unquoteBasesLiteral', () => {
  it('parses quoted strings, booleans, null, and numbers', () => {
    assert.equal(unquoteBasesLiteral('"hello"'), 'hello');
    assert.equal(unquoteBasesLiteral("'world'"), 'world');
    assert.equal(unquoteBasesLiteral('true'), true);
    assert.equal(unquoteBasesLiteral('null'), null);
    assert.equal(unquoteBasesLiteral('42'), 42);
  });
});

describe('convertBasesExpression', () => {
  it('converts comparisons and hasTag', () => {
    const warnings = [];
    assert.deepEqual(
      convertBasesExpression('note.status == "open"', warnings),
      { field: 'task.status', op: 'eq', value: 'open' },
    );
    assert.deepEqual(
      convertBasesExpression('file.hasTag("task")', warnings),
      { field: 'task.tags', op: 'contains', value: 'task' },
    );
    assert.equal(warnings.length, 0);
  });

  it('converts AND / OR with correct grouping', () => {
    const warnings = [];
    assert.deepEqual(
      convertBasesExpression('note.status == "open" && note.priority == "high"', warnings),
      {
        all: [
          { field: 'task.status', op: 'eq', value: 'open' },
          { field: 'task.priority', op: 'eq', value: 'high' },
        ],
      },
    );
    assert.deepEqual(
      convertBasesExpression('note.status == "open" || note.status == "done"', warnings),
      {
        any: [
          { field: 'task.status', op: 'eq', value: 'open' },
          { field: 'task.status', op: 'eq', value: 'done' },
        ],
      },
    );
  });

  it('converts isEmpty / !isEmpty and contains', () => {
    const warnings = [];
    assert.deepEqual(
      convertBasesExpression('note.due.isEmpty()', warnings),
      { field: 'task.due', op: 'missing' },
    );
    assert.deepEqual(
      convertBasesExpression('!note.due.isEmpty()', warnings),
      { field: 'task.due', op: 'exists' },
    );
    assert.deepEqual(
      convertBasesExpression('note.projects.contains("Alpha")', warnings),
      { field: 'task.projects', op: 'contains', value: 'Alpha' },
    );
  });

  it('records warnings for unsupported expressions', () => {
    const warnings = [];
    assert.equal(convertBasesExpression('formula.score > 1', warnings), null);
    assert.ok(warnings.some((w) => /unsupported/i.test(w)));
  });
});

describe('convertBasesFiltersToWhere', () => {
  it('converts YAML and/or/not trees', () => {
    const warnings = [];
    const where = convertBasesFiltersToWhere({
      and: [
        'note.status == "open"',
        { or: ['note.priority == "high"', 'note.priority == "normal"'] },
      ],
    }, warnings);
    assert.deepEqual(where, {
      all: [
        { field: 'task.status', op: 'eq', value: 'open' },
        {
          any: [
            { field: 'task.priority', op: 'eq', value: 'high' },
            { field: 'task.priority', op: 'eq', value: 'normal' },
          ],
        },
      ],
    });
    assert.equal(warnings.length, 0);
  });
});

describe('mergeBasesFilters / views', () => {
  it('merges file and view filters with and', () => {
    assert.deepEqual(
      mergeBasesFilters('a', 'b'),
      { and: ['a', 'b'] },
    );
    assert.equal(mergeBasesFilters(null, 'b'), 'b');
    assert.equal(mergeBasesFilters('a', null), 'a');
  });

  it('lists and finds views case-insensitively', () => {
    const doc = {
      views: [
        { name: 'Work Context', filters: 'note.status == "open"' },
        { filters: null },
      ],
    };
    const views = viewsFromBaseDoc(doc);
    assert.equal(views[0].name, 'Work Context');
    assert.equal(views[1].name, 'View 2');
    assert.equal(findViewInDoc(doc, 'work context').name, 'Work Context');
    assert.equal(findViewInDoc(doc, 'missing'), null);
  });

  it('parseBaseDocument uses injected yaml parser', () => {
    const doc = parseBaseDocument('filters: x\nviews: []', (text) => {
      assert.match(text, /filters/);
      return { filters: 'x', views: [] };
    });
    assert.deepEqual(doc, { filters: 'x', views: [] });
    assert.equal(parseBaseDocument('', () => ({})), null);
    assert.equal(parseBaseDocument('bad', () => { throw new Error('nope'); }), null);
  });
});

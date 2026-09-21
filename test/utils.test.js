'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseNonNegInt, debounce, isPlainObject } = require('../src/utils');

describe('parseNonNegInt', () => {
  it('parses valid non-negative integers', () => {
    assert.equal(parseNonNegInt('0', 14), 0);
    assert.equal(parseNonNegInt('7', 14), 7);
    assert.equal(parseNonNegInt(3, 14), 3);
  });

  it('falls back for invalid or negative values', () => {
    assert.equal(parseNonNegInt('-1', 14), 14);
    assert.equal(parseNonNegInt('abc', 14), 14);
    assert.equal(parseNonNegInt('', 14), 14);
    assert.equal(parseNonNegInt(undefined, 14), 14);
  });
});

describe('isPlainObject', () => {
  it('accepts plain objects only', () => {
    assert.equal(isPlainObject({ a: 1 }), true);
    assert.equal(isPlainObject([]), false);
    assert.equal(isPlainObject(null), false);
    assert.equal(isPlainObject('x'), false);
  });
});

describe('debounce', () => {
  it('collapses rapid calls into one', async () => {
    let count = 0;
    const run = debounce(() => { count += 1; }, 20);
    run();
    run();
    run();
    assert.equal(count, 0);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(count, 1);
  });

  it('cancel prevents the pending call', async () => {
    let count = 0;
    const run = debounce(() => { count += 1; }, 20);
    run();
    run.cancel();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(count, 0);
  });
});

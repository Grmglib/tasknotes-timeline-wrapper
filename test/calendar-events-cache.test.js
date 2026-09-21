'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  CACHE_VERSION,
  CACHE_FILENAME,
  cacheFilePath,
  buildCachePayload,
  parseCachePayload,
  resolveCalendarEvents,
  createCalendarEventsCache,
} = require('../src/calendar-events-cache');

describe('calendar-events-cache paths and payload', () => {
  it('cacheFilePath joins manifest dir with filename', () => {
    assert.equal(cacheFilePath('plugins/foo'), `plugins/foo/${CACHE_FILENAME}`);
    assert.equal(cacheFilePath('plugins/foo/'), `plugins/foo/${CACHE_FILENAME}`);
    assert.equal(cacheFilePath(''), CACHE_FILENAME);
  });

  it('buildCachePayload includes version, updatedAt, and events', () => {
    const events = [{ id: '1', title: 'Meet' }];
    const payload = buildCachePayload(events, '2026-09-21T12:00:00.000Z');
    assert.equal(payload.version, CACHE_VERSION);
    assert.equal(payload.updatedAt, '2026-09-21T12:00:00.000Z');
    assert.deepEqual(payload.events, events);
  });

  it('parseCachePayload accepts JSON string or object and ignores bad input', () => {
    const events = [{ id: 'a', title: 'A' }];
    assert.deepEqual(
      parseCachePayload(JSON.stringify({ version: 1, events })),
      events,
    );
    assert.deepEqual(parseCachePayload({ events }), events);
    assert.deepEqual(parseCachePayload(null), []);
    assert.deepEqual(parseCachePayload('{'), []);
    assert.deepEqual(parseCachePayload({ events: 'nope' }), []);
    assert.deepEqual(parseCachePayload({ events: [null, { id: 'ok' }, 3] }), [{ id: 'ok' }]);
  });
});

describe('resolveCalendarEvents', () => {
  const cached = [
    { id: 'cached-1', title: 'Cached', isEvent: true },
  ];
  const live = [
    { id: 'live-1', title: 'Live', isEvent: true },
  ];

  it('prefers live events and schedules persist', () => {
    const resolved = resolveCalendarEvents({
      live,
      cache: cached,
      syncObserved: false,
    });
    assert.deepEqual(resolved.events, live);
    assert.equal(resolved.shouldPersist, true);
    assert.deepEqual(resolved.persistEvents, live);
  });

  it('falls back to cache before sync is observed', () => {
    const resolved = resolveCalendarEvents({
      live: [],
      cache: cached,
      syncObserved: false,
    });
    assert.deepEqual(resolved.events, cached);
    assert.equal(resolved.shouldPersist, false);
    assert.equal(resolved.persistEvents, null);
  });

  it('clears cache after sync observes empty live data', () => {
    const resolved = resolveCalendarEvents({
      live: [],
      cache: cached,
      syncObserved: true,
    });
    assert.deepEqual(resolved.events, []);
    assert.equal(resolved.shouldPersist, true);
    assert.deepEqual(resolved.persistEvents, []);
  });

  it('returns empty when there is no cache and sync has not run', () => {
    const resolved = resolveCalendarEvents({
      live: [],
      cache: [],
      syncObserved: false,
    });
    assert.deepEqual(resolved.events, []);
    assert.equal(resolved.shouldPersist, false);
  });
});

describe('createCalendarEventsCache load/save', () => {
  it('loads events from injectable readText', async () => {
    const events = [{ id: '1', title: 'From disk' }];
    const store = createCalendarEventsCache({
      readText: async () => JSON.stringify({ version: 1, events }),
      writeText: async () => {},
    });
    const loaded = await store.load();
    assert.deepEqual(loaded, events);
  });

  it('returns empty array when read fails or file is missing', async () => {
    const missing = createCalendarEventsCache({
      readText: async () => null,
      writeText: async () => {},
    });
    assert.deepEqual(await missing.load(), []);

    const boom = createCalendarEventsCache({
      readText: async () => { throw new Error('io'); },
      writeText: async () => {},
    });
    assert.deepEqual(await boom.load(), []);
  });

  it('saves a versioned payload via writeText', async () => {
    let written = null;
    const store = createCalendarEventsCache({
      readText: async () => null,
      writeText: async (text) => { written = text; },
      now: () => '2026-09-21T15:00:00.000Z',
    });
    const events = [{ id: 'e1', title: 'Saved', calendarName: 'Work' }];
    await store.save(events);
    assert.ok(written);
    const parsed = JSON.parse(written);
    assert.equal(parsed.version, CACHE_VERSION);
    assert.equal(parsed.updatedAt, '2026-09-21T15:00:00.000Z');
    assert.deepEqual(parsed.events, events);
  });

  it('scheduleSave debounces writes and cancelScheduledSave prevents flush', async () => {
    let writes = 0;
    const store = createCalendarEventsCache({
      readText: async () => null,
      writeText: async () => { writes += 1; },
      debounceMs: 30,
      now: () => '2026-09-21T15:00:00.000Z',
    });
    store.scheduleSave([{ id: '1' }]);
    store.scheduleSave([{ id: '2' }]);
    store.cancelScheduledSave();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(writes, 0);

    store.scheduleSave([{ id: '3' }]);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(writes, 1);
  });
});

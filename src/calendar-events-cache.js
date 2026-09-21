'use strict';

const { debounce } = require('./utils');

const CACHE_VERSION = 1;
const CACHE_FILENAME = 'calendar-events-cache.json';
const DEFAULT_SAVE_DEBOUNCE_MS = 1000;

function cacheFilePath(manifestDir) {
  const base = String(manifestDir || '').replace(/[/\\]+$/, '');
  return base ? `${base}/${CACHE_FILENAME}` : CACHE_FILENAME;
}

function buildCachePayload(events, updatedAt) {
  return {
    version: CACHE_VERSION,
    updatedAt: updatedAt || new Date().toISOString(),
    events: Array.isArray(events) ? events : [],
  };
}

function parseCachePayload(raw) {
  if (raw == null || raw === '') return [];
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return [];
    }
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.events)) return [];
  return data.events.filter((ev) => ev && typeof ev === 'object');
}

/**
 * Decide which events to show and whether to persist.
 * - Live non-empty → show live and persist.
 * - Live empty after sync observed → show [] and clear cache.
 * - Live empty before sync → show cached events (startup / offline).
 */
function resolveCalendarEvents({ live, cache, syncObserved }) {
  const liveEvents = Array.isArray(live) ? live : [];
  if (liveEvents.length > 0) {
    return { events: liveEvents, shouldPersist: true, persistEvents: liveEvents };
  }
  if (syncObserved) {
    return { events: [], shouldPersist: true, persistEvents: [] };
  }
  const cached = Array.isArray(cache) ? cache : [];
  return { events: cached, shouldPersist: false, persistEvents: null };
}

function createAdapterIO(adapter, manifestDir) {
  const path = cacheFilePath(manifestDir);
  return {
    async readText() {
      if (!adapter) return null;
      if (typeof adapter.exists === 'function') {
        const exists = await adapter.exists(path);
        if (!exists) return null;
      }
      if (typeof adapter.read !== 'function') return null;
      return adapter.read(path);
    },
    async writeText(text) {
      if (!adapter || typeof adapter.write !== 'function') return;
      await adapter.write(path, text);
    },
  };
}

function createCalendarEventsCache(options = {}) {
  const {
    readText,
    writeText,
    debounceMs = DEFAULT_SAVE_DEBOUNCE_MS,
    now = () => new Date().toISOString(),
  } = options;

  async function load() {
    if (typeof readText !== 'function') return [];
    try {
      const raw = await readText();
      return parseCachePayload(raw);
    } catch (e) {
      return [];
    }
  }

  async function save(events) {
    if (typeof writeText !== 'function') return;
    const payload = buildCachePayload(events, now());
    await writeText(JSON.stringify(payload));
  }

  const scheduleSave = debounce((events) => {
    Promise.resolve(save(events)).catch(() => { /* never break the agenda */ });
  }, debounceMs);

  return {
    load,
    save,
    scheduleSave,
    cancelScheduledSave: scheduleSave.cancel,
  };
}

module.exports = {
  CACHE_VERSION,
  CACHE_FILENAME,
  DEFAULT_SAVE_DEBOUNCE_MS,
  cacheFilePath,
  buildCachePayload,
  parseCachePayload,
  resolveCalendarEvents,
  createAdapterIO,
  createCalendarEventsCache,
};

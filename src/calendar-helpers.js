'use strict';

/**
 * Pure calendar / agenda date helpers.
 * Injected with a moment instance so Obsidian (obsidian.moment) and Node tests
 * can share the same logic without a build step.
 */
function createCalendarHelpers(moment, defaults = {}) {
  const defaultMaxRecurring = defaults.maxRecurringOccurrences ?? 3;

  function seriesKey(ev) {
    if (ev.recurringEventId) return `rid:${ev.subscriptionId || ''}:${ev.recurringEventId}`;
    if (ev.seriesId) return `sid:${ev.subscriptionId || ''}:${ev.seriesId}`;
    if (ev.masterEventId) return `mid:${ev.subscriptionId || ''}:${ev.masterEventId}`;
    const id = String(ev.id || '');
    // Google / Microsoft occurrence ids: baseId_YYYYMMDD or baseId_YYYYMMDDTHHMMSSZ
    const stripped = id.replace(/_\d{8}(T\d{6}Z?)?$/, '');
    if (stripped && stripped !== id) return `id:${ev.subscriptionId || ''}:${stripped}`;
    if (ev.uid) return `uid:${ev.subscriptionId || ''}:${ev.uid}`;
    return `solo:${id || `${ev.subscriptionId || 'cal'}:${ev.start || ''}:${ev.title || ''}`}`;
  }

  function eventStartMoment(ev) {
    return moment(ev.start, [moment.ISO_8601, 'YYYY-MM-DDTHH:mm', 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD']);
  }

  function isMarkedRecurring(ev) {
    return !!(ev.isRecurring || ev.rrule || ev.recurringEventId || ev.seriesId || ev.masterEventId);
  }

  function limitRecurringOccurrences(events, max, todayStart) {
    // 0 = no cap — keep every occurrence.
    if (max === 0) return events || [];
    const maxN = Math.max(1, max || defaultMaxRecurring);
    const groups = new Map();
    for (const ev of events || []) {
      const key = seriesKey(ev);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(ev);
    }
    const out = [];
    for (const group of groups.values()) {
      const isSeries = group.length > 1 || group.some(isMarkedRecurring);
      if (!isSeries) {
        out.push(...group);
        continue;
      }
      const past = [];
      const upcoming = [];
      for (const ev of group) {
        const start = eventStartMoment(ev);
        if (start.isValid() && start.isBefore(todayStart, 'day')) past.push(ev);
        else upcoming.push(ev);
      }
      upcoming.sort((a, b) => {
        const ta = eventStartMoment(a);
        const tb = eventStartMoment(b);
        const va = ta.isValid() ? ta.valueOf() : 0;
        const vb = tb.isValid() ? tb.valueOf() : 0;
        return va - vb;
      });
      out.push(...past, ...upcoming.slice(0, maxN));
    }
    return out;
  }

  // Sorted YYYY-MM-DD keys from today through each lookahead. limit 0 = unlimited.
  function collectAgendaDayKeys(today, taskDays, eventDays, taskBuckets, eventBuckets) {
    const todayKey = today.format('YYYY-MM-DD');
    const keys = new Set();
    const taskEnd = taskDays === 0 ? null : today.clone().add(taskDays - 1, 'days').format('YYYY-MM-DD');
    const eventEnd = eventDays === 0 ? null : today.clone().add(eventDays - 1, 'days').format('YYYY-MM-DD');

    for (const key of taskBuckets.keys()) {
      if (key < todayKey || (taskEnd && key > taskEnd)) continue;
      keys.add(key);
    }

    for (const key of eventBuckets.keys()) {
      if (key < todayKey) continue;
      if (eventEnd && key > eventEnd) continue;
      keys.add(key);
    }

    return [...keys].sort();
  }

  function withinLookahead(offset, limit) {
    // limit 0 = unlimited
    return limit === 0 || offset < limit;
  }

  function extractDateKey(dateStr) {
    if (!dateStr) return null;
    const m = String(dateStr).match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  }

  function localDateKey(value) {
    if (!value) return null;
    const date = moment(value, [moment.ISO_8601, 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD'], true);
    return date.isValid() ? date.format('YYYY-MM-DD') : null;
  }

  // One pass per render instead of filtering every task again for each day.
  function indexAgendaTasks(tasks, todayKey) {
    const byDay = new Map();
    const overdue = [];
    const unplanned = [];
    for (const task of tasks) {
      const scheduled = localDateKey(task.scheduled);
      const due = localDateKey(task.due);
      const isOverdue = due && due < todayKey;
      if (isOverdue) overdue.push(task);
      if (!scheduled && !due) unplanned.push(task);
      const dayKeys = new Set([scheduled, due]);
      // Carry unfinished scheduled work into Today without introducing another filter.
      // An expired due date still belongs in Overdue.
      if (scheduled && scheduled < todayKey && !isOverdue) dayKeys.add(todayKey);
      for (const key of dayKeys) {
        if (!key || key < todayKey) continue;
        if (!byDay.has(key)) byDay.set(key, []);
        byDay.get(key).push(task);
      }
    }
    return { byDay, overdue, unplanned };
  }

  // Timed events use local calendar dates; all-day dates have no timezone conversion.
  function eventDateKeys(ev) {
    const start = ev.allDay
      ? moment.utc(extractDateKey(ev.start), 'YYYY-MM-DD', true)
      : eventStartMoment(ev);
    if (!start.isValid()) return [];
    const startKey = start.format('YYYY-MM-DD');
    if (!ev.end) return [startKey];
    let end = ev.allDay
      ? moment.utc(extractDateKey(ev.end), 'YYYY-MM-DD', true)
      : eventStartMoment({ start: ev.end });
    if (!end.isValid() || !end.isAfter(start)) return [startKey];
    // Calendar ends are exclusive, including timed events ending at midnight.
    end = end.clone().subtract(1, ev.allDay ? 'day' : 'millisecond');
    start.startOf('day');
    end.startOf('day');

    const keys = [];
    const cursor = start.clone();
    for (let i = 0; !cursor.isAfter(end, 'day') && i < 370; i++) {
      keys.push(cursor.format('YYYY-MM-DD'));
      cursor.add(1, 'day');
    }
    return keys.length ? keys : [startKey];
  }

  function hasClockTime(dateStr) {
    if (!dateStr) return false;
    // YYYY-MM-DD alone is date-only; anything with a time component counts.
    return /T\d{2}:\d{2}/.test(String(dateStr)) || /\d{2}:\d{2}/.test(String(dateStr).slice(10));
  }

  function itemSortTime(item) {
    if (item.isEvent) {
      if (item.allDay || !hasClockTime(item.start)) return null;
      const t = moment(item.start, [moment.ISO_8601, 'YYYY-MM-DDTHH:mm', 'YYYY-MM-DD HH:mm']);
      return t.isValid() ? t.valueOf() : null;
    }
    const raw = item.scheduled || item.due;
    if (!raw || !hasClockTime(raw)) return null;
    const t = moment(raw, [moment.ISO_8601, 'YYYY-MM-DDTHH:mm', 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD']);
    return t.isValid() ? t.valueOf() : null;
  }

  function eventHasEnded(ev, now) {
    if (!ev.end) {
      if (ev.allDay || !hasClockTime(ev.start)) return false;
      const start = moment(ev.start, [moment.ISO_8601, 'YYYY-MM-DDTHH:mm']);
      if (!start.isValid()) return false;
      // No end time: assume 1h so in-progress meetings stay visible.
      return start.clone().add(1, 'hour').isBefore(now);
    }
    if (ev.allDay && /^\d{4}-\d{2}-\d{2}$/.test(String(ev.end))) {
      // Exclusive end date: the event covers through the day before.
      const endDay = moment(ev.end, 'YYYY-MM-DD').startOf('day');
      return !endDay.isAfter(now, 'day');
    }
    const end = moment(ev.end, [moment.ISO_8601, 'YYYY-MM-DDTHH:mm', 'YYYY-MM-DD']);
    return end.isValid() && end.isBefore(now);
  }

  function isEventOngoing(ev, now) {
    if (ev.allDay || !hasClockTime(ev.start)) return false;
    const start = eventStartMoment(ev);
    const end = ev.end ? eventStartMoment({ start: ev.end }) : start.clone().add(1, 'hour');
    return start.isValid() && end.isValid() && !now.isBefore(start) && now.isBefore(end);
  }

  function isTaskOverdue(task, now) {
    if (task.done || !task.due) return false;
    const due = moment(task.due, [moment.ISO_8601, 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD'], true);
    return due.isValid() && (hasClockTime(task.due) ? due.isBefore(now) : due.isBefore(now, 'day'));
  }

  function formatEventTimeRange(ev) {
    if (ev.allDay || !hasClockTime(ev.start)) return 'All day';
    const start = moment(ev.start, [moment.ISO_8601, 'YYYY-MM-DDTHH:mm']);
    if (!start.isValid()) return 'All day';
    const startLabel = start.format('HH:mm');
    if (!ev.end || !hasClockTime(ev.end)) return startLabel;
    const end = moment(ev.end, [moment.ISO_8601, 'YYYY-MM-DDTHH:mm']);
    if (!end.isValid()) return startLabel;
    return `${startLabel} – ${end.format('HH:mm')}`;
  }

  function formatEventDateTimeLabel(ev) {
    const startStr = ev.allDay && /^\d{4}-\d{2}-\d{2}$/.test(String(ev.start))
      ? `${ev.start}T00:00:00`
      : ev.start;
    const start = moment(startStr, [moment.ISO_8601, 'YYYY-MM-DDTHH:mm', 'YYYY-MM-DD']);
    if (!start.isValid()) return formatEventTimeRange(ev);
    let text = start.format('dddd, MMMM D, YYYY');
    if (ev.allDay || !hasClockTime(ev.start)) return `${text} · All day`;
    text += ` · ${start.format('HH:mm')}`;
    if (ev.end && hasClockTime(ev.end)) {
      const end = moment(ev.end, [moment.ISO_8601, 'YYYY-MM-DDTHH:mm']);
      if (end.isValid()) text += ` – ${end.format('HH:mm')}`;
    }
    return text;
  }

  /** Untimed items first (tasks before all-day events), then timed by clock. */
  function sortMixedItems(items, cfg) {
    const wt = (p) => (cfg.prioMap[p] && cfg.prioMap[p].weight) || 0;
    const untimed = [];
    const timed = [];
    for (const item of items) {
      if (itemSortTime(item) == null) untimed.push(item);
      else timed.push(item);
    }
    untimed.sort((a, b) => {
      if (a.isEvent !== b.isEvent) return a.isEvent ? 1 : -1; // tasks before events among untimed
      if (!a.isEvent && !b.isEvent) {
        return wt(b.priority) - wt(a.priority) || a.title.localeCompare(b.title);
      }
      return (a.title || '').localeCompare(b.title || '');
    });
    timed.sort((a, b) => {
      const ta = itemSortTime(a);
      const tb = itemSortTime(b);
      if (ta !== tb) return ta - tb;
      if (a.isEvent !== b.isEvent) return a.isEvent ? 1 : -1;
      return (a.title || '').localeCompare(b.title || '');
    });
    return untimed.concat(timed);
  }

  return {
    seriesKey,
    eventStartMoment,
    isMarkedRecurring,
    limitRecurringOccurrences,
    collectAgendaDayKeys,
    withinLookahead,
    extractDateKey,
    localDateKey,
    indexAgendaTasks,
    eventDateKeys,
    hasClockTime,
    itemSortTime,
    eventHasEnded,
    isEventOngoing,
    isTaskOverdue,
    formatEventTimeRange,
    formatEventDateTimeLabel,
    sortMixedItems,
  };
}

module.exports = { createCalendarHelpers };

'use strict';

function parseSearchQuery(query) {
  const filters = [];
  const text = String(query || '').replace(/(?:^|\s)(status|tag|due):(?:"([^"]+)"|'([^']+)'|(\S+))/gi,
    (match, field, doubleQuoted, singleQuoted, bare) => {
      const value = (doubleQuoted || singleQuoted || bare || '').trim();
      if (value) filters.push({ field: field.toLowerCase(), value });
      return ' ';
    }).replace(/\s+/g, ' ').trim();
  return { text: text.toLocaleLowerCase(), filters };
}

function dateKeyOffset(dateKey, offset) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function matchesSearchFilters(task, filters, { cfg, todayKey, localDateKey }) {
  return filters.every(({ field, value }) => {
    const expected = value.toLocaleLowerCase();
    if (field === 'status') {
      if (expected === 'todo') return !task.done;
      if (expected === 'done') return !!task.done;
      return String(task.status || '').toLocaleLowerCase() === expected;
    }
    if (field === 'tag') {
      const expectedTag = expected.replace(/^#/, '');
      return (Array.isArray(task.tags) ? task.tags : [task.tags])
        .filter(Boolean)
        .some((tag) => String(tag).replace(/^#/, '').toLocaleLowerCase() === expectedTag);
    }
    if (field === 'due') {
      const dueKey = localDateKey(task.due);
      if (!dueKey) return false;
      if (expected === 'today') return dueKey === todayKey;
      if (expected === 'tomorrow') return dueKey === dateKeyOffset(todayKey, 1);
      if (expected === 'overdue') return dueKey < todayKey && !task.done;
      return dueKey === expected;
    }
    return true;
  });
}

function searchAgendaItems({ taskCatalog, eventBuckets, query, filter, cfg, todayKey, localDateKey }) {
  const parsedQuery = parseSearchQuery(query);
  const normalizedQuery = parsedQuery.text;
  let tasks = taskCatalog.filter((task) => {
    const searchable = [task.title, task.status, task.priority, ...(task.projects || []), ...(task.tags || [])]
      .filter(Boolean).join(' ').toLocaleLowerCase();
    return (!normalizedQuery || searchable.includes(normalizedQuery))
      && matchesSearchFilters(task, parsedQuery.filters, { cfg, todayKey, localDateKey });
  });
  const statusOrder = new Map(Object.keys(cfg.statusMap || {}).map((status, index) => [status, index]));
  const taskDate = (task) => [localDateKey(task.scheduled), localDateKey(task.due)]
    .filter(Boolean)
    .sort()[0] || '9999-12-31';
  tasks.sort((a, b) => taskDate(a).localeCompare(taskDate(b))
    || (statusOrder.get(a.status) ?? Number.MAX_SAFE_INTEGER)
      - (statusOrder.get(b.status) ?? Number.MAX_SAFE_INTEGER)
    || String(a.title || '').localeCompare(String(b.title || '')));

  if (filter === 'todo') tasks = tasks.filter((task) => !task.done);
  else if (filter === 'overdue') tasks = tasks.filter((task) => !task.done && task.due && localDateKey(task.due) < todayKey);
  else if (filter === 'unplanned') tasks = tasks.filter((task) => !task.done && !task.scheduled && !task.due);

  const events = [];
  if (normalizedQuery && !filter && parsedQuery.filters.length === 0) {
    const seen = new Set();
    for (const bucket of eventBuckets.values()) {
      for (const event of bucket) {
        const id = event.id || `${event.calendarName || ''}|${event.start || ''}|${event.end || ''}|${event.title || ''}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const searchable = [
          event.title, event.calendarName, event.location, event.description, event.url,
          event.start, event.end,
        ].filter(Boolean).join(' ').toLocaleLowerCase();
        if (searchable.includes(normalizedQuery)) events.push(event);
      }
    }
  }
  return { tasks, events, results: tasks.concat(events) };
}

function toggleCollapsed(collapsed, key) {
  const next = !collapsed.has(key);
  if (next) collapsed.add(key);
  else collapsed.delete(key);
  return next;
}

function isCurrentRender(renderId, currentRenderId, disposed) {
  return !disposed && renderId === currentRenderId;
}

function findFocusTarget(nodes, focusKey) {
  return [...nodes].find((node) => node.getAttribute('data-fw-focus') === focusKey);
}

function dateWithExistingTime(dateValue, previousValue) {
  if (!dateValue) return null;
  const previous = String(previousValue || '');
  const suffix = /\d{2}:\d{2}/.test(previous.slice(10)) ? previous.slice(10) : '';
  return `${dateValue}${suffix}`;
}

function taskPath(task) {
  return task.path || task.file.path;
}

module.exports = {
  parseSearchQuery,
  searchAgendaItems,
  toggleCollapsed,
  isCurrentRender,
  findFocusTarget,
  dateWithExistingTime,
  taskPath,
};

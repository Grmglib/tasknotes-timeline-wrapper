'use strict';

const { linkNames, orderTags } = require('./frontmatter');

/**
 * Map a TaskNotes TaskInfo (or similar) into the timeline UI shape.
 * Does not filter by identification tag — listing comes from the Runtime API.
 */
function mapTaskInfo(info, cfg, resolveFile) {
  if (!info || !info.path) return null;
  const path = String(info.path);
  const file = typeof resolveFile === 'function' ? resolveFile(path) : null;
  if (!file) return null;

  const status = info.status != null && info.status !== ''
    ? String(info.status)
    : cfg.defaultStatus;
  const tags = new Set();
  if (Array.isArray(info.tags)) {
    for (const t of info.tags) {
      if (t) tags.add(String(t).replace(/^#/, ''));
    }
  }

  const due = normalizeTaskDate(info.due);
  const scheduled = normalizeTaskDate(info.scheduled);
  const completedDate = normalizeTaskDate(info.completedDate);
  const projects = Array.isArray(info.projects)
    ? linkNames(info.projects)
    : linkNames(info.projects);

  return {
    file,
    path,
    title: info.title != null ? String(info.title) : (file.basename || path),
    status,
    priority: info.priority != null && info.priority !== '' ? String(info.priority) : 'none',
    due,
    scheduled,
    completedDate,
    projects,
    tags: orderTags(tags, cfg.taskTag),
    done: !!(cfg.statusMap[status] && cfg.statusMap[status].isCompleted),
  };
}

function normalizeTaskDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

function isStatusCompleted(status, cfg) {
  return !!(cfg.statusMap[status] && cfg.statusMap[status].isCompleted);
}

module.exports = {
  mapTaskInfo,
  normalizeTaskDate,
  isStatusCompleted,
};

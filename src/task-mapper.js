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
  const recurrence = readRecurrence(info);
  const recurrenceAnchor = readRecurrenceAnchor(info);
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
    recurrence,
    recurrenceAnchor,
    done: !!(cfg.statusMap[status] && cfg.statusMap[status].isCompleted),
  };
}

function readRecurrence(info) {
  const value = info && info.recurrence;
  if (value == null || value === '') return null;
  const text = String(value).trim();
  return text || null;
}

function readRecurrenceAnchor(info) {
  const value = info && (info.recurrence_anchor || info.recurrenceAnchor);
  if (value == null || value === '') return null;
  const text = String(value).trim().toLowerCase();
  return text || null;
}

function taskDateKey(value) {
  if (value == null || value === '') return null;
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function isRecurringSeries(task) {
  return !!(task && task.recurrence && String(task.recurrence).trim());
}

// complete_instances indexes an occurrence day. Scheduled-anchor series use the
// scheduled day (including a late completion of that day). Completion-anchor
// series use the day the instance is completed.
function recurringOccurrenceDate(task, todayKey) {
  if (!isRecurringSeries(task)) return null;
  if (task.recurrenceAnchor === 'completion') return todayKey || null;
  return taskDateKey(task.scheduled) || taskDateKey(task.due) || todayKey || null;
}

function completionTarget(task, todayKey) {
  if (task && !task.done && isRecurringSeries(task)) {
    return { kind: 'instance', date: recurringOccurrenceDate(task, todayKey) };
  }
  return { kind: 'task', date: null };
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
  isRecurringSeries,
  recurringOccurrenceDate,
  completionTarget,
};

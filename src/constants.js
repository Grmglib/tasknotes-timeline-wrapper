'use strict';

const VIEW_TYPE_AGENDA = 'tasknotes-timeline-wrapper';
const COMPLETION_UNDO_MS = 8000;

const DEFAULT_SETTINGS = {
  metaIcons: false,
  showScheduledDate: true,
  showDueDate: true,
  showPriority: true,
  showProjects: true,
  showTags: true,
  showTaskTag: false,
  density: 'comfortable',
  openInNewTab: true,
  showCalendarEvents: false,
  hideFinishedEventsToday: false,
  taskDays: 14,
  eventDays: 14,
  maxRecurringOccurrences: 3,
  tasknotesBasePath: '',
  tasknotesViewName: '',
};

// Bases note/file property → TaskNotes runtime query field.
const BASES_FIELD_MAP = {
  'note.status': 'task.status',
  'note.priority': 'task.priority',
  'note.due': 'task.due',
  'note.scheduled': 'task.scheduled',
  'note.contexts': 'task.contexts',
  'note.projects': 'task.projects',
  'note.timeEstimate': 'task.timeEstimate',
  'note.recurrence': 'task.recurrence',
  'note.blockedBy': 'task.blockedBy',
  'note.blocking': 'task.blocking',
  'note.completedDate': 'task.completedDate',
  'note.dateCreated': 'task.dateCreated',
  'note.dateModified': 'task.dateModified',
  'note.title': 'task.title',
  'note.archived': 'task.archived',
  'file.tags': 'task.tags',
  'file.name': 'file.name',
  'file.path': 'file.path',
  'file.folder': 'file.folder',
  // Bare property names (common in generated templates)
  status: 'task.status',
  priority: 'task.priority',
  due: 'task.due',
  scheduled: 'task.scheduled',
  contexts: 'task.contexts',
  projects: 'task.projects',
  tags: 'task.tags',
  title: 'task.title',
  archived: 'task.archived',
  timeEstimate: 'task.timeEstimate',
  recurrence: 'task.recurrence',
};

// Lucide names for the meta row when icons are on. Tags are deliberately absent —
// they keep their pill background and read as labels, not as a field.
const META_ICONS = {
  due: 'calendar',
  scheduled: 'notebook-pen',
  priority: 'circle-alert',
  file: 'file-text',
};

// Fallbacks — used only if TaskNotes settings can't be read at runtime.
const DEFAULT_FIELDS = {
  title: 'title', status: 'status', priority: 'priority', due: 'due',
  scheduled: 'scheduled', completedDate: 'completedDate', projects: 'projects',
  dateCreated: 'dateCreated', dateModified: 'dateModified', archiveTag: 'archived',
};
const DEFAULT_STATUSES = [
  { value: 'none', label: 'None', color: '#cccccc', isCompleted: false },
  { value: 'open', label: 'Open', color: '#808080', isCompleted: false },
  { value: 'in-progress', label: 'In progress', color: '#0066cc', isCompleted: false },
  { value: 'done', label: 'Done', color: '#00aa00', isCompleted: true },
];
const DEFAULT_PRIORITIES = [
  { value: 'none', label: 'None', color: '#cccccc', weight: 0 },
  { value: 'low', label: 'Low', color: '#00aa00', weight: 1 },
  { value: 'normal', label: 'Normal', color: '#ffaa00', weight: 2 },
  { value: 'high', label: 'High', color: '#ff0000', weight: 3 },
];

const GOOGLE_DEFAULT_COLOR = '#4285F4';
const MICROSOFT_DEFAULT_COLOR = '#0078D4';
const CALENDAR_SERVICE_KEYS = [
  'icsSubscriptionService',
  'googleCalendarService',
  'microsoftCalendarService',
];

module.exports = {
  VIEW_TYPE_AGENDA,
  COMPLETION_UNDO_MS,
  DEFAULT_SETTINGS,
  BASES_FIELD_MAP,
  META_ICONS,
  DEFAULT_FIELDS,
  DEFAULT_STATUSES,
  DEFAULT_PRIORITIES,
  GOOGLE_DEFAULT_COLOR,
  MICROSOFT_DEFAULT_COLOR,
  CALENDAR_SERVICE_KEYS,
};

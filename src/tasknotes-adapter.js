'use strict';

const {
  DEFAULT_FIELDS,
  DEFAULT_STATUSES,
  DEFAULT_PRIORITIES,
  CALENDAR_SERVICE_KEYS,
  GOOGLE_DEFAULT_COLOR,
  MICROSOFT_DEFAULT_COLOR,
} = require('./constants');
const {
  findProviderCalendar,
  calendarLabel,
  calendarColor,
  calendarIsEnabled,
} = require('./calendar-providers');

const SOURCE = 'tasknotes-timeline-wrapper';
const REQUIRED_CAPS = ['tasks.read', 'tasks.write'];

function createTaskNotesAdapter(app) {
  let calendarReadErrors = [];

  function getPlugin() {
    if (app.plugins && typeof app.plugins.getPlugin === 'function') {
      const viaGet = app.plugins.getPlugin('tasknotes');
      if (viaGet) return viaGet;
    }
    return (app.plugins && app.plugins.plugins && app.plugins.plugins.tasknotes) || null;
  }

  function getApi() {
    const tn = getPlugin();
    return tn && tn.api ? tn.api : null;
  }

  function hasCapability(name) {
    const api = getApi();
    if (!api) return false;
    if (typeof api.hasCapability === 'function') return !!api.hasCapability(name);
    if (Array.isArray(api.capabilities)) return api.capabilities.includes(name);
    return false;
  }

  function getCompatibility() {
    const tn = getPlugin();
    if (!tn) {
      return {
        ok: false,
        apiVersion: null,
        missingCaps: [...REQUIRED_CAPS],
        message: 'TaskNotes is not installed or enabled.',
      };
    }
    const api = tn.api;
    if (!api) {
      return {
        ok: false,
        apiVersion: null,
        missingCaps: [...REQUIRED_CAPS],
        message: 'TaskNotes Runtime API is unavailable. Requires TaskNotes 4.10.0 or newer.',
      };
    }
    const apiVersion = api.apiVersion;
    if (apiVersion !== 1) {
      return {
        ok: false,
        apiVersion: apiVersion != null ? apiVersion : null,
        missingCaps: [...REQUIRED_CAPS],
        message: `Unsupported TaskNotes API version (${apiVersion == null ? 'unknown' : apiVersion}). Expected apiVersion 1.`,
      };
    }
    const missingCaps = REQUIRED_CAPS.filter((cap) => !hasCapability(cap));
    if (missingCaps.length) {
      return {
        ok: false,
        apiVersion,
        missingCaps,
        message: `TaskNotes is missing required capabilities: ${missingCaps.join(', ')}.`,
      };
    }
    return { ok: true, apiVersion, missingCaps: [], message: null };
  }

  function mutationContext(extra) {
    return Object.assign({ source: SOURCE }, extra || {});
  }

  function readSettings() {
    const api = getApi();
    if (api && api.settings && typeof api.settings.snapshot === 'function') {
      try {
        const snap = api.settings.snapshot();
        if (snap && typeof snap === 'object') return snap;
      } catch (e) { /* fall through */ }
    }
    const tn = getPlugin();
    return (tn && tn.settings) || {};
  }

  function getConfig() {
    const s = readSettings();
    const fields = Object.assign({}, DEFAULT_FIELDS, s.fieldMapping || {});
    const statuses = (s.customStatuses && s.customStatuses.length) ? s.customStatuses : DEFAULT_STATUSES;
    const priorities = (s.customPriorities && s.customPriorities.length) ? s.customPriorities : DEFAULT_PRIORITIES;
    const statusMap = {};
    statuses.forEach((x) => { statusMap[x.value] = x; });
    const prioMap = {};
    priorities.forEach((x) => { prioMap[x.value] = x; });
    const doneStatus = (statuses.find((x) => x.isCompleted) || { value: 'done' }).value;
    return {
      taskTag: (s.taskTag || 'task').replace(/^#/, ''),
      tasksFolder: s.tasksFolder || 'TaskNotes/Tasks',
      defaultStatus: s.defaultTaskStatus || 'open',
      taskIdentificationMethod: s.taskIdentificationMethod || 'tag',
      fields,
      statusMap,
      prioMap,
      doneStatus,
      enableNaturalLanguageInput: !!s.enableNaturalLanguageInput,
      viewsFolder: (s.viewsFolder || s.defaultViewsFolder || 'TaskNotes/Views').replace(/\/$/, ''),
    };
  }

  async function listTasks(query) {
    const compat = getCompatibility();
    if (!compat.ok) throw new Error(compat.message);
    const api = getApi();
    const q = query || { scope: { includeArchived: false } };
    if (q.where != null && hasCapability('query.tasks') && api.query && typeof api.query.tasks === 'function') {
      const result = await api.query.tasks(q);
      return (result && Array.isArray(result.tasks)) ? result.tasks : [];
    }
    if (typeof api.tasks.list !== 'function') {
      throw new Error('TaskNotes api.tasks.list is unavailable.');
    }
    const listed = await api.tasks.list(q);
    return Array.isArray(listed) ? listed : [];
  }

  async function queryTasks(query) {
    const compat = getCompatibility();
    if (!compat.ok) throw new Error(compat.message);
    const api = getApi();
    if (!hasCapability('query.tasks') || !api.query || typeof api.query.tasks !== 'function') {
      throw new Error('TaskNotes Runtime API query.tasks unavailable.');
    }
    return api.query.tasks(query);
  }

  async function getTask(path) {
    const compat = getCompatibility();
    if (!compat.ok) throw new Error(compat.message);
    const api = getApi();
    if (!api.tasks || typeof api.tasks.get !== 'function') return null;
    return api.tasks.get(path);
  }

  async function createTask(data, context) {
    const compat = getCompatibility();
    if (!compat.ok) throw new Error(compat.message);
    const api = getApi();
    return api.tasks.create(data, mutationContext(context));
  }

  async function complete(path, options, context) {
    const compat = getCompatibility();
    if (!compat.ok) throw new Error(compat.message);
    const api = getApi();
    return api.tasks.complete(path, options, mutationContext(context));
  }

  async function uncomplete(path, options, context) {
    const compat = getCompatibility();
    if (!compat.ok) throw new Error(compat.message);
    const api = getApi();
    return api.tasks.uncomplete(path, options, mutationContext(context));
  }

  async function setStatus(path, status, context) {
    const compat = getCompatibility();
    if (!compat.ok) throw new Error(compat.message);
    const api = getApi();
    return api.tasks.setStatus(path, status, mutationContext(context));
  }

  async function updateTask(path, patch, context) {
    const compat = getCompatibility();
    if (!compat.ok) throw new Error(compat.message);
    const api = getApi();
    if (!api.tasks) throw new Error('TaskNotes api.tasks is unavailable.');
    const mutation = mutationContext(context || { reason: 'timeline quick edit' });
    if (typeof api.tasks.update === 'function') {
      return api.tasks.update(path, patch, mutation);
    }

    // Keep compatibility with Runtime API v1 builds that expose field helpers
    // before the generic update method.
    const changes = Object.entries(patch || {});
    for (const [field, value] of changes) {
      let method;
      if (field === 'priority') method = value == null ? null : api.tasks.setPriority;
      else if (field === 'due') method = value == null ? api.tasks.clearDue : api.tasks.setDue;
      else if (field === 'scheduled') method = value == null ? api.tasks.clearScheduled : api.tasks.setScheduled;
      if (typeof method !== 'function') {
        throw new Error(`TaskNotes cannot update task field: ${field}`);
      }
      if (value == null) await method.call(api.tasks, path, mutation);
      else await method.call(api.tasks, path, value, mutation);
    }
    return api.tasks.get ? api.tasks.get(path) : null;
  }

  function showTaskMenu(opts) {
    const api = getApi();
    if (!hasCapability('ui.task-menu') || !api || !api.ui || !api.ui.taskMenu) return false;
    const menu = api.ui.taskMenu;
    if (typeof menu.show === 'function') {
      menu.show(opts);
      return true;
    }
    if (opts && opts.element && typeof menu.showAtElement === 'function') {
      menu.showAtElement(opts);
      return true;
    }
    return false;
  }

  function populateTaskMenu(menu, opts) {
    const api = getApi();
    if (!hasCapability('ui.task-menu') || !api || !api.ui || !api.ui.taskMenu) return false;
    if (typeof api.ui.taskMenu.populate !== 'function') return false;
    api.ui.taskMenu.populate(menu, opts);
    return true;
  }

  function subscribeLifecycle(handler, registerEvent) {
    const api = getApi();
    if (!api || !api.lifecycle || typeof api.lifecycle.on !== 'function') return false;
    if (!hasCapability('lifecycle.events') && api.apiVersion !== 1) return false;
    try {
      for (const name of ['cache.changed', 'cache.rebuilt', 'settings.changed']) {
        const ref = api.lifecycle.on(name, handler);
        if (ref && typeof registerEvent === 'function') registerEvent(ref);
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function openCreateModal(prefill) {
    const tn = getPlugin();
    if (!tn || typeof tn.openTaskCreationModal !== 'function') return false;
    tn.openTaskCreationModal(prefill || {});
    return true;
  }

  function openEditModal(taskInfo, onUpdate) {
    const tn = getPlugin();
    if (!tn || typeof tn.openTaskEditModal !== 'function') return false;
    return Promise.resolve(tn.openTaskEditModal(taskInfo, onUpdate)).then(() => true);
  }

  function getCalendarService(key) {
    const tn = getPlugin();
    return tn && tn[key] ? tn[key] : null;
  }

  function getIcsNoteService() {
    const tn = getPlugin();
    return tn && tn.icsNoteService ? tn.icsNoteService : null;
  }

  function hasCalendarIntegration() {
    return CALENDAR_SERVICE_KEYS.some((key) => {
      const service = getCalendarService(key);
      return service && typeof service.getAllEvents === 'function';
    });
  }

  function listCalendarEvents() {
    calendarReadErrors = [];
    if (!getPlugin()) return [];

    const out = [];
    const seen = new Set();
    const push = (list, resolveMeta) => {
      for (const ev of list || []) {
        if (!ev) continue;
        const id = ev.id || `${ev.subscriptionId || 'cal'}:${ev.start || ''}:${ev.title || ''}`;
        if (!id || seen.has(id)) continue;
        let meta;
        try { meta = resolveMeta(ev); } catch (e) { continue; }
        if (!meta) continue;
        seen.add(id);
        out.push(Object.assign({}, ev, meta, { isEvent: true, id }));
      }
    };

    const ics = getCalendarService('icsSubscriptionService');
    if (ics && typeof ics.getAllEvents === 'function') {
      try {
        const subs = new Map();
        if (typeof ics.getSubscriptions === 'function') {
          for (const s of ics.getSubscriptions() || []) {
            if (s && s.id) subs.set(s.id, s);
            if (s && s.lastError) calendarReadErrors.push({
              source: s.name || 'ICS calendar',
              message: String(s.lastError),
            });
          }
        }
        push(ics.getAllEvents(), (ev) => {
          const sub = subs.get(ev.subscriptionId);
          if (sub && sub.enabled === false) return null;
          return {
            calendarName: (sub && sub.name) || 'Calendar',
            color: ev.color || (sub && sub.color) || '#7aa2f7',
          };
        });
      } catch (e) { calendarReadErrors.push({ source: 'ICS calendar', message: (e && e.message) || String(e) }); }
    }

    const google = getCalendarService('googleCalendarService');
    if (google && typeof google.getAllEvents === 'function') {
      try {
        const calendars = typeof google.getAvailableCalendars === 'function'
          ? google.getAvailableCalendars()
          : [];
        push(google.getAllEvents(), (ev) => {
          const calId = String(ev.subscriptionId || '').replace(/^google-/, '');
          const cal = findProviderCalendar(calendars, calId);
          if (!calendarIsEnabled(cal)) return null;
          return {
            calendarName: calendarLabel(cal, 'Google Calendar'),
            color: ev.color || calendarColor(cal, GOOGLE_DEFAULT_COLOR),
          };
        });
      } catch (e) { calendarReadErrors.push({ source: 'Google Calendar', message: (e && e.message) || String(e) }); }
    }

    const microsoft = getCalendarService('microsoftCalendarService');
    if (microsoft && typeof microsoft.getAllEvents === 'function') {
      try {
        const calendars = typeof microsoft.getAvailableCalendars === 'function'
          ? microsoft.getAvailableCalendars()
          : [];
        push(microsoft.getAllEvents(), (ev) => {
          const calId = String(ev.subscriptionId || '').replace(/^microsoft-/, '');
          const cal = findProviderCalendar(calendars, calId);
          if (!calendarIsEnabled(cal)) return null;
          return {
            calendarName: calendarLabel(cal, 'Microsoft Calendar'),
            color: ev.color || calendarColor(cal, MICROSOFT_DEFAULT_COLOR),
          };
        });
      } catch (e) { calendarReadErrors.push({ source: 'Microsoft Calendar', message: (e && e.message) || String(e) }); }
    }

    return out;
  }

  function getCalendarReadErrors() {
    return calendarReadErrors.slice();
  }

  function subscribeCalendarDataChanged(handler, alreadySubscribed) {
    const subscribed = alreadySubscribed || new Set();
    const unsubs = [];
    for (const key of CALENDAR_SERVICE_KEYS) {
      if (subscribed.has(key)) continue;
      const service = getCalendarService(key);
      if (!service || typeof service.on !== 'function') continue;
      try {
        const unsub = service.on('data-changed', handler);
        if (typeof unsub === 'function') unsubs.push(unsub);
        subscribed.add(key);
      } catch (e) { /* optional */ }
    }
    return { unsubs, subscribed };
  }

  async function createTaskFromEvent(ev) {
    const svc = getIcsNoteService();
    if (!svc || typeof svc.createTaskFromICS !== 'function') {
      throw new Error('TaskNotes calendar integration is not available.');
    }
    return svc.createTaskFromICS(ev);
  }

  async function createNoteFromEvent(ev) {
    const svc = getIcsNoteService();
    if (!svc || typeof svc.createNoteFromICS !== 'function') {
      throw new Error('TaskNotes calendar integration is not available.');
    }
    return svc.createNoteFromICS(ev);
  }

  async function findRelatedNotes(ev) {
    const svc = getIcsNoteService();
    if (!svc || typeof svc.findRelatedNotes !== 'function') return [];
    try {
      return (await svc.findRelatedNotes(ev)) || [];
    } catch (e) {
      return [];
    }
  }

  function canFindRelatedNotes() {
    const svc = getIcsNoteService();
    return !!(svc && typeof svc.findRelatedNotes === 'function');
  }

  function canCreateFromEvents() {
    const svc = getIcsNoteService();
    return !!(
      svc
      && typeof svc.createTaskFromICS === 'function'
      && typeof svc.createNoteFromICS === 'function'
    );
  }

  return {
    SOURCE,
    REQUIRED_CAPS,
    getPlugin,
    getApi,
    hasCapability,
    getCompatibility,
    getConfig,
    listTasks,
    queryTasks,
    getTask,
    createTask,
    complete,
    uncomplete,
    setStatus,
    updateTask,
    showTaskMenu,
    populateTaskMenu,
    subscribeLifecycle,
    openCreateModal,
    openEditModal,
    hasCalendarIntegration,
    listCalendarEvents,
    getCalendarReadErrors,
    subscribeCalendarDataChanged,
    createTaskFromEvent,
    createNoteFromEvent,
    findRelatedNotes,
    canFindRelatedNotes,
    canCreateFromEvents,
  };
}

module.exports = {
  SOURCE,
  REQUIRED_CAPS,
  createTaskNotesAdapter,
};

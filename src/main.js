'use strict';

const obsidian = require('obsidian');
const {
  Plugin, MarkdownRenderChild, ItemView,
  Notice, Keymap, Menu, parseYaml,
} = obsidian;
const moment = obsidian.moment || window.moment;
const AgendaController = require('./agenda-controller');
const AgendaEventInfoModal = require('./agenda-event-modal');
const AgendaSettingTab = require('./agenda-settings');

const {
  VIEW_TYPE_AGENDA,
  COMPLETION_UNDO_MS,
  DEFAULT_SETTINGS,
} = require('./constants');
const { debounce, parseNonNegInt } = require('./utils');
const { parseOptions } = require('./block-options');
const {
  convertBasesFiltersToWhere,
  mergeBasesFilters,
  parseBaseDocument,
  viewsFromBaseDoc,
  findViewInDoc,
} = require('./bases-filters');
const { createCalendarHelpers } = require('./calendar-helpers');
const {
  createAdapterIO,
  createCalendarEventsCache,
  resolveCalendarEvents,
} = require('./calendar-events-cache');
const { createTaskNotesAdapter } = require('./tasknotes-adapter');
const { mapTaskInfo, completionTarget, recurringOccurrenceDate, isRecurringSeries } = require('./task-mapper');

const {
  eventDateKeys,
  eventStartMoment,
  hasClockTime,
  eventHasEnded,
} = createCalendarHelpers(moment, {
  maxRecurringOccurrences: DEFAULT_SETTINGS.maxRecurringOccurrences,
});

function recurringMenuDate(task) {
  if (!isRecurringSeries(task)) return undefined;
  const dateKey = recurringOccurrenceDate(task, moment().format('YYYY-MM-DD'));
  if (!dateKey) return undefined;
  const [year, month, day] = dateKey.split('-').map(Number);
  if (!year || !month || !day) return undefined;
  return new Date(year, month - 1, day);
}

module.exports = class TaskNotesTimelineWrapper extends Plugin {
  async onload() {
    this.adapter = createTaskNotesAdapter(this.app);
    this.controllers = new Set();
    this._statusUpdates = new Set();
    this._taskMutations = new Map();
    this._completionUndos = new Map();
    this._sentScheduledReminders = new Map();
    this._scheduledReminderCheckRunning = false;
    this._scheduledReminderSessionStartedAt = null;
    this.register(() => {
      this._unloading = true;
      for (const record of [...this._completionUndos.values()]) this.dismissCompletionUndo(record);
    });
    this._calendarUnsubs = [];
    this._calendarSubscribed = new Set();
    this._calendarEventsCache = [];
    this._calendarEventsCacheUpdatedAt = null;
    this._calendarSyncObserved = false;
    this._activeCalendarErrors = new Set();
    this._viewPathCache = new Map();
    this._taskSnapshot = null;
    this._viewFilterGen = 0;
    this._viewFilterWarned = new Set();
    this._calendarCacheStore = createCalendarEventsCache(
      createAdapterIO(this.app.vault.adapter, this.manifest.dir),
    );
    this.register(() => this._calendarCacheStore.cancelScheduledSave());
    await this.loadSettings();
    const calendarSnapshot = await this._calendarCacheStore.loadSnapshot();
    this._calendarEventsCache = calendarSnapshot.events;
    this._calendarEventsCacheUpdatedAt = calendarSnapshot.updatedAt;
    this.addSettingTab(new AgendaSettingTab(this.app, this));

    this.registerView(VIEW_TYPE_AGENDA, (leaf) => new AgendaPane(leaf, this));
    this.addRibbonIcon('calendar-clock', 'TaskNotes Timeline Wrapper', () => this.activateAgenda());
    this.addCommand({ id: 'open-timeline', name: "Open Today's Timeline", callback: () => this.activateAgenda() });

    this.registerMarkdownCodeBlockProcessor('tasknotes-timeline-wrapper', (source, el, ctx) => {
      ctx.addChild(new AgendaBlock(this, el, parseOptions(source)));
    });

    this._refreshTasks = debounce(() => {
      this.invalidateTaskCache();
      this.renderAll();
    }, 500);
    this._refreshViews = debounce(() => {
      this.invalidateViewFilterCache();
      this.renderAll();
    }, 500);
    this._refreshEverything = debounce(() => this.refreshAll(), 500);
    this.register(() => this._refreshTasks.cancel());
    this.register(() => this._refreshViews.cancel());
    this.register(() => this._refreshEverything.cancel());
    // TaskNotes lifecycle events are the authoritative task invalidation source.
    // Metadata events remain a startup fallback until that subscription exists.
    this.registerEvent(this.app.metadataCache.on('resolved', () => {
      if (!this._lifecycleSubscribed) this._refreshTasks();
    }));
    this.registerEvent(this.app.metadataCache.on('changed', (file) => {
      if (file && file.extension === 'base') this._refreshViews();
      else if (!this._lifecycleSubscribed) this._refreshTasks();
    }));
    const onBaseFileChange = (file) => {
      if (file && file.extension === 'base') this._refreshViews();
    };
    this.registerEvent(this.app.vault.on('modify', onBaseFileChange));
    this.registerEvent(this.app.vault.on('create', onBaseFileChange));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if ((file && file.extension === 'base') || String(oldPath || '').endsWith('.base')) this._refreshViews();
      else if (!this._lifecycleSubscribed) this._refreshTasks();
    }));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      if (file && file.extension === 'base') this._refreshViews();
      else if (!this._lifecycleSubscribed) this._refreshTasks();
    }));
    this.registerInterval(window.setInterval(() => {
      this.refreshAll();
    }, 5 * 60 * 1000));
    this.registerInterval(window.setInterval(() => {
      this.controllers.forEach((controller) => controller.refreshTimeIndicators());
    }, 30 * 1000));
    this.registerInterval(window.setInterval(() => {
      void this.checkScheduledReminders();
    }, 15 * 1000));

    this.app.workspace.onLayoutReady(() => {
      this.subscribeCalendarServices();
      this.subscribeTaskNotesLifecycle();
      void this.checkScheduledReminders();
    });
    // Safety net if TaskNotes loads after us — also re-tried from render().
    this.register(() => this.unsubscribeCalendarServices());
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.renderAll();
  }

  invalidateTaskCache() {
    this._taskSnapshot = null;
  }

  invalidateViewFilterCache() {
    this._viewPathCache.clear();
    this._viewFilterGen = (this._viewFilterGen || 0) + 1;
  }

  renderAll() {
    this.controllers.forEach((c) => void c.render());
  }

  refreshAll() {
    this.invalidateTaskCache();
    this.invalidateViewFilterCache();
    this.renderAll();
  }

  subscribeTaskNotesLifecycle() {
    if (this._lifecycleSubscribed) return;
    const ok = this.adapter.subscribeLifecycle(
      () => this._refreshEverything(),
      (ref) => this.registerEvent(ref),
    );
    if (ok) this._lifecycleSubscribed = true;
  }

  async activateAgenda() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_AGENDA)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_AGENDA, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  getTaskNotes() {
    return this.adapter.getPlugin();
  }

  getCompatibility() {
    return this.adapter.getCompatibility();
  }

  getViewsFolder() {
    return this.adapter.getConfig().viewsFolder;
  }

  listBaseFiles() {
    const viewsFolder = this.getViewsFolder();
    const files = this.app.vault.getFiles().filter((f) => f.extension === 'base');
    files.sort((a, b) => {
      const aIn = a.path.startsWith(viewsFolder + '/') || a.path === viewsFolder ? 0 : 1;
      const bIn = b.path.startsWith(viewsFolder + '/') || b.path === viewsFolder ? 0 : 1;
      if (aIn !== bIn) return aIn - bIn;
      return a.path.localeCompare(b.path);
    });
    return files;
  }

  async readBaseDocument(path) {
    if (!path) return null;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || typeof file.extension !== 'string' || file.extension !== 'base') return null;
    try {
      // Prefer vault.read so edits to .base files are visible immediately
      // (cachedRead can stay stale until restart in some cases).
      const text = await this.app.vault.read(file);
      return parseBaseDocument(text, parseYaml);
    } catch (e) {
      return null;
    }
  }

  getBaseFileMtime(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !file.stat) return 0;
    return file.stat.mtime || 0;
  }

  async listViewsInBase(path) {
    const doc = await this.readBaseDocument(path);
    return viewsFromBaseDoc(doc);
  }

  resolveViewFilterSource(opts) {
    const s = this.settings;
    const basePath = (opts && opts.base != null ? opts.base : s.tasknotesBasePath) || '';
    const viewName = (opts && opts.view != null ? opts.view : s.tasknotesViewName) || '';
    return {
      basePath: String(basePath).trim(),
      viewName: String(viewName).trim(),
    };
  }

  // Keep no filter, applied filter, errors and obsolete results distinct.
  // Cache promises by source so embedded agendas can share in-flight queries.
  async getViewTaskPathSet(opts) {
    const { basePath, viewName } = this.resolveViewFilterSource(opts);
    if (!basePath) return { status: 'none', paths: null };
    const gen = this._viewFilterGen || 0;
    const mtime = this.getBaseFileMtime(basePath);
    const cacheKey = JSON.stringify([basePath, viewName, mtime]);
    if (this._viewPathCache.has(cacheKey)) return this._viewPathCache.get(cacheKey);
    const pending = this.queryViewTaskPaths(basePath, viewName, gen);
    this._viewPathCache.set(cacheKey, pending);
    const result = await pending;
    if (gen !== this._viewFilterGen) return { status: 'stale', paths: null };
    if (result.status === 'error') {
      this._viewPathCache.delete(cacheKey);
      this.warnViewFilterOnce(`${cacheKey}::${result.message}`, result.message);
    }
    return result;
  }

  async queryViewTaskPaths(basePath, viewName, gen) {
    try {
      const doc = await this.readBaseDocument(basePath);
      if (gen !== this._viewFilterGen) return { status: 'stale', paths: null };
      if (!doc) throw new Error(`Could not read TaskNotes base: ${basePath}`);
      const view = findViewInDoc(doc, viewName);
      if (viewName && !view) throw new Error(`View "${viewName}" not found in ${basePath}`);
      const merged = mergeBasesFilters(doc.filters ?? null, view ? view.filters : null);
      const warnings = [];
      const where = convertBasesFiltersToWhere(merged, warnings);
      if (warnings.length) throw new Error(`Filter not applied: ${warnings.join(' ')}`);
      if (!where) return { status: 'applied', paths: null };
      const result = await this.adapter.queryTasks({
        where,
        scope: { includeArchived: false },
      });
      if (gen !== this._viewFilterGen) return { status: 'stale', paths: null };
      if (!result || !Array.isArray(result.tasks)) throw new Error('Invalid TaskNotes query response.');
      const paths = new Set();
      for (const task of result.tasks) {
        if (task && task.path) paths.add(task.path);
      }
      return { status: 'applied', paths };
    } catch (e) {
      return { status: 'error', paths: new Set(), message: (e && e.message) || String(e) };
    }
  }

  warnViewFilterOnce(key, message) {
    if (this._viewFilterWarned.has(key)) return;
    if (this._viewFilterWarned.size >= 100) this._viewFilterWarned.clear();
    this._viewFilterWarned.add(key);
    console.warn(`[tasknotes-timeline-wrapper] ${message}`);
    new Notice(message, 5000);
  }

  hasCalendarIntegration() {
    return this.adapter.hasCalendarIntegration();
  }

  subscribeCalendarServices() {
    this.subscribeTaskNotesLifecycle();
    const { unsubs, subscribed } = this.adapter.subscribeCalendarDataChanged(
      () => {
        this._calendarSyncObserved = true;
        this.renderAll();
      },
      this._calendarSubscribed,
    );
    for (const unsub of unsubs) this._calendarUnsubs.push(unsub);
    this._calendarSubscribed = subscribed;
  }

  unsubscribeCalendarServices() {
    for (const unsub of this._calendarUnsubs) {
      try { unsub(); } catch (e) { /* ignore */ }
    }
    this._calendarUnsubs = [];
    this._calendarSubscribed = new Set();
  }

  getConfig() {
    return this.adapter.getConfig();
  }

  async getTasks(cfg) {
    const compat = this.adapter.getCompatibility();
    if (!compat.ok) {
      this._taskSnapshot = null;
      return [];
    }
    const key = JSON.stringify([
      cfg.defaultStatus,
      cfg.doneStatus,
      Object.keys(cfg.statusMap || {}).sort(),
      cfg.taskTag,
    ]);
    if (this._taskSnapshot && this._taskSnapshot.key === key) return this._taskSnapshot.tasks;

    const infos = await this.adapter.listTasks({ scope: { includeArchived: false } });
    const out = [];
    for (const info of infos) {
      if (info && info.archived) continue;
      const mapped = mapTaskInfo(info, cfg, (path) => this.app.vault.getAbstractFileByPath(path));
      if (mapped) out.push(mapped);
    }
    this._taskSnapshot = { key, tasks: out };
    return out;
  }

  getCalendarEvents() {
    // TaskNotes may finish booting after us — keep trying to attach listeners.
    this.subscribeCalendarServices();
    const live = this.adapter.listCalendarEvents();
    this.reportCalendarReadErrors();
    const resolved = resolveCalendarEvents({
      live,
      cache: this._calendarEventsCache,
      cacheUpdatedAt: this._calendarEventsCacheUpdatedAt,
      syncObserved: this._calendarSyncObserved,
    });
    if (resolved.shouldPersist) {
      this._calendarEventsCache = resolved.persistEvents;
      this._calendarEventsCacheUpdatedAt = new Date().toISOString();
      this._calendarCacheStore.scheduleSave(resolved.persistEvents);
    }
    return resolved.events;
  }

  async checkScheduledReminders() {
    const NotificationApi = window.Notification;
    if (!this.settings?.scheduledNotificationsEnabled
      || !NotificationApi
      || NotificationApi.permission !== 'granted'
      || this._scheduledReminderCheckRunning
      || this._unloading) return;
    if (this._scheduledReminderSessionStartedAt == null) {
      this._scheduledReminderSessionStartedAt = Date.now();
    }
    const sessionStartedAt = this._scheduledReminderSessionStartedAt;
    this._scheduledReminderCheckRunning = true;
    try {
      const cfg = this.getConfig();
      const [tasks, events] = await Promise.all([
        this.getTasks(cfg),
        Promise.resolve(this.getCalendarEvents()),
      ]);
      const now = Date.now();
      const leadMinutes = parseNonNegInt(
        this.settings.scheduledNotificationLeadMinutes,
        DEFAULT_SETTINGS.scheduledNotificationLeadMinutes,
      );
      const leadMs = leadMinutes * 60 * 1000;
      const startGraceMs = 2 * 60 * 1000;
      const staleBeforeMs = 24 * 60 * 60 * 1000;

      for (const [key, startMs] of this._sentScheduledReminders) {
        if (startMs < now - staleBeforeMs) this._sentScheduledReminders.delete(key);
      }

      const notify = (kind, title, identity, startMs) => {
        const phase = now >= startMs ? 'start' : 'before';
        const key = `${identity}:${startMs}:${phase}`;
        if (this._sentScheduledReminders.has(key)) return;
        // Do not replay a start notification for an item that was already overdue
        // when scheduled-reminder checks began (for example, when Obsidian opened).
        if (phase === 'start' && startMs < sessionStartedAt) return;
        if (phase === 'before' && (leadMinutes === 0 || now < startMs - leadMs)) return;
        if (phase === 'start' && now - startMs > startGraceMs) return;
        const heading = phase === 'start'
          ? `${kind} starting now`
          : `${kind} in ${leadMinutes} minutes`;
        try {
          new NotificationApi(heading, { body: title, tag: key });
          this._sentScheduledReminders.set(key, startMs);
        } catch (error) {
          console.warn('[tasknotes-timeline-wrapper] Could not show system notification', error);
        }
      };

      for (const task of tasks) {
        if (!task || task.done) continue;
        const scheduled = task.scheduled;
        if (!hasClockTime(scheduled)) continue;
        const start = moment(scheduled, [moment.ISO_8601, 'YYYY-MM-DD HH:mm', 'YYYY-MM-DDTHH:mm'], true);
        if (!start.isValid()) continue;
        const startMs = start.valueOf();
        if (now >= startMs - leadMs && now < startMs + startGraceMs) {
          notify('Task', task.title || task.path || 'Untitled task', `task:${task.path}`, startMs);
        }
      }

      for (const event of events) {
        if (!event || event.allDay || !hasClockTime(event.start)) continue;
        const start = eventStartMoment(event);
        if (!start.isValid()) continue;
        const startMs = start.valueOf();
        if (now >= startMs - leadMs && now < startMs + startGraceMs) {
          notify('Event', event.title || 'Untitled event', `event:${event.id || event.calendarName || ''}`, startMs);
        }
      }
    } catch (error) {
      console.error('[tasknotes-timeline-wrapper] Scheduled reminder check failed', error);
    } finally {
      this._scheduledReminderCheckRunning = false;
    }
  }

  reportCalendarReadErrors() {
    const errors = this.adapter.getCalendarReadErrors();
    const current = new Set();
    for (const error of errors) {
      const key = `${error.source}: ${error.message}`;
      current.add(key);
      if (this._activeCalendarErrors.has(key)) continue;
      new Notice(`Calendar synchronization failed (${key}).`, 8000);
    }
    this._activeCalendarErrors = current;
  }

  isCalendarLoading() {
    return this.hasCalendarIntegration()
      && !this._calendarSyncObserved
      && this._activeCalendarErrors.size === 0;
  }

  // Events for a day key map, optionally dropping ones that already ended today.
  bucketCalendarEvents(events, todayKey, hideFinished) {
    const buckets = new Map();
    const now = moment();
    for (const ev of events) {
      if (hideFinished) {
        const keys = eventDateKeys(ev);
        if (keys.includes(todayKey) && eventHasEnded(ev, now)) {
          // Still show on other days of a multi-day span; drop only the today slot.
          for (const key of keys) {
            if (key === todayKey) continue;
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(ev);
          }
          continue;
        }
      }
      for (const key of eventDateKeys(ev)) {
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(ev);
      }
    }
    return buckets;
  }

  showEventsEnabled(opts) {
    if (opts && typeof opts.events === 'boolean') return opts.events;
    return !!this.settings.showCalendarEvents;
  }

  openEventDetails(ev) {
    new AgendaEventInfoModal(this.app, this, ev).open();
  }

  openEventMenu(ev, mouseEvent) {
    const menu = new Menu();

    menu.addItem((item) => item
      .setTitle('Show details')
      .setIcon('info')
      .onClick(() => this.openEventDetails(ev)));

    menu.addSeparator();

    menu.addItem((item) => item
      .setTitle('Create task from event')
      .setIcon('check-circle')
      .onClick(async () => {
        try {
          await this.adapter.createTaskFromEvent(ev);
          new Notice(`Task created: ${ev.title}`);
        } catch (e) {
          new Notice(e && e.message ? e.message : 'Could not create task from event.');
        }
      }));

    menu.addItem((item) => item
      .setTitle('Create note from event')
      .setIcon('file-plus')
      .onClick(async () => {
        try {
          await this.adapter.createNoteFromEvent(ev);
          new Notice(`Note created: ${ev.title}`);
        } catch (e) {
          new Notice(e && e.message ? e.message : 'Could not create note from event.');
        }
      }));

    if (ev.url) {
      menu.addSeparator();
      menu.addItem((item) => item
        .setTitle('Open link')
        .setIcon('external-link')
        .onClick(() => {
          window.open(ev.url, '_blank', 'noopener');
        }));
    }

    menu.addSeparator();
    menu.addItem((item) => item
      .setTitle('Copy title')
      .setIcon('copy')
      .onClick(async () => {
        try {
          await navigator.clipboard.writeText(ev.title || '');
          new Notice('Title copied');
        } catch (e) {
          new Notice('Could not copy title.');
        }
      }));

    if (mouseEvent) menu.showAtMouseEvent(mouseEvent);
    else menu.showAtPosition({ x: 0, y: 0 });
  }

  async toggleStatus(task, cfg) {
    const path = task.path || (task.file && task.file.path);
    if (!path || this._statusUpdates.has(path)) return;
    this._statusUpdates.add(path);
    try {
      if (!task.done) {
        const previousStatus = task.status || cfg.defaultStatus;
        const target = completionTarget(task, moment().format('YYYY-MM-DD'));
        if (target.kind === 'instance') {
          await this.adapter.toggleCompleteInstance(path, target.date);
        } else {
          await this.adapter.complete(path);
        }
        const record = {
          file: task.file,
          path,
          title: task.title,
          previousStatus,
          completedStatus: cfg.doneStatus,
          recurring: target.kind === 'instance',
          instanceDate: target.date,
        };
        const previous = this._completionUndos.get(path);
        if (previous) this.dismissCompletionUndo(previous);
        if (!this._unloading) this.showCompletionUndo(record);
      } else {
        await this.adapter.uncomplete(path, { status: cfg.defaultStatus });
      }
    } finally {
      this._statusUpdates.delete(path);
    }
  }

  async updateTaskFields(task, patch, refresh = true) {
    const path = task.path || (task.file && task.file.path);
    if (!path) throw new Error('Task path is unavailable.');
    const previous = this._taskMutations.get(path) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.adapter.updateTask(path, patch));
    this._taskMutations.set(path, operation);
    try {
      await operation;
      Object.assign(task, patch);
      if (refresh) this.refreshAll();
      return true;
    } finally {
      if (this._taskMutations.get(path) === operation) this._taskMutations.delete(path);
    }
  }

  showCompletionUndo(record) {
    const fragment = document.createDocumentFragment();
    const content = document.createElement('span');
    content.className = 'fw-agenda-undo';
    const label = document.createElement('span');
    label.textContent = `Completed: ${record.title}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Undo';
    button.setAttribute('aria-label', `Undo completion of ${record.title}`);
    content.append(label, button);
    fragment.append(content);
    record.expiresAt = Date.now() + COMPLETION_UNDO_MS;
    record.button = button;
    record.onClick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.undoCompletion(record);
    };
    button.addEventListener('click', record.onClick);
    this._completionUndos.set(record.path, record);
    record.notice = new Notice(fragment, 0);
    record.timer = window.setTimeout(() => this.dismissCompletionUndo(record), COMPLETION_UNDO_MS);
  }

  dismissCompletionUndo(record) {
    window.clearTimeout(record.timer);
    if (record.button) record.button.removeEventListener('click', record.onClick);
    if (record.notice) record.notice.hide();
    if (this._completionUndos.get(record.path) === record) this._completionUndos.delete(record.path);
  }

  async undoCompletion(record) {
    if (this._completionUndos.get(record.path) !== record || record.busy || this._statusUpdates.has(record.path)) return false;
    if (Date.now() >= record.expiresAt) { this.dismissCompletionUndo(record); return false; }
    record.busy = true;
    record.button.disabled = true;
    this._statusUpdates.add(record.path);
    try {
      if (record.recurring) {
        await this.adapter.toggleCompleteInstance(record.path, record.instanceDate);
      } else {
        await this.adapter.uncomplete(record.path, { status: record.previousStatus });
      }
      this.dismissCompletionUndo(record);
      this.refreshAll();
      return true;
    } catch (error) {
      console.error('[tasknotes-timeline-wrapper] Undo completion failed', error);
      new Notice('Could not undo completion.');
      return false;
    } finally {
      record.busy = false;
      record.button.disabled = false;
      this._statusUpdates.delete(record.path);
    }
  }

  // Hand off to TaskNotes' own creation modal (full field editor + NLP parsing).
  openNativeCreator(rawTitle) {
    const text = (rawTitle || '').trim();
    const cfg = this.getConfig();
    const prefill = (!cfg.enableNaturalLanguageInput && text) ? { title: text } : {};
    if (this.adapter.openCreateModal(prefill)) return true;
    if (this.app.commands.executeCommandById('tasknotes:create-new-task')) return true;
    new Notice('TaskNotes is not available.');
    return false;
  }

  // Click routing for task titles. A mod-click keeps Obsidian's native meaning
  // (tab / split) regardless of the setting; a plain click follows openInNewTab.
  // forceNewTab is the middle-click path — a new tab is the whole point there,
  // so it ignores the setting.
  openTask(file, evt, forceNewTab) {
    const ws = this.app.workspace;
    const mode = evt ? Keymap.isModEvent(evt) : false;
    if (mode) { ws.getLeaf(mode).openFile(file); return; }
    if (!forceNewTab && !this.settings.openInNewTab) { ws.getLeaf(false).openFile(file); return; }
    // getLeaf('tab') always builds a new one, so repeat clicks would stack
    // duplicate tabs of the same task — surface the existing one instead.
    const open = ws.getLeavesOfType('markdown')
      .find((l) => l.view && l.view.file && l.view.file.path === file.path);
    if (open) { ws.revealLeaf(open); ws.setActiveLeaf(open, { focus: true }); return; }
    ws.getLeaf('tab').openFile(file);
  }

  async resolveTaskInfo(task) {
    const path = task.path || (task.file && task.file.path);
    if (!path) return null;
    try {
      const info = await this.adapter.getTask(path);
      if (info) return info;
    } catch (e) { /* fall through to local shape */ }
    return {
      title: task.title,
      status: task.status,
      priority: task.priority || 'none',
      due: task.due || undefined,
      scheduled: task.scheduled || undefined,
      path,
      archived: false,
      tags: task.tags || [],
      projects: task.projects || [],
    };
  }

  async openTaskDetails(task) {
    const info = await this.resolveTaskInfo(task);
    if (!info) {
      new Notice('Could not open task details.');
      return;
    }
    try {
      const opened = await this.adapter.openEditModal(info, () => this.refreshAll());
      if (!opened) this.openTask(task.file, null, false);
    } catch (e) {
      new Notice('Could not open task details.');
    }
  }

  openTaskMenu(task, mouseEvent) {
    const path = task.path || (task.file && task.file.path);
    const onUpdate = () => this.refreshAll();
    if (path && this.adapter.showTaskMenu({
      taskPath: path,
      event: mouseEvent,
      onUpdate,
      targetDate: recurringMenuDate(task),
    })) {
      return;
    }

    const menu = new Menu();

    menu.addItem((item) => item
      .setTitle('Show details')
      .setIcon('info')
      .onClick(() => this.openTaskDetails(task)));

    menu.addSeparator();

    menu.addItem((item) => item
      .setTitle('Open note')
      .setIcon('file-text')
      .onClick(() => this.openTask(task.file, mouseEvent, false)));

    menu.addItem((item) => item
      .setTitle('Open in new tab')
      .setIcon('file-plus')
      .onClick(() => this.openTask(task.file, mouseEvent, true)));

    menu.addSeparator();
    menu.addItem((item) => item
      .setTitle('Copy title')
      .setIcon('copy')
      .onClick(async () => {
        try {
          await navigator.clipboard.writeText(task.title || '');
          new Notice('Title copied');
        } catch (e) {
          new Notice('Could not copy title.');
        }
      }));

    if (mouseEvent) menu.showAtMouseEvent(mouseEvent);
    else menu.showAtPosition({ x: 0, y: 0 });
  }

  openStatusMenu(task, mouseEvent) {
    const path = task.path || (task.file && task.file.path);
    if (!path) return;
    const onUpdate = () => this.refreshAll();
    if (this.adapter.showTaskMenu({
      taskPath: path,
      event: mouseEvent,
      onUpdate,
      targetDate: recurringMenuDate(task),
    })) return;
    this.openTaskMenu(task, mouseEvent);
  }

  async createTask(rawTitle, cfg) {
    const title = (rawTitle || '').trim();
    if (!title) return;
    await this.adapter.createTask({
      title,
      status: cfg.defaultStatus,
    });
    new Notice(`Task created: ${title}`);
  }
};

class AgendaBlock extends MarkdownRenderChild {
  constructor(plugin, el, opts) { super(el); this.plugin = plugin; this.opts = opts; }
  onload() {
    this.ctrl = new AgendaController(this.plugin, this.containerEl, this.opts);
    this.plugin.controllers.add(this.ctrl);
    this.ctrl.render();
  }
  onunload() { this.ctrl.dispose(); this.plugin.controllers.delete(this.ctrl); }
}

/* Workspace pane (sidebar or main). */
class AgendaPane extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW_TYPE_AGENDA; }
  getDisplayText() { return "Today's Timeline"; }
  getIcon() { return 'calendar-clock'; }
  async onOpen() {
    this.contentEl.addClass('fw-agenda-view');
    // Horizons come from plugin settings at render time (not baked in here).
    this.ctrl = new AgendaController(this.plugin, this.contentEl, { title: "Today's Timeline" });
    this.plugin.controllers.add(this.ctrl);
    this.ctrl.render();
  }
  async onClose() {
    if (this.ctrl) { this.ctrl.dispose(); this.plugin.controllers.delete(this.ctrl); }
  }
}

/* Settings. */

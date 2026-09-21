'use strict';

const obsidian = require('obsidian');
const {
  Plugin, PluginSettingTab, Setting, MarkdownRenderChild, ItemView,
  Notice, setIcon, Keymap, Menu, Modal, parseYaml,
} = obsidian;
const moment = obsidian.moment || window.moment;

const {
  VIEW_TYPE_AGENDA,
  COMPLETION_UNDO_MS,
  DEFAULT_SETTINGS,
  META_ICONS,
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
const { mapTaskInfo } = require('./task-mapper');

const {
  limitRecurringOccurrences,
  collectAgendaDayKeys,
  withinLookahead,
  indexAgendaTasks,
  eventDateKeys,
  hasClockTime,
  eventHasEnded,
  isEventOngoing,
  isTaskOverdue,
  formatEventTimeRange,
  formatEventDateTimeLabel,
  sortMixedItems,
} = createCalendarHelpers(moment, {
  maxRecurringOccurrences: DEFAULT_SETTINGS.maxRecurringOccurrences,
});

module.exports = class TaskNotesTimelineWrapper extends Plugin {
  async onload() {
    this.adapter = createTaskNotesAdapter(this.app);
    this.controllers = new Set();
    this._statusUpdates = new Set();
    this._completionUndos = new Map();
    this.register(() => {
      this._unloading = true;
      for (const record of [...this._completionUndos.values()]) this.dismissCompletionUndo(record);
    });
    this._calendarUnsubs = [];
    this._calendarSubscribed = new Set();
    this._calendarEventsCache = [];
    this._calendarSyncObserved = false;
    this._viewPathCache = new Map();
    this._taskSnapshot = null;
    this._viewFilterGen = 0;
    this._viewFilterWarned = new Set();
    this._calendarCacheStore = createCalendarEventsCache(
      createAdapterIO(this.app.vault.adapter, this.manifest.dir),
    );
    this.register(() => this._calendarCacheStore.cancelScheduledSave());
    await this.loadSettings();
    this._calendarEventsCache = await this._calendarCacheStore.load();
    this.addSettingTab(new AgendaSettingTab(this.app, this));

    this.registerView(VIEW_TYPE_AGENDA, (leaf) => new AgendaPane(leaf, this));
    this.addRibbonIcon('calendar-clock', 'TaskNotes Timeline Wrapper', () => this.activateAgenda());
    this.addCommand({ id: 'open-timeline', name: "Open Today's Timeline", callback: () => this.activateAgenda() });

    this.registerMarkdownCodeBlockProcessor('tasknotes-timeline-wrapper', (source, el, ctx) => {
      ctx.addChild(new AgendaBlock(this, el, parseOptions(source)));
    });

    this._refresh = debounce(() => {
      this.invalidateViewFilterCache();
      this.controllers.forEach((c) => c.render());
    }, 500);
    this.register(() => this._refresh.cancel());
    this.registerEvent(this.app.metadataCache.on('resolved', this._refresh));
    this.registerEvent(this.app.metadataCache.on('changed', this._refresh));
    const onBaseFileChange = (file) => {
      if (file && file.extension === 'base') this._refresh();
    };
    this.registerEvent(this.app.vault.on('modify', onBaseFileChange));
    this.registerEvent(this.app.vault.on('create', onBaseFileChange));
    this.registerEvent(this.app.vault.on('rename', this._refresh));
    this.registerEvent(this.app.vault.on('delete', this._refresh));
    this.registerInterval(window.setInterval(() => {
      this.invalidateViewFilterCache();
      this.controllers.forEach((c) => c.render());
    }, 5 * 60 * 1000));
    this.registerInterval(window.setInterval(() => {
      this.controllers.forEach((controller) => controller.refreshTimeIndicators());
    }, 30 * 1000));

    this.app.workspace.onLayoutReady(() => {
      this.subscribeCalendarServices();
      this.subscribeTaskNotesLifecycle();
    });
    // Safety net if TaskNotes loads after us — also re-tried from render().
    this.register(() => this.unsubscribeCalendarServices());
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshAll();
  }

  invalidateViewFilterCache() {
    this._viewPathCache.clear();
    this._taskSnapshot = null;
    this._viewFilterGen = (this._viewFilterGen || 0) + 1;
  }

  refreshAll() {
    this.invalidateViewFilterCache();
    this.controllers.forEach((c) => c.render());
  }

  subscribeTaskNotesLifecycle() {
    if (this._lifecycleSubscribed) return;
    const ok = this.adapter.subscribeLifecycle(
      () => this._refresh(),
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
        this._refresh();
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
    const resolved = resolveCalendarEvents({
      live,
      cache: this._calendarEventsCache,
      syncObserved: this._calendarSyncObserved,
    });
    if (resolved.shouldPersist) {
      this._calendarEventsCache = resolved.persistEvents;
      this._calendarCacheStore.scheduleSave(resolved.persistEvents);
    }
    return resolved.events;
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
        await this.adapter.complete(path);
        const record = {
          file: task.file,
          path,
          title: task.title,
          previousStatus,
          completedStatus: cfg.doneStatus,
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
      await this.adapter.uncomplete(record.path, { status: record.previousStatus });
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
    if (path && this.adapter.showTaskMenu({ taskPath: path, event: mouseEvent, onUpdate })) {
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
    if (this.adapter.showTaskMenu({ taskPath: path, event: mouseEvent, onUpdate })) return;
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

/* Event details modal — mirrors TaskNotes ICSEventInfoModal essentials (not publicly exported). */
class AgendaEventInfoModal extends Modal {
  constructor(app, plugin, ev) {
    super(app);
    this.plugin = plugin;
    this.ev = ev;
    this.relatedNotes = [];
  }

  async onOpen() {
    await this.renderContent();
  }

  onClose() {
    this.contentEl.empty();
  }

  async loadRelatedNotes() {
    this.relatedNotes = await this.plugin.adapter.findRelatedNotes(this.ev);
  }

  async renderContent() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('fw-event-info-modal');
    const ev = this.ev;
    const adapter = this.plugin.adapter;

    await this.loadRelatedNotes();

    new Setting(contentEl).setName('Calendar event').setHeading();

    new Setting(contentEl)
      .setName('Title')
      .setDesc(ev.title || 'Untitled event');

    if (ev.calendarName) {
      new Setting(contentEl)
        .setName('Calendar')
        .setDesc(ev.calendarName);
    }

    new Setting(contentEl)
      .setName('Date & time')
      .setDesc(formatEventDateTimeLabel(ev));

    if (ev.location) {
      new Setting(contentEl)
        .setName('Location')
        .setDesc(ev.location);
    }

    if (ev.description) {
      new Setting(contentEl)
        .setName('Description')
        .setDesc(ev.description);
    }

    if (ev.url) {
      const urlSetting = new Setting(contentEl).setName('URL');
      const link = urlSetting.descEl.createEl('a', {
        cls: 'external-link',
        href: ev.url,
        text: ev.url,
      });
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener');
    }

    if (adapter.canFindRelatedNotes()) {
      new Setting(contentEl).setName('Related notes').setHeading();
      if (!this.relatedNotes.length) {
        new Setting(contentEl).setDesc('No related notes or tasks.');
      } else {
        for (const note of this.relatedNotes) {
          const title = note.title || note.path || 'Untitled';
          const isTask = !!(note.status != null || note.priority != null);
          new Setting(contentEl)
            .setName(title)
            .setDesc(isTask ? 'Type: Task' : 'Type: Note')
            .addButton((btn) => btn
              .setButtonText('Open')
              .onClick(async () => {
                const path = note.path;
                if (!path) return;
                const file = this.app.vault.getAbstractFileByPath(path);
                if (file) {
                  await this.app.workspace.getLeaf(false).openFile(file);
                  this.close();
                }
              }));
        }
      }
    }

    new Setting(contentEl).setName('Actions').setHeading();

    new Setting(contentEl)
      .setName('Create from event')
      .setDesc('Create a TaskNotes task or note linked to this calendar event.')
      .addButton((btn) => btn
        .setButtonText('Create note')
        .onClick(async () => {
          try {
            const result = await adapter.createNoteFromEvent(ev);
            new Notice(`Note created: ${ev.title}`);
            if (result && result.file) {
              await this.app.workspace.getLeaf(false).openFile(result.file);
              this.close();
            } else {
              await this.renderContent();
            }
          } catch (e) {
            new Notice(e && e.message ? e.message : 'Could not create note from event.');
          }
        }))
      .addButton((btn) => btn
        .setButtonText('Create task')
        .setCta()
        .onClick(async () => {
          try {
            const result = await adapter.createTaskFromEvent(ev);
            const title = (result && result.taskInfo && result.taskInfo.title) || ev.title;
            new Notice(`Task created: ${title}`);
            if (result && result.file) {
              await this.app.workspace.getLeaf(false).openFile(result.file);
              this.close();
            } else {
              await this.renderContent();
            }
          } catch (e) {
            new Notice(e && e.message ? e.message : 'Could not create task from event.');
          }
        }));

    if (adapter.canFindRelatedNotes()) {
      new Setting(contentEl)
        .setName('Refresh')
        .setDesc('Reload related notes for this event.')
        .addButton((btn) => btn
          .setButtonText('Refresh')
          .onClick(async () => {
            await this.renderContent();
          }));
    }
  }
}

/* Shared renderer — used by both the pane and the code block. */
class AgendaController {
  constructor(plugin, containerEl, opts) {
    this.plugin = plugin;
    this.containerEl = containerEl;
    this.opts = opts;
    this.filter = null; // null | 'todo' | 'overdue' | 'unplanned'
    this.collapsed = new Set(); // section labels the user has collapsed
    this.eventsVisible = true; // session toggle; only relevant when feature is on
    this.draft = '';
    this.draftRevision = 0;
    this.creating = false;
    this.disposed = false;
    this.pendingStatus = new Set();
    this.timeIndicators = [];
  }

  dispose() {
    this.disposed = true;
    this._renderId = (this._renderId || 0) + 1;
    this.inputEl = null;
    this.timeIndicators = [];
  }

  async submitTask(cfg) {
    if (this.creating || !this.draft.trim() || this.disposed) return;
    const text = this.draft;
    const revision = this.draftRevision;
    this.creating = true;
    this.render();
    let saved = false;
    try {
      await this.plugin.createTask(text, cfg);
      saved = true;
      // Do not erase new text entered while the previous task was being saved.
      if (this.draftRevision === revision) {
        this.draft = '';
        this.draftRevision++;
      }
    } catch (e) {
      console.error('[tasknotes-timeline-wrapper] Task creation failed', e);
      new Notice('Could not create task. Your draft has been kept.');
    } finally {
      this.creating = false;
      if (saved) this.plugin.refreshAll();
      else this.render();
    }
  }

  relDate(dateStr) {
    const d = moment(dateStr, [moment.ISO_8601, 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD'], true);
    const today = moment().startOf('day');
    const diff = d.clone().startOf('day').diff(today, 'days');
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    return d.year() === today.year() ? d.format('MMM D') : d.format('MMM D, YYYY');
  }

  sameDay(dateStr, m) {
    return dateStr && moment(dateStr, ['YYYY-MM-DD', moment.ISO_8601]).isSame(m, 'day');
  }

  formatTaskDate(value) {
    const date = moment(value, [moment.ISO_8601, 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD'], true);
    if (!date.isValid()) return String(value);
    const label = this.relDate(value);
    return hasClockTime(value) ? `${label} ${date.format('HH:mm')}` : label;
  }

  refreshTimeIndicators() {
    if (this.disposed) return;
    const now = moment();
    if (this.renderDay && this.renderDay !== now.format('YYYY-MM-DD')) {
      void this.render();
      return;
    }
    for (const update of this.timeIndicators) update(now);
  }

  empty(root, text) { root.createDiv({ cls: 'fw-agenda__empty', text }); }

  formatEventTime(ev) {
    return formatEventTimeRange(ev);
  }

  async render() {
    if (this.disposed) return;
    const renderId = (this._renderId = (this._renderId || 0) + 1);
    const compat = this.plugin.getCompatibility();
    const cfg = this.plugin.getConfig();

    if (!compat.ok) {
      const el = this.containerEl;
      el.empty();
      const density = this.plugin.settings.density === 'compact' ? 'compact' : 'comfortable';
      const root = el.createDiv({ cls: `fw-agenda fw-agenda--${density}` });
      this.timeIndicators = [];
      const error = root.createDiv({ cls: 'fw-agenda__filter-error', attr: { role: 'alert' } });
      error.createDiv({ text: compat.message || 'TaskNotes Runtime API is unavailable.' });
      const retry = error.createEl('button', {
        text: 'Retry', attr: { type: 'button', 'data-fw-focus': 'retry-compat' },
      });
      retry.addEventListener('click', () => {
        this.plugin.subscribeTaskNotesLifecycle();
        this.plugin.subscribeCalendarServices();
        this.plugin.refreshAll();
      });
      return;
    }

    let active = (await this.plugin.getTasks(cfg)).filter((t) => !t.done);
    if (this.disposed || renderId !== this._renderId) return;

    const viewFilter = await this.plugin.getViewTaskPathSet(this.opts);
    if (this.disposed || renderId !== this._renderId || viewFilter.status === 'stale') return;
    if (viewFilter.status === 'error') active = [];
    else if (viewFilter.paths) {
      active = active.filter((t) => viewFilter.paths.has(t.file.path));
    }

    const today = moment().startOf('day');
    const todayKey = today.format('YYYY-MM-DD');
    const featureOn = this.plugin.showEventsEnabled(this.opts);
    const showEvents = featureOn && this.eventsVisible;
    const s = this.plugin.settings;
    const taskDays = parseNonNegInt(
      this.opts.taskDays ?? s.taskDays,
      DEFAULT_SETTINGS.taskDays
    );
    const eventDays = parseNonNegInt(
      this.opts.eventDays ?? s.eventDays,
      DEFAULT_SETTINGS.eventDays
    );
    const maxRecurring = parseNonNegInt(
      s.maxRecurringOccurrences,
      DEFAULT_SETTINGS.maxRecurringOccurrences
    );

    let eventBuckets = new Map();
    if (showEvents) {
      const events = limitRecurringOccurrences(
        this.plugin.getCalendarEvents(),
        maxRecurring,
        today
      );
      eventBuckets = this.plugin.bucketCalendarEvents(
        events,
        todayKey,
        !!this.plugin.settings.hideFinishedEventsToday
      );
    }

    const eventsFor = (dayMoment) => eventBuckets.get(dayMoment.format('YYYY-MM-DD')) || [];
    const { byDay: taskBuckets, overdue, unplanned } = indexAgendaTasks(active, todayKey);
    const dayKeys = collectAgendaDayKeys(today, taskDays, eventDays, taskBuckets, eventBuckets);
    const todoToday = taskBuckets.get(todayKey) || [];
    const todayEvents = eventsFor(today);

    const el = this.containerEl;
    const focused = el.ownerDocument.activeElement;
    const focusKey = focused && el.contains(focused) ? focused.getAttribute('data-fw-focus') : null;
    const selection = focused === this.inputEl
      ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection]
      : null;
    const scrollHost = el.closest('.fw-agenda-view, .markdown-preview-view, .cm-scroller');
    const scrollTop = scrollHost ? scrollHost.scrollTop : null;
    el.empty();
    const density = this.plugin.settings.density === 'compact' ? 'compact' : 'comfortable';
    const root = el.createDiv({ cls: `fw-agenda fw-agenda--${density}` });
    this.timeIndicators = [];
    this.renderDay = todayKey;

    const { basePath, viewName } = this.plugin.resolveViewFilterSource(this.opts);
    if (viewFilter.status === 'error') {
      const error = root.createDiv({ cls: 'fw-agenda__filter-error', attr: { role: 'alert' } });
      error.createDiv({ text: `Tasks unavailable: ${viewFilter.message}` });
      const retry = error.createEl('button', {
        text: 'Retry filter', attr: { type: 'button', 'data-fw-focus': 'retry-filter' },
      });
      retry.addEventListener('click', () => this.plugin.refreshAll());
    } else if (basePath && viewFilter.status === 'applied') {
      const filterLabel = viewName
        ? `${basePath.split('/').pop()} · ${viewName}`
        : basePath.split('/').pop();
      root.createDiv({
        cls: 'fw-agenda__view-filter',
        text: `Filtered by: ${filterLabel}`,
      });
    }

    const now = moment();
    const dl = root.createDiv({ cls: 'fw-agenda__dateline' });
    dl.createSpan({ text: now.format('MMMM') });
    dl.createSpan({ cls: 'fw-sep', text: '•' });
    dl.createSpan({ text: now.format('D') });
    dl.createSpan({ cls: 'fw-sep', text: '•' });
    dl.createSpan({ text: now.format('YYYY') });

    const titleRow = root.createDiv({ cls: 'fw-agenda__title-row' });
    titleRow.createDiv({ cls: 'fw-agenda__title', text: this.opts.title });
    if (featureOn) {
      const btn = titleRow.createEl('button', {
        cls: 'fw-agenda__events-toggle' + (this.eventsVisible ? ' is-active' : ''),
        attr: {
          'aria-label': this.eventsVisible ? 'Hide calendar events' : 'Show calendar events',
          type: 'button',
          'aria-pressed': String(this.eventsVisible),
          'data-fw-focus': 'events',
        },
      });
      setIcon(btn, 'calendar');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.eventsVisible = !this.eventsVisible;
        this.render();
      });
    }

    // clickable, colored stat tiles that filter the list
    const stats = root.createDiv({ cls: 'fw-agenda__stats' });
    const tile = (num, label, key) => {
      const t = stats.createEl('button', {
        cls: `fw-stat fw-stat--${key}` + (this.filter === key ? ' is-active' : ''),
        attr: { type: 'button', 'aria-pressed': String(this.filter === key), 'data-fw-focus': `filter-${key}` },
      });
      t.createSpan({ cls: 'fw-stat__num', text: String(num) });
      t.createSpan({ cls: 'fw-stat__label', text: label });
      t.setAttribute('aria-label', `Show ${label.toLowerCase()}: ${num}`);
      t.addEventListener('click', () => { this.filter = this.filter === key ? null : key; this.render(); });
    };
    // Todo count matches the Todo filter list (tasks + today's events when visible).
    tile(todoToday.length + todayEvents.length, 'Todo', 'todo');
    tile(overdue.length, 'Overdue', 'overdue');
    tile(unplanned.length, 'Unplanned', 'unplanned');

    // new-task input
    const inputWrap = root.createDiv({ cls: 'fw-agenda__input' });
    const inputHead = inputWrap.createDiv({ cls: 'fw-agenda__input-head' });
    inputHead.createDiv({ cls: 'fw-agenda__input-label', text: 'New task' });
    const advBtn = inputHead.createEl('button', {
      cls: 'fw-agenda__input-advanced',
      attr: { type: 'button', 'data-fw-focus': 'advanced', 'aria-label': 'More options — open the TaskNotes task creator' },
    });
    setIcon(advBtn, 'chevron-down');
    const inputRow = inputWrap.createDiv({ cls: 'fw-agenda__input-row' });
    const input = this.inputEl = inputRow.createEl('input', {
      cls: 'fw-agenda__input-field',
      attr: { type: 'text', placeholder: 'Enter your task here', 'aria-label': 'New task', 'data-fw-focus': 'draft' },
    });
    input.value = this.draft;
    input.addEventListener('input', () => { this.draft = input.value; this.draftRevision++; });
    const submit = () => this.submitTask(cfg);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); }
    });
    const enterBtn = inputRow.createEl('button', {
      cls: 'fw-agenda__input-enter',
      attr: { type: 'button', 'data-fw-focus': 'submit', 'aria-label': this.creating ? 'Saving task' : 'Add task' },
    });
    enterBtn.disabled = this.creating;
    setIcon(enterBtn, 'corner-down-left');
    enterBtn.addEventListener('click', submit);
    // Keep the draft when handing it to the native modal, including cancellation.
    advBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.plugin.openNativeCreator(input.value);
    });

    // list — filtered by the active tile, or the full agenda
    if (viewFilter.status === 'error') {
      // Calendar events are independent of task filters and remain available.
      for (const key of dayKeys) {
        const events = eventBuckets.get(key) || [];
        if (events.length) this.renderSection(root, moment(key, 'YYYY-MM-DD').format('dddd, MMM D'), events, cfg, false, false, key);
      }
    } else if (this.filter === 'todo') {
      const todayItems = todoToday.concat(todayEvents);
      todayItems.length
        ? this.renderSection(root, 'Today', todayItems, cfg, false)
        : this.empty(root, 'No tasks for today.');
    } else if (this.filter === 'overdue') {
      overdue.length ? this.renderSection(root, 'Overdue', overdue, cfg, true) : this.empty(root, 'Nothing overdue.');
    } else if (this.filter === 'unplanned') {
      unplanned.length ? this.renderSection(root, 'Unplanned', unplanned, cfg, false, true) : this.empty(root, 'No unplanned tasks.');
    } else {
      let any = false;
      if (unplanned.length) { this.renderSection(root, 'Unplanned', unplanned, cfg, false, true); any = true; }
      if (overdue.length) { this.renderSection(root, 'Overdue', overdue, cfg, true); any = true; }
      for (const key of dayKeys) {
        const day = moment(key, 'YYYY-MM-DD');
        const offset = day.diff(today, 'days');
        const tasks = withinLookahead(offset, taskDays)
          ? taskBuckets.get(key) || []
          : [];
        const dayEvents = withinLookahead(offset, eventDays) ? eventsFor(day) : [];
        const items = tasks.concat(dayEvents);
        if (!items.length) continue;
        this.renderSection(root, key === todayKey ? 'Today' : day.format('dddd, MMM D'), items, cfg, false, false, key);
        any = true;
      }
      if (!any) this.empty(root, 'Nothing scheduled. Enjoy the quiet.');
    }
    this.refreshTimeIndicators();
    if (focusKey) {
      const next = [...el.querySelectorAll('[data-fw-focus]')]
        .find((node) => node.getAttribute('data-fw-focus') === focusKey);
      if (next && !next.disabled) {
        next.focus({ preventScroll: true });
        if (selection && next === input) input.setSelectionRange(...selection);
      }
    }
    if (scrollHost) scrollHost.scrollTop = scrollTop;
  }

  renderSection(root, label, items, cfg, isOverdue, isUnplanned, sectionKey = label) {
    const collapsed = this.collapsed.has(sectionKey);
    const head = root.createEl('button', {
      cls: 'fw-agenda__dayhead' + (isOverdue ? ' fw-agenda__dayhead--overdue' : '') + (isUnplanned ? ' fw-agenda__dayhead--unplanned' : '') + (collapsed ? ' is-collapsed' : ''),
      attr: { type: 'button', 'aria-expanded': String(!collapsed), 'data-fw-focus': `section-${sectionKey}` },
    });
    const left = head.createSpan({ cls: 'fw-agenda__dayhead-left' });
    setIcon(left.createSpan({ cls: 'fw-agenda__chevron' }), 'chevron-down');
    left.createSpan({ cls: 'fw-agenda__dayhead-label', text: label });
    head.createSpan({ cls: 'fw-agenda__dayhead-count', text: String(items.length) });
    head.addEventListener('click', () => {
      if (this.collapsed.has(sectionKey)) this.collapsed.delete(sectionKey);
      else this.collapsed.add(sectionKey);
      this.render();
    });
    if (collapsed) return;
    const sorted = sortMixedItems(items.slice(), cfg);
    for (const item of sorted) {
      if (item.isEvent) this.renderEvent(root, item, /^\d{4}-\d{2}-\d{2}$/.test(sectionKey) ? sectionKey : null);
      else this.renderTask(root, item, cfg);
    }
  }

  renderEvent(root, ev, dayKey = null) {
    const color = ev.color || '#7aa2f7';
    const row = root.createDiv({ cls: 'fw-task fw-event' });
    row.style.setProperty('--fw-event-color', color);

    const dots = row.createDiv({ cls: 'fw-task__dots fw-event__dots' });
    const bar = dots.createDiv({ cls: 'fw-event__bar' });
    bar.style.background = color;
    const icon = dots.createDiv({ cls: 'fw-event__icon', attr: { 'aria-label': 'Calendar event' } });
    icon.style.color = color;
    setIcon(icon, 'calendar');

    const body = row.createDiv({ cls: 'fw-task__body' });
    const titleEl = body.createDiv({ cls: 'fw-task__title fw-event__title', text: ev.title || 'Untitled event' });
    titleEl.setAttribute('role', 'button');
    titleEl.setAttribute('tabindex', '0');
    titleEl.setAttribute('aria-label', 'Show calendar event details');

    const openDetails = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.plugin.openEventDetails(ev);
    };
    const openMenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.plugin.openEventMenu(ev, e);
    };
    titleEl.addEventListener('click', openDetails);
    titleEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      openDetails(e);
    });
    titleEl.addEventListener('contextmenu', openMenu);
    row.addEventListener('contextmenu', openMenu);

    const meta = body.createDiv({ cls: 'fw-task__meta' });
    const ongoing = meta.createSpan({ cls: 'fw-event__now', text: 'Now', attr: { 'aria-label': 'Event in progress' } });
    ongoing.hidden = true;
    this.timeIndicators.push((now) => {
      const active = isEventOngoing(ev, now) && (!dayKey || dayKey === now.format('YYYY-MM-DD'));
      ongoing.hidden = !active;
      row.classList.toggle('fw-event--ongoing', active);
    });
    const parts = [{ cls: 'fw-event__time', text: this.formatEventTime(ev) }];
    if (ev.calendarName) parts.push({ text: ev.calendarName });
    if (ev.location) parts.push({ text: ev.location });
    parts.forEach((part, i) => {
      if (i) meta.createSpan({ cls: 'fw-sep', text: '·' });
      meta.createSpan(part);
    });
  }

  renderTask(root, task, cfg) {
    const row = root.createDiv({ cls: 'fw-task' });
    const dots = row.createDiv({ cls: 'fw-task__dots' });
    const statusColor = (cfg.statusMap[task.status] && cfg.statusMap[task.status].color) || '#808080';
    const prioColor = (cfg.prioMap[task.priority] && cfg.prioMap[task.priority].color) || '#cccccc';
    const statusEl = dots.createEl('button', {
      cls: 'fw-task__status', attr: { type: 'button', 'data-fw-focus': `status-${task.file.path}` },
    });
    statusEl.style.borderColor = statusColor;
    statusEl.setAttribute(
      'aria-label',
      task.done
        ? `Reopen ${task.title}. Right-click for more status options.`
        : `Complete ${task.title}. Right-click for more status options.`,
    );
    statusEl.disabled = this.pendingStatus.has(task.file.path);
    statusEl.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (this.pendingStatus.has(task.file.path)) return;
      this.pendingStatus.add(task.file.path);
      statusEl.disabled = true;
      try {
        await this.plugin.toggleStatus(task, cfg);
      } catch (error) {
        console.error('[tasknotes-timeline-wrapper] Status update failed', error);
        new Notice('Could not update task status.');
      } finally {
        this.pendingStatus.delete(task.file.path);
        this.plugin.refreshAll();
      }
    });
    statusEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.plugin.openStatusMenu(task, e);
    });
    if (this.plugin.settings.showPriority !== false && task.priority && task.priority !== 'none') {
      dots.createDiv({ cls: 'fw-task__priority' }).style.background = prioColor;
    }

    const body = row.createDiv({ cls: 'fw-task__body' });
    const titleRow = body.createDiv({ cls: 'fw-task__title-row' });
    if (task.due) {
      const overdue = titleRow.createSpan({
        cls: 'fw-task__overdue',
        attr: { role: 'img', 'aria-label': `Overdue: ${this.formatTaskDate(task.due)}`, title: `Overdue: ${this.formatTaskDate(task.due)}` },
      });
      setIcon(overdue, 'clock-alert');
      overdue.hidden = true;
      this.timeIndicators.push((now) => { overdue.hidden = !isTaskOverdue(task, now); });
    }
    const titleEl = titleRow.createDiv({ cls: 'fw-task__title', text: task.title });
    titleEl.setAttribute('role', 'button');
    titleEl.setAttribute('tabindex', '0');
    titleEl.setAttribute('data-fw-focus', `task-${task.file.path}`);
    titleEl.setAttribute('aria-label', 'Show task details');

    const openDetails = (e) => {
      // Mod-click keeps Obsidian's open-in-new-tab/split meaning.
      if (Keymap.isModEvent(e)) {
        e.preventDefault();
        this.plugin.openTask(task.file, e);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      void this.plugin.openTaskDetails(task);
    };
    const openMenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.plugin.openTaskMenu(task, e);
    };
    titleEl.addEventListener('click', openDetails);
    titleEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      openDetails(e);
    });
    titleEl.addEventListener('contextmenu', openMenu);
    row.addEventListener('contextmenu', openMenu);
    // Chromium fires `auxclick`, not `click`, for the middle button, and its own
    // mousedown default starts autoscroll — so both handlers are needed.
    titleEl.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      this.plugin.openTask(task.file, e, true);
    });
    titleEl.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });

    const meta = body.createDiv({ cls: 'fw-task__meta' });
    const settings = this.plugin.settings;
    const icons = !!settings.metaIcons;
    let parts = 0;
    const separator = () => {
      if (parts++) meta.createSpan({ cls: 'fw-sep', text: '·' });
    };
    const part = (label, val) => {
      if (val == null) return;
      separator();
      if (icons && META_ICONS[label]) {
        const ic = meta.createSpan({ cls: 'fw-task__meta-icon', attr: { 'aria-label': label } });
        setIcon(ic, META_ICONS[label]);
      } else {
        meta.createSpan({ cls: 'fw-task__meta-key', text: label + ': ' });
      }
      meta.createSpan({ text: val });
    };
    // Order is fixed: scheduled (when you'll do it) before due (when it's owed).
    if (settings.showScheduledDate !== false && task.scheduled) part('scheduled', this.formatTaskDate(task.scheduled));
    if (settings.showDueDate !== false && task.due) part('due', this.formatTaskDate(task.due));
    if (settings.showPriority !== false && task.priority && task.priority !== 'none') {
      part('priority', (cfg.prioMap[task.priority] && cfg.prioMap[task.priority].label) || task.priority);
    }
    if (settings.showProjects !== false && task.projects.length) part('file', task.projects.join(', '));
    const tags = settings.showTags === false ? [] : task.tags.filter((tag) => settings.showTaskTag || tag !== cfg.taskTag);
    if (tags.length) {
      separator();
      for (const tag of tags) meta.createSpan({ cls: 'fw-task__tag', text: tag });
    }
    if (!parts) meta.remove();
  }
}

/* Code-block embed (in a note). */
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
class AgendaSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  async display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Open tasks in a new tab')
      .setDesc('Clicking a task title opens it in a new tab, reusing that tab if the task is already open. Turn this off to open tasks in the current tab. Mod-click always opens a new tab either way.')
      .addToggle((t) => t
        .setValue(this.plugin.settings.openInNewTab)
        .onChange(async (v) => {
          this.plugin.settings.openInNewTab = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Icons in task metadata')
      .setDesc('Replace the "due:" / "scheduled:" / "priority:" / "file:" labels with icons. Tags keep their pill background either way.')
      .addToggle((t) => t
        .setValue(this.plugin.settings.metaIcons)
        .onChange(async (v) => {
          this.plugin.settings.metaIcons = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Timeline density')
      .setDesc('Compact shows more items; comfortable gives text and controls more room.')
      .addDropdown((dropdown) => dropdown
        .addOptions({ comfortable: 'Comfortable', compact: 'Compact' })
        .setValue(this.plugin.settings.density === 'compact' ? 'compact' : 'comfortable')
        .onChange(async (value) => {
          this.plugin.settings.density = value;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: 'Visible task metadata' });
    for (const [key, label, description] of [
      ['showScheduledDate', 'Scheduled date and time', 'Show when a task is scheduled, including its time when present.'],
      ['showDueDate', 'Due date and time', 'Show the deadline. The overdue indicator remains visible when this field is hidden.'],
      ['showPriority', 'Priority', 'Show the priority label and colored dot.'],
      ['showProjects', 'Projects', 'Show linked project names.'],
      ['showTags', 'Tags', 'Show task tags in the metadata row.'],
      ['showTaskTag', 'Task identification tag', 'Include the TaskNotes identification tag (usually task) when tags are visible. Hidden by default.'],
    ]) {
      new Setting(containerEl)
        .setName(label)
        .setDesc(description)
        .addToggle((toggle) => toggle
          .setValue(key === 'showTaskTag' ? !!this.plugin.settings[key] : this.plugin.settings[key] !== false)
          .onChange(async (value) => {
            this.plugin.settings[key] = value;
            await this.plugin.saveSettings();
          }));
    }

    containerEl.createEl('h3', { text: 'Calendar events' });
    new Setting(containerEl)
      .setName('Show calendar events')
      .setDesc('When TaskNotes has calendar integrations active (ICS subscriptions, Google, or Microsoft), show those events alongside tasks in each day. Click an event for options like creating a task or note from it.')
      .addToggle((t) => t
        .setValue(this.plugin.settings.showCalendarEvents)
        .onChange(async (v) => {
          this.plugin.settings.showCalendarEvents = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Hide events that already ended today')
      .setDesc('When showing calendar events, omit today\'s events whose end time has already passed. Multi-day events still appear on their remaining days.')
      .addToggle((t) => t
        .setValue(this.plugin.settings.hideFinishedEventsToday)
        .onChange(async (v) => {
          this.plugin.settings.hideFinishedEventsToday = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Task lookahead (days)')
      .setDesc('How many days ahead to show tasks by due or scheduled date. Use 0 for no limit. Default: 14.')
      .addText((text) => {
        text.inputEl.type = 'number';
        text.inputEl.min = '0';
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.taskDays))
          .setValue(String(this.plugin.settings.taskDays ?? DEFAULT_SETTINGS.taskDays))
          .onChange(async (v) => {
            this.plugin.settings.taskDays = parseNonNegInt(v, DEFAULT_SETTINGS.taskDays);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Event lookahead (days)')
      .setDesc('How many days ahead to show calendar events. Use 0 for no limit. Default: 14.')
      .addText((text) => {
        text.inputEl.type = 'number';
        text.inputEl.min = '0';
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.eventDays))
          .setValue(String(this.plugin.settings.eventDays ?? DEFAULT_SETTINGS.eventDays))
          .onChange(async (v) => {
            this.plugin.settings.eventDays = parseNonNegInt(v, DEFAULT_SETTINGS.eventDays);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Max recurring event occurrences')
      .setDesc('For each recurring series, show at most this many upcoming instances. Use 0 for no limit.')
      .addText((text) => {
        text.inputEl.type = 'number';
        text.inputEl.min = '0';
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.maxRecurringOccurrences))
          .setValue(String(this.plugin.settings.maxRecurringOccurrences ?? DEFAULT_SETTINGS.maxRecurringOccurrences))
          .onChange(async (v) => {
            this.plugin.settings.maxRecurringOccurrences = parseNonNegInt(v, DEFAULT_SETTINGS.maxRecurringOccurrences);
            await this.plugin.saveSettings();
          });
      });

    containerEl.createEl('h3', { text: 'TaskNotes view filter' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Optionally restrict the timeline to tasks matching a TaskNotes Bases file and one of its views. Calendar events are not filtered. Requires TaskNotes Runtime API (query.tasks). Unsupported filters show an error and hide tasks until the filter is corrected or removed.',
    });

    const baseFiles = this.plugin.listBaseFiles();
    const baseOptions = { '': 'None — all tasks' };
    for (const f of baseFiles) baseOptions[f.path] = f.path;

    const currentBase = this.plugin.settings.tasknotesBasePath || '';
    new Setting(containerEl)
      .setName('TaskNotes base')
      .setDesc('Choose a .base file (views from TaskNotes/Views are listed first).')
      .addDropdown((dd) => {
        dd.addOptions(baseOptions);
        if (currentBase && !baseOptions[currentBase]) {
          dd.addOption(currentBase, `${currentBase} (missing)`);
        }
        dd.setValue(currentBase);
        dd.onChange(async (v) => {
          this.plugin.settings.tasknotesBasePath = v;
          this.plugin.settings.tasknotesViewName = '';
          await this.plugin.saveSettings();
          this.display();
        });
      });

    const viewOptions = { '': 'None — file filters only' };
    let views = [];
    if (currentBase) {
      views = await this.plugin.listViewsInBase(currentBase);
      for (const v of views) viewOptions[v.name] = v.name;
    }
    const currentView = this.plugin.settings.tasknotesViewName || '';
    new Setting(containerEl)
      .setName('View')
      .setDesc('View inside the selected base whose filters should apply (combined with file-level filters).')
      .addDropdown((dd) => {
        dd.addOptions(viewOptions);
        if (currentView && !viewOptions[currentView]) {
          dd.addOption(currentView, `${currentView} (missing)`);
        }
        dd.setValue(currentView);
        dd.setDisabled(!currentBase);
        dd.onChange(async (v) => {
          this.plugin.settings.tasknotesViewName = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Refresh view list')
      .setDesc('Re-read .base files after creating or renaming views in TaskNotes.')
      .addButton((btn) => btn
        .setButtonText('Refresh')
        .onClick(() => {
          this.plugin.invalidateViewFilterCache();
          this.plugin.refreshAll();
          this.display();
        }));

    if (!this.plugin.hasCalendarIntegration()) {
      containerEl.createEl('p', {
        cls: 'setting-item-description',
        text: 'No TaskNotes calendar integration detected. Enable ICS subscriptions, Google Calendar, or Microsoft Calendar in TaskNotes settings to use these options.',
      });
    }
  }
}

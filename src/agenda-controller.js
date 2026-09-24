const obsidian = require('obsidian');
const { Notice, setIcon, Menu } = obsidian;
const moment = obsidian.moment || window.moment;
const { DEFAULT_SETTINGS, UI_STRINGS } = require('./constants');
const { debounce, parseNonNegInt } = require('./utils');
const { createCalendarHelpers } = require('./calendar-helpers');
const { renderEvent, renderTask } = require('./agenda-renderers');
const {
  searchAgendaItems, toggleCollapsed, isCurrentRender, findFocusTarget, dateWithExistingTime,
} = require('./agenda-model');
const {
  limitRecurringOccurrences, collectAgendaDayKeys, withinLookahead, indexAgendaTasks,
  hasClockTime, localDateKey, formatEventTimeRange, sortMixedItems,
} = createCalendarHelpers(moment, { maxRecurringOccurrences: DEFAULT_SETTINGS.maxRecurringOccurrences });

class AgendaController {
  constructor(plugin, containerEl, opts) {
    this.plugin = plugin;
    this.containerEl = containerEl;
    this.opts = opts;
    this.viewFilterOverride = null;
    this.viewFilterOpen = false;
    this.filter = null; // null | 'todo' | 'overdue' | 'unplanned'
    this.searchQuery = '';
    this.collapsed = new Set(); // section labels the user has collapsed
    this.eventsVisible = true; // session toggle; only relevant when feature is on
    this.draft = '';
    this.draftRevision = 0;
    this.creating = false;
    this.disposed = false;
    this.pendingStatus = new Set();
    this.timeIndicators = [];
    this.renderSearch = debounce(() => {
      if (!this.disposed && this.listEl && this.listModel) this.renderAgendaList(this.listEl, this.listModel);
    }, 150);
  }

  dispose() {
    this.disposed = true;
    this._renderId = (this._renderId || 0) + 1;
    this.inputEl = null;
    this.listEl = null;
    this.listModel = null;
    this.timeIndicators = [];
    this.renderSearch.cancel();
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

  renderState(kind, message, detail, retry) {
    const el = this.containerEl;
    el.empty();
    const density = this.plugin.settings.density === 'compact' ? 'compact' : 'comfortable';
    const root = el.createDiv({ cls: `fw-agenda fw-agenda--${density}` });
    const state = root.createDiv({
      cls: `fw-agenda__state fw-agenda__state--${kind}`,
      attr: { role: kind === 'error' ? 'alert' : 'status', 'aria-live': 'polite' },
    });
    state.createDiv({ cls: 'fw-agenda__state-title', text: message });
    if (kind === 'loading') {
      const skeleton = state.createDiv({ cls: 'fw-agenda__skeleton', attr: { 'aria-hidden': 'true' } });
      for (let i = 0; i < 3; i++) {
        const line = skeleton.createDiv({ cls: 'fw-agenda__skeleton-row' });
        line.createSpan({ cls: 'fw-agenda__skeleton-dot' });
        const text = line.createDiv({ cls: 'fw-agenda__skeleton-lines' });
        text.createSpan({ cls: 'fw-agenda__skeleton-title' });
        text.createSpan({ cls: 'fw-agenda__skeleton-meta' });
      }
    }
    if (detail) state.createDiv({ cls: 'fw-agenda__state-detail', text: detail });
    if (typeof retry === 'function') {
      const button = state.createEl('button', { text: 'Retry', attr: { type: 'button' } });
      button.addEventListener('click', retry);
    }
    this.timeIndicators = [];
  }

  currentViewFilterSource() {
    return this.viewFilterOverride || this.plugin.resolveViewFilterSource(this.opts);
  }

  async updateViewFilter(basePath, viewName) {
    const source = { basePath: String(basePath || '').trim(), viewName: String(viewName || '').trim() };
    this.viewFilterOverride = source;
    this.plugin.invalidateViewFilterCache();
    if ((this.opts || {}).base == null && (this.opts || {}).view == null) {
      this.plugin.settings.tasknotesBasePath = source.basePath;
      this.plugin.settings.tasknotesViewName = source.viewName;
      await this.plugin.saveSettings();
    } else {
      await this.render();
    }
  }

  formatEventTime(ev) {
    return formatEventTimeRange(ev);
  }

  async render() {
    if (this.disposed) return;
    const renderId = (this._renderId = (this._renderId || 0) + 1);
    const compat = this.plugin.getCompatibility();

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
      this.hasRendered = true;
      return;
    }

    if (!this.hasRendered) this.renderState('loading', UI_STRINGS.loadingTasks);
    let cfg;
    let allTasks;
    let taskCatalog;
    let active;
    let viewFilter;
    let viewFilterSource;
    let filterViews = [];
    try {
      cfg = this.plugin.getConfig();
      allTasks = await this.plugin.getTasks(cfg);
      taskCatalog = allTasks;
      active = allTasks.filter((t) => !t.done);
      if (!isCurrentRender(renderId, this._renderId, this.disposed)) return;
      viewFilterSource = this.currentViewFilterSource();
      viewFilter = await this.plugin.getViewTaskPathSet({
        base: viewFilterSource.basePath,
        view: viewFilterSource.viewName,
      });
      if (!isCurrentRender(renderId, this._renderId, this.disposed) || viewFilter.status === 'stale') return;
      if (this.viewFilterOpen && viewFilterSource.basePath) {
        filterViews = await this.plugin.listViewsInBase(viewFilterSource.basePath);
        if (!isCurrentRender(renderId, this._renderId, this.disposed)) return;
      }
    } catch (error) {
      if (!isCurrentRender(renderId, this._renderId, this.disposed)) return;
      console.error('[tasknotes-timeline-wrapper] Timeline load failed', error);
      const detail = error && error.message ? error.message : String(error || 'Unknown error');
      this.renderState('error', 'Could not load the timeline.', detail, () => this.plugin.refreshAll());
      this.hasRendered = true;
      return;
    }
    if (viewFilter.status === 'error') {
      allTasks = [];
      active = [];
    } else if (viewFilter.paths) {
      allTasks = allTasks.filter((t) => viewFilter.paths.has(t.file.path));
      active = allTasks.filter((t) => !t.done);
    }

    const today = moment().startOf('day');
    const todayKey = today.format('YYYY-MM-DD');
    const completedToday = this.plugin.settings.showCompletedToday !== false
      ? allTasks.filter((task) => task.done && localDateKey(task.completedDate) === todayKey)
      : [];
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
    const dayKeySet = new Set(collectAgendaDayKeys(today, taskDays, eventDays, taskBuckets, eventBuckets));
    // An unlimited lookahead cannot produce an infinite set of empty dates, so
    // keep future drop targets available while showing them only during a drag.
    const emptyDayHorizon = taskDays > 0 ? Math.min(taskDays, 60) : 14;
    for (let offset = 0; offset < emptyDayHorizon; offset++) {
      dayKeySet.add(today.clone().add(offset, 'days').format('YYYY-MM-DD'));
    }
    const dayKeys = [...dayKeySet].sort();
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

    if (viewFilter.status === 'error') {
      const error = root.createDiv({ cls: 'fw-agenda__filter-error', attr: { role: 'alert' } });
      error.createDiv({ text: `Tasks unavailable: ${viewFilter.message}` });
      const retry = error.createEl('button', {
        text: 'Retry filter', attr: { type: 'button', 'data-fw-focus': 'retry-filter' },
      });
      retry.addEventListener('click', () => this.plugin.refreshAll());
    }
    const now = moment();
    if (this.plugin.settings.showTimelineDate !== false) {
      const dl = root.createDiv({ cls: 'fw-agenda__dateline' });
      dl.createSpan({ text: now.format('MMMM') });
      dl.createSpan({ cls: 'fw-sep', text: '•' });
      dl.createSpan({ text: now.format('D') });
      dl.createSpan({ cls: 'fw-sep', text: '•' });
      dl.createSpan({ text: now.format('YYYY') });
    }

    const titleRow = root.createDiv({ cls: 'fw-agenda__title-row' });
    titleRow.createDiv({ cls: 'fw-agenda__title', text: this.opts.title });
    if (showEvents && this.plugin.isCalendarLoading()) {
      const loading = titleRow.createDiv({
        cls: 'fw-agenda__calendar-loading',
        attr: { role: 'status', 'aria-label': 'Loading calendar events', title: 'Loading calendar events' },
      });
      setIcon(loading, 'loader-circle');
    }
    const filterLabel = viewFilterSource.basePath
      ? (viewFilterSource.viewName
        ? `${viewFilterSource.basePath.split('/').pop()} · ${viewFilterSource.viewName}`
        : viewFilterSource.basePath.split('/').pop())
      : '';
    const menuTitle = filterLabel
      ? `Filtered by: ${filterLabel}${viewFilter.status === 'error' ? ' (filter error)' : ''}`
      : 'Timeline options';
    const menuButton = titleRow.createEl('button', {
      cls: 'fw-agenda__menu-toggle',
      attr: {
        type: 'button',
        title: menuTitle,
        'aria-label': menuTitle,
        'data-fw-focus': 'timeline-menu',
      },
    });
    setIcon(menuButton, 'more-horizontal');
    menuButton.addEventListener('click', (event) => this.openTimelineMenu(event));
    if (this.viewFilterOpen) {
      this.renderViewFilterPanel(root, viewFilterSource, filterViews);
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
      t.addEventListener('click', () => {
        this.filter = this.filter === key ? null : key;
        for (const button of stats.querySelectorAll('.fw-stat')) {
          const active = button.getAttribute('data-fw-filter') === this.filter;
          button.classList.toggle('is-active', active);
          button.setAttribute('aria-pressed', String(active));
        }
        if (this.listEl && this.listModel) this.renderAgendaList(this.listEl, this.listModel);
      });
      t.setAttribute('data-fw-filter', key);
      return t;
    };
    tile(active.length, 'Todo', 'todo');
    tile(overdue.length, 'Overdue', 'overdue');
    tile(unplanned.length, 'Unplanned', 'unplanned');

    this.renderTaskSearch(root);

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

    // List updates independently from the header for local filter/collapse actions.
    const list = root.createDiv({ cls: 'fw-agenda__list' });
    this.listEl = list;
    this.listModel = {
      viewFilter,
      viewFilterSource,
      dayKeys,
      eventBuckets,
      taskBuckets,
      overdue,
      unplanned,
      completedToday,
      showCompletedToday: this.plugin.settings.showCompletedToday !== false,
      todoToday,
      allTasks: active,
      taskCatalog: this.plugin.settings.ignoreBaseFilterInSearch ? taskCatalog : allTasks,
      todayEvents,
      today,
      todayKey,
      taskDays,
      eventDays,
      cfg,
    };
    this.renderAgendaList(list, this.listModel);
    if (focusKey) {
      const next = findFocusTarget(el.querySelectorAll('[data-fw-focus]'), focusKey);
      if (next && !next.disabled) {
        next.focus({ preventScroll: true });
        if (selection && next === input) input.setSelectionRange(...selection);
      }
    }
    if (scrollHost) scrollHost.scrollTop = scrollTop;
    this.hasRendered = true;
  }

  renderAgendaList(root, model) {
    root.empty();
    this.timeIndicators = [];
    const {
      viewFilter, viewFilterSource, dayKeys, eventBuckets, taskBuckets, overdue, unplanned,
      completedToday, showCompletedToday, todoToday, allTasks, todayEvents, today, todayKey,
      taskDays, eventDays, cfg,
    } = model;
    const eventsFor = (dayMoment) => eventBuckets.get(dayMoment.format('YYYY-MM-DD')) || [];
    const hasAdvancedFilters = !!this.searchQuery.trim();
    const ignoreBaseFilterForSearch = !!this.plugin.settings.ignoreBaseFilterInSearch;
    if (hasAdvancedFilters && (viewFilter.status !== 'error' || ignoreBaseFilterForSearch)) {
      const query = this.searchQuery.trim().toLocaleLowerCase();
      const { events: matchingEvents, results } = searchAgendaItems({
        taskCatalog: model.taskCatalog,
        eventBuckets,
        query,
        filter: this.filter,
        cfg,
        todayKey,
        localDateKey,
      });
      if (ignoreBaseFilterForSearch && viewFilterSource?.basePath) {
        root.createDiv({
          cls: 'fw-agenda__search-scope',
          text: 'Search includes tasks outside the selected Base/view filter.',
        });
      }
      results.length
        ? this.renderSection(
          root,
          matchingEvents.length ? 'Matching tasks and events' : 'Matching tasks',
          results,
          cfg,
          false,
          false,
          'matching-tasks-and-events',
          null,
          true,
        )
        : this.empty(root, 'No tasks or events match this search.');
      this.refreshTimeIndicators();
      return;
    }

    if (viewFilter.status === 'error') {
      // Calendar events are independent of task filters and remain available.
      for (const key of dayKeys) {
        const events = eventBuckets.get(key) || [];
        if (events.length) this.renderSection(root, moment(key, 'YYYY-MM-DD').format('dddd, MMM D'), events, cfg, false, false, key);
      }
    } else if (this.filter === 'todo') {
      allTasks.length
        ? this.renderSection(root, 'Todo', allTasks, cfg, false, false, 'todo-all')
        : this.empty(root, 'No pending tasks.');
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
        this.renderSection(root, key === todayKey ? 'Today' : day.format('dddd, MMM D'), items, cfg, false, false, key);
        any = true;
      }
      if (!any) this.empty(root, 'Nothing scheduled. Enjoy the quiet.');
      if (showCompletedToday) {
        this.renderSection(
          root,
          'Completed today',
          completedToday,
          cfg,
          false,
          false,
          'completed-today',
          'No tasks completed today.',
        );
      }
    }
    this.refreshTimeIndicators();
  }

  renderTaskSearch(root) {
    const wrap = root.createDiv({ cls: 'fw-agenda__search' });
    const search = wrap.createEl('input', {
      cls: 'fw-agenda__search-input',
      attr: {
        type: 'search',
        placeholder: 'Search… (status:, tag:, due:)',
        'aria-label': 'Search tasks, projects, tags, status, and due date',
        'data-fw-focus': 'task-search',
      },
    });
    search.value = this.searchQuery;
    search.addEventListener('input', () => {
      this.searchQuery = search.value;
      this.renderSearch();
    });

  }

  openTimelineMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    const menu = new Menu();
    menu.addItem((item) => item
      .setTitle(this.viewFilterOpen ? 'Hide filter' : 'Filter')
      .setIcon('filter')
      .onClick(() => {
        this.viewFilterOpen = !this.viewFilterOpen;
        this.render();
      }));
    menu.addItem((item) => item
      .setTitle(this.eventsVisible ? 'Hide calendar events' : 'Show calendar events')
      .setIcon(this.eventsVisible ? 'eye-off' : 'eye')
      .onClick(() => {
        this.eventsVisible = !this.eventsVisible;
        this.render();
      }));
    menu.showAtMouseEvent(event);
  }

  renderViewFilterPanel(root, source, views) {
    const hasBase = !!source.basePath;
    const wrap = root.createDiv({ cls: 'fw-agenda__view-filter-wrap' });
    const panel = wrap.createDiv({ cls: 'fw-agenda__view-filter-panel' });
    const makeSelect = (label, value, options) => {
      const field = panel.createDiv({ cls: 'fw-agenda__view-filter-field' });
      field.createEl('label', { text: label });
      const select = field.createEl('select', { attr: { 'aria-label': label } });
      for (const option of options) {
        select.createEl('option', { text: option.label, attr: { value: option.value } });
      }
      select.value = value;
      return select;
    };
    const baseOptions = [{ value: '', label: 'All tasks' }];
    for (const file of this.plugin.listBaseFiles()) {
      baseOptions.push({ value: file.path, label: file.path });
    }
    if (hasBase && !baseOptions.some((option) => option.value === source.basePath)) {
      baseOptions.push({ value: source.basePath, label: `${source.basePath} (missing)` });
    }
    const baseSelect = makeSelect('TaskNotes base', source.basePath, baseOptions);
    baseSelect.addEventListener('change', () => {
      void this.updateViewFilter(baseSelect.value, '');
    });

    const viewOptions = [{ value: '', label: hasBase ? 'File filters only' : 'All tasks' }];
    for (const view of views) viewOptions.push({ value: view.name, label: view.name });
    if (source.viewName && !viewOptions.some((option) => option.value === source.viewName)) {
      viewOptions.push({ value: source.viewName, label: `${source.viewName} (missing)` });
    }
    const viewSelect = makeSelect('View', source.viewName, viewOptions);
    viewSelect.disabled = !hasBase;
    viewSelect.addEventListener('change', () => {
      void this.updateViewFilter(source.basePath, viewSelect.value);
    });
  }

  renderSection(root, label, items, cfg, isOverdue, isUnplanned, sectionKey = label, emptyMessage = null, preserveOrder = false) {
    const collapsed = this.collapsed.has(sectionKey);
    const section = root.createDiv({ cls: 'fw-agenda__section' });
    const isDayDropTarget = /^\d{4}-\d{2}-\d{2}$/.test(sectionKey) && !isOverdue && !isUnplanned;
    if (isDayDropTarget) {
      section.setAttribute('data-fw-drop-day', sectionKey);
      if (!items.length) section.setAttribute('data-fw-empty-day', '');
      section.addEventListener('dragover', (event) => {
        if (!event.dataTransfer) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        section.classList.add('is-drop-target');
      });
      section.addEventListener('dragleave', (event) => {
        if (!section.contains(event.relatedTarget)) section.classList.remove('is-drop-target');
      });
      section.addEventListener('drop', (event) => {
        event.preventDefault();
        section.classList.remove('is-drop-target');
        const path = event.dataTransfer && event.dataTransfer.getData('text/plain');
        const task = (this.listModel && this.listModel.allTasks || items)
          .find((item) => !item.isEvent && (item.path || item.file?.path) === path);
        if (task) void this.rescheduleTask(task, sectionKey);
      });
    }
    const head = section.createEl('button', {
      cls: 'fw-agenda__dayhead' + (isOverdue ? ' fw-agenda__dayhead--overdue' : '') + (isUnplanned ? ' fw-agenda__dayhead--unplanned' : '') + (collapsed ? ' is-collapsed' : ''),
      attr: { type: 'button', 'aria-expanded': String(!collapsed), 'data-fw-focus': `section-${sectionKey}` },
    });
    const left = head.createSpan({ cls: 'fw-agenda__dayhead-left' });
    setIcon(left.createSpan({ cls: 'fw-agenda__chevron' }), 'chevron-down');
    left.createSpan({ cls: 'fw-agenda__dayhead-label', text: label });
    head.createSpan({ cls: 'fw-agenda__dayhead-count', text: String(items.length) });
    head.addEventListener('click', () => {
      const nextCollapsed = toggleCollapsed(this.collapsed, sectionKey);
      head.classList.toggle('is-collapsed', nextCollapsed);
      head.setAttribute('aria-expanded', String(!nextCollapsed));
      content.hidden = nextCollapsed;
      if (!nextCollapsed) renderItems(true);
    });
    const content = section.createDiv({ cls: 'fw-agenda__section-content' });
    content.hidden = collapsed;
    let rendered = false;
    const renderItems = (refreshIndicators = false) => {
      if (rendered) return;
      rendered = true;
      if (!items.length) {
        if (emptyMessage) this.empty(content, emptyMessage);
        return;
      }
      const sorted = preserveOrder ? items.slice() : sortMixedItems(items.slice(), cfg);
      for (const item of sorted) {
        if (item.isEvent) renderEvent.call(this, content, item, /^\d{4}-\d{2}-\d{2}$/.test(sectionKey) ? sectionKey : null);
        else renderTask.call(this, content, item, cfg);
      }
      if (refreshIndicators) this.refreshTimeIndicators();
    };
    if (!collapsed) renderItems();
  }

  taskDateValue(value) {
    const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : '';
  }

  async rescheduleTask(task, dateKey) {
    if (this.taskDateValue(task.scheduled) === dateKey) return;
    try {
      const scheduled = dateWithExistingTime(dateKey, task.scheduled);
      await this.plugin.updateTaskFields(task, { scheduled });
      new Notice(`Scheduled for ${moment(dateKey, 'YYYY-MM-DD').format('MMM D')}.`);
    } catch (error) {
      console.error('[tasknotes-timeline-wrapper] Task rescheduling failed', error);
      new Notice(error && error.message ? error.message : 'Could not reschedule task.');
    }
  }


}

/* Code-block embed (in a note). */

module.exports = AgendaController;

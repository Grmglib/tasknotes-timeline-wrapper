const obsidian = require('obsidian');
const { Notice, setIcon, Keymap } = obsidian;
const moment = obsidian.moment || window.moment;
const { DEFAULT_SETTINGS, META_ICONS } = require('./constants');
const { createCalendarHelpers } = require('./calendar-helpers');
const { taskPath, dateWithExistingTime } = require('./agenda-model');
const { isEventOngoing, isTaskOverdue } = createCalendarHelpers(moment, { maxRecurringOccurrences: DEFAULT_SETTINGS.maxRecurringOccurrences });

function renderEvent(root, ev, dayKey = null) {
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
    titleEl.setAttribute('aria-label', `Show details for ${ev.title || 'Untitled event'}`);

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

function renderTask(root, task, cfg) {
    const row = root.createDiv({ cls: task.done ? 'fw-task fw-task--completed' : 'fw-task' });
    const setAgendaDragging = (dragging) => {
      const agenda = row.closest('.fw-agenda');
      if (!agenda || agenda.classList.contains('is-dragging') === dragging) return;
      const rowTop = row.getBoundingClientRect().top;
      agenda.classList.toggle('is-dragging', dragging);
      const rowShift = row.getBoundingClientRect().top - rowTop;
      const scrollHost = agenda.closest('.fw-agenda-view, .markdown-preview-view, .cm-scroller');
      if (scrollHost && rowShift) scrollHost.scrollTop += rowShift;
    };
    row.addEventListener('dragstart', (event) => {
      if (task.done) {
        event.preventDefault();
        return;
      }
      if (event.target.closest('button:not(.fw-task__drag-handle), input, select')) {
        event.preventDefault();
        return;
      }
      if (!event.dataTransfer) return;
      event.dataTransfer.setData('text/plain', taskPath(task));
      event.dataTransfer.effectAllowed = 'move';
      row.classList.add('is-dragging');
      setAgendaDragging(true);
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('is-dragging');
      setAgendaDragging(false);
    });
    const dots = row.createDiv({ cls: 'fw-task__dots' });
    if (!task.done) {
      const dragHandle = dots.createEl('button', {
        cls: 'fw-task__drag-handle',
        attr: {
          type: 'button',
          draggable: 'true',
          'aria-label': `Drag ${task.title || 'task'} to reschedule`,
        },
      });
      setIcon(dragHandle, 'grip-vertical');
    }
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
        : task.recurrence
          ? `Complete this occurrence of ${task.title}. Right-click for more status options.`
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
    titleEl.setAttribute('aria-label', `Show details for ${task.title || 'Untitled task'}`);

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

    const editToggle = titleRow.createEl('button', {
      cls: 'fw-task__edit-toggle',
      attr: { type: 'button', 'aria-label': `Quick edit ${task.title}`, 'aria-expanded': 'false' },
    });
    setIcon(editToggle, 'pencil');

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

    const editor = body.createDiv({ cls: 'fw-task__quick-edit' });
    editor.hidden = true;
    const makeField = (labelText, type, value, name) => {
      const field = editor.createDiv({ cls: 'fw-task__quick-edit-field' });
      field.createEl('label', { text: labelText });
      const input = field.createEl(type, { attr: { 'aria-label': labelText } });
      input.classList.add(`fw-task__quick-edit-${name}`);
      if (type === 'input') input.type = 'date';
      input.value = value || '';
      return input;
    };
    const priorityField = editor.createDiv({ cls: 'fw-task__quick-edit-field' });
    priorityField.createEl('label', { text: 'Priority' });
    const priorityInput = priorityField.createEl('select', { attr: { 'aria-label': 'Priority' } });
    priorityInput.classList.add('fw-task__quick-edit-priority');
    const priorities = Object.values(cfg.prioMap || {});
    if (!priorities.some((priority) => priority.value === 'none')) {
      priorities.unshift({ value: 'none', label: 'None' });
    }
    for (const priority of priorities) {
      const option = priorityInput.createEl('option', {
        text: priority.label || priority.value,
        attr: { value: priority.value },
      });
      if (priority.value === task.priority) option.selected = true;
    }
    const scheduledInput = makeField('Scheduled', 'input', this.taskDateValue(task.scheduled), 'scheduled');
    const dueInput = makeField('Due', 'input', this.taskDateValue(task.due), 'due');
    const pendingChanges = new Map();
    let saving = false;
    let editorClosed = true;
    const restoreInput = (field, input) => {
      if (field === 'priority') input.value = task.priority || 'none';
      else input.value = this.taskDateValue(task[field]);
    };
    const flushChanges = async () => {
      if (saving) return;
      saving = true;
      while (pendingChanges.size) {
        const changes = [...pendingChanges.entries()];
        pendingChanges.clear();
        const patch = Object.fromEntries(changes.map(([field, change]) => [field, change.value]));
        try {
          await this.plugin.updateTaskFields(task, patch, false);
        } catch (error) {
          console.error('[tasknotes-timeline-wrapper] Inline task edit failed', error);
          new Notice(error && error.message ? error.message : 'Could not update task.');
          for (const [field, change] of changes) restoreInput(field, change.input);
        }
      }
      saving = false;
      if (editorClosed) this.plugin.refreshAll();
    };
    const saveField = (field, value, input) => {
      pendingChanges.set(field, { value, input });
      void flushChanges();
    };
    priorityInput.addEventListener('change', () => saveField('priority', priorityInput.value || 'none', priorityInput));
    scheduledInput.addEventListener('change', () => saveField('scheduled', dateWithExistingTime(scheduledInput.value, task.scheduled), scheduledInput));
    dueInput.addEventListener('change', () => saveField('due', dateWithExistingTime(dueInput.value, task.due), dueInput));
    editToggle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const willOpen = editor.hidden;
      editor.hidden = !willOpen;
      editorClosed = !willOpen;
      editToggle.setAttribute('aria-expanded', String(willOpen));
      if (willOpen) priorityInput.focus();
      else if (!saving) this.plugin.refreshAll();
    });
  }

module.exports = { renderEvent, renderTask };

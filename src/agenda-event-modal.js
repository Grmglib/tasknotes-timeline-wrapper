const obsidian = require('obsidian');
const { Modal, Setting, Notice } = obsidian;
const moment = obsidian.moment || window.moment;
const { DEFAULT_SETTINGS } = require('./constants');
const { createCalendarHelpers } = require('./calendar-helpers');
const { formatEventDateTimeLabel } = createCalendarHelpers(moment, { maxRecurringOccurrences: DEFAULT_SETTINGS.maxRecurringOccurrences });

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

    const canCreateNote = adapter.canCreateNoteFromEvents();
    const canCreateTask = adapter.canCreateTaskFromEvents();
    if (canCreateNote || canCreateTask) {
      new Setting(contentEl).setName('Actions').setHeading();
      const createSetting = new Setting(contentEl)
        .setName('Create from event')
        .setDesc(canCreateNote && canCreateTask
          ? 'Create a TaskNotes task or note linked to this calendar event.'
          : canCreateTask
            ? 'Create a TaskNotes task linked to this calendar event.'
            : 'Create a note linked to this calendar event.');

      if (canCreateNote) {
        createSetting.addButton((btn) => btn
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
          }));
      }

      if (canCreateTask) {
        createSetting.addButton((btn) => btn
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
      }
    }

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

module.exports = AgendaEventInfoModal;

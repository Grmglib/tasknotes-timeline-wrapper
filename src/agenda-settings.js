const { PluginSettingTab, Setting } = require('obsidian');
const { DEFAULT_SETTINGS, UI_STRINGS } = require('./constants');
const { parseNonNegInt } = require('./utils');

/* Settings. */
class AgendaSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  async display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h3', { text: UI_STRINGS.settings.timeline });
    new Setting(containerEl)
      .setName('Show date above timeline title')
      .setDesc('Show or hide the current date above “Today’s Timeline”.')
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.showTimelineDate !== false)
        .onChange(async (value) => {
          this.plugin.settings.showTimelineDate = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Show completed today')
      .setDesc('Add a daily review section for tasks completed today, with an Undo action to reopen them.')
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.showCompletedToday !== false)
        .onChange(async (value) => {
          this.plugin.settings.showCompletedToday = value;
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

    containerEl.createEl('h3', { text: UI_STRINGS.settings.taskDisplay });
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

    containerEl.createEl('h4', { text: 'Visible task metadata' });
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

    containerEl.createEl('h3', { text: UI_STRINGS.settings.calendar });
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

    containerEl.createEl('h3', { text: 'Scheduled reminders' });
    const NotificationApi = window.Notification;
    const notificationPermission = NotificationApi ? NotificationApi.permission : 'unsupported';
    const permissionDescription = notificationPermission === 'granted'
      ? 'System notification permission is granted.'
      : notificationPermission === 'denied'
        ? 'System notifications are blocked. Allow notifications for Obsidian in your operating system settings.'
        : notificationPermission === 'unsupported'
          ? 'System notifications are not supported in this Obsidian environment.'
          : 'Turning this on will ask for permission to show system notifications.';
    new Setting(containerEl)
      .setName('System notifications for scheduled tasks and events')
      .setDesc(`Show an operating system notification before the scheduled time and again when it starts. Tasks need a scheduled date with a time; all-day events are ignored. ${permissionDescription}`)
      .addToggle((toggle) => toggle
        .setValue(!!this.plugin.settings.scheduledNotificationsEnabled && notificationPermission === 'granted')
        .onChange(async (value) => {
          let enabled = value && !!NotificationApi;
          if (enabled && NotificationApi.permission === 'default'
            && typeof NotificationApi.requestPermission === 'function') {
            try {
              enabled = (await NotificationApi.requestPermission()) === 'granted';
            } catch (error) {
              console.warn('[tasknotes-timeline-wrapper] System notification permission request failed', error);
              enabled = false;
            }
          } else if (enabled) {
            enabled = NotificationApi.permission === 'granted';
          }
          this.plugin.settings.scheduledNotificationsEnabled = enabled;
          await this.plugin.saveSettings();
          await this.display();
          if (enabled) void this.plugin.checkScheduledReminders();
        }));

    new Setting(containerEl)
      .setName('Reminder lead time')
      .setDesc('How long before a scheduled task or event to show the first notification. Choose Never to disable the advance notification; the start-time notification remains enabled.')
      .addDropdown((dropdown) => dropdown
        .addOptions({ 0: 'Never', 5: '5 minutes', 10: '10 minutes', 15: '15 minutes', 30: '30 minutes', 60: '1 hour' })
        .setValue(String(this.plugin.settings.scheduledNotificationLeadMinutes ?? DEFAULT_SETTINGS.scheduledNotificationLeadMinutes))
        .onChange(async (value) => {
          this.plugin.settings.scheduledNotificationLeadMinutes = parseNonNegInt(
            value,
            DEFAULT_SETTINGS.scheduledNotificationLeadMinutes,
          );
          await this.plugin.saveSettings();
        }));

    if (!this.plugin.hasCalendarIntegration()) {
      containerEl.createEl('p', {
        cls: 'setting-item-description',
        text: 'No TaskNotes calendar integration detected. Enable ICS subscriptions, Google Calendar, or Microsoft Calendar in TaskNotes settings to use these options.',
      });
    }

    containerEl.createEl('h3', { text: UI_STRINGS.settings.filters });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Choose a TaskNotes Bases file and view from Filter in the timeline menu. Filtering requires TaskNotes Runtime API (query.tasks).',
    });
    new Setting(containerEl)
      .setName('Search outside the Base/view filter')
      .setDesc('Include matching tasks from all of TaskNotes while searching, even when a Base and view are selected in the timeline.')
      .addToggle((toggle) => toggle
        .setValue(!!this.plugin.settings.ignoreBaseFilterInSearch)
        .onChange(async (value) => {
          this.plugin.settings.ignoreBaseFilterInSearch = value;
          await this.plugin.saveSettings();
        }));
  }
}

module.exports = AgendaSettingTab;

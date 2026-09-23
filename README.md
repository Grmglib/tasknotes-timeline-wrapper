# TaskNotes Timeline Wrapper

Companion plugin for [TaskNotes](https://github.com/callumalpass/tasknotes) that shows an agenda-style **Today's Timeline**: incomplete tasks grouped by day, optional calendar events, quick task creation, and filters — in a sidebar pane or embedded in a note.

It does **not** own the task model. Reads and writes go through the [TaskNotes JavaScript Runtime API](https://tasknotes.dev/javascript-api/) (`api.tasks.list`, `create`, `complete`, `uncomplete`, and related UI helpers). That keeps behavior aligned with TaskNotes settings: templates, file naming, recurrence, time tracking, custom fields, excluded folders, and **tag or property** task identification.

## Requirements

- [Obsidian](https://obsidian.md/) (see `minAppVersion` in `manifest.json`)
- [TaskNotes](https://github.com/callumalpass/tasknotes) **4.10.0+** with Runtime API **v1** and capabilities `tasks.read` / `tasks.write`

If TaskNotes is missing or the API is incompatible, the timeline shows a clear error instead of scanning the vault by tag.

## Features

- **Today's Timeline pane** — ribbon icon or command *Open Today's Timeline*
- **Stat tiles** — Todo / Overdue / Unplanned; click to filter, click again to clear
- **Date-grouped list** — Unplanned, Overdue, then upcoming days (collapsible sections)
- **Reschedule by drag and drop** — drag a task onto another day to change its scheduled date
- **Inline quick edit** — change priority, scheduled date, and due date without opening the task modal
- **Loading feedback** — a small skeleton appears while tasks load
- **Completed today** — optional daily review section with an Undo action to reopen completed tasks
- **Quick add** — Enter creates a task via `api.tasks.create`; the chevron opens the TaskNotes creation modal
- **Status ring** — click completes or reopens via the API; right-click opens the native TaskNotes task menu (any configured status, recurrence actions when available)
- **Task interactions** — click title for TaskNotes details modal; context menu for native actions (or a local fallback); mod/middle-click open the note
- **Optional calendar events** — ICS / Google / Microsoft when those TaskNotes integrations are active
- **Optional Bases view filter** — restrict tasks to a `.base` file + view (`query.tasks`)
- **Embeddable** — `tasknotes-timeline-wrapper` code block with per-block options
- **Display settings** — density, metadata visibility, icons, empty-day visibility, lookahead days, open-in-new-tab for note opens

## Usage

### Sidebar pane

1. Click the **calendar-clock** ribbon icon, or  
2. Run **TaskNotes Timeline Wrapper: Open Today's Timeline**

### Embedded block

````markdown
```tasknotes-timeline-wrapper
title: This Week
days: 7
events: true
```
````

With a Bases filter:

````markdown
```tasknotes-timeline-wrapper
title: Work timeline
base: TaskNotes/Views/tasks-default.base
view: Work Context
```
````

| Option | Meaning |
|--------|---------|
| `title` | Header under the date line (default: `Today's Timeline`) |
| `days` | Sets both task and event lookahead (default from settings; `0` = unlimited) |
| `taskDays` | Task lookahead override |
| `eventDays` | Event lookahead override |
| `events` | `true` / `false` — show calendar events in this block |
| `base` | Path to a TaskNotes `.base` file |
| `view` | View name inside that base (filters combined with file-level filters) |

### Settings (plugin options)

- Open notes in a new tab (affects note opens from the menu / middle-click paths)
- Metadata icons and which fields appear (scheduled, due, priority, projects, tags)
- Timeline density (comfortable / compact)
- Calendar: show events, hide finished events today, task/event lookahead, max recurring occurrences
- Completed-today daily review section (show / hide)
- TaskNotes base + view filter (optional); calendar events are not filtered by the base

## How tasks are loaded and updated

1. **List** — `api.tasks.list` (non-archived). No local “must have `#task`” filter, so property-based identification works.
2. **Create (quick add)** — `api.tasks.create` with your TaskNotes defaults (folder, templates, identification).
3. **Complete / reopen** — `api.tasks.complete` / `uncomplete`. Undo after completion calls `uncomplete` with the previous status.
4. **Rich status / actions** — `api.ui.taskMenu` when available.
5. **Quick edits / rescheduling** — `api.tasks.update` or the TaskNotes field-specific setters.
6. **Completed-today review** — uses `completedDate`; reopening calls `api.tasks.uncomplete`.
7. **Bases filter** — Bases YAML → runtime `where`, then `api.query.tasks`.

Calendar feeds are loaded through the adapter (`listCalendarEvents`), which feature-detects TaskNotes ICS / Google / Microsoft services (there is no public Runtime calendar namespace yet). The plugin does not touch `cacheManager`, modal DOM selectors, or `document.execCommand`.

## Installation

### Community plugins (when available)

Settings → Community plugins → Browse → **TaskNotes Timeline Wrapper** → Install → Enable.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest [release](https://github.com/Grmglib/tasknotes-timeline-wrapper/releases).
2. Copy into `<vault>/.obsidian/plugins/tasknotes-timeline-wrapper/`.
3. Reload Obsidian and enable the plugin.

### BRAT

Add `Grmglib/tasknotes-timeline-wrapper` in [BRAT](https://github.com/TfTHacker/obsidian42-brat).

## Development

```bash
npm install
npm test
npm run build   # production → main.js
npm run dev     # development bundle with inline sourcemap
```

| Module | Role |
|--------|------|
| `src/main.js` | Plugin, timeline UI, settings |
| `src/tasknotes-adapter.js` | Runtime API gate, tasks/UI/lifecycle, calendar wrappers |
| `src/task-mapper.js` | `TaskInfo` → timeline row shape |
| `src/bases-filters.js` | Bases → runtime `where` |
| `src/calendar-helpers.js` | Day bucketing, recurring caps, sort |
| `src/calendar-providers.js` | Calendar id / label / color helpers |
| `src/block-options.js` | Code-block options |
| `src/frontmatter.js` | Tag/project helpers (mapping / filters) |
| `src/constants.js` / `src/utils.js` | Defaults and small utilities |

## License

[MIT](LICENSE)


<img width="1280" height="764" alt="Screenshot_2" src="https://github.com/user-attachments/assets/5bed14a7-0cdf-4954-acd6-31c9fe8f611b" />


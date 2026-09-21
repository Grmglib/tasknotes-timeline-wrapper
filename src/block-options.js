'use strict';

const { DEFAULT_SETTINGS } = require('./constants');
const { parseNonNegInt } = require('./utils');

/** Parse optional key: value lines from a ```tasknotes-timeline-wrapper code block. */
function parseOptions(source, defaults = DEFAULT_SETTINGS) {
  const opts = { title: "Today's Timeline" };
  (source || '').split('\n').forEach((line) => {
    const m = line.match(/^\s*([a-zA-Z]+)\s*:\s*(.+?)\s*$/);
    if (!m) return;
    const k = m[1].toLowerCase();
    if (k === 'title') opts.title = m[2];
    else if (k === 'days') {
      // Shortcut: one value sets both task and event horizons. 0 = unlimited.
      const n = parseNonNegInt(m[2], defaults.taskDays);
      opts.days = n;
      opts.taskDays = n;
      opts.eventDays = n;
    } else if (k === 'taskdays') {
      opts.taskDays = parseNonNegInt(m[2], defaults.taskDays);
    } else if (k === 'eventdays') {
      opts.eventDays = parseNonNegInt(m[2], defaults.eventDays);
    } else if (k === 'events') {
      const v = m[2].trim().toLowerCase();
      opts.events = v === 'true' || v === 'yes' || v === '1';
    } else if (k === 'base') {
      opts.base = m[2].trim();
    } else if (k === 'view') {
      opts.view = m[2].trim();
    }
  });
  return opts;
}

module.exports = { parseOptions };

'use strict';

function findProviderCalendar(calendars, id) {
  if (!calendars || !id) return null;
  if (Array.isArray(calendars)) {
    return calendars.find((c) => c && (c.id === id || c.calendarId === id)) || null;
  }
  if (typeof calendars.get === 'function') return calendars.get(id) || null;
  return calendars[id] || null;
}

function calendarLabel(cal, fallback) {
  if (!cal) return fallback;
  return cal.summary || cal.name || cal.displayName || fallback;
}

function calendarColor(cal, fallback) {
  if (!cal) return fallback;
  return cal.backgroundColor || cal.color || cal.hexColor || fallback;
}

function calendarIsEnabled(cal) {
  if (!cal) return true;
  if (cal.enabled === false || cal.selected === false || cal.hidden === true) return false;
  return true;
}

module.exports = {
  findProviderCalendar,
  calendarLabel,
  calendarColor,
  calendarIsEnabled,
};

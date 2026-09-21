'use strict';

const { BASES_FIELD_MAP } = require('./constants');
const { isPlainObject } = require('./utils');

function unquoteBasesLiteral(raw) {
  const s = String(raw).trim();
  if (s.startsWith('"')) return JSON.parse(s);
  if (/^'(?:[^'\\]|\\.)*'$/.test(s)) {
    return s.slice(1, -1).replace(/\\(["'\\])/g, '$1');
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  throw new Error(`Unsupported filter value: ${s}`);
}

// Scan once, keeping operators inside quoted strings and nested groups intact.
function scanBasesExpression(text) {
  const positions = { or: [], and: [] };
  const stack = [];
  let quote = null;
  let outerEnd = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(' || ch === '[') { stack.push(ch); continue; }
    if (ch === ')' || ch === ']') {
      if (stack.pop() !== (ch === ')' ? '(' : '[')) return null;
      if (!stack.length && outerEnd < 0) outerEnd = i;
      continue;
    }
    if (!stack.length) {
      const pair = text.slice(i, i + 2);
      if (pair === '||' || pair === '&&') {
        positions[pair === '||' ? 'or' : 'and'].push(i);
        i++;
      }
    }
  }
  if (quote || stack.length) return null;
  const split = (indices) => {
    let start = 0;
    const parts = indices.map((index) => {
      const part = text.slice(start, index).trim();
      start = index + 2;
      return part;
    });
    parts.push(text.slice(start).trim());
    return parts;
  };
  return {
    or: split(positions.or),
    and: split(positions.and),
    wrapped: text[0] === '(' && outerEnd === text.length - 1,
  };
}

function mapBasesField(raw) {
  if (!raw) return null;
  let key = String(raw).trim();
  // note["Custom Field"] → skip (unsupported bracket form beyond simple)
  const bracket = key.match(/^note\["([^"]+)"\]$/i) || key.match(/^note\['([^']+)'\]$/i);
  if (bracket) {
    const name = bracket[1];
    if (BASES_FIELD_MAP[`note.${name}`]) return BASES_FIELD_MAP[`note.${name}`];
    return `user.${name}`;
  }
  if (key.startsWith('formula.') || key.startsWith('file.tasks')) return null;
  if (BASES_FIELD_MAP[key]) return BASES_FIELD_MAP[key];
  if (key.startsWith('note.')) {
    const rest = key.slice(5);
    if (BASES_FIELD_MAP[`note.${rest}`]) return BASES_FIELD_MAP[`note.${rest}`];
    return `task.${rest}`;
  }
  if (key.startsWith('file.')) return key;
  return null;
}

/**
 * Convert a single Bases filter expression string into a runtime condition,
 * or null if unsupported. Pushes a short reason into `warnings` when skipped.
 */
function convertBasesExpression(expr, warnings, nesting = 0) {
  if (nesting > 100) {
    warnings.push('Filter nesting exceeds the supported depth.');
    return null;
  }
  try {
    return convertBasesExpressionInner(expr, warnings, nesting);
  } catch (e) {
    warnings.push(e.message || 'Invalid filter expression.');
    return null;
  }
}

function convertBasesExpressionInner(expr, warnings, nesting) {
  const raw = String(expr || '').trim();
  if (!raw) return null;

  let s = raw;
  let scan = scanBasesExpression(s);
  while (scan && scan.wrapped) {
    s = s.slice(1, -1).trim();
    scan = scanBasesExpression(s);
  }
  if (!scan || !s) {
    warnings.push(`Invalid Bases filter: ${raw}`);
    return null;
  }

  // OR has lower precedence than AND. Only recurse after an actual split.
  for (const [parts, group] of [[scan.or, 'any'], [scan.and, 'all']]) {
    if (parts.length <= 1) continue;
    if (parts.some((part) => !part)) {
      warnings.push(`Missing operand in Bases filter: ${raw}`);
      return null;
    }
    const children = parts.map((part) => convertBasesExpression(part, warnings, nesting + 1));
    return children.every(Boolean) ? { [group]: children } : null;
  }
  if (s.startsWith('!') && s[1] !== '=') {
    const inner = s.slice(1).trim();
    if (inner.startsWith('(') || inner.startsWith('!') || inner.startsWith('file.hasTag(')) {
      const child = convertBasesExpression(inner, warnings, nesting + 1);
      return child ? { not: child } : null;
    }
  }

  // file.hasTag("task") — default TaskNotes identification filter
  let m = s.match(/^file\.hasTag\(\s*(.+?)\s*\)$/i);
  if (m) {
    let tag = unquoteBasesLiteral(m[1]);
    if (typeof tag === 'string') tag = tag.replace(/^#/, '');
    return { field: 'task.tags', op: 'contains', value: tag };
  }

  // !prop / (!prop || prop == "" || prop == null)
  const emptyish = s.match(
    /^!\s*([a-zA-Z_][\w.]*(?:\["[^"]+"\])?)\s*$/
  ) || s.match(
    /^\(\s*!\s*([a-zA-Z_][\w.]*)\s*\|\|\s*\1\s*==\s*""\s*\|\|\s*\1\s*==\s*null\s*\)$/
  );
  if (emptyish) {
    const field = mapBasesField(emptyish[1]);
    if (!field) {
      warnings.push(`Skipped unsupported property: ${emptyish[1]}`);
      return null;
    }
    return { field, op: 'missing' };
  }

  // !prop.isEmpty() → exists
  m = s.match(/^!\s*(.+?)\.isEmpty\(\)$/i);
  if (m) {
    const field = mapBasesField(m[1].trim());
    if (!field) { warnings.push(`Skipped unsupported property: ${m[1]}`); return null; }
    return { field, op: 'exists' };
  }

  // prop.isEmpty() / prop.isEmpty() == false
  m = s.match(/^(.+?)\.isEmpty\(\)\s*==\s*false$/i)
    || s.match(/^\((.+?)\.isEmpty\(\)\s*==\s*false\)$/i);
  if (m) {
    const field = mapBasesField(m[1].trim());
    if (!field) { warnings.push(`Skipped unsupported property: ${m[1]}`); return null; }
    return { field, op: 'exists' };
  }
  m = s.match(/^(.+?)\.isEmpty\(\)$/i);
  if (m) {
    const field = mapBasesField(m[1].trim());
    if (!field) { warnings.push(`Skipped unsupported property: ${m[1]}`); return null; }
    return { field, op: 'missing' };
  }

  // prop.contains("value") / list(prop).contains(...)
  m = s.match(/^(?:list\()?([a-zA-Z_][\w.]*(?:\["[^"]+"\])?)\)?\.contains\(\s*(.+?)\s*\)$/);
  if (m) {
    const field = mapBasesField(m[1]);
    if (!field) { warnings.push(`Skipped unsupported property: ${m[1]}`); return null; }
    return { field, op: 'contains', value: unquoteBasesLiteral(m[2]) };
  }

  // Comparison: prop == / != / >= / <= / > / <
  m = s.match(/^([a-zA-Z_][\w.]*(?:\["[^"]+"\])?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (m) {
    const field = mapBasesField(m[1]);
    if (!field) { warnings.push(`Skipped unsupported property: ${m[1]}`); return null; }
    const opMap = { '==': 'eq', '!=': 'ne', '>': 'gt', '<': 'lt', '>=': 'gte', '<=': 'lte' };
    return { field, op: opMap[m[2]], value: unquoteBasesLiteral(m[3]) };
  }

  // Bare property — truthy / exists
  m = s.match(/^([a-zA-Z_][\w.]*(?:\["[^"]+"\])?)$/);
  if (m) {
    const field = mapBasesField(m[1]);
    if (!field) { warnings.push(`Skipped unsupported property: ${m[1]}`); return null; }
    return { field, op: 'exists' };
  }

  warnings.push(`Skipped unsupported Bases filter: ${raw}`);
  return null;
}

/**
 * Convert Bases YAML filter tree (object / string / array) to a runtime `where` predicate.
 */
function convertBasesFiltersToWhere(node, warnings, nesting = 0) {
  if (nesting > 100) { warnings.push('Filter nesting exceeds the supported depth.'); return null; }
  if (node == null || node === '') return null;

  if (typeof node === 'string') {
    return convertBasesExpression(node, warnings);
  }

  if (Array.isArray(node)) {
    const all = node.map((n) => convertBasesFiltersToWhere(n, warnings, nesting + 1)).filter(Boolean);
    if (!all.length) return null;
    return all.length === 1 ? all[0] : { all };
  }

  if (!isPlainObject(node)) { warnings.push('Unsupported Bases filter value.'); return null; }

  if (Object.keys(node).length !== 1) {
    if (Object.keys(node).length) warnings.push('Expected one boolean group per Bases filter object.');
    return null;
  }

  if (node.and != null) {
    const all = (Array.isArray(node.and) ? node.and : [node.and])
      .map((n) => convertBasesFiltersToWhere(n, warnings, nesting + 1)).filter(Boolean);
    if (!all.length) return null;
    return all.length === 1 ? all[0] : { all };
  }
  if (node.or != null) {
    const any = (Array.isArray(node.or) ? node.or : [node.or])
      .map((n) => convertBasesFiltersToWhere(n, warnings, nesting + 1)).filter(Boolean);
    if (!any.length) return null;
    return any.length === 1 ? any[0] : { any };
  }
  if (node.not != null) {
    const inner = convertBasesFiltersToWhere(node.not, warnings, nesting + 1);
    return inner ? { not: inner } : null;
  }

  // Single unknown key — try treating values as expressions
  const keys = Object.keys(node);
  if (keys.length === 1) {
    warnings.push(`Skipped unknown Bases filter key: ${keys[0]}`);
  }
  return null;
}

function mergeBasesFilters(fileFilters, viewFilters) {
  if (fileFilters == null && viewFilters == null) return null;
  if (fileFilters == null) return viewFilters;
  if (viewFilters == null) return fileFilters;
  return { and: [fileFilters, viewFilters] };
}

/** @param {function} parseYaml — Obsidian's parseYaml (or a test stub). */
function parseBaseDocument(text, parseYaml) {
  if (!text || !String(text).trim()) return null;
  try {
    const doc = parseYaml(text);
    return isPlainObject(doc) ? doc : null;
  } catch (e) {
    return null;
  }
}

function viewsFromBaseDoc(doc) {
  if (!doc || !Array.isArray(doc.views)) return [];
  return doc.views
    .filter((v) => v && typeof v === 'object')
    .map((v, i) => ({
      name: (v.name != null && String(v.name).trim()) ? String(v.name).trim() : `View ${i + 1}`,
      filters: v.filters != null ? v.filters : null,
      index: i,
    }));
}

function findViewInDoc(doc, viewName) {
  const views = viewsFromBaseDoc(doc);
  if (!views.length) return null;
  if (!viewName) return null;
  const want = String(viewName).trim().toLowerCase();
  return views.find((v) => v.name.toLowerCase() === want) || null;
}

module.exports = {
  unquoteBasesLiteral,
  scanBasesExpression,
  mapBasesField,
  convertBasesExpression,
  convertBasesFiltersToWhere,
  mergeBasesFilters,
  parseBaseDocument,
  viewsFromBaseDoc,
  findViewInDoc,
};

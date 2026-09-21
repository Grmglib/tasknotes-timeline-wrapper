'use strict';

function debounce(fn, ms) {
  let t;
  const run = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  run.cancel = () => clearTimeout(t);
  return run;
}

function parseNonNegInt(v, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || Number.isNaN(n) || n < 0) return fallback;
  return n;
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

module.exports = {
  debounce,
  parseNonNegInt,
  isPlainObject,
};

'use strict';

function collectTags(fm, cache) {
  const tags = new Set();
  const add = (t) => { if (t) tags.add(String(t).replace(/^#/, '')); };
  if (fm) {
    if (Array.isArray(fm.tags)) fm.tags.forEach(add);
    else if (typeof fm.tags === 'string') fm.tags.split(/[,\s]+/).forEach(add);
  }
  if (cache && cache.tags) cache.tags.forEach((x) => add(x.tag));
  return tags;
}

// Task tag first so it stays anchored where it has always been; extra tags follow it.
function orderTags(tags, taskTag) {
  const rest = [...tags].filter((t) => t !== taskTag);
  return tags.has(taskTag) ? [taskTag, ...rest] : rest;
}

// TaskNotes stores projects as wikilinks ("[[Note]]", "[[path/Note|Alias]]") or
// markdown links; we only want the display name.
function linkText(v) {
  if (v == null) return null;
  let s = String(v).trim();
  if (!s) return null;
  const wiki = s.match(/^\[\[([^\]]+)\]\]$/);
  if (wiki) s = wiki[1].split('|').pop();
  else {
    const md = s.match(/^\[([^\]]*)\]\(([^)]+)\)$/);
    if (md) s = md[1] || decodeURIComponent(md[2]);
  }
  s = s.trim().split('/').pop().replace(/\.md$/i, '');
  return s || null;
}

function linkNames(v) {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).map(linkText).filter(Boolean);
}

function createFrontmatterHelpers(moment) {
  function normDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return moment(v).format('YYYY-MM-DD');
    return String(v);
  }

  return {
    collectTags,
    orderTags,
    linkText,
    linkNames,
    normDate,
  };
}

module.exports = {
  collectTags,
  orderTags,
  linkText,
  linkNames,
  createFrontmatterHelpers,
};

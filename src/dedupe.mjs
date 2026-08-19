import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export function loadSeen(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${err.message}`);
  }
}

export function saveSeen(path, seen) {
  writeFileSync(path, JSON.stringify(seen, null, 2), 'utf8');
}

export function isSeen(seen, id) {
  return Object.prototype.hasOwnProperty.call(seen, id);
}

export function recordSeen(seen, id, isoDate) {
  return { ...seen, [id]: isoDate };
}

/**
 * Drop entries older than `retentionDays` before `todayIso`.
 * `today` is a parameter, not a clock read, so the function is pure.
 * Entries whose date will not parse are dropped — an unreadable date cannot
 * be shown to be fresh, and keeping it would leak state forever.
 */
export function pruneSeen(seen, todayIso, retentionDays) {
  const cutoff = new Date(`${todayIso}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  const out = {};
  for (const [id, dateStr] of Object.entries(seen)) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) continue;
    if (d >= cutoff) out[id] = dateStr;
  }
  return out;
}

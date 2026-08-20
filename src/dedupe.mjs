import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

const describe = (value) => {
  if (Array.isArray(value)) return 'an array';
  if (value === null) return 'null';
  return `a ${typeof value}`;
};

/**
 * Read the dedup state.
 *
 * The shape is checked, not assumed: valid JSON is not valid state. A file
 * containing `null` would sail through JSON.parse and then make isSeen throw
 * on the first posting, and an array or a string would produce silent nonsense
 * — every posting reported as new, or none. A hand-edited or half-written file
 * should say so here rather than misbehave three stages later.
 */
export function loadSeen(path) {
  if (!existsSync(path)) return {};
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${err.message}`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(
      `Invalid dedup state in ${path}: expected a JSON object of id -> date, got ${describe(data)}`
    );
  }
  return data;
}

/**
 * Write the dedup state atomically.
 *
 * A plain writeFileSync truncates the target before it writes: a scheduled run
 * interrupted mid-write (reboot, laptop lid, CI cancellation) would leave an
 * empty or truncated seen.json, and the next run would re-report every posting
 * as new. Writing beside the target and renaming over it means the file is
 * either the old state or the new one, never a fragment.
 */
export function saveSeen(path, seen) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(seen, null, 2), 'utf8');
  renameSync(tmp, path);
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

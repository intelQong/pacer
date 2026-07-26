// Pacing math for a metered usage window.
// Pure functions only: no network, no DOM, no credentials.

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_MS = 5 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
export const MINUTE_MS = 60 * 1000;

// How far the budget rate may drift from the burn rate before it stops
// counting as "on pace". Relative, so it means the same thing on both windows.
const PACE_TOLERANCE = 0.05;

// Two readings closer together than this are too noisy for a reliable slope.
const RECENT_MIN_GAP_MS = 15 * MINUTE_MS;

/**
 * Work out where you stand in a usage window.
 *
 * The window length is known, so the reset time also tells us when the window
 * opened: start = resetAt - windowMs. That gives elapsed and remaining time
 * without asking for anything else.
 *
 * Returns either { error } or a reading with state "ok" | "expired" | "exhausted".
 * Rates come back per-millisecond; scale them with perDay / perHour.
 */
export function analyze({ usedPct, resetAt, windowMs, now = Date.now() }) {
  // Number("") and Number(null) are both 0, which would turn an empty form
  // field into a confident "0% used". Reject blanks before converting.
  const blank =
    usedPct === null ||
    usedPct === undefined ||
    (typeof usedPct === "string" && usedPct.trim() === "");
  const used = blank ? NaN : Number(usedPct);
  const reset = resetAt instanceof Date ? resetAt.getTime() : new Date(resetAt).getTime();

  if (!Number.isFinite(used) || used < 0 || used > 100) {
    return { error: "Usage must be a number from 0 to 100." };
  }
  if (!Number.isFinite(reset)) {
    return { error: "Reset time is not a valid date." };
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    return { error: "Window length must be a positive number of milliseconds." };
  }

  const remainingMs = reset - now;
  const elapsedMs = windowMs - remainingMs;
  const leftPct = 100 - used;

  if (elapsedMs < 0) {
    return { error: "That reset time is further out than the window is long." };
  }
  if (remainingMs <= 0) {
    return {
      state: "expired",
      used,
      leftPct,
      elapsedMs: windowMs,
      remainingMs: 0,
      elapsedFrac: 1,
      burnPerMs: used / windowMs,
      budgetPerMs: null,
      projectedPct: used,
      verdict: null,
    };
  }

  const elapsedFrac = elapsedMs / windowMs;
  // No elapsed time means no rate to measure yet, not a rate of zero.
  const burnPerMs = elapsedMs > 0 ? used / elapsedMs : null;
  const projectedPct = burnPerMs === null ? null : burnPerMs * windowMs;

  if (leftPct <= 0) {
    return {
      state: "exhausted",
      used: 100,
      leftPct: 0,
      elapsedMs,
      remainingMs,
      elapsedFrac,
      burnPerMs,
      budgetPerMs: 0,
      projectedPct,
      verdict: "over",
    };
  }

  const budgetPerMs = leftPct / remainingMs;

  return {
    state: "ok",
    used,
    leftPct,
    elapsedMs,
    remainingMs,
    elapsedFrac,
    burnPerMs,
    budgetPerMs,
    projectedPct,
    verdict: paceVerdict(budgetPerMs, burnPerMs),
  };
}

// Spending faster than a steady burn would allow means the budget left per unit
// time is lower than what you have been spending. Compare the two rates.
function paceVerdict(budgetPerMs, burnPerMs) {
  if (burnPerMs === null || burnPerMs === 0) return "under";
  const ratio = budgetPerMs / burnPerMs;
  if (ratio > 1 + PACE_TOLERANCE) return "under";
  if (ratio < 1 - PACE_TOLERANCE) return "over";
  return "on";
}

export const perDay = (ratePerMs) => (ratePerMs === null ? null : ratePerMs * DAY_MS);
export const perHour = (ratePerMs) => (ratePerMs === null ? null : ratePerMs * HOUR_MS);

// Blank counts as zero; anything unparseable does not.
function partOrNull(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string" && value.trim() === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Resolve a "resets in 4 hr 23 min" countdown into an absolute instant.
 *
 * The Claude app states the session reset as a duration rather than a clock
 * time, so take it in that shape and pin it to a timestamp at entry. Storing
 * the instant, not the duration, keeps the countdown honest afterwards.
 */
export function resetInDuration({ hours, minutes, now = Date.now() }) {
  const h = partOrNull(hours);
  const m = partOrNull(minutes);
  if (h === null || m === null) return null;
  const ms = (h * 60 + m) * MINUTE_MS;
  if (ms <= 0) return null;
  return now + ms;
}

/**
 * Resolve "resets Wed 08:00" into the next instant matching that weekday and
 * time. Today counts only if the time has not gone by yet, so the answer is
 * always ahead of `now` and never more than a week out.
 */
export function nextWeekdayAt({ weekday, time, now = Date.now() }) {
  // Number("") is 0, which would quietly turn an empty select into Sunday.
  const blank =
    weekday === null ||
    weekday === undefined ||
    (typeof weekday === "string" && weekday.trim() === "");
  const wd = blank ? NaN : Number(weekday);
  if (!Number.isInteger(wd) || wd < 0 || wd > 6) return null;

  const parts = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? "").trim());
  if (!parts) return null;
  const hh = Number(parts[1]);
  const mm = Number(parts[2]);
  if (hh > 23 || mm > 59) return null;

  const target = new Date(now);
  target.setHours(hh, mm, 0, 0);
  let days = (wd - target.getDay() + 7) % 7;
  if (days === 0 && target.getTime() <= now) days = 7; // already gone by today
  target.setDate(target.getDate() + days);
  return target.getTime();
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun",
                "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const pad2 = (n) => String(n).padStart(2, "0");

/** "6:40pm", "8am", "08:00", "18:14" → { hh, mm }, or null. */
function parseClock(text) {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(String(text).trim());
  if (!m) return null;
  let hh = Number(m[1]);
  const mm = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3] ? m[3].toLowerCase() : null;
  if (mm > 59) return null;
  if (meridiem) {
    if (hh < 1 || hh > 12) return null;
    if (meridiem === "pm" && hh !== 12) hh += 12;
    if (meridiem === "am" && hh === 12) hh = 0;
  } else if (hh > 23) {
    return null;
  }
  return { hh, mm };
}

/**
 * "Jul 26" carries no year. Windows are at most a week long, so pick whichever
 * year puts the date nearest to now — which also gets December/January right.
 */
function nearestYearFor(monthIdx, day, clock, now) {
  const thisYear = new Date(now).getFullYear();
  const build = (year) => {
    const d = new Date(year, monthIdx, day, clock.hh, clock.mm, 0, 0);
    // Reject rollovers like "Feb 30" landing in March.
    return d.getMonth() === monthIdx && d.getDate() === day ? d.getTime() : null;
  };
  const candidates = [build(thisYear - 1), build(thisYear), build(thisYear + 1)]
    .filter((v) => v !== null);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) => (Math.abs(c - now) < Math.abs(best - now) ? c : best));
}

/**
 * Read whatever follows the word "resets" into an instant.
 *
 * Claude states it three different ways depending on where you look:
 *   "in 4 hr 23 min"   the app, for the session
 *   "Wed 08:00"        the app, for the week
 *   "Jul 26, 6:40pm"   the CLI, for either
 *
 * A trailing timezone label like "(Asia/Dhaka)" is dropped; times are read in
 * the browser's own zone, which is the same machine in practice.
 */
export function parseResetPhrase(phrase, now = Date.now()) {
  const s = String(phrase ?? "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;]+$/, "");
  if (!s) return null;

  // "in 4 hr 23 min" / "in 45 min" / "in 2h"
  const dur = /^in (?:(\d+) ?(?:h|hr|hrs|hour|hours))? ?(?:(\d+) ?(?:m|min|mins|minute|minutes))?$/
    .exec(s);
  if (dur && (dur[1] || dur[2])) {
    return resetInDuration({ hours: dur[1] ?? 0, minutes: dur[2] ?? 0, now });
  }

  // "wed 08:00" / "wednesday 8am"
  const wd = /^(?:on )?([a-z]{3,9})\.? (\d{1,2}(?::\d{2})? ?(?:am|pm)?)$/.exec(s);
  if (wd) {
    const dayIdx = WEEKDAYS.indexOf(wd[1].slice(0, 3));
    const clock = parseClock(wd[2]);
    if (dayIdx >= 0 && clock) {
      return nextWeekdayAt({
        weekday: dayIdx,
        time: `${pad2(clock.hh)}:${pad2(clock.mm)}`,
        now,
      });
    }
  }

  // "jul 26, 6:40pm" / "26 jul at 8am"
  const md = /^(?:on )?([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)? ?,? ?(?:at )?(\d{1,2}(?::\d{2})? ?(?:am|pm)?)$/
    .exec(s);
  if (md) {
    const monthIdx = MONTHS.indexOf(md[1].slice(0, 3));
    const day = Number(md[2]);
    const clock = parseClock(md[3]);
    if (monthIdx >= 0 && day >= 1 && day <= 31 && clock) {
      return nearestYearFor(monthIdx, day, clock, now);
    }
  }

  return null;
}

/**
 * Pull both meters out of pasted `/usage` output or the app's Usage screen.
 *
 * Tolerant by design: it scans line by line for a meter name, a percentage and
 * a "resets ..." phrase, and lets the reset sit on its own line beneath the
 * name the way the app lays it out. The `breakdown` line is skipped explicitly
 * because its per-model percentages are not window usage.
 *
 * Returns { weekly: {pct, resetAt}, session: {pct, resetAt} } or { error }.
 */
export function parseUsageText(text, now = Date.now()) {
  if (!String(text ?? "").trim()) return { error: "Paste what /usage printed first." };

  const found = { session: {}, weekly: {} };
  let current = null;

  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const low = trimmed.toLowerCase();

    // Per-model breakdown percentages are not window usage.
    if (/^breakdown\b/.test(low)) { current = null; continue; }

    const meter =
      /current session|^session\b/.test(low) ? "session" :
      /current week|weekly|all models/.test(low) ? "weekly" :
      null;
    if (meter) current = meter;
    if (!current) continue;

    const pct = /(\d+(?:\.\d+)?)\s*%/.exec(trimmed);
    if (pct && found[current].pct === undefined) found[current].pct = Number(pct[1]);

    const resets = /resets?\b:?\s+(.+)$/i.exec(trimmed);
    if (resets && found[current].resetAt === undefined) {
      const at = parseResetPhrase(resets[1], now);
      if (at !== null) found[current].resetAt = at;
    }
  }

  const missing = [];
  for (const [key, label] of [["session", "5-hour session"], ["weekly", "weekly limit"]]) {
    if (found[key].pct === undefined) missing.push(`${label} percentage`);
    else if (found[key].resetAt === undefined) missing.push(`${label} reset time`);
  }
  if (missing.length) {
    return { error: `Could not find the ${missing.join(" or the ")} in that. Paste the whole of what /usage printed.` };
  }

  return { session: found.session, weekly: found.weekly };
}

/**
 * What one hour of actual use costs, as a share of the window.
 *
 * Elapsed wall-clock time cannot answer this: most of a week is time you were
 * not using Claude at all. So this needs your own count of hours spent, and it
 * sharpens as the week goes on. Returns null when there is nothing to divide.
 */
export function hourlyCost({ usedPct, hoursUsed }) {
  const used = Number(usedPct);
  const hours = Number(hoursUsed);
  if (!Number.isFinite(used) || used <= 0) return null;
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return used / hours;
}

/** Turn a share of the window into hours of use, given a cost per hour. */
export function hoursFor(pct, costPerHour) {
  if (!Number.isFinite(pct) || pct < 0) return null;
  if (!Number.isFinite(costPerHour) || costPerHour <= 0) return null;
  return pct / costPerHour;
}

/**
 * Derive a burn rate from the two most recent readings in a history array.
 *
 * Each entry is { pct, at } where `pct` is the usage percentage and `at` is
 * the timestamp when it was captured. Only entries within the current window
 * (at >= windowStart) count — older ones belong to a previous reset cycle.
 *
 * Returns the rate per millisecond, or null if there are not enough points or
 * the two most recent are too close together (< 15 min apart) to be reliable.
 */
export function recentRate(history, windowStart) {
  if (!Array.isArray(history) || history.length < 2) return null;

  // Keep only points in the current window, sorted newest first.
  const pts = history
    .filter((h) => Number.isFinite(h.pct) && Number.isFinite(h.at) && h.at >= windowStart)
    .sort((a, b) => b.at - a.at);

  // Walk backwards from the most recent point to find a partner far enough away.
  if (pts.length < 2) return null;
  const latest = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const gap = latest.at - pts[i].at;
    if (gap >= RECENT_MIN_GAP_MS) {
      const delta = latest.pct - pts[i].pct;
      // Usage should not go down within a window. If it does the data is
      // inconsistent (e.g. a window rolled over mid-history). Bail out.
      if (delta < 0) return null;
      return delta / gap;
    }
  }
  return null; // every pair is too close together
}

/**
 * Layer a recent-rate projection over the output of analyze().
 *
 * When a recent burn rate is available (from two or more readings) it gives a
 * sharper projection than the overall average because it captures what the user
 * is doing *now*, not what they did two days ago.
 *
 * The recent rate describes the present, so it may only be applied to the time
 * still ahead: what is already spent is banked and cannot be re-forecast.
 * Multiplying the recent rate by the whole window instead would re-spend the
 * past at the current rate, which inflates a busy stretch wildly and — after a
 * quiet one — can project a total below what has already gone.
 *
 * Returns { recentBurnPerMs, projectedPct, verdict }. Any field may be null if
 * there is not enough data, in which case the caller should fall back to the
 * original values from analyze().
 */
export function refineProjection({ budgetPerMs, usedPct, remainingMs, recentBurnPerMs }) {
  const nothing = { recentBurnPerMs: null, projectedPct: null, verdict: null };
  if (recentBurnPerMs === null || recentBurnPerMs === undefined) return nothing;

  const used = Number(usedPct);
  if (!Number.isFinite(used) || !Number.isFinite(remainingMs) || remainingMs < 0) return nothing;
  if (!Number.isFinite(recentBurnPerMs) || recentBurnPerMs < 0) return nothing;

  return {
    recentBurnPerMs,
    projectedPct: used + recentBurnPerMs * remainingMs,
    verdict: paceVerdict(budgetPerMs, recentBurnPerMs),
  };
}

/** Local midnight at the end of the calendar day containing `ms`. */
function nextMidnight(ms) {
  const d = new Date(ms);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/**
 * Split what is left of the quota across the calendar days up to the reset.
 *
 * A flat "%/day" is wrong at both ends of the window: today is already part
 * spent, and the reset day usually ends mid-morning. So cut the remaining time
 * at local midnights and hand each day a share proportional to the hours it
 * actually contributes. Days that straddle a DST change are 23 or 25 hours long
 * and get their share accordingly, because the split is by elapsed time rather
 * than by counting days.
 *
 * Shares sum to `leftPct` exactly, up to floating point.
 */
export function planDays({ leftPct, resetAt, now = Date.now(), maxDays = 14, weightFn }) {
  const left = Number(leftPct);
  const end = resetAt instanceof Date ? resetAt.getTime() : new Date(resetAt).getTime();

  if (!Number.isFinite(left) || left <= 0) return [];
  if (!Number.isFinite(end) || end <= now) return [];

  // First pass: gather raw segments at each midnight boundary.
  const segs = [];
  let cursor = now;
  while (cursor < end && segs.length < maxDays) {
    const dayEnd = Math.min(nextMidnight(cursor), end);
    segs.push({ startsAt: cursor, endsAt: dayEnd, ms: dayEnd - cursor });
    cursor = dayEnd;
  }

  // Weigh each segment. Default weight is wall-clock ms (current behaviour).
  const weight = typeof weightFn === "function" ? weightFn : (s, e) => e - s;
  const weights = segs.map((s) => Math.max(0, weight(s.startsAt, s.endsAt)));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  // If every segment has zero weight, fall back to proportional-by-ms so we
  // never return an empty plan when there is time and quota remaining.
  const fallback = totalWeight === 0;
  const totalMs = end - now;

  return segs.map((s, i) => ({
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    ms: s.ms,
    hours: s.ms / HOUR_MS,
    pct: fallback ? (left * s.ms) / totalMs : (left * weights[i]) / totalWeight,
    partial: s.ms < DAY_MS - 1000,
  }));
}

/** "2d 18h", "4h 05m", "12m" — coarse on purpose, it is a countdown not a stopwatch. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m`;
}

/** "6h ago" for a reading's age, or "just now" under a minute. */
export function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < MINUTE_MS) return "just now";
  return `${formatDuration(ms)} ago`;
}

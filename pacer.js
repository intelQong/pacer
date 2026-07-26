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
export function planDays({ leftPct, resetAt, now = Date.now(), maxDays = 14 }) {
  const left = Number(leftPct);
  const end = resetAt instanceof Date ? resetAt.getTime() : new Date(resetAt).getTime();

  if (!Number.isFinite(left) || left <= 0) return [];
  if (!Number.isFinite(end) || end <= now) return [];

  const totalMs = end - now;
  const days = [];
  let cursor = now;

  while (cursor < end && days.length < maxDays) {
    const dayEnd = Math.min(nextMidnight(cursor), end);
    const ms = dayEnd - cursor;
    days.push({
      startsAt: cursor,
      endsAt: dayEnd,
      ms,
      hours: ms / HOUR_MS,
      pct: (left * ms) / totalMs,
      partial: ms < DAY_MS - 1000, // a stub of a day at either end
    });
    cursor = dayEnd;
  }

  return days;
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

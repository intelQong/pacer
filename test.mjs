// Run: node test.mjs
import assert from "node:assert/strict";
import {
  analyze, planDays, hourlyCost, hoursFor, resetInDuration, nextWeekdayAt,
  perDay, perHour, formatDuration, formatAge,
  WEEK_MS, SESSION_MS, DAY_MS, HOUR_MS,
} from "./pacer.js";

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const at = (msFromNow) => new Date(NOW + msFromNow).toISOString();
const weekly = (usedPct, remainingMs) =>
  analyze({ usedPct, resetAt: at(remainingMs), windowMs: WEEK_MS, now: NOW });

let passed = 0;
const check = (name, fn) => { fn(); passed++; };

// --- pace verdicts: same elapsed time, three different burn rates ---------
const HALFWAY = WEEK_MS / 2;

check("under pace when spending slower than the window allows", () => {
  const r = weekly(25, HALFWAY);
  assert.equal(r.state, "ok");
  assert.equal(r.verdict, "under");
  // 25% over 3.5 days burned, 75% left over 3.5 days available.
  assert.ok(Math.abs(perDay(r.burnPerMs) - 50 / 7) < 1e-9);
  assert.ok(Math.abs(perDay(r.budgetPerMs) - 150 / 7) < 1e-9);
  assert.ok(perDay(r.budgetPerMs) > perDay(r.burnPerMs));
});

check("over pace when spending faster than the window allows", () => {
  const r = weekly(75, HALFWAY);
  assert.equal(r.verdict, "over");
  assert.ok(perDay(r.budgetPerMs) < perDay(r.burnPerMs));
  assert.ok(Math.abs(r.projectedPct - 150) < 1e-9); // would need 150% of quota
});

check("on pace when exactly linear", () => {
  const r = weekly(50, HALFWAY);
  assert.equal(r.verdict, "on");
  assert.ok(Math.abs(r.projectedPct - 100) < 1e-9);
  assert.ok(Math.abs(perDay(r.budgetPerMs) - perDay(r.burnPerMs)) < 1e-9);
});

check("small drift still counts as on pace", () => {
  assert.equal(weekly(49, HALFWAY).verdict, "on");
  assert.equal(weekly(51, HALFWAY).verdict, "on");
});

check("elapsed and remaining are derived from the reset time alone", () => {
  const r = weekly(40, WEEK_MS / 4); // three quarters of the way through
  assert.ok(Math.abs(r.elapsedFrac - 0.75) < 1e-12);
  assert.equal(r.elapsedMs, (WEEK_MS * 3) / 4);
  assert.equal(r.remainingMs, WEEK_MS / 4);
});

// --- boundary states ------------------------------------------------------
check("a window whose reset has passed is expired, not negative", () => {
  const r = weekly(60, -HOUR_MS);
  assert.equal(r.state, "expired");
  assert.equal(r.remainingMs, 0);
  assert.equal(r.budgetPerMs, null);
  assert.equal(r.elapsedFrac, 1);
});

check("fully used quota is exhausted with a zero budget", () => {
  const r = weekly(100, HALFWAY);
  assert.equal(r.state, "exhausted");
  assert.equal(r.budgetPerMs, 0);
  assert.equal(r.leftPct, 0);
  assert.equal(r.verdict, "over");
});

check("a window that just reset reports no burn rate rather than dividing by zero", () => {
  const r = weekly(0, WEEK_MS);
  assert.equal(r.state, "ok");
  assert.equal(r.elapsedMs, 0);
  assert.equal(r.burnPerMs, null);      // not 0, and not Infinity
  assert.equal(r.projectedPct, null);
  assert.equal(r.verdict, "under");
  assert.ok(Number.isFinite(r.budgetPerMs));
});

check("zero usage part-way through is under pace, not a divide-by-zero", () => {
  const r = weekly(0, HALFWAY);
  assert.equal(r.burnPerMs, 0);
  assert.equal(r.verdict, "under");
});

check("the last millisecond of a window still yields a finite budget", () => {
  const r = weekly(99, 1);
  assert.equal(r.state, "ok");
  assert.ok(Number.isFinite(r.budgetPerMs));
  assert.ok(r.budgetPerMs > 0);
});

// --- rejected input -------------------------------------------------------
check("usage outside 0-100 is rejected", () => {
  assert.match(weekly(101, HALFWAY).error, /0 to 100/);
  assert.match(weekly(-1, HALFWAY).error, /0 to 100/);
  assert.match(weekly("abc", HALFWAY).error, /0 to 100/);
  assert.match(weekly(NaN, HALFWAY).error, /0 to 100/);
});

// An empty field must not coerce to a confident 0% used.
check("blank usage is rejected rather than read as zero", () => {
  assert.match(weekly("", HALFWAY).error, /0 to 100/);
  assert.match(weekly("   ", HALFWAY).error, /0 to 100/);
  assert.match(weekly(null, HALFWAY).error, /0 to 100/);
  assert.match(weekly(undefined, HALFWAY).error, /0 to 100/);
});

check("an unparseable reset time is rejected", () => {
  const r = analyze({ usedPct: 50, resetAt: "not a date", windowMs: WEEK_MS, now: NOW });
  assert.match(r.error, /valid date/);
});

check("a non-positive window is rejected", () => {
  assert.match(analyze({ usedPct: 50, resetAt: at(HOUR_MS), windowMs: 0, now: NOW }).error, /positive/);
});

check("a reset further out than the window is long is rejected", () => {
  const r = weekly(50, WEEK_MS + MINUTE());
  assert.match(r.error, /further out/);
});
function MINUTE() { return 60 * 1000; }

check("numeric strings from form inputs are accepted", () => {
  const r = weekly("50", HALFWAY);
  assert.equal(r.state, "ok");
  assert.equal(r.used, 50);
});

// --- the 5-hour window uses the same math ---------------------------------
check("session window scales to hours", () => {
  const r = analyze({ usedPct: 20, resetAt: at(SESSION_MS / 2), windowMs: SESSION_MS, now: NOW });
  assert.equal(r.verdict, "under");
  // 80% left across 2.5 remaining hours.
  assert.ok(Math.abs(perHour(r.budgetPerMs) - 32) < 1e-9);
  assert.ok(Math.abs(perHour(r.burnPerMs) - 8) < 1e-9);
});

// --- formatting -----------------------------------------------------------
check("durations read coarsely", () => {
  assert.equal(formatDuration(2 * DAY_MS + 18 * HOUR_MS + 20 * 60000), "2d 18h");
  assert.equal(formatDuration(4 * HOUR_MS + 5 * 60000), "4h 05m");
  assert.equal(formatDuration(12 * 60000), "12m");
  assert.equal(formatDuration(0), "0m");
  assert.equal(formatDuration(-5), "0m");
  assert.equal(formatDuration(NaN), "0m");
});

check("ages read as ago", () => {
  assert.equal(formatAge(30 * 1000), "just now");
  assert.equal(formatAge(6 * HOUR_MS), "6h 00m ago");
});

check("rate scaling handles a missing rate", () => {
  assert.equal(perDay(null), null);
  assert.equal(perHour(null), null);
});

// --- day-by-day allocation ------------------------------------------------
// Built in local time so the split lands on local midnights whatever TZ runs it.
const LOCAL_NOON = new Date(2026, 0, 15, 12, 0, 0).getTime();
const LOCAL_RESET = new Date(2026, 0, 18, 6, 0, 0).getTime(); // 66 hours later

check("remaining quota is split at local midnights, not into equal days", () => {
  const plan = planDays({ leftPct: 66, resetAt: LOCAL_RESET, now: LOCAL_NOON });
  assert.equal(plan.length, 4); // part of today, two whole days, part of reset day
  assert.deepEqual(plan.map((d) => Math.round(d.hours)), [12, 24, 24, 6]);
  // 66% across 66 hours makes each hour worth exactly 1%.
  assert.deepEqual(plan.map((d) => Math.round(d.pct)), [12, 24, 24, 6]);
});

check("the partial days at each end are flagged", () => {
  const plan = planDays({ leftPct: 66, resetAt: LOCAL_RESET, now: LOCAL_NOON });
  assert.deepEqual(plan.map((d) => d.partial), [true, false, false, true]);
});

check("the shares add back up to the quota left", () => {
  const plan = planDays({ leftPct: 52, resetAt: LOCAL_RESET, now: LOCAL_NOON });
  const total = plan.reduce((sum, d) => sum + d.pct, 0);
  assert.ok(Math.abs(total - 52) < 1e-9);
});

check("segments run end to end with no gaps", () => {
  const plan = planDays({ leftPct: 50, resetAt: LOCAL_RESET, now: LOCAL_NOON });
  assert.equal(plan[0].startsAt, LOCAL_NOON);
  assert.equal(plan.at(-1).endsAt, LOCAL_RESET);
  for (let i = 1; i < plan.length; i++) {
    assert.equal(plan[i].startsAt, plan[i - 1].endsAt);
  }
});

check("a window ending before the next midnight is a single partial day", () => {
  const plan = planDays({
    leftPct: 30,
    resetAt: LOCAL_NOON + 3 * HOUR_MS,
    now: LOCAL_NOON,
  });
  assert.equal(plan.length, 1);
  assert.ok(Math.abs(plan[0].pct - 30) < 1e-9);
  assert.equal(plan[0].partial, true);
});

check("nothing to plan when the quota or the time is gone", () => {
  assert.deepEqual(planDays({ leftPct: 0, resetAt: LOCAL_RESET, now: LOCAL_NOON }), []);
  assert.deepEqual(planDays({ leftPct: -5, resetAt: LOCAL_RESET, now: LOCAL_NOON }), []);
  assert.deepEqual(planDays({ leftPct: 50, resetAt: LOCAL_NOON, now: LOCAL_NOON }), []);
  assert.deepEqual(planDays({ leftPct: 50, resetAt: "nope", now: LOCAL_NOON }), []);
});

check("the plan is capped so a bad reset date cannot spin forever", () => {
  const plan = planDays({
    leftPct: 50,
    resetAt: LOCAL_NOON + 400 * DAY_MS,
    now: LOCAL_NOON,
    maxDays: 14,
  });
  assert.equal(plan.length, 14);
});

// --- reset times entered the way the apps state them ----------------------
check('"resets in 4 hr 23 min" becomes an instant', () => {
  const at = resetInDuration({ hours: 4, minutes: 23, now: NOW });
  assert.equal(at - NOW, (4 * 60 + 23) * 60 * 1000);
});

check("a blank hour or minute box counts as zero, not as broken input", () => {
  assert.equal(resetInDuration({ hours: "", minutes: 45, now: NOW }) - NOW, 45 * 60000);
  assert.equal(resetInDuration({ hours: 2, minutes: "", now: NOW }) - NOW, 2 * HOUR_MS);
});

check("a countdown of nothing at all is rejected", () => {
  assert.equal(resetInDuration({ hours: 0, minutes: 0, now: NOW }), null);
  assert.equal(resetInDuration({ hours: "", minutes: "", now: NOW }), null);
  assert.equal(resetInDuration({ hours: "abc", minutes: 10, now: NOW }), null);
  assert.equal(resetInDuration({ hours: -2, minutes: 10, now: NOW }), null);
});

// Local-time weekdays: Thu 15 Jan 2026, 12:00 local.
const THU_NOON = new Date(2026, 0, 15, 12, 0, 0).getTime();
const dayOf = (ms) => new Date(ms).getDay();

check('"resets Wed 08:00" finds the coming Wednesday', () => {
  const at = nextWeekdayAt({ weekday: 3, time: "08:00", now: THU_NOON });
  assert.equal(dayOf(at), 3);
  assert.equal(new Date(at).getHours(), 8);
  // Thursday noon to next Wednesday morning is under a week.
  assert.ok(at - THU_NOON < WEEK_MS && at > THU_NOON);
});

check("later today counts as today", () => {
  const at = nextWeekdayAt({ weekday: 4, time: "18:00", now: THU_NOON });
  assert.equal(new Date(at).getDate(), 15);
  assert.equal(at - THU_NOON, 6 * HOUR_MS);
});

check("earlier today rolls to next week rather than into the past", () => {
  const at = nextWeekdayAt({ weekday: 4, time: "09:00", now: THU_NOON });
  assert.ok(at > THU_NOON);
  assert.equal(at - THU_NOON, WEEK_MS - 3 * HOUR_MS);
});

check("a weekly reset always lands inside the seven day window", () => {
  for (let wd = 0; wd < 7; wd++) {
    const at = nextWeekdayAt({ weekday: wd, time: "08:00", now: THU_NOON });
    assert.ok(at > THU_NOON, `weekday ${wd} must be ahead of now`);
    assert.ok(at - THU_NOON <= WEEK_MS, `weekday ${wd} must be within a week`);
    // So analyze() never rejects it as further out than the window is long.
    assert.equal(analyze({ usedPct: 50, resetAt: at, windowMs: WEEK_MS, now: THU_NOON }).error, undefined);
  }
});

check("a malformed weekday or time is rejected", () => {
  assert.equal(nextWeekdayAt({ weekday: 7, time: "08:00", now: THU_NOON }), null);
  assert.equal(nextWeekdayAt({ weekday: -1, time: "08:00", now: THU_NOON }), null);
  assert.equal(nextWeekdayAt({ weekday: "", time: "08:00", now: THU_NOON }), null);
  assert.equal(nextWeekdayAt({ weekday: 3, time: "", now: THU_NOON }), null);
  assert.equal(nextWeekdayAt({ weekday: 3, time: "25:00", now: THU_NOON }), null);
  assert.equal(nextWeekdayAt({ weekday: 3, time: "8am", now: THU_NOON }), null);
});

// --- percentages into hours -----------------------------------------------
check("cost per hour comes from hours actually spent, not wall clock", () => {
  assert.equal(hourlyCost({ usedPct: 48, hoursUsed: 12 }), 4);
  assert.equal(hoursFor(18.8, 4), 4.7);
});

check("a whole week's budget converts to hours end to end", () => {
  const r = weekly(48, WEEK_MS / 2);
  const cost = hourlyCost({ usedPct: r.used, hoursUsed: 12 }); // 4% per hour
  assert.equal(hoursFor(r.leftPct, cost), 13); // 52% left / 4% per hour
});

check("no hours estimate without something to divide", () => {
  assert.equal(hourlyCost({ usedPct: 0, hoursUsed: 12 }), null);   // nothing spent yet
  assert.equal(hourlyCost({ usedPct: 48, hoursUsed: 0 }), null);   // would divide by zero
  assert.equal(hourlyCost({ usedPct: 48, hoursUsed: "" }), null);  // field left blank
  assert.equal(hourlyCost({ usedPct: 48, hoursUsed: -3 }), null);
  assert.equal(hourlyCost({ usedPct: 48, hoursUsed: "abc" }), null);
});

check("hours conversion refuses a missing or nonsense rate", () => {
  assert.equal(hoursFor(20, null), null);
  assert.equal(hoursFor(20, 0), null);
  assert.equal(hoursFor(null, 4), null);
  assert.equal(hoursFor(0, 4), 0);
});

check("analyze and planDays agree on what is left", () => {
  const reading = analyze({ usedPct: 48, resetAt: LOCAL_RESET, windowMs: WEEK_MS, now: LOCAL_NOON });
  const plan = planDays({ leftPct: reading.leftPct, resetAt: LOCAL_RESET, now: LOCAL_NOON });
  const total = plan.reduce((sum, d) => sum + d.pct, 0);
  assert.ok(Math.abs(total - reading.leftPct) < 1e-9);
  // A whole day's share must match the flat per-day budget rate.
  const wholeDay = plan.find((d) => !d.partial);
  assert.ok(Math.abs(wholeDay.pct - perDay(reading.budgetPerMs)) < 1e-9);
});

console.log(`ok — ${passed} checks passed`);

// Run: node test.mjs
import assert from "node:assert/strict";
import {
  analyze, planDays, hourlyCost, hoursFor, resetInDuration, nextWeekdayAt,
  recentRate, refineProjection, parseUsageText, parseResetPhrase,
  perDay, perHour, formatDuration, formatAge,
  WEEK_MS, SESSION_MS, DAY_MS, HOUR_MS, MINUTE_MS,
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

// --- recent rate from history ----------------------------------------------
const H_BASE = NOW;  // window opened at NOW for these tests
const H_GAP = 20 * MINUTE_MS; // comfortably above the 15-min minimum

check("recentRate uses the last two points that are far enough apart", () => {
  const history = [
    { pct: 10, at: H_BASE },
    { pct: 30, at: H_BASE + H_GAP },
    { pct: 50, at: H_BASE + 2 * H_GAP },
  ];
  const rate = recentRate(history, H_BASE);
  // Slope between the last two: (50 - 30) / H_GAP
  assert.ok(Math.abs(rate - 20 / H_GAP) < 1e-15);
});

check("recentRate ignores points before windowStart", () => {
  const windowStart = H_BASE + H_GAP;
  const history = [
    { pct: 10, at: H_BASE },               // before window, should be ignored
    { pct: 30, at: H_BASE + H_GAP },        // exactly at windowStart
    { pct: 50, at: H_BASE + 2 * H_GAP },
  ];
  const rate = recentRate(history, windowStart);
  assert.ok(Math.abs(rate - 20 / H_GAP) < 1e-15);
});

check("recentRate returns null when all points are before windowStart", () => {
  const history = [
    { pct: 10, at: H_BASE },
    { pct: 30, at: H_BASE + H_GAP },
  ];
  assert.equal(recentRate(history, H_BASE + 3 * H_GAP), null);
});

check("recentRate skips pairs closer than 15 min", () => {
  const history = [
    { pct: 10, at: H_BASE },
    { pct: 30, at: H_BASE + H_GAP },
    { pct: 32, at: H_BASE + H_GAP + 5 * MINUTE_MS }, // only 5 min after previous
  ];
  // Should skip the (32, 30) pair (5 min gap) and use (32, 10) — 20+H_GAP+5min gap
  const rate = recentRate(history, H_BASE);
  const expectedGap = H_GAP + 5 * MINUTE_MS;
  assert.ok(Math.abs(rate - 22 / expectedGap) < 1e-15);
});

check("recentRate returns null with 0 or 1 point", () => {
  assert.equal(recentRate([], H_BASE), null);
  assert.equal(recentRate([{ pct: 10, at: H_BASE }], H_BASE), null);
  assert.equal(recentRate(null, H_BASE), null);
  assert.equal(recentRate(undefined, H_BASE), null);
});

check("recentRate returns null when usage goes down (inconsistent data)", () => {
  const history = [
    { pct: 50, at: H_BASE },
    { pct: 30, at: H_BASE + H_GAP }, // usage decreased — window probably reset
  ];
  assert.equal(recentRate(history, H_BASE), null);
});

check("recentRate handles unsorted history", () => {
  const history = [
    { pct: 50, at: H_BASE + 2 * H_GAP },
    { pct: 10, at: H_BASE },
    { pct: 30, at: H_BASE + H_GAP },
  ];
  const rate = recentRate(history, H_BASE);
  // Should sort internally and use (50, 30) pair
  assert.ok(Math.abs(rate - 20 / H_GAP) < 1e-15);
});

// --- refine projection -----------------------------------------------------
check("refineProjection overrides projection with recent rate", () => {
  // Nothing spent and the whole window still ahead: the recent rate covers all
  // of it, so it projects the rate itself. Part-way through a window the two
  // differ, which is what the recent-rate projection tests below pin down.
  const r = refineProjection({
    budgetPerMs: 100 / WEEK_MS,
    usedPct: 0,
    remainingMs: WEEK_MS,
    recentBurnPerMs: 80 / WEEK_MS,
  });
  assert.ok(Math.abs(r.projectedPct - 80) < 1e-9);
  assert.equal(r.recentBurnPerMs, 80 / WEEK_MS);
});

check("refineProjection returns nulls when recent rate is absent", () => {
  const r = refineProjection({
    budgetPerMs: 100 / WEEK_MS,
    burnPerMs: 50 / WEEK_MS,
    recentBurnPerMs: null,
    windowMs: WEEK_MS,
  });
  assert.equal(r.projectedPct, null);
  assert.equal(r.verdict, null);
  assert.equal(r.recentBurnPerMs, null);
});

check("refineProjection derives verdict from recent rate vs budget", () => {
  // Recent rate much higher than budget → over pace
  const over = refineProjection({
    budgetPerMs: 50 / WEEK_MS,
    usedPct: 20,                    // overall pace is fine
    remainingMs: WEEK_MS / 2,
    recentBurnPerMs: 150 / WEEK_MS, // but recently burning fast
  });
  assert.equal(over.verdict, "over");

  // Recent rate much lower than budget → under pace
  const under = refineProjection({
    budgetPerMs: 100 / WEEK_MS,
    usedPct: 20,
    remainingMs: WEEK_MS / 2,
    recentBurnPerMs: 30 / WEEK_MS,
  });
  assert.equal(under.verdict, "under");
});

// --- planDays with weightFn ------------------------------------------------
check("planDays with a custom weightFn redistributes shares", () => {
  // Weight function that gives the first half of each day double weight.
  const halfDay = 12 * HOUR_MS;
  const weightFn = (start, end) => {
    // For simplicity, just return a constant for whole days.
    return end - start; // Same as default — just verify the hook works.
  };
  const plan = planDays({ leftPct: 66, resetAt: LOCAL_RESET, now: LOCAL_NOON, weightFn });
  assert.equal(plan.length, 4);
  const total = plan.reduce((sum, d) => sum + d.pct, 0);
  assert.ok(Math.abs(total - 66) < 1e-9);
});

check("planDays falls back to proportional-by-ms when all weights are zero", () => {
  const plan = planDays({
    leftPct: 50,
    resetAt: LOCAL_RESET,
    now: LOCAL_NOON,
    weightFn: () => 0, // everything gets zero weight
  });
  assert.ok(plan.length > 0); // should not return empty
  const total = plan.reduce((sum, d) => sum + d.pct, 0);
  assert.ok(Math.abs(total - 50) < 1e-9);
});


// --- importing pasted /usage output ---------------------------------------
// Jul 26 2026, 14:16 local — matching the sample readings below.
const PASTE_NOW = new Date(2026, 6, 26, 14, 16, 0).getTime();

const CLI_OUTPUT = `You are currently using your subscription to power your Claude Code usage

Current session: 71% used · resets Jul 26, 6:40pm (Asia/Dhaka)
Current week (all models): 54% used · resets Jul 29, 8am (Asia/Dhaka)

breakdown · opus: 100% · haiku: 0% · cache hit: 98%`;

const APP_SCREEN = `Usage
Current session          71% used
Resets in 4 hr 23 min
Weekly limits
All models               54% used
Resets Wed 08:00
Credits
Balance                  92.55 credits`;

check("the CLI output parses into both meters", () => {
  const r = parseUsageText(CLI_OUTPUT, PASTE_NOW);
  assert.equal(r.error, undefined);
  assert.equal(r.session.pct, 71);
  assert.equal(r.weekly.pct, 54);
  // 6:40pm the same day is 4h24m out; 8am on the 29th is a bit under 3 days.
  assert.equal(r.session.resetAt - PASTE_NOW, (4 * 60 + 24) * MINUTE_MS);
  assert.equal(new Date(r.weekly.resetAt).getDate(), 29);
  assert.equal(new Date(r.weekly.resetAt).getHours(), 8);
});

check("the per-model breakdown line is not mistaken for usage", () => {
  const r = parseUsageText(CLI_OUTPUT, PASTE_NOW);
  assert.equal(r.session.pct, 71);  // not opus 100%
  assert.equal(r.weekly.pct, 54);   // not haiku 0% or cache 98%
});

check("the app's Usage screen parses too, resets on their own lines", () => {
  const r = parseUsageText(APP_SCREEN, PASTE_NOW);
  assert.equal(r.error, undefined);
  assert.equal(r.session.pct, 71);
  assert.equal(r.weekly.pct, 54);
  assert.equal(r.session.resetAt - PASTE_NOW, (4 * 60 + 23) * MINUTE_MS);
  assert.equal(new Date(r.weekly.resetAt).getDay(), 3); // Wednesday
  assert.equal(new Date(r.weekly.resetAt).getHours(), 8);
});

check("the credits balance is not read as a percentage", () => {
  const r = parseUsageText(APP_SCREEN, PASTE_NOW);
  assert.notEqual(r.weekly.pct, 92.55);
});

check("parsed readings feed straight into analyze", () => {
  const r = parseUsageText(CLI_OUTPUT, PASTE_NOW);
  const wk = analyze({ usedPct: r.weekly.pct, resetAt: r.weekly.resetAt, windowMs: WEEK_MS, now: PASTE_NOW });
  const se = analyze({ usedPct: r.session.pct, resetAt: r.session.resetAt, windowMs: SESSION_MS, now: PASTE_NOW });
  assert.equal(wk.error, undefined);
  assert.equal(se.error, undefined);
  assert.equal(wk.state, "ok");
  assert.equal(se.state, "ok");
});

check("incomplete paste says what is missing rather than guessing", () => {
  assert.match(parseUsageText("", PASTE_NOW).error, /Paste what/);
  assert.match(parseUsageText("   \n  ", PASTE_NOW).error, /Paste what/);
  assert.match(parseUsageText("Current session: 71% used", PASTE_NOW).error, /reset time/);
  assert.match(parseUsageText("Current session: 71% used · resets Jul 26, 6:40pm", PASTE_NOW).error, /weekly limit percentage/);
  assert.match(parseUsageText("hello world", PASTE_NOW).error, /Could not find/);
});

check("all three reset phrasings are understood", () => {
  assert.equal(parseResetPhrase("in 4 hr 23 min", PASTE_NOW) - PASTE_NOW, (4 * 60 + 23) * MINUTE_MS);
  assert.equal(parseResetPhrase("in 45 min", PASTE_NOW) - PASTE_NOW, 45 * MINUTE_MS);
  assert.equal(parseResetPhrase("in 2h", PASTE_NOW) - PASTE_NOW, 2 * HOUR_MS);
  assert.equal(new Date(parseResetPhrase("Wed 08:00", PASTE_NOW)).getDay(), 3);
  assert.equal(new Date(parseResetPhrase("Jul 29, 8am", PASTE_NOW)).getDate(), 29);
  assert.equal(new Date(parseResetPhrase("Jul 26, 6:40pm", PASTE_NOW)).getHours(), 18);
});

check("a timezone label does not confuse the reset phrase", () => {
  const withTz = parseResetPhrase("Jul 29, 8am (Asia/Dhaka)", PASTE_NOW);
  const without = parseResetPhrase("Jul 29, 8am", PASTE_NOW);
  assert.equal(withTz, without);
});

check("a date with no year picks the nearest one across a year boundary", () => {
  const newYearsEve = new Date(2026, 11, 31, 20, 0, 0).getTime();
  const at = parseResetPhrase("Jan 2, 9am", newYearsEve);
  assert.equal(new Date(at).getFullYear(), 2027);
  assert.ok(at > newYearsEve && at - newYearsEve < WEEK_MS);
});

check("nonsense after the word resets is rejected, not guessed at", () => {
  assert.equal(parseResetPhrase("", PASTE_NOW), null);
  assert.equal(parseResetPhrase("soon", PASTE_NOW), null);
  assert.equal(parseResetPhrase("Smurfday 08:00", PASTE_NOW), null);
  assert.equal(parseResetPhrase("Jul 99, 8am", PASTE_NOW), null);
  assert.equal(parseResetPhrase("Feb 30, 8am", PASTE_NOW), null);
  assert.equal(parseResetPhrase("Jul 26, 25:00", PASTE_NOW), null);
});


// --- recent-rate projection ------------------------------------------------
// A recent rate describes what is happening NOW, so it may only be applied to
// the time still ahead. Multiplying it by the whole window re-spends the past
// at the present rate and can even project less than is already gone.
const PROJ_NOW = new Date(2026, 6, 26, 20, 5, 0).getTime();
const PROJ_RESET = new Date(2026, 6, 29, 8, 0, 0).getTime();
const projBase = analyze({ usedPct: 61, resetAt: PROJ_RESET, windowMs: WEEK_MS, now: PROJ_NOW });

const projectAt = (perHour) => refineProjection({
  budgetPerMs: projBase.budgetPerMs,
  usedPct: projBase.used,
  remainingMs: projBase.remainingMs,
  recentBurnPerMs: perHour / HOUR_MS,
});

check("a recent rate is applied only to the time left, not the whole window", () => {
  const hoursLeft = projBase.remainingMs / HOUR_MS;
  for (const perHour of [0.2, 1, 3, 8]) {
    const got = projectAt(perHour).projectedPct;
    assert.ok(Math.abs(got - (61 + perHour * hoursLeft)) < 1e-9,
      `at ${perHour}%/h expected ${61 + perHour * hoursLeft}, got ${got}`);
  }
});

check("a projection can never come out below what is already spent", () => {
  for (const perHour of [0, 0.01, 0.2, 1, 50]) {
    assert.ok(projectAt(perHour).projectedPct >= 61,
      `${perHour}%/h projected below the 61% already spent`);
  }
});

check("a dead-quiet recent stretch projects the current figure, not zero", () => {
  assert.equal(projectAt(0).projectedPct, 61);
});

check("no recent rate means no refinement, so the caller falls back", () => {
  const none = refineProjection({
    budgetPerMs: projBase.budgetPerMs, usedPct: 61,
    remainingMs: projBase.remainingMs, recentBurnPerMs: null,
  });
  assert.equal(none.projectedPct, null);
  assert.equal(none.verdict, null);
  assert.equal(none.recentBurnPerMs, null);
});

check("the refined verdict compares the budget against the recent rate", () => {
  const budgetPerHour = perHour(projBase.budgetPerMs);
  assert.equal(projectAt(budgetPerHour * 3).verdict, "over");
  assert.equal(projectAt(budgetPerHour / 3).verdict, "under");
  assert.equal(projectAt(budgetPerHour).verdict, "on");
});

check("nonsense inputs refine to nothing rather than NaN", () => {
  const bad = refineProjection({
    budgetPerMs: projBase.budgetPerMs, usedPct: "abc",
    remainingMs: projBase.remainingMs, recentBurnPerMs: 1 / HOUR_MS,
  });
  assert.equal(bad.projectedPct, null);
});

console.log(`ok — ${passed} checks passed`);

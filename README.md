# Pace

### → [intelqong.github.io/claude-usage-pacer](https://intelqong.github.io/claude-usage-pacer/)

Work out how much Claude you can use each day to stay inside your **5-hour session**
limit and your **weekly** limit.

You run `/usage` in Claude Code, type the two percentages and their reset times in, and the
page tells you what you can spend per day for the rest of the week — split day by day, with
today and the reset day getting their correct partial shares.

**No account, no API key, no network calls, no analytics.** It is arithmetic on numbers you
type in. Your readings are kept in your browser's local storage and nowhere else.

---

## Use it

**Quickest:** run `/usage` in Claude Code and paste the whole output into the box at the top.
It reads out both percentages and both reset times for you.

Or fill the boxes by hand:

1. Run `/usage` in Claude Code, or open **Usage** in the Claude app.
2. Copy the two figures across. The reset boxes take them in the same shape those screens
   show them, so there is nothing to convert:

   | The app says | You type |
   |---|---|
   | Current session · 71% used · Resets in 4 hr 23 min | `71` · `4` hr `23` min |
   | All models · 54% used · Resets Wed 08:00 | `54` · `Wednesday` `08:00` |

3. Read your daily budget.

A countdown is only true at the moment you type it, so it is pinned to an actual instant on
submit. Reopen the form later and it restates what is left rather than replaying a stale
"4 hr 23 min".

That is the whole thing. Re-enter the numbers whenever you want a fresh reading — the page
keeps counting down on its own in between, but usage only ever goes up, so an old reading
flatters you. It says so when a reading gets stale.

## What it works out

For each window it knows the length (7 days, 5 hours), so the reset time also tells it when
the window opened:

```
windowStart = resetAt − windowLength
elapsed     = now − windowStart
remaining   = resetAt − now
```

From there:

| Figure | How |
|---|---|
| **Budget from here** | `(100 − used) / remaining` — what you can spend per day, or per hour on the session window |
| **Burned so far** | `used / elapsed` |
| **Verdict** | budget rate vs. burn rate, with 5% tolerance either side of level |

### Projections

"On track for X%" extrapolates forward. Two rates can drive it:

- the **average** since the window opened (`used ÷ elapsed`), used when there is only one reading
- a **recent** rate, measured between the last two readings at least 15 minutes apart

Either way the rate is applied only to the time **still ahead**, and added to what is already
spent: `projected = used + rate × remaining`. What has gone is banked and cannot be
re-forecast. (For the average rate this is algebraically the same as `used × window ÷ elapsed`;
for a recent rate it is not, and multiplying a recent rate by the whole window would re-spend
the past at the present rate — inflating a busy stretch and, after a quiet one, projecting a
total lower than what is already used.)

An hours-used count belongs to the week it was taken in, so it is dropped when the weekly
window rolls over rather than being paired with fresh percentages.

### Getting an answer in hours

Percentages do not convert to hours on their own. Elapsed wall-clock time cannot stand in for
hours of use, because most of a week is time you were not using Claude at all.

So there is one optional field: **roughly how many hours you have actually used this week**.
From that it works out what an hour costs you, and restates the budget in hours:

```
48% spent over about 12 hours   →  4% of the week per hour
18.9% a day                     →  about 4.7 hours a day
```

Leave it blank and everything stays in percentages. A rough count is fine, and the estimate
sharpens as the week goes on.

### Why the day-by-day split is not just "divide by days left"

A flat per-day figure is wrong at both ends of the week. Today is already part spent, and
the weekly window usually resets mid-morning rather than at midnight. So the remaining quota
is cut at **local midnights** and each day gets a share proportional to the hours it actually
contributes:

```
Today      Jul 26 · 10 hours              7.9%
Tomorrow   Jul 27 · 24 hours             18.8%
Tuesday    Jul 28 · 24 hours             18.8%
Wednesday  Jul 29 · 8h, resets 8:14 AM    6.5%
                                        ------
                                         52.0%   ← exactly what you had left
```

Splitting by elapsed time rather than by counting days also means a 23- or 25-hour daylight
saving day gets its share adjusted automatically.

### Flat or 3D

The day-by-day chart has a **Flat / 3D** switch. 3D stands each day up as a block seen from
above, built with CSS transforms — no library, no canvas. It is a second reading of the same
one number per day rather than extra information, so the rows underneath always stay put and
carry the actual figures; the switch only changes the chart. Your choice is remembered.

### The pace band

The track is the whole window, start to reset. The fill is what you have spent. The upright
mark is where a perfectly steady spender would be right now. The gap between them is your
slack — fill behind the mark means you are under pace.

## Run the tests

Pure logic lives in `pacer.js` with no DOM and no network, so it runs straight under Node:

```bash
node test.mjs
```

## Files

| File | Purpose |
|---|---|
| `index.html` | The page. Inline CSS and JS, no build step, no dependencies. |
| `pacer.js` | The maths: `analyze()`, `planDays()`, `hourlyCost()`, reset-time parsing, formatting helpers. |
| `test.mjs` | 68 assertions over the maths and its edge cases. |

## Hosting

Static files. Any host will do; this one is built for GitHub Pages — push to `main` and
serve from the repository root. There is nothing to configure and nothing to keep secret.

**One rule when changing `pacer.js`:** bump the `?v=` on its import in `index.html`. The page
loads it as an ES module, so a cached copy missing a newly added export throws on import and
the page renders nothing at all. The version query forces a fresh fetch.

## Caveats

- Percentages are what Claude Code reports. This tool never fetches them for you.
- Budgets assume you spend evenly from now until reset. Real usage is lumpy.
- The 5-hour window is a rolling session, so its reset time moves once a new session starts.

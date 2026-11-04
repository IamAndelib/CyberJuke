# Performance notes

What has been measured, what was deliberately left alone, and how to measure again. Read this
before optimising anything: the rule is to fix only what a person can feel.

## Tab switches (measured 4 Nov 2026, Preview 65)

Pixel 7 project in Chromium 141, CPU slowed 4× with CDP (`Emulation.setCPUThrottlingRate`),
Playwright tracing off, taps sent as CDP touch events. The library was seeded with the 720-post
Jukebox (about 420 artists, 160 genres), 300 likes, 600 plays, 6 playlists of 40 and 200 local
songs. Time is from pointerdown to the next frame shown after the click (Event Timing), median,
in ms at 4× (a real phone is about four times faster).

| Tab | First visit | Coming back |
|---|---|---|
| Home | mounted at start-up | 56 |
| Genres | 116 | 71 |
| Artists | 125 | 73 |
| Library | 91 | 54 |
| Radio | 107 | 51 |

- **Coming back** costs about 16 component renders and 2–6 ms of script. The rest is painting
  the revealed pane, which `content-visibility: hidden` throws away while it is hidden.
- **Two quick taps** (B 60 ms after A) never stack up: A's frame always paints first.
- **The tab buttons** call `selectTab` straight from `onClick`, with no `afterPress` hold.
- **Verdict:** already fluent. No change was made.

## Known and left alone

- **A list's first frame after coming back is empty.**
  - **When:** coming back to a tab or a covered page (Home, Liked and the other Library pages,
    Artists A–Z, Back from Search). The rows appear one frame later, about 30–50 ms at 4×.
  - **Cause:** rows with `content-visibility: auto` (`.list > .row`, `.az-section`,
    `.place-list > li`) in a pane coming back from `content-visibility: hidden`. Chrome draws them
    as skipped for one frame before deciding they are on screen.
  - **Fix if it's ever noticed:** always draw the first rows. Keep `contain-intrinsic-size` on
    `.list > .row` and move `content-visibility: auto` to `.list > .row:nth-child(n + 11)`. Do
    the same for the first 2 `.az-section`s and for `.place-list > li` in `search.css`. Measured
    with no cost elsewhere. A list scrolled past row 10 would still show one empty frame.
  - **Test for it:** count `contentvisibilityautostatechange` events on Liked in the frame after
    coming back. About 25 rows switch from skipped to shown today; with the fix, none should.
- **Grid tiles are container-query containers.**
  - **Cost:** every `.genre-cell` sizes its text with `cqi` (the `@supports (width: 1cqi)` block in
    `ui.css`). After the first Artists visit, the idle batches of 120 tiles cost 4 long tasks,
    262 ms in all at 4× over about a second. A tap in that second waits.
  - **Fix if it matters:** the grid is always 2 columns, so `100cqi` is `50vw − 24px`. Drop the
    block and use `font-size: clamp(13px, calc(6.25vw - 10px), 17px)` in `genres.css` (16px max in
    `artists.css`). Measured: 262 → 106 ms, and Genres' first frame 75 → 61 ms. Check landscape
    with `npm run screenshots`.

## Tried and not worth it

| Idea | Why not |
|---|---|
| Draw the tapped tab underneath on pointerdown | Removes every empty frame, but Artists and Genres coming back got slower (72 → 140–180 ms) |
| Mount every tab in idle time at start-up | Saves about 50 ms once per tab, but adds Artists' long tasks to start-up |
| Drop `content-visibility: auto` from rows | No empty frame, but +90–110 ms with a 530-row list (it paints everything) |
| Hide panes with `visibility: hidden` | Switches 1.5–2× slower, resize 48–60 ms instead of 29 |
| Drop `inert` on hidden panes | A hidden pane then catches taps: `inert` must stay |
| Build the artist index in idle time | About 20 ms once at 4× (about 5 ms on a phone) |

## Measuring again

- **Where to start:** `tests/e2e/perf.spec.ts`. It has the render counter (`installRenderCounter` in
  `src/app/main.tsx`) and CDP throttling.
- **Your own probe:** use a private port and build folder in `playwright.config.ts`, so it doesn't
  share a server with another run. Build without minifying (`vite build --minify false`) so
  profiles show component names.
- **Timing:** use Event Timing (`PerformanceObserver` with `type: 'event'`) for tap-to-frame. A
  rAF-plus-message timer reads high whenever other tasks are queued.
- **Load:** keep the machine otherwise idle. Under load the ranking held, but the numbers didn't.

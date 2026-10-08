# Student public API integration

Backend: `https://schools-bridge-admin.onrender.com`. The production student client uses this exact origin for every public API request; no localhost, legacy Render hostname, credential, or database access is used.

## Changes

- `bridge-client.js`: JSON-only public API client; no cookies, teacher credentials, or database access.
- `index.html`: loads the client before the existing application. No markup/style/content redesign.
- `app.js`: hooks gateway submission/resume, external game/vocabulary opens, worksheet views/print launches, reading opens/results, and assessment opens/results/retries.
- `app.js` / `bridge-client.js`: a shared, central cross-origin **game reporting bridge** (see below) so completion/score/certificate events from any external game/vocabulary activity can reach the backend under the SAME student who opened it, with no per-game code.
- Reading and assessment attempts report actual correct-answer counts and totals, percentage, and completed status even below the passing threshold. Original local stars, best scores, certificates, and completion rules are unchanged.
- Assessment attempts also report to `assessment/result` with verification/progress/mastery station keys for station-specific dashboard records. This is intentionally a separate record with a separate event ID from the generic activity result.
- Existing content IDs are the API activity keys (e.g. `book-picnic`, `st-checkpoint`). No invented numeric mappings.

## Identity and reliability — one independent record per student

The client keeps a **durable student roster** in `localStorage` (`bridge_roster`), one append-only entry per distinct `name + school`. Each entry owns its **own `visitor_id`**, so the server creates and keeps one independent, persistent student record per child:

- Registering a second child on the same device gives her a fresh `visitor_id` → her own server student. Nothing about the first child is rewritten, merged or removed.
- Coming back to a child later reuses her stored `visitor_id` and `submission_token` → the same server student is resumed, with her own history.
- Roster entries are append-only. Writes re-read `localStorage` and merge by key first, so a student registered in another tab is never dropped.
- The first student on a device adopts the pre-existing device visitor ID (`bridge_visitor_id`), so any server record already attached to that device stays attached to that child instead of being orphaned.
- The active student is a per-tab pointer into that roster, so another tab cannot swap the identity out from under an attempt already in flight. Attempts capture their owner at launch and keep it through retries, reloads and student switches.

On the site side (`app.js`), stars, completed activities, scores and certificates are namespaced per student (`sb_progress::<key>`, `sb_cert::<key>`). Switching students swaps the whole set, so one student's work can never overwrite or delete another's. Pre-existing single-student slots are carried over once into the first registered student's namespace; the originals are left in place.

Certificates and badges are reported through the **existing, documented `activity/result` contract** as their own events, with their own activity keys (`<key>-cert`, `badge-<id>`) and their own event IDs, so a certificate record can never overwrite the score record it came from. Award event IDs are deterministic **per persistent student identity** (for example `cert-<visitor-scope>-<key>-<score>`): a resend stores one record, an improved score is separate, and two students earning the same award never share an idempotency key.

Submitting the gateway form always requests identification, even when the name/school are unchanged, and an identity whose token is missing is re-identified on resume. The gateway does **not** show “registered successfully” until the backend has returned both `student_id` and `submission_token`; failure leaves the form open with a safe retry message. The browser's `navigator.onLine` hint is not used to suppress attempts; a wrong hint can no longer silently block submissions. Failed requests emit console diagnostics limited to endpoint, HTTP status, and error code (no names, schools, visitor IDs, tokens, or payloads).

Session queue persists reloads and offline reconnects **within the tab session**, not permanent tab closure. Storage-denied environments fall back to memory: application writes to sessionStorage/localStorage are guarded, and bridge-client reads/writes are guarded, so a storage exception cannot abort gateway submission or local activity. Result duplicate responses count as success; opened has no server idempotency key, so an ambiguous network failure can cause an opened retry to count twice. Retries are serialized; 429 delays are honored, server/network failures retry after 60 seconds, invalid 400 payloads are logged and removed. Calls time out after 20 seconds without blocking local activity.

The supplied backend contract uses the same visitor ID to resume the same server student, even when name/school are edited. This client cannot turn a shared-browser name edit into a separate server student without a backend-supported identity-switch contract. It does not invent one.

## Shared cross-origin game reporting bridge (fixes: open worked, completion/score/certificate did not)

**Confirmed symptom**: a real, already-registered student opened `game-comparisons` — the Teacher
Control Center correctly recorded "فتح نشاط — game-comparisons" — but her completion, real score
and earned certificate never arrived, even though she finished the game and saw a certificate.

**Root cause (three separate gaps, all inside this repository, all now fixed centrally)**:

1. Every connected game/vocabulary card was a native `<a target="_blank" rel="noopener noreferrer">`.
   Per the HTML living standard, `rel="noreferrer"` **implies `noopener` too**, so the new tab's
   `window.opener` was always `null`. Even a game that tries to call
   `window.opener.postMessage(...)` has no window object to call it on — the reply channel was
   structurally severed before a single byte of game code ever ran.
2. This page never had a single `window.addEventListener('message', …)` handler. Even a game that
   *could* reach back across origins had nothing on this side listening for it.
3. No code anywhere called `BridgeClient.result()`/`BridgeClient.certificate()` for a game. Those
   two functions existed and were already tested, but were wired only to the in-site reading
   quizzes and assessment stations — never to the external games grid. "فتح نشاط" worked only
   because the click handler calls `BridgeClient.start()` synchronously, before the browser
   navigates away, using the identity already active in this tab.

A local artifact (`server.py`, a same-origin iframe proxy for the Comparisons game, worked around
by a previous attempt because Arena games send `X-Frame-Options: SAMEORIGIN`) confirms a prior
attempt assumed *iframe* embedding. That proxy requires a Python process and **cannot run on
GitHub Pages** (100% static hosting) and was never wired into `app.js` — it is dead, non-production
code, left untouched here. The deployable fix for a statically-hosted site is a new tab with its
opener preserved, which is what this change implements.

**The fix** — one shared bridge, in `app.js`, used by every current and future game/vocabulary
activity that shares the exact same launch path (not special-cased to Comparisons):

- The native link markup keeps working with no JS (same `<a href>` navigation, same appearance),
  but drops `rel="noopener noreferrer"` in favor of `rel="opener"` + `referrerpolicy="no-referrer"`
  — the referrer is still hidden from the game, but `window.opener` now survives so a reply is
  physically possible. A plain click is intercepted to open the same URL through a JS `window.open`
  call (also without a `noopener` feature) so the attempt can be tracked; modified clicks
  (ctrl/cmd/shift/middle-click → new window/background tab) keep the browser's native, untouched
  behavior.
- `BridgeClient.start()` (open event, unchanged) now also registers the in-flight attempt
  (its captured student `owner`) in an in-memory map keyed by `origin + activityId`, both for the
  new-tab path and for the in-site iframe player (`openPlayer`/`g.play`, currently unused by any
  catalog entry but now wired identically) — reporting survives either context.
- One central `window.addEventListener('message', …)` validates the sender's `event.origin`
  against the exact set of origins already present in the `games`/`vocabulary` catalog (anything
  else is ignored — a stranger origin can never inject a fake result), matches the message to the
  attempt captured at THAT activity's own launch (a message for an activity never opened in this
  tab, or arriving after the owner changed, is ignored — it can never attach to another student or
  invent a result for nobody), and then calls the exact same, already-tested
  `BridgeClient.result()` / `BridgeClient.certificate(award, attempt.owner)` used by reading and
  assessment. `certificate()` now accepts an optional explicit owner so a certificate can never be
  attributed to "whichever student is active now" if the active student changed while the game tab
  was still open.
- The contract a cooperating game reports back with (new tab: `window.opener.postMessage`; iframe:
  `parent.postMessage`), targeting this site's origin:
  ```js
  { source: 'schools-bridge-game', activityId: 'game-comparisons', type: 'completed', score, maxScore }
  { source: 'schools-bridge-game', activityId: 'game-comparisons', type: 'certificate', score, title? }
  ```
  Unknown message shapes, unknown `type`s, non-finite scores, and messages for badges/onboarding
  are rejected/ignored with a diagnostic `console.warn` (never silently dropped, never scored as an
  achievement) — badges and onboarding remain unscored exactly as before.

**What this does and does not fix**: every structural gap inside this repository is now closed and
covered by tests (`tests/game-bridge.test.cjs`). Whether the *live* Comparisons game (a separate,
externally hosted, user-generated project — "Built with Arena · Content is user-generated and
unverified" per its own footer — not part of this repository and not inspectable from here; it
re-asks the student's name itself, confirming it has no existing integration with this site's
identity) actually calls `window.opener.postMessage(...)` with this contract when it finishes is
outside this repository's control. If it does not yet, this bridge is the receiving half that makes
it possible the moment the game's own code sends it — no further change would be needed on this
side. No backend change is required; the existing `activity/result` contract is reused as-is.

## Full-screen game viewer (branch `arena/44b6bed9-schools-bridge`)

Not yet merged. Production (`main`, GitHub Pages) is unchanged by this branch.

**What it does**

- `game-viewer.js` (new, loaded before `app.js`) provides `window.GameViewer`: a reusable full-screen overlay. A slim bar holds a clear **Back to Jisr Almadaris** control (Arabic + English on larger screens), an external-tab button, and a frame that fills the rest of the screen (dynamic viewport units, safe-area aware, no borders, no site menus). Back, Escape, and the browser's own game controls close or stop it; closing restores the exact scroll position and stops the game (`about:blank`).
- `app.js` `launchGame()` is the single entry point for every catalog game and vocabulary activity. It opens the viewer only when `GameViewer.launchMode()` returns `embed`; otherwise it keeps the original new-tab launch byte-for-byte (same URL, `target="_blank"`, same click interception and modified-click behaviour).
- **Default: every catalog entry is `embed:false`.** The 13 games (10 grammar games, 3 vocabulary activities) therefore keep opening in their own tab for every student. A game is switched to the viewer only by setting its `embed: true` after it has been verified (see below). Embedding is never forced on an unverified game.
- Verification switch: `?gameViewer=embed` on the site URL opens **every** game in the viewer for that visit only. It exists so the owner can test each game in a real browser before any `embed: true` is set. It does not change what students see by default.

**Reporting rules (changed in this branch)**

- Opening a game (or the viewer) is still reported as `activity/opened`. It is **never** a completion: it grants no star, unlocks no `learn` / `vocab-star` badge, and does not count as an activity. Previously a visit granted one local star and could unlock those badges, which reported them to the Teacher Control Center as achievements. This is the one intended change to existing local scoring; please confirm it.
- A completion counts only when the game sends the `completed` message (below). Its stars and the achievement count come from that message only (`SB.progress.gameDone`).
- A `certificate` message is accepted only if this same attempt already sent a passing completion (≥ 80%, the same 80% rule the site uses for its own certificates) and the certificate score is 80–100. Otherwise it is rejected and logged (`certificate_without_passing_completion`, `invalid_certificate_score`), and nothing is reported.
- When a game runs in the viewer, its replies are accepted only from the launched iframe (`event.source === iframe.contentWindow`). A message from any other window is ignored (`source_mismatch`).
- Completion scores must be finite, `maxScore > 0`, and `0 ≤ score ≤ maxScore`.
- Nothing is shown to students about reporting: no toast, no visible text. Diagnostics are `console.warn` only.

**What a game must send** (unchanged contract; new in-viewer case noted)

```js
// Embedded in the viewer:  parent.postMessage(msg, 'https://jisr-almadaris.github.io')
// Opened in a new tab:     window.opener.postMessage(msg, 'https://jisr-almadaris.github.io')
{ source: 'schools-bridge-game', activityId: 'game-comparisons', type: 'completed', score, maxScore }
{ source: 'schools-bridge-game', activityId: 'game-comparisons', type: 'certificate', score, title? }
```
Send `completed` first, and only when the student has genuinely finished. Send `certificate` only after a passing completion.

**How to verify a game and enable it** (owner, in a normal browser on the production origin)

1. Open the site with `?gameViewer=embed` and register a test student.
2. Open the game. Confirm it plays inside the viewer, fills the screen, sounds and animations work, and the Back button returns to the site.
3. Finish the game. Confirm the stars on the card and the Teacher Control Center record for that student (score and, if earned, the certificate).
4. If the game refuses to display (the browser shows a refusal inside the frame), **do not enable it**. Keep `embed:false`; the external tab remains the correct experience.
5. Only for games that pass 2–3, change that catalog entry to `embed: true` in `app.js`.

**Tests**

```sh
node --check game-viewer.js && node --check app.js
node --test tests/*.test.cjs            # 72 tests: bridge, students, game bridge, game viewer
SITE_URL=http://localhost:8080 CHROME_PATH=/path/to/chrome PUPPETEER_MODULE=puppeteer-core \
  node tests/e2e/game-viewer.e2e.mjs    # real headless browser: 50 checks, mobile + desktop
```
The browser test serves a scripted stand-in for each game through request interception on the real arena.site URLs and intercepts the Teacher API, so it writes nothing to any backend. It is not part of `node --test` (it needs a Chrome binary and `puppeteer-core`).

**Limits of this change**

- The 13 games are hosted on Arena (`*.arena.site`), outside this repository. This environment could not reach them, so **whether any game can be framed was not verified here**. The repository's earlier `server.py` note says Arena games send `X-Frame-Options: SAMEORIGIN`; if that is true for all of them, no game can be embedded without a change on the Arena side, and all 13 stay in external tabs.
- Embedded games are third-party to this site. Browsers may partition or block their storage (cookies, localStorage). A game that keeps its own progress across visits may behave differently inside the viewer, so check this during verification.
- The bridge is receive-only. No inspected game is known to send the contract messages; this could not be checked from here (the page-fetch tool returns rendered text, not game source).

**Rollback**

- The branch is not merged. To abandon it, close the PR without merging. `main` and GitHub Pages are unaffected.
- To revert after merge: `git revert <merge-commit>` on `main` (or revert the feature commit), push, and GitHub Pages republishes the previous version. No Supabase or backend records are touched by this change.
- Partial rollback without a revert: set every `embed:` flag to `false` in `app.js`. All games return to their original new-tab launch. Visit-star removal and certificate gating are not undone by this; revert the commit for those.
- Local progress is namespaced per student and nothing is deleted. Existing visit stars already stored on a device remain as they are.

## Limits that must not be misrepresented

- External game sources are not in this repository. The game-reporting bridge above covers the
  *receiving* half for every game/vocabulary activity; a game still has to call
  `window.opener.postMessage(...)` with the documented contract for completion/score/certificate to
  actually arrive. Internal activities are fully covered end-to-end: the reading quizzes and the
  three assessment stations report opens, completions, scores, certificates and badges with no
  external dependency.
- Worksheets are static images for viewing/printing. There is no worksheet submission, answer check, or completion signal. A view/print is reported as an open, never as a completed/scored worksheet.
- Backend catalog flags control score storage. Published catalog keys and `score_capture_supported` must match the existing frontend IDs before score visibility can be certified.
- Gateway validation requires a school and at least two name parts before a registration request is attempted. Backend rejection is surfaced as a safe retry state; the site no longer marks a local pass as registered when the server has not confirmed it.

## Verification

Run:

```sh
node --check bridge-client.js
node --check app.js
node --test tests/bridge-client.test.cjs   # 30 tests — public API contract
node --test tests/app-students.test.cjs    #  6 tests — per-student site storage
node --test tests/game-bridge.test.cjs     # 12 tests — shared cross-origin game reporting bridge
node --test tests/*.test.cjs               # 72 tests — full suite (incl. game viewer)
```

Tests mock the supplied HTTP contract, not the production database/dashboard. Cover payloads/auth, idempotency, token recovery, identity capture, offline replay/reload, retries, rate limiting, disabled API, storage failure, honest open-only tracking, independent multi-student records, shared-device switching, append-only rosters, cross-tab merge, per-student certificate/badge reporting, and (new) the shared game-reporting bridge: open uses the correct student, completion/score/certificate report for that same student, no duplicate student is ever created, a result cannot attach to a different student even if the active student changes mid-flight, an untracked/unknown-origin message is ignored, registration-only metrics and badges/onboarding stay unaffected, reporting survives both the new-tab and the in-site iframe-player launch context, API errors are logged rather than swallowed, and the fix is shared across games (proven with a second, unrelated game).

Live checks during implementation:
- Page-fetch GET `/api/public/activities` returned `Not Found`.
- Direct HTTPS OPTIONS to `/api/public/student/identify` failed with `curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL` before response headers. This does not establish a CORS rejection.
- No production student records were created. Production writes, dashboard display, and CORS are **unverified**.

## Before merge / real student test

1. Confirm the public API is deployed at the supplied host and paths.
2. Allow-list exactly `https://jisr-almadaris.github.io` in backend settings or `ALLOWED_ORIGINS` (no path or trailing slash). Frontend code cannot set the browser's Origin or fix backend CORS.
3. Verify OPTIONS returns that Access-Control-Allow-Origin with Content-Type and Authorization permitted.
4. Verify the backend catalog accepts scores for the six book keys and three assessment keys in app.js; no catalog/API changes were made here.
5. In a browser at the allowed origin, use a designated multi-word test name, register, launch a reading quiz and assessment, complete each, and inspect teacher dashboard records. Replay a result event ID to confirm one stored record. Test offline/reconnect.
6. Register a **second** student on the same device and confirm the teacher dashboard shows two separate students, each with her own history, and that the first student's records are unchanged.
6. Only after successful live verification merge the PR; GitHub Pages publishes main.

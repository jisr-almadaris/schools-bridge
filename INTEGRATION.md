# Student public API integration

Backend: `https://schools--bridge-admin.onrender.com`. Implements the user-supplied contract; backend source is not accessible to this session.

## Changes

- `bridge-client.js`: JSON-only public API client; no cookies, teacher credentials, or database access.
- `index.html`: loads the client before the existing application. No markup/style/content redesign.
- `app.js`: hooks gateway submission/resume, external game/vocabulary opens, worksheet views/print launches, reading opens/results, and assessment opens/results/retries.
- Reading and assessment attempts report actual correct-answer counts and totals, percentage, and completed status even below the passing threshold. Original local stars, best scores, certificates, and completion rules are unchanged.
- Assessment attempts also report to `assessment/result` with verification/progress/mastery station keys for station-specific dashboard records. This is intentionally a separate record with a separate event ID from the generic activity result.
- Existing content IDs are the API activity keys (e.g. `book-picnic`, `st-checkpoint`). No invented numeric mappings.

## Identity and reliability

A stable browser visitor ID is stored in localStorage. Identity/token and queued events are tab-scoped in sessionStorage, avoiding cross-tab token replacement. Attempts capture their owner at launch. Queue items retain that owner and result event ID through retries and reloads. Token recovery verifies that the returned student ID has not changed. Anonymous attempts and pre-existing local progress are not uploaded retroactively.

Submitting the gateway form always requests identification, even when the name/school are unchanged, and an identity whose token is missing is re-identified on resume. The browser's `navigator.onLine` hint is not used to suppress attempts; a wrong hint can no longer silently block submissions. Failed requests emit console diagnostics limited to endpoint, HTTP status, and error code (no names, schools, visitor IDs, tokens, or payloads).

Session queue persists reloads and offline reconnects **within the tab session**, not permanent tab closure. Storage-denied environments fall back to memory: application writes to sessionStorage/localStorage are guarded, and bridge-client reads/writes are guarded, so a storage exception cannot abort gateway submission or local activity. Result duplicate responses count as success; opened has no server idempotency key, so an ambiguous network failure can cause an opened retry to count twice. Retries are serialized; 429 delays are honored, server/network failures retry after 60 seconds, invalid 400 payloads are logged and removed. Calls time out after 20 seconds without blocking local activity.

The supplied backend contract uses the same visitor ID to resume the same server student, even when name/school are edited. This client cannot turn a shared-browser name edit into a separate server student without a backend-supported identity-switch contract. It does not invent one.

## Limits that must not be misrepresented

- External game sources are not in this repository and expose no result callback here. Launches are reported; completion/scores cannot be observed.
- Worksheets are static images for viewing/printing. There is no worksheet submission, answer check, or completion signal. A view/print is reported as an open, never as a completed/scored worksheet.
- Backend catalog flags control score storage. Published catalog keys and `score_capture_supported` must match the existing frontend IDs before score visibility can be certified.
- Existing gateway validation allows one-word names, whereas the backend requires two words. To preserve the requested unchanged student experience, backend rejection remains silent and local activity continues. Use a full, multi-word name for the real test.

## Verification

Run:

```sh
node --check bridge-client.js
node --check app.js
node --test tests/bridge-client.test.cjs
```

Tests mock the supplied HTTP contract, not the production database/dashboard. Cover payloads/auth, idempotency, token recovery, identity capture, offline replay/reload, retries, rate limiting, disabled API, storage failure, and honest open-only tracking.

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
6. Only after successful live verification merge the PR; GitHub Pages publishes main.

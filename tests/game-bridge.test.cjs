/* Shared cross-origin GAME REPORTING BRIDGE — proves the live bug fix.
   "فتح نشاط — game-comparisons" already worked before this fix; these tests
   cover what did NOT work: completion, real score, and certificate
   reporting for the SAME student who opened the game, for Comparisons and
   for every other game/vocabulary activity sharing the same bridge. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const store = () => { const m = new Map(); return {
  getItem: k => (m.has(k) ? m.get(k) : null),
  setItem: (k, v) => m.set(k, String(v)),
  removeItem: k => m.delete(k),
}; };

function makeEl() {
  const el = {
    innerHTML: '', textContent: '', value: '', hidden: false, disabled: false,
    style: {}, dataset: {}, children: [], parentElement: null,
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    setAttribute(){}, getAttribute(){ return null; }, removeAttribute(){},
    addEventListener(){}, removeEventListener(){}, appendChild(c){ el.children.push(c); return c; },
    remove(){}, closest(){ return null; }, contains(){ return false; }, focus(){}, scrollIntoView(){}, click(){},
    getBoundingClientRect(){ return { top:0, left:0, width:0, height:0, bottom:0, right:0 }; },
    querySelector(){ return makeEl(); }, querySelectorAll(){ return []; },
    insertAdjacentHTML(){}, getContext(){ return null; },
    offsetWidth: 0, offsetHeight: 0, clientWidth: 0, clientHeight: 0, scrollY: 0,
  };
  el.parentElement = { addEventListener(){} };
  return el;
}

function boot(shared = {}, fetchOverride = null) {
  const logs = [];
  const docListeners = {};
  const winListeners = {};
  const opens = [];
  const ctx = { calls: [],
    console: { warn: (...a) => logs.push(a.join(' ')), log(){}, error(){} },
    AbortController, Date, Math, JSON, setTimeout: () => 0, clearTimeout(){},
    setInterval: () => 0, clearInterval(){}, requestAnimationFrame: () => 0,
    performance: { now: () => 0 },
    navigator: { onLine: true },
    localStorage: shared.localStorage || store(),
    sessionStorage: shared.sessionStorage || store(),
    addEventListener: (name, fn) => { (winListeners[name] ||= []).push(fn); },
    removeEventListener(){},
    matchMedia: () => ({ matches: false, addEventListener(){}, addListener(){} }),
    IntersectionObserver: class { observe(){} unobserve(){} disconnect(){} },
    MutationObserver: class { observe(){} disconnect(){} },
    ResizeObserver: class { observe(){} disconnect(){} },
    Intl, URL, location: { href: 'https://jisr-almadaris.github.io/', hash: '', pathname: '/' },
    crypto: { randomUUID: () => 'u-' + Math.random().toString(36).slice(2, 10) },
    getComputedStyle: () => ({ getPropertyValue: () => '', setProperty(){} }),
    open: (url, target) => { opens.push({ url, target }); return { closed: false }; },
    fetch: async (url, opts) => {
      const body = JSON.parse(opts.body);
      ctx.calls.push({ url, headers: opts.headers, body });
      if (fetchOverride) return fetchOverride(url, opts, body);
      return { ok: true, status: 200, headers: { get: () => null },
        json: async () => (url.endsWith('student/identify')
          ? { ok: true, student_id: 'id-' + body.visitor_id, submission_token: 'tok-' + body.visitor_id }
          : { ok: true, stored: true }) };
    },
  };
  ctx.window = ctx;
  ctx.document = {
    documentElement: makeEl(), body: makeEl(),
    createElement: () => makeEl(),
    getElementById: () => makeEl(),
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    addEventListener: (name, fn) => { (docListeners[name] ||= []).push(fn); },
    removeEventListener(){},
  };
  vm.runInNewContext(fs.readFileSync('bridge-client.js', 'utf8'), ctx, { filename: 'bridge-client.js' });
  vm.runInNewContext(fs.readFileSync('game-viewer.js', 'utf8'), ctx, { filename: 'game-viewer.js' });
  vm.runInNewContext(fs.readFileSync('app.js', 'utf8'), ctx, { filename: 'app.js' });
  return { ctx, SB: ctx.SB, logs, calls: ctx.calls, docListeners, winListeners, opens };
}

const settle = () => new Promise(r => setImmediate(r));
const A = { name: 'مريم تجريبي', school: 'مدرسة الاختبار' };
const B = { name: 'طالبة أخرى', school: 'مدرسة الاختبار' };

function fireDocClick(docListeners, detail) {
  const event = Object.assign({
    button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  }, detail);
  for (const fn of (docListeners.click || [])) fn(event);
  return event;
}
function clickDestLink(docListeners, activityId, href, mods = {}) {
  const link = { dataset: { card: activityId }, href, querySelectorAll: () => [] };
  return fireDocClick(docListeners, Object.assign({ target: { closest: sel => (sel === '.dest-link' ? link : null) } }, mods));
}
function fireMessage(winListeners, msg) {
  for (const fn of (winListeners.message || [])) fn(msg);
}
const identifyVisitor = calls => calls.find(c => c.url.endsWith('/student/identify')).body.visitor_id;
const authFor = visitorId => 'Bearer tok-' + visitorId;

test('an existing registered student opening Comparisons reports the open event under her own identity', async () => {
  const { ctx, SB, calls, docListeners, opens } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  const game = SB.data.games.find(g => g.id === 'game-comparisons');
  const evt = clickDestLink(docListeners, 'game-comparisons', game.url);
  await settle();

  assert.equal(evt.defaultPrevented, true);               // native navigation replaced by a tracked window.open
  assert.equal(opens.length, 1);
  assert.equal(opens[0].url, game.url);                    // the real student still launches the real game
  const opened = calls.filter(c => c.url.endsWith('/activity/opened'));
  assert.equal(opened.length, 1);
  assert.equal(opened[0].body.activity_key, 'game-comparisons');
  assert.equal(opened[0].headers.Authorization, authFor(identifyVisitor(calls)));
});

test('Comparisons completion reports the real score for the SAME student that opened it', async () => {
  const { ctx, SB, calls, docListeners, winListeners } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  const game = SB.data.games.find(g => g.id === 'game-comparisons');
  const origin = new URL(game.url).origin;
  clickDestLink(docListeners, 'game-comparisons', game.url);
  await settle();
  const visitor = identifyVisitor(calls);

  fireMessage(winListeners, { origin, data: { source: 'schools-bridge-game', activityId: 'game-comparisons', type: 'completed', score: 9, maxScore: 10 } });
  await settle();

  const results = calls.filter(c => c.url.endsWith('/activity/result'));
  assert.equal(results.length, 1);
  assert.equal(results[0].body.activity_key, 'game-comparisons');
  assert.equal(results[0].body.activity_type, 'game');
  assert.equal(results[0].body.score, 9);
  assert.equal(results[0].body.max_score, 10);
  assert.equal(results[0].body.percentage, 90);
  assert.equal(results[0].body.completion_status, 'completed');
  assert.equal(results[0].headers.Authorization, authFor(visitor));     // same student who opened it
});

test('a certificate earned in Comparisons is persisted for the SAME student', async () => {
  const { ctx, SB, calls, docListeners, winListeners } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  const game = SB.data.games.find(g => g.id === 'game-comparisons');
  const origin = new URL(game.url).origin;
  clickDestLink(docListeners, 'game-comparisons', game.url);
  await settle();
  const visitor = identifyVisitor(calls);

  fireMessage(winListeners, { origin, data: { source: 'schools-bridge-game', activityId: 'game-comparisons', type: 'completed', score: 10, maxScore: 10 } });
  fireMessage(winListeners, { origin, data: { source: 'schools-bridge-game', activityId: 'game-comparisons', type: 'certificate', score: 95, title: 'Comparisons Certificate' } });
  await settle();

  const certs = calls.filter(c => c.url.endsWith('/activity/result') && c.body.activity_type === 'certificate');
  assert.equal(certs.length, 1);
  assert.equal(certs[0].body.activity_key, 'game-comparisons-cert');
  assert.equal(certs[0].body.score, 95);
  assert.equal(certs[0].headers.Authorization, authFor(visitor));
});

test('no duplicate student is created by completion/certificate messages', async () => {
  const { ctx, SB, calls, docListeners, winListeners } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  const identifiesBefore = calls.filter(c => c.url.endsWith('/student/identify')).length;
  const game = SB.data.games.find(g => g.id === 'game-comparisons');
  const origin = new URL(game.url).origin;
  clickDestLink(docListeners, 'game-comparisons', game.url);
  await settle();

  fireMessage(winListeners, { origin, data: { source: 'schools-bridge-game', activityId: 'game-comparisons', type: 'completed', score: 9, maxScore: 10 } });
  fireMessage(winListeners, { origin, data: { source: 'schools-bridge-game', activityId: 'game-comparisons', type: 'certificate', score: 88 } });
  await settle();

  assert.equal(SB.students.length, 1);
  const identifiesAfter = calls.filter(c => c.url.endsWith('/student/identify')).length;
  assert.equal(identifiesAfter, identifiesBefore);        // the already-identified student is resumed, never re-created
  const visitors = new Set(calls.map(c => c.body.visitor_id || null).filter(Boolean));
  assert.equal(visitors.size, 1);
});

test('a completion message cannot attach to a different student, even if the active student changed mid-flight', async () => {
  const { ctx, SB, calls, docListeners, winListeners } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  const game = SB.data.games.find(g => g.id === 'game-comparisons');
  const origin = new URL(game.url).origin;
  clickDestLink(docListeners, 'game-comparisons', game.url);
  await settle();
  const aVisitor = identifyVisitor(calls);

  SB.registerStudent(B);         // student B becomes "current" in this tab while A's game tab is still open
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();

  // 9/10 is a passing completion: a certificate must follow one (see tests/game-viewer.test.cjs).
  fireMessage(winListeners, { origin, data: { source: 'schools-bridge-game', activityId: 'game-comparisons', type: 'completed', score: 9, maxScore: 10 } });
  fireMessage(winListeners, { origin, data: { source: 'schools-bridge-game', activityId: 'game-comparisons', type: 'certificate', score: 80 } });
  await settle();

  const results = calls.filter(c => c.url.endsWith('/activity/result'));
  assert.equal(results.length, 2);
  for (const r of results) assert.equal(r.headers.Authorization, authFor(aVisitor));   // always A, never B
  assert.equal(SB.students.length, 2);                    // B is still her own independent student
});

test('a message for an activity never opened in this tab is ignored, not guessed at', async () => {
  const { ctx, SB, calls, winListeners, logs } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  const game = SB.data.games.find(g => g.id === 'game-comparisons');
  const origin = new URL(game.url).origin;
  // No click happened — nothing was ever opened/tracked for this origin+activity.
  fireMessage(winListeners, { origin, data: { source: 'schools-bridge-game', activityId: 'game-comparisons', type: 'completed', score: 10, maxScore: 10 } });
  await settle();
  assert.equal(calls.filter(c => c.url.endsWith('/activity/result')).length, 0);
  assert.ok(logs.some(l => l.includes('no tracked attempt')));
});

test('messages from an origin outside the games/vocabulary catalog are rejected', async () => {
  const { ctx, SB, calls, docListeners, winListeners } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  const game = SB.data.games.find(g => g.id === 'game-comparisons');
  clickDestLink(docListeners, 'game-comparisons', game.url);
  await settle();
  fireMessage(winListeners, { origin: 'https://evil.example', data: { source: 'schools-bridge-game', activityId: 'game-comparisons', type: 'completed', score: 10, maxScore: 10 } });
  await settle();
  assert.equal(calls.filter(c => c.url.endsWith('/activity/result')).length, 0);
});

test('registration-only metrics are unchanged: no game call happens unless a game is actually opened', async () => {
  const { ctx, SB, calls } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  assert.equal(calls.filter(c => c.url.endsWith('/activity/opened')).length, 0);
  assert.equal(calls.filter(c => c.url.endsWith('/activity/result')).length, 0);
});

test('badges/onboarding are never scored through the game bridge', async () => {
  const { ctx, SB, calls, docListeners, winListeners } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  const game = SB.data.games.find(g => g.id === 'game-comparisons');
  const origin = new URL(game.url).origin;
  clickDestLink(docListeners, 'game-comparisons', game.url);
  await settle();
  // An unrecognized/attempted "badge" style message must never be treated as scoring.
  fireMessage(winListeners, { origin, data: { source: 'schools-bridge-game', activityId: 'game-comparisons', type: 'badge', id: 'onboarding' } });
  await settle();
  assert.equal(calls.filter(c => c.url.endsWith('/activity/result')).length, 0);
  // A genuine completion reports as a "game", never as an "achievement".
  fireMessage(winListeners, { origin, data: { source: 'schools-bridge-game', activityId: 'game-comparisons', type: 'completed', score: 5, maxScore: 10 } });
  await settle();
  const results = calls.filter(c => c.url.endsWith('/activity/result'));
  assert.equal(results.length, 1);
  assert.equal(results[0].body.activity_type, 'game');
  assert.notEqual(results[0].body.activity_type, 'achievement');
});

test('reporting survives an iframe/in-site-player launch context, not only a new tab', async () => {
  const { SB, ctx, calls, winListeners } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  // Same allow-listed origin as game-comparisons, reached via the in-site
  // iframe player (openPlayer/g.play) instead of a new tab. openPlayer is a
  // top-level function declaration in app.js, so it is reachable on the same
  // realm object (ctx) the script ran in — exactly like window.openPlayer
  // would be reachable from a real page's global scope.
  const embedUrl = 'https://01a0cd6d-83ae-7de8-9b94-b5f56306d66f.arena.site/embed';
  const origin = new URL(embedUrl).origin;
  assert.equal(typeof ctx.openPlayer, 'function');
  ctx.openPlayer({ id: 'game-embed-test', title: 'Embed Test', play: embedUrl }, 'game');
  await settle();

  fireMessage(winListeners, { origin, data: { source: 'schools-bridge-game', activityId: 'game-embed-test', type: 'completed', score: 8, maxScore: 10 } });
  await settle();

  const results = calls.filter(c => c.url.endsWith('/activity/result'));
  assert.equal(results.length, 1);
  assert.equal(results[0].body.activity_key, 'game-embed-test');
  assert.equal(results[0].body.score, 8);
});

test('shared reporting works for another game using the same bridge (not special-cased to Comparisons)', async () => {
  const { ctx, SB, calls, docListeners, winListeners } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  const game = SB.data.games.find(g => g.id === 'game-possessives');
  assert.ok(game && game.url);
  const origin = new URL(game.url).origin;
  clickDestLink(docListeners, 'game-possessives', game.url);
  await settle();
  const visitor = identifyVisitor(calls);

  fireMessage(winListeners, { origin, data: { source: 'schools-bridge-game', activityId: 'game-possessives', type: 'completed', score: 4, maxScore: 5 } });
  fireMessage(winListeners, { origin, data: { source: 'schools-bridge-game', activityId: 'game-possessives', type: 'certificate', score: 85 } });
  await settle();

  const results = calls.filter(c => c.url.endsWith('/activity/result'));
  const score = results.find(r => r.body.activity_type === 'game');
  const cert = results.find(r => r.body.activity_type === 'certificate');
  assert.ok(score && cert);
  assert.equal(score.body.activity_key, 'game-possessives');
  assert.equal(cert.body.activity_key, 'game-possessives-cert');
  assert.equal(score.headers.Authorization, authFor(visitor));
  assert.equal(cert.headers.Authorization, authFor(visitor));
});

test('API errors from a tracked game completion are logged, never silently swallowed', async () => {
  const fetchOverride = async (url, opts, body) => {
    if (url.endsWith('student/identify')) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, student_id: 'id-' + body.visitor_id, submission_token: 'tok-' + body.visitor_id }) };
    }
    if (url.endsWith('activity/result')) {
      return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({ ok: false, error: 'server_error' }) };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, stored: true }) };
  };
  const { ctx, SB, calls, docListeners, winListeners, logs } = boot({}, fetchOverride);
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  const game = SB.data.games.find(g => g.id === 'game-comparisons');
  const origin = new URL(game.url).origin;
  clickDestLink(docListeners, 'game-comparisons', game.url);
  await settle();

  fireMessage(winListeners, { origin, data: { source: 'schools-bridge-game', activityId: 'game-comparisons', type: 'completed', score: 3, maxScore: 10 } });
  await settle();

  assert.ok(calls.some(c => c.url.endsWith('/activity/result')));       // the attempt WAS made, not dropped pre-flight
  assert.ok(logs.some(l => l.includes('Bridge submission')));           // the failure is surfaced, not swallowed
});

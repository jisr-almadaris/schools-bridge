/* Full-screen game viewer + game launch/reporting contract.
   Runs game-viewer.js and app.js in a VM with minimal DOM stubs. The overlay
   is replaced by a recording fake (ctx.GameViewer.open), so these tests cover
   launch decisions, identity, message binding, scoring, achievements and
   certificates. The visible overlay (size, Back button, closing) is covered by
   the real-browser test in tests/e2e/game-viewer.e2e.mjs. */
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

function boot(shared = {}) {
  const logs = [];
  const docListeners = {};
  const winListeners = {};
  const opens = [];
  const toasts = [];
  const viewerOpens = [];
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
    Intl, URL, URLSearchParams,
    location: { href: 'https://jisr-almadaris.github.io/', hash: '', pathname: '/', search: '' },
    crypto: { randomUUID: () => 'u-' + Math.random().toString(36).slice(2, 10) },
    getComputedStyle: () => ({ getPropertyValue: () => '', setProperty(){} }),
    open: (url, target) => { opens.push({ url, target }); return { closed: false }; },
    fetch: async (url, opts) => {
      const body = JSON.parse(opts.body);
      ctx.calls.push({ url, headers: opts.headers, body });
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

  // Replace only the visible overlay with a recorder. The real overlay is
  // exercised in the browser test; here we need the launch decision and the
  // iframe binding, not pixels.
  const frames = [];
  ctx.GameViewer.open = (activity, options) => {
    const contentWindow = { id: 'frame-' + frames.length };          // stands in for iframe.contentWindow
    const frame = { contentWindow };
    frames.push(frame);
    viewerOpens.push({ activity, url: options.url });
    return { frame, url: options.url };
  };
  ctx.toast = msg => toasts.push(msg);

  return { ctx, SB: ctx.SB, logs, calls: ctx.calls, docListeners, winListeners, opens, toasts, viewerOpens, frames };
}

const settle = () => new Promise(r => setImmediate(r));
const A = { name: 'مريم تجريبي', school: 'مدرسة الاختبار' };
const B = { name: 'طالبة أخرى', school: 'مدرسة الاختبار' };
const CATALOG = (SB) => [...SB.data.games, ...SB.data.vocabulary];

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
const contract = (activityId, type, extra = {}) => ({ source: 'schools-bridge-game', activityId, type, ...extra });
const identifyVisitor = calls => calls.find(c => c.url.endsWith('/student/identify')).body.visitor_id;
const authFor = visitorId => 'Bearer tok-' + visitorId;
const resultsOf = calls => calls.filter(c => c.url.endsWith('/activity/result'));

/* ---------------- 1. launch policy ---------------- */

test('every catalog game and vocabulary activity is explicitly marked embed:false by default', () => {
  const { SB } = boot();
  const list = CATALOG(SB);
  assert.equal(list.length, 13);                        // 10 grammar games + 3 vocabulary activities
  for (const activity of list) {
    assert.equal(activity.embed, false, activity.id + ' must not embed until verified');
    assert.match(activity.url, /^https:\/\/[0-9a-f-]+\.arena\.site\/$/, activity.id + ' URL must stay unchanged');
  }
});

test('launchMode is external for every catalog entry unless the verification switch is on', () => {
  const { ctx, SB } = boot();
  for (const activity of CATALOG(SB)) {
    assert.equal(ctx.GameViewer.launchMode(activity, { testMode: false }), 'external', activity.id);
  }
});

test('launchMode embeds only https activities explicitly flagged embeddable', () => {
  const { ctx } = boot();
  const lm = (a, o) => ctx.GameViewer.launchMode(a, o);
  assert.equal(lm({ url: 'https://x.arena.site/', embed: true }, {}), 'embed');
  assert.equal(lm({ url: 'https://x.arena.site/', embed: false }, {}), 'external');
  assert.equal(lm({ url: 'https://x.arena.site/' }, {}), 'external');           // flag absent
  assert.equal(lm({ url: 'http://x.arena.site/', embed: true }, {}), 'external'); // never plain http
  assert.equal(lm({ url: 'javascript:alert(1)', embed: true }, {}), 'external');
  assert.equal(lm({ embed: true }, {}), 'external');                              // no URL
  assert.equal(lm(null, {}), 'external');
});

test('the verification switch is exact: only ?gameViewer=embed enables embedding', () => {
  const { ctx } = boot();
  assert.equal(ctx.GameViewer.isTestMode('?gameViewer=embed'), true);
  assert.equal(ctx.GameViewer.isTestMode('?gameViewer=yes'), false);
  assert.equal(ctx.GameViewer.isTestMode('?gameViewer='), false);
  assert.equal(ctx.GameViewer.isTestMode(''), false);
  assert.equal(ctx.GameViewer.isTestMode(undefined), false);
});

test('default click on a connected game keeps the original new-tab launch (no viewer)', async () => {
  const { SB, docListeners, opens, viewerOpens, calls, ctx } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  const game = SB.data.games.find(g => g.id === 'game-comparisons');
  const evt = clickDestLink(docListeners, 'game-comparisons', game.url);
  await settle();
  assert.equal(evt.defaultPrevented, true);
  assert.equal(opens.length, 1);
  assert.equal(opens[0].url, game.url);                  // same URL as before
  assert.equal(opens[0].target, '_blank');
  assert.equal(viewerOpens.length, 0);
  const opened = calls.filter(c => c.url.endsWith('/activity/opened'));
  assert.equal(opened.length, 1);
  assert.equal(opened[0].headers.Authorization, authFor(identifyVisitor(calls)));
});

test('a verified game opens in the full-screen viewer with its catalog URL, not a new tab', async () => {
  const { SB, docListeners, opens, viewerOpens, calls, ctx, frames } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  const game = SB.data.games.find(g => g.id === 'game-comparisons');
  ctx.location.search = '?gameViewer=embed';
  clickDestLink(docListeners, 'game-comparisons', game.url);
  await settle();
  assert.equal(opens.length, 0);                        // no new tab
  assert.equal(viewerOpens.length, 1);
  assert.equal(viewerOpens[0].url, game.url);
  assert.equal(viewerOpens[0].activity.id, 'game-comparisons');
  const opened = calls.filter(c => c.url.endsWith('/activity/opened'));
  assert.equal(opened.length, 1);                       // the open is still reported, nothing else
  assert.equal(opened[0].body.activity_key, 'game-comparisons');
  assert.equal(opened[0].headers.Authorization, authFor(identifyVisitor(calls)));
  assert.equal(frames.length, 1);
});

/* ---------------- 2. identity ---------------- */

test('an embedded game reports under the student who launched it, even after a student switch', async () => {
  const { SB, docListeners, winListeners, calls, ctx, frames } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  const game = SB.data.games.find(g => g.id === 'game-comparisons');
  const origin = new URL(game.url).origin;
  ctx.location.search = '?gameViewer=embed';
  clickDestLink(docListeners, 'game-comparisons', game.url);
  await settle();
  const aVisitor = identifyVisitor(calls);

  SB.registerStudent(B);                                // B is now "current" while A plays
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();

  fireMessage(winListeners, { origin, source: frames[0].contentWindow, data: contract('game-comparisons', 'completed', { score: 9, maxScore: 10 }) });
  fireMessage(winListeners, { origin, source: frames[0].contentWindow, data: contract('game-comparisons', 'certificate', { score: 90 }) });
  await settle();

  const results = resultsOf(calls);
  assert.equal(results.length, 2);
  for (const r of results) assert.equal(r.headers.Authorization, authFor(aVisitor));
  assert.equal(SB.students.length, 2);                  // B is still her own independent student
});

/* ---------------- 3. message binding ---------------- */

test('a completion is accepted only from the iframe that was launched', async () => {
  const { SB, docListeners, winListeners, calls, ctx, frames, logs } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  const game = SB.data.games.find(g => g.id === 'game-comparisons');
  const origin = new URL(game.url).origin;
  ctx.location.search = '?gameViewer=embed';
  clickDestLink(docListeners, 'game-comparisons', game.url);
  await settle();

  const stranger = { id: 'some-other-window' };          // e.g. another window on the same origin
  fireMessage(winListeners, { origin, source: stranger, data: contract('game-comparisons', 'completed', { score: 10, maxScore: 10 }) });
  await settle();
  assert.equal(resultsOf(calls).length, 0);
  assert.ok(logs.some(l => l.includes('source_mismatch')));

  fireMessage(winListeners, { origin, source: frames[0].contentWindow, data: contract('game-comparisons', 'completed', { score: 10, maxScore: 10 }) });
  await settle();
  assert.equal(resultsOf(calls).length, 1);
});

test('a replayed completion is recorded once', async () => {
  const { SB, docListeners, winListeners, calls, ctx, frames } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  const game = SB.data.games.find(g => g.id === 'game-comparisons');
  const origin = new URL(game.url).origin;
  ctx.location.search = '?gameViewer=embed';
  clickDestLink(docListeners, 'game-comparisons', game.url);
  await settle();
  const msg = { origin, source: frames[0].contentWindow, data: contract('game-comparisons', 'completed', { score: 8, maxScore: 10 }) };
  fireMessage(winListeners, msg);
  fireMessage(winListeners, msg);
  fireMessage(winListeners, msg);
  await settle();
  assert.equal(resultsOf(calls).length, 1);
});

test('malformed completions are rejected: non-numeric, zero max, score above max, negative', async () => {
  const { SB, docListeners, winListeners, calls, ctx, frames, logs } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  const game = SB.data.games.find(g => g.id === 'game-comparisons');
  const origin = new URL(game.url).origin;
  clickDestLink(docListeners, 'game-comparisons', game.url);
  await settle();
  const src = frames.length ? frames[0].contentWindow : undefined;
  for (const bad of [
    { score: 'lots', maxScore: 10 }, { score: 5, maxScore: 0 }, { score: 12, maxScore: 10 }, { score: -1, maxScore: 10 }, { score: 5 },
  ]) {
    fireMessage(winListeners, { origin, source: src, data: contract('game-comparisons', 'completed', bad) });
  }
  await settle();
  assert.equal(resultsOf(calls).length, 0);
  assert.ok(logs.filter(l => l.includes('invalid_score')).length >= 5);
});

test('unknown message types never produce an award or a result', async () => {
  const { SB, docListeners, winListeners, calls, ctx, frames } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  const game = SB.data.games.find(g => g.id === 'game-comparisons');
  const origin = new URL(game.url).origin;
  ctx.location.search = '?gameViewer=embed';
  clickDestLink(docListeners, 'game-comparisons', game.url);
  await settle();
  for (const type of ['opened', 'achievement', 'progress', 'started']) {
    fireMessage(winListeners, { origin, source: frames[0].contentWindow, data: contract('game-comparisons', type, { score: 10, maxScore: 10 }) });
  }
  await settle();
  assert.equal(resultsOf(calls).length, 0);
});

/* ---------------- 4. scoring & achievements ---------------- */

test('opening a game is not a completion: no star, no achievement, no game result', async () => {
  const { SB, docListeners, calls, ctx, frames } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  const game = SB.data.games.find(g => g.id === 'game-comparisons');
  ctx.location.search = '?gameViewer=embed';
  clickDestLink(docListeners, 'game-comparisons', game.url);
  await settle();
  assert.ok(frames.length === 1);
  assert.equal(SB.stars('game-comparisons'), 0);
  assert.equal(Object.keys(SB.progress.gameDone || {}).length, 0);
  assert.equal(resultsOf(calls).length, 0);
});

test('a genuine completion sets the real stars and is recorded as completed', async () => {
  const { SB, docListeners, winListeners, ctx, frames } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  const game = SB.data.games.find(g => g.id === 'game-comparisons');
  const origin = new URL(game.url).origin;
  ctx.location.search = '?gameViewer=embed';
  clickDestLink(docListeners, 'game-comparisons', game.url);
  await settle();
  fireMessage(winListeners, { origin, source: frames[0].contentWindow, data: contract('game-comparisons', 'completed', { score: 9, maxScore: 10 }) });
  await settle();
  assert.equal(SB.stars('game-comparisons'), 3);       // 90% → 3 stars (unchanged rule)
  assert.equal(SB.progress.gameDone['game-comparisons'].score, 9);
});

test('a completion reports the real score and percentage for the same student', async () => {
  const { SB, docListeners, winListeners, calls, ctx, frames } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  const game = SB.data.games.find(g => g.id === 'game-possessives');
  const origin = new URL(game.url).origin;
  ctx.location.search = '?gameViewer=embed';
  clickDestLink(docListeners, 'game-possessives', game.url);
  await settle();
  const visitor = identifyVisitor(calls);
  fireMessage(winListeners, { origin, source: frames[0].contentWindow, data: contract('game-possessives', 'completed', { score: 4, maxScore: 5 }) });
  await settle();
  const [r] = resultsOf(calls);
  assert.equal(r.body.activity_key, 'game-possessives');
  assert.equal(r.body.activity_type, 'game');
  assert.equal(r.body.score, 4);
  assert.equal(r.body.max_score, 5);
  assert.equal(r.body.percentage, 80);
  assert.equal(r.body.completion_status, 'completed');
  assert.equal(r.headers.Authorization, authFor(visitor));
});

test('completion produces no student-facing toast or technical text', async () => {
  const { SB, docListeners, winListeners, ctx, frames, toasts } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  const game = SB.data.games.find(g => g.id === 'game-comparisons');
  const origin = new URL(game.url).origin;
  ctx.location.search = '?gameViewer=embed';
  clickDestLink(docListeners, 'game-comparisons', game.url);
  await settle();
  fireMessage(winListeners, { origin, source: frames[0].contentWindow, data: contract('game-comparisons', 'completed', { score: 10, maxScore: 10 }) });
  fireMessage(winListeners, { origin, source: frames[0].contentWindow, data: contract('game-comparisons', 'certificate', { score: 100 }) });
  await settle();
  assert.deepEqual(toasts, []);
});

/* ---------------- 5. certificates ---------------- */

test('a completion after a student switch reports to the launcher but never writes local progress to the new student', async () => {
  const { SB, docListeners, winListeners, calls, ctx, frames } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  const game = SB.data.games.find(g => g.id === 'game-comparisons');
  const origin = new URL(game.url).origin;
  ctx.location.search = '?gameViewer=embed';
  clickDestLink(docListeners, 'game-comparisons', game.url);
  await settle();
  const aVisitor = identifyVisitor(calls);
  SB.registerStudent(B);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  fireMessage(winListeners, { origin, source: frames[0].contentWindow, data: contract('game-comparisons', 'completed', { score: 10, maxScore: 10 }) });
  await settle();
  const [r] = resultsOf(calls);
  assert.equal(r.headers.Authorization, authFor(aVisitor));          // server: the launcher (A)
  assert.equal(SB.stars('game-comparisons'), 0);                     // local: nothing written to B
  assert.equal(Object.keys(SB.progress.gameDone || {}).length, 0);
});

test('a certificate with no prior completion is never reported', async () => {
  const { SB, docListeners, winListeners, calls, ctx, frames, logs } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  const game = SB.data.games.find(g => g.id === 'game-comparisons');
  const origin = new URL(game.url).origin;
  ctx.location.search = '?gameViewer=embed';
  clickDestLink(docListeners, 'game-comparisons', game.url);
  await settle();
  fireMessage(winListeners, { origin, source: frames[0].contentWindow, data: contract('game-comparisons', 'certificate', { score: 100 }) });
  await settle();
  assert.equal(resultsOf(calls).length, 0);
  assert.ok(logs.some(l => l.includes('certificate_without_passing_completion')));
});

test('a certificate needs a passing (80%+) completion of the same attempt', async () => {
  const { SB, docListeners, winListeners, calls, ctx, frames, logs } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  const game = SB.data.games.find(g => g.id === 'game-comparisons');
  const origin = new URL(game.url).origin;
  ctx.location.search = '?gameViewer=embed';
  clickDestLink(docListeners, 'game-comparisons', game.url);
  await settle();
  const src = frames[0].contentWindow;
  fireMessage(winListeners, { origin, source: src, data: contract('game-comparisons', 'completed', { score: 7, maxScore: 10 }) });
  fireMessage(winListeners, { origin, source: src, data: contract('game-comparisons', 'certificate', { score: 90 }) });
  await settle();
  assert.equal(resultsOf(calls).filter(r => r.body.activity_type === 'certificate').length, 0);
  assert.ok(logs.some(l => l.includes('certificate_without_passing_completion')));
});

test('a passing completion followed by a certificate reports the award for the same student', async () => {
  const { SB, docListeners, winListeners, calls, ctx, frames } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  const game = SB.data.games.find(g => g.id === 'game-comparisons');
  const origin = new URL(game.url).origin;
  ctx.location.search = '?gameViewer=embed';
  clickDestLink(docListeners, 'game-comparisons', game.url);
  await settle();
  const visitor = identifyVisitor(calls);
  fireMessage(winListeners, { origin, source: frames[0].contentWindow, data: contract('game-comparisons', 'completed', { score: 10, maxScore: 10 }) });
  fireMessage(winListeners, { origin, source: frames[0].contentWindow, data: contract('game-comparisons', 'certificate', { score: 95, title: 'Comparisons Certificate' }) });
  await settle();
  const certs = resultsOf(calls).filter(r => r.body.activity_type === 'certificate');
  assert.equal(certs.length, 1);
  assert.equal(certs[0].body.activity_key, 'game-comparisons-cert');
  assert.equal(certs[0].body.score, 95);
  assert.equal(certs[0].body.max_score, 100);
  assert.equal(certs[0].headers.Authorization, authFor(visitor));
  assert.equal(SB.students.length, 1);                  // no duplicate student
});

test('certificate scores outside 80–100 are rejected', async () => {
  const { SB, docListeners, winListeners, calls, ctx, frames, logs } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  const game = SB.data.games.find(g => g.id === 'game-comparisons');
  const origin = new URL(game.url).origin;
  ctx.location.search = '?gameViewer=embed';
  clickDestLink(docListeners, 'game-comparisons', game.url);
  await settle();
  const src = frames[0].contentWindow;
  fireMessage(winListeners, { origin, source: src, data: contract('game-comparisons', 'completed', { score: 10, maxScore: 10 }) });
  fireMessage(winListeners, { origin, source: src, data: contract('game-comparisons', 'certificate', { score: 79 }) });
  fireMessage(winListeners, { origin, source: src, data: contract('game-comparisons', 'certificate', { score: 101 }) });
  fireMessage(winListeners, { origin, source: src, data: contract('game-comparisons', 'certificate', { score: 'high' }) });
  await settle();
  assert.equal(resultsOf(calls).filter(r => r.body.activity_type === 'certificate').length, 0);
  assert.ok(logs.filter(l => l.includes('invalid_certificate_score')).length >= 3);
});

test('a certificate from a non-launched window is rejected even after a passing completion', async () => {
  const { SB, docListeners, winListeners, calls, ctx, frames, logs } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  const game = SB.data.games.find(g => g.id === 'game-comparisons');
  const origin = new URL(game.url).origin;
  ctx.location.search = '?gameViewer=embed';
  clickDestLink(docListeners, 'game-comparisons', game.url);
  await settle();
  fireMessage(winListeners, { origin, source: frames[0].contentWindow, data: contract('game-comparisons', 'completed', { score: 10, maxScore: 10 }) });
  fireMessage(winListeners, { origin, source: { id: 'other' }, data: contract('game-comparisons', 'certificate', { score: 95 }) });
  await settle();
  assert.equal(resultsOf(calls).filter(r => r.body.activity_type === 'certificate').length, 0);
  assert.ok(logs.some(l => l.includes('source_mismatch')));
});

/* ---------------- 6. unchanged surfaces ---------------- */

test('a closed viewer reports nothing: open + close is an open event only', async () => {
  const { SB, docListeners, calls, ctx } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  await settle();
  const game = SB.data.games.find(g => g.id === 'game-comparisons');
  ctx.location.search = '?gameViewer=embed';
  clickDestLink(docListeners, 'game-comparisons', game.url);
  await settle();
  assert.equal(calls.filter(c => c.url.endsWith('/activity/opened')).length, 1);
  assert.equal(resultsOf(calls).length, 0);
  assert.equal(calls.filter(c => c.body.activity_type === 'certificate').length, 0);
});

test('the viewer labels name the way back clearly in Arabic and English', () => {
  const { ctx } = boot();
  assert.match(ctx.GameViewer.labels.back, /العودة إلى جسر المدارس/);
  assert.equal(ctx.GameViewer.labels.backEn, 'Back to Jisr Almadaris');
});

test('the original player entry point still works for an explicit play URL', async () => {
  const { ctx, winListeners, calls, viewerOpens, frames } = boot();
  ctx.SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(ctx.SB.pass, { force: true });
  await settle();
  const embedUrl = 'https://01a0cd6d-83ae-7de8-9b94-b5f56306d66f.arena.site/embed';
  ctx.openPlayer({ id: 'game-embed-test', title: 'Embed Test', play: embedUrl }, 'game');
  await settle();
  assert.equal(viewerOpens.length, 1);
  assert.equal(viewerOpens[0].url, embedUrl);
  // Replies are bound to the launched iframe: a reply from elsewhere is ignored.
  fireMessage(winListeners, { origin: new URL(embedUrl).origin, source: { id: 'stranger' }, data: contract('game-embed-test', 'completed', { score: 8, maxScore: 10 }) });
  await settle();
  assert.equal(resultsOf(calls).length, 0);
  fireMessage(winListeners, { origin: new URL(embedUrl).origin, source: frames[0].contentWindow, data: contract('game-embed-test', 'completed', { score: 8, maxScore: 10 }) });
  await settle();
  assert.equal(resultsOf(calls).length, 1);
  assert.equal(resultsOf(calls)[0].body.activity_key, 'game-embed-test');
});

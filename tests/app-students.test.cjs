/* Smoke test for the shared-device student storage in app.js.
   Loads the real app.js against a minimal DOM shim and checks that two
   students registering on the same device keep independent progress,
   scores and certificates. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const store = () => { const m = new Map(); return {
  getItem: k => (m.has(k) ? m.get(k) : null),
  setItem: (k, v) => m.set(k, String(v)),
  removeItem: k => m.delete(k),
  _dump: () => Object.fromEntries(m),
}; };

function makeEl() {
  const el = {
    innerHTML: '', textContent: '', value: '', hidden: false, disabled: false,
    style: {}, dataset: {}, children: [], parentElement: null,
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    setAttribute(){}, getAttribute(){ return null; }, removeAttribute(){},
    addEventListener(){}, removeEventListener(){}, appendChild(c){ el.children.push(c); return c; },
    remove(){}, closest(){ return null; }, focus(){}, scrollIntoView(){}, click(){},
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
  const ctx = { calls: [],
    console: { warn: (...a) => logs.push(a.join(' ')), log: () => {}, error: () => {} },
    AbortController, Date, Math, JSON, setTimeout: () => 0, clearTimeout: () => {},
    setInterval: () => 0, clearInterval: () => {}, requestAnimationFrame: () => 0,
    performance: { now: () => 0 },
    navigator: { onLine: true },
    localStorage: shared.localStorage || store(),
    sessionStorage: shared.sessionStorage || store(),
    addEventListener: () => {}, removeEventListener: () => {},
    matchMedia: () => ({ matches: false, addEventListener(){}, addListener(){} }),
    IntersectionObserver: class { observe(){} unobserve(){} disconnect(){} },
    MutationObserver: class { observe(){} disconnect(){} },
    ResizeObserver: class { observe(){} disconnect(){} },
    Intl, URL, location: { href: 'https://example.test/', hash: '', pathname: '/' },
    crypto: { randomUUID: () => 'u-' + Math.random().toString(36).slice(2, 10) },
    getComputedStyle: () => ({ getPropertyValue: () => '', setProperty(){} }),
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
    addEventListener: () => {}, removeEventListener: () => {},
  };
  ctx.window.addEventListener('load', () => {});
  vm.runInNewContext(fs.readFileSync('bridge-client.js', 'utf8'), ctx, { filename: 'bridge-client.js' });
  vm.runInNewContext(fs.readFileSync('app.js', 'utf8'), ctx, { filename: 'app.js' });
  return { ctx, SB: ctx.SB, logs, calls: ctx.calls };
}

// Values created inside the vm realm have foreign prototypes; compare as plain JSON.
const plain = v => JSON.parse(JSON.stringify(v));

const A = { name: 'طالبة أولى', school: 'مدرسة النور' };
const B = { name: 'طالبة ثانية', school: 'مدرسة النور' };

test('app boots and exposes the student roster', () => {
  const { SB } = boot();
  assert.ok(Array.isArray(SB.students));
  assert.equal(SB.students.length, 0);
  assert.equal(SB.currentKey, null);
});

test('two students on one device keep independent progress and certificates', () => {
  const { SB, ctx } = boot();
  SB.registerStudent(A);
  SB.progress.stars = 7;
  SB.progress.done.push('book-picnic');
  SB.progress.scores = { 'st-checkpoint': 100 };
  SB.issueCertificate({ key: 'st-checkpoint', title: 'Station', score: 100 });
  SB.saveProgress();
  assert.equal(SB.cert.awards.length, 1);

  SB.registerStudent(B);
  assert.deepEqual(plain(SB.progress.done), []);
  assert.equal(SB.progress.stars, 0);
  assert.equal(SB.cert.awards.length, 0);
  SB.progress.stars = 3;
  SB.saveProgress();

  SB.registerStudent(A);
  assert.deepEqual(plain(SB.progress.done), ['book-picnic']);
  assert.equal(SB.progress.stars, 7);
  assert.equal(SB.progress.scores['st-checkpoint'], 100);
  assert.equal(SB.cert.awards.length, 1);

  SB.registerStudent(B);
  assert.equal(SB.progress.stars, 3);
  assert.equal(SB.cert.awards.length, 0);

  const roster = JSON.parse(ctx.localStorage.getItem('sb_students'));
  assert.equal(roster.length, 2);            // append-only, nobody was replaced
  assert.deepEqual(roster.map(s => s.name), [A.name, B.name]);
});

test('per-student state is namespaced in storage, legacy slots left intact', () => {
  const { ctx } = boot();
  ctx.localStorage.setItem('sb_progress', JSON.stringify({ stars: 42, done: ['book-sea'] }));
  const { SB } = boot({ localStorage: ctx.localStorage, sessionStorage: ctx.sessionStorage });
  SB.registerStudent(A);
  assert.equal(SB.progress.stars, 42);                    // carried over, not lost
  assert.ok(ctx.localStorage.getItem('sb_progress::' + SB.currentKey));
  assert.equal(ctx.localStorage.getItem('sb_progress'), JSON.stringify({ stars: 42, done: ['book-sea'] }));
});

test('registering a second student reports her own certificate, not the first one', () => {
  const { SB } = boot();
  SB.registerStudent(A);
  SB.issueCertificate({ key: 'st-mastery', title: 'Mastery', score: 90 });
  const firstCerts = plain(SB.cert.awards);
  SB.registerStudent(B);
  SB.issueCertificate({ key: 'st-mastery', title: 'Mastery', score: 85 });
  assert.equal(SB.cert.awards.length, 1);
  SB.registerStudent(A);
  assert.deepEqual(plain(SB.cert.awards), firstCerts);           // A's record untouched by B
});

test("each student's activity, certificate and badge are reported under her own identity", async () => {
  const { SB, ctx, calls } = boot();
  SB.registerStudent(A);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  SB.renderAll();                                     // the gateway submit path redraws the page
  SB.issueCertificate({ key: 'st-checkpoint', title: 'Station', score: 100 });
  SB.registerStudent(B);
  ctx.BridgeClient.setIdentity(SB.pass, { force: true });
  SB.renderAll();
  SB.issueCertificate({ key: 'st-checkpoint', title: 'Station', score: 80 });
  await new Promise(r => setImmediate(r));

  const results = calls.filter(c => c.url.endsWith('/activity/result'));
  const byToken = {};
  for (const c of results) (byToken[c.headers.Authorization] ||= []).push(c.body);
  const tokens = Object.keys(byToken);
  assert.equal(tokens.length, 2);                      // two independent server students
  for (const list of Object.values(byToken)) {
    assert.equal(list.filter(b => b.activity_type === 'certificate').length, 1);
    assert.equal(list.filter(b => b.activity_type === 'achievement').length >= 1, true);
  }
  const certs = results.filter(c => c.body.activity_type === 'certificate').map(c => c.body);
  assert.deepEqual(certs.map(c => c.score).sort((x, y) => x - y), [80, 100]);
  assert.equal(new Set(certs.map(c => c.activity_key)).size, 1);        // same activity
  assert.equal(new Set(certs.map(c => c.event_id)).size, 2);            // one record per student
});

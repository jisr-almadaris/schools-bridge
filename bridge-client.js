/* Public, write-only student API. No teacher credentials or cookies. */
(() => {
  'use strict';
  const API = 'https://schools-bridge-admin.onrender.com/api/public/';
  const uid = () => globalThis.crypto?.randomUUID?.() ||
    'ev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  const slug = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60) || 'x';
  const read = (store, key, fallback) => {
    try { return JSON.parse(window[store].getItem(key)) ?? fallback; } catch { return fallback; }
  };
  const write = (store, key, value) => {
    try { window[store].setItem(key, JSON.stringify(value)); } catch { /* local-only fallback */ }
  };

  /* ------------------------------------------------------------------
     Shared-device student roster
     One entry per distinct (name, school). Every entry owns its own
     visitor_id, so the server keeps ONE INDEPENDENT, PERSISTENT student
     record per child: registering a second child on the same device can
     never rewrite, merge into, or delete the first child's record, and
     returning to a child later resumes that same server student.
     Entries are append-only — nothing here ever removes a student.
     ------------------------------------------------------------------ */
  const ROSTER_KEY = 'bridge_roster';
  const TAB_KEY    = 'bridge_identity';
  const QUEUE_KEY  = 'bridge_queue';
  const LEGACY_KEY = 'bridge_visitor_id';
  const PATHS = ['student/identify', 'activity/opened', 'activity/result', 'assessment/result'];

  // Device id. Adopted by the first student on this device so pre-existing
  // server records stay attached to that child; later students get fresh ids.
  let visitor = read('localStorage', LEGACY_KEY, null);
  if (!visitor) { visitor = 'v-' + uid(); write('localStorage', LEGACY_KEY, visitor); }

  const studentKey = (name, school) => JSON.stringify([
    String(name || '').trim().replace(/\s+/g, ' ').toLowerCase(),
    String(school || '').trim().replace(/\s+/g, ' ').toLowerCase(),
  ]);

  const cleanRoster = list => (Array.isArray(list) ? list : []).filter(e =>
    e && typeof e.key === 'string' && typeof e.name === 'string' &&
    typeof e.school === 'string' && typeof e.visitor_id === 'string'
  ).map(e => ({
    key: e.key, name: e.name, school: e.school, visitor_id: e.visitor_id,
    student_id: e.student_id ?? null, token: e.token ?? null, lastUsed: e.lastUsed ?? null,
  }));

  let roster = cleanRoster(read('localStorage', ROSTER_KEY, []));

  const saveRoster = () => {
    // Re-read first: another tab may have registered a student while this page
    // was open. Merge by key so a concurrent registration is never dropped.
    for (const e of cleanRoster(read('localStorage', ROSTER_KEY, []))) {
      const mine = roster.find(x => x.key === e.key);
      if (!mine) roster.push(e);
      else if (!mine.token && e.token) { mine.token = e.token; mine.student_id = e.student_id; }
    }
    write('localStorage', ROSTER_KEY, roster);
  };

  // Per-tab pointer into the durable roster, so another tab cannot swap the
  // identity out from under an attempt that is already in flight.
  let current = null;
  const tab = read('sessionStorage', TAB_KEY, null);
  if (tab && typeof tab.key === 'string') current = roster.find(e => e.key === tab.key) || null;

  let queue = read('sessionStorage', QUEUE_KEY, []);
  if (!Array.isArray(queue)) queue = [];
  queue = queue.filter(item => item && PATHS.includes(item.path) && item.body &&
    item.owner && typeof item.owner.name === 'string' && typeof item.owner.school === 'string');
  // Re-bind queued owners to the durable roster entries after a reload.
  for (const item of queue) {
    const key = item.owner.key || studentKey(item.owner.name, item.owner.school);
    const entry = roster.find(e => e.key === key);
    if (entry) item.owner = entry;
    else if (typeof item.owner.visitor_id !== 'string') item.owner.visitor_id = visitor;
  }

  let busy = false, timer;
  const persist = () => {
    write('sessionStorage', TAB_KEY, current ? { key: current.key } : null);
    write('sessionStorage', QUEUE_KEY, queue);
  };
  const defer = ms => { clearTimeout(timer); timer = setTimeout(flush, ms); };
  async function call(path, body, token) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(API + path, {
        method: 'POST', credentials: 'omit', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok || data.ok !== true) {
        const retry = Number(res.headers.get('Retry-After')) || Number(data.retry_after_seconds) || 60;
        throw Object.assign(new Error(data.error || 'invalid_response'), { status: res.status, retry });
      }
      return data;
    } finally { clearTimeout(timeout); }
  }
  async function identify(owner) {
    const data = await call('student/identify', {
      full_name: owner.name, school: owner.school, visitor_id: owner.visitor_id || visitor
    });
    if (!data.student_id || !data.submission_token) throw new Error('invalid_identity_response');
    // Never replay an old student's attempt under a newly returned student id.
    if (owner.student_id && owner.student_id !== data.student_id) {
      throw Object.assign(new Error('identity_changed'), { status: 400 });
    }
    owner.student_id = data.student_id;
    owner.token = data.submission_token;
    const entry = roster.find(e => e.key === (owner.key || studentKey(owner.name, owner.school)));
    if (entry) { entry.student_id = data.student_id; entry.token = data.submission_token; }
    saveRoster();
  }
  async function flush() {
    // The browser's offline hint is unreliable (in-app browsers, proxies, sandboxes).
    // It must never suppress an attempt: fetch fails fast when truly offline and the
    // queued item is retried, so a wrong hint can no longer silently block submissions.
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const item = queue[0], owner = item.owner;
        try {
          if (!owner.token || item.path === 'student/identify') await identify(owner);
          if (item.path !== 'student/identify') {
            try { await call(item.path, item.body, owner.token); }
            catch (e) {
              if (![401, 403].includes(e.status)) throw e;
              await identify(owner);
              await call(item.path, item.body, owner.token);
            }
          }
          queue.shift(); persist();
        } catch (e) {
          // Safe diagnostics only: endpoint, HTTP status, and error code.
          // Never log names, schools, visitor IDs, tokens, or payload bodies.
          const status = Number.isFinite(e?.status) ? e.status : null;
          const reason = e?.name === 'AbortError' ? 'timeout' : (e?.message || 'network_error');
          if (e.status === 400) {
            console.warn('Bridge submission rejected:', item.path, status, reason);
            queue.shift(); persist(); continue;
          }
          console.warn('Bridge submission deferred:', item.path, status, reason);
          defer((e.status === 429 ? e.retry : 60) * 1000);
          break;
        }
      }
    } finally { busy = false; }
  }
  function enqueue(path, body, owner) {
    if (!owner) return; // No attribution of anonymous/historical work to a later identity.
    queue.push({ path, body, owner }); persist(); void flush();
  }

  /* Identify (or switch to) a student. Called on every gateway submission so a
     shared device can hand the site to the next child: the new name+school gets
     its own roster entry and its own server student record. */
  function setIdentity(pass, options) {
    if (!pass) return;
    const name = String(pass.name || '').trim(), school = String(pass.school || '').trim();
    if (!name || !school) return;
    const key = studentKey(name, school);
    let entry = roster.find(e => e.key === key);
    if (!entry) {
      const used = new Set(roster.map(e => e.visitor_id));
      entry = {
        key, name, school,
        visitor_id: used.has(visitor) ? 'v-' + uid() : visitor, // independent server student
        student_id: null, token: null, lastUsed: null,
      };
      roster.push(entry); // append-only: another student's record is never replaced or removed
    } else {
      entry.name = name; entry.school = school; // display text only — the identity is untouched
    }
    entry.lastUsed = new Date().toISOString();
    current = entry;
    saveRoster();
    persist();
    // An explicit form submission must request identification even when the
    // name/school are unchanged; an identity that lost its token must be
    // re-identified on resume.
    const force = options?.force === true;
    if (!entry.token || force) enqueue('student/identify', {}, entry);
    else void flush();
  }
  function start(activity, type) {
    const attempt = { owner: current, activity, type, event_id: uid(), submitted: false };
    enqueue('activity/opened', { activity_key: activity.id }, attempt.owner);
    return attempt;
  }
  function result(attempt, score, maxScore) {
    if (!attempt || attempt.submitted) return;
    attempt.submitted = true;
    enqueue('activity/result', {
      event_id: attempt.event_id, activity_key: attempt.activity.id,
      activity_title: attempt.activity.title || attempt.activity.name,
      activity_type: attempt.type, score, max_score: maxScore,
      percentage: Math.round(score / maxScore * 100),
      completion_status: 'completed', completed_at: new Date().toISOString()
    }, attempt.owner);
    const station = { 'st-checkpoint': 'verification', 'st-progress': 'progress', 'st-mastery': 'mastery' }[attempt.activity.id];
    if (attempt.type === 'assessment' && station) {
      enqueue('assessment/result', {
        event_id: uid(), station_key: station, score, max_score: maxScore,
        completed_at: new Date().toISOString()
      }, attempt.owner);
    }
  }
  /* Certificates and badges are reported through the same documented
     activity/result contract, as their own events with their own keys, so a
     certificate record can never overwrite the score record it came from. */
  function certificate(award) {
    const owner = current;
    if (!owner || !award || typeof award.score !== 'number') return;
    const key = slug(award.key), score = Math.round(award.score);
    enqueue('activity/result', {
      event_id: 'cert-' + key + '-' + score,
      activity_key: key + '-cert',
      activity_title: award.title || ('Certificate · ' + key),
      activity_type: 'certificate',
      score, max_score: 100, percentage: score,
      completion_status: 'completed', completed_at: new Date().toISOString()
    }, owner);
  }
  function achievement(badge) {
    const owner = current;
    if (!owner || !badge || !badge.id) return;
    const key = 'badge-' + slug(badge.id);
    enqueue('activity/result', {
      event_id: key, activity_key: key,
      activity_title: badge.name || badge.id,
      activity_type: 'achievement',
      score: 1, max_score: 1, percentage: 100,
      completion_status: 'completed', completed_at: new Date().toISOString()
    }, owner);
  }
  function listStudents() {
    return roster.map(e => ({ name: e.name, school: e.school, lastUsed: e.lastUsed }));
  }
  window.BridgeClient = { setIdentity, start, result, certificate, achievement, flush, listStudents };
  window.addEventListener('online', flush);
  defer(3000);
})();

/* Public, write-only student API. No teacher credentials or cookies. */
(() => {
  'use strict';

  // This is the only production API origin used by the student site.
  const API = 'https://schools-bridge-admin.onrender.com/api/public/';
  const uid = () => globalThis.crypto?.randomUUID?.() ||
    'ev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  const slug = value => String(value == null ? '' : value)
    .replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60) || 'x';
  const eventScope = owner => {
    // A deterministic, non-personal scope prevents two students who earn the
    // same award from sharing one idempotency key on a global event store.
    let hash = 2166136261;
    for (const char of String(owner?.visitor_id || '')) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  };
  const read = (store, key, fallback) => {
    try { return JSON.parse(window[store].getItem(key)) ?? fallback; } catch { return fallback; }
  };
  const write = (store, key, value) => {
    try { window[store].setItem(key, JSON.stringify(value)); } catch { /* local-only fallback */ }
  };

  /* ------------------------------------------------------------------
     Shared-device student roster
     One append-only entry per distinct name + school pair. Each entry gets
     its own visitor_id; a second child on the same device can never take over
     the first child's server identity or history.
     ------------------------------------------------------------------ */
  const ROSTER_KEY = 'bridge_roster';
  const TAB_KEY = 'bridge_identity';
  const QUEUE_KEY = 'bridge_queue';
  const LEGACY_KEY = 'bridge_visitor_id';
  const PATHS = ['student/identify', 'activity/opened', 'activity/result', 'assessment/result'];

  let visitor = read('localStorage', LEGACY_KEY, null);
  if (!visitor) { visitor = 'v-' + uid(); write('localStorage', LEGACY_KEY, visitor); }

  const studentKey = (name, school) => JSON.stringify([
    String(name || '').trim().replace(/\s+/g, ' ').toLowerCase(),
    String(school || '').trim().replace(/\s+/g, ' ').toLowerCase(),
  ]);
  const cleanRoster = list => (Array.isArray(list) ? list : []).filter(entry =>
    entry && typeof entry.key === 'string' && typeof entry.name === 'string' &&
    typeof entry.school === 'string' && typeof entry.visitor_id === 'string'
  ).map(entry => ({
    key: entry.key, name: entry.name, school: entry.school, visitor_id: entry.visitor_id,
    student_id: entry.student_id ?? null, token: entry.token ?? null, lastUsed: entry.lastUsed ?? null,
  }));

  let roster = cleanRoster(read('localStorage', ROSTER_KEY, []));
  const saveRoster = () => {
    // Merge a concurrent tab's new records before writing; nothing is removed.
    for (const entry of cleanRoster(read('localStorage', ROSTER_KEY, []))) {
      const mine = roster.find(candidate => candidate.key === entry.key);
      if (!mine) roster.push(entry);
      else if (!mine.token && entry.token) {
        mine.token = entry.token;
        mine.student_id = entry.student_id;
      }
    }
    write('localStorage', ROSTER_KEY, roster);
  };

  let current = null;
  const tab = read('sessionStorage', TAB_KEY, null);
  if (tab && typeof tab.key === 'string') current = roster.find(entry => entry.key === tab.key) || null;

  let queue = read('sessionStorage', QUEUE_KEY, []);
  if (!Array.isArray(queue)) queue = [];
  queue = queue.filter(item => item && PATHS.includes(item.path) && item.body && item.owner &&
    typeof item.owner.name === 'string' && typeof item.owner.school === 'string');
  for (const item of queue) {
    const key = item.owner.key || studentKey(item.owner.name, item.owner.school);
    const entry = roster.find(candidate => candidate.key === key);
    if (entry) item.owner = entry;
    else if (typeof item.owner.visitor_id !== 'string') item.owner.visitor_id = visitor;
  }

  let busy = false, timer;
  const persist = () => {
    write('sessionStorage', TAB_KEY, current ? { key: current.key } : null);
    write('sessionStorage', QUEUE_KEY, queue);
  };
  const defer = milliseconds => { clearTimeout(timer); timer = setTimeout(flush, milliseconds); };
  const safeCode = value => String(value || 'network_error')
    .replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'network_error';
  const logFailure = (kind, item, error) => {
    const status = Number.isFinite(error?.status) ? error.status : null;
    const code = error?.name === 'AbortError' ? 'timeout' : safeCode(error?.code || error?.message);
    // Do not include a payload, student details, visitor id, or bearer token.
    console.warn(`Bridge submission ${kind}:`, item.path, status, code);
  };
  const settle = (item, error) => {
    const waiter = item._waiter;
    if (!waiter) return;
    delete item._waiter;
    if (error) waiter.reject(error);
    else waiter.resolve({ student_id: item.owner.student_id, visitor_id: item.owner.visitor_id });
  };

  async function call(path, body, token) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(API + path, {
        method: 'POST', credentials: 'omit', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify(body)
      });
      let data;
      try { data = await response.json(); } catch {
        throw Object.assign(new Error('invalid_json_response'), { status: response.status });
      }
      if (!response.ok || data?.ok !== true) {
        const retry = Number(response.headers.get('Retry-After')) || Number(data?.retry_after_seconds) || 60;
        throw Object.assign(new Error(safeCode(data?.error || 'invalid_response')), {
          status: response.status, retry, code: safeCode(data?.error || 'invalid_response')
        });
      }
      return data;
    } finally { clearTimeout(timeout); }
  }

  async function identify(owner) {
    const data = await call('student/identify', {
      full_name: owner.name,
      school: owner.school,
      visitor_id: owner.visitor_id || visitor,
    });
    if (!data.student_id || !data.submission_token) {
      throw Object.assign(new Error('invalid_identity_response'), { code: 'invalid_identity_response' });
    }
    // An old attempt must never be replayed as a different server student.
    if (owner.student_id && owner.student_id !== data.student_id) {
      throw Object.assign(new Error('identity_changed'), { status: 400, code: 'identity_changed' });
    }
    owner.student_id = data.student_id;
    owner.token = data.submission_token;
    const entry = roster.find(candidate => candidate.key === (owner.key || studentKey(owner.name, owner.school)));
    if (entry) {
      entry.student_id = data.student_id;
      entry.token = data.submission_token;
    }
    saveRoster();
  }

  async function flush() {
    // navigator.onLine is only a hint and must not suppress a real request.
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const item = queue[0], owner = item.owner;
        try {
          if (!owner.token || item.path === 'student/identify') await identify(owner);
          if (item.path !== 'student/identify') {
            try { await call(item.path, item.body, owner.token); }
            catch (error) {
              if (![401, 403].includes(error.status)) throw error;
              await identify(owner);
              await call(item.path, item.body, owner.token);
            }
          }
          queue.shift();
          persist();
          settle(item);
        } catch (error) {
          const rejected = error?.status === 400;
          logFailure(rejected ? 'rejected' : 'deferred', item, error);
          settle(item, error); // Gateway callers receive an honest failure state.
          if (rejected) {
            queue.shift();
            persist();
            continue;
          }
          defer((error?.status === 429 ? error.retry : 60) * 1000);
          break;
        }
      }
    } finally { busy = false; }
  }

  function enqueue(path, body, owner, waitForConfirmation = false) {
    if (!owner) return waitForConfirmation
      ? Promise.reject(Object.assign(new Error('missing_student_identity'), { code: 'missing_student_identity' }))
      : undefined;
    const item = { path, body, owner };
    let confirmation;
    if (waitForConfirmation) {
      confirmation = new Promise((resolve, reject) => {
        // Non-enumerable: function references never enter sessionStorage.
        Object.defineProperty(item, '_waiter', { value: { resolve, reject }, configurable: true });
      });
    }
    queue.push(item);
    persist();
    void flush();
    return confirmation;
  }

  /* Called from the gateway. A caller that asks for confirmation gets a
     resolving Promise only after the backend has returned student_id + token.
     The form uses this to avoid claiming registration succeeded on failure. */
  function setIdentity(pass, options = {}) {
    if (!pass) return options.waitForConfirmation ? Promise.reject(new Error('missing_identity')) : undefined;
    const name = String(pass.name || '').trim();
    const school = String(pass.school || '').trim();
    if (!name || !school) return options.waitForConfirmation
      ? Promise.reject(Object.assign(new Error('invalid_identity'), { code: 'invalid_identity' }))
      : undefined;

    const key = studentKey(name, school);
    let entry = roster.find(candidate => candidate.key === key);
    if (!entry) {
      const usedVisitors = new Set(roster.map(candidate => candidate.visitor_id));
      entry = {
        key, name, school,
        visitor_id: usedVisitors.has(visitor) ? 'v-' + uid() : visitor,
        student_id: null, token: null, lastUsed: null,
      };
      roster.push(entry);
    } else {
      // Only presentation text changes; visitor_id and server identity do not.
      entry.name = name;
      entry.school = school;
    }
    entry.lastUsed = new Date().toISOString();
    current = entry;
    saveRoster();
    persist();

    if (!entry.token || options.force === true) {
      return enqueue('student/identify', {}, entry, options.waitForConfirmation === true);
    }
    void flush();
    return options.waitForConfirmation
      ? Promise.resolve({ student_id: entry.student_id, visitor_id: entry.visitor_id })
      : undefined;
  }

  function start(activity, type) {
    const attempt = { owner: current, activity, type, event_id: uid(), submitted: false };
    enqueue('activity/opened', { activity_key: activity.id }, attempt.owner);
    return attempt;
  }
  function result(attempt, score, maxScore) {
    if (!attempt || attempt.submitted || !Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0) return;
    attempt.submitted = true;
    enqueue('activity/result', {
      event_id: attempt.event_id,
      activity_key: attempt.activity.id,
      activity_title: attempt.activity.title || attempt.activity.name,
      activity_type: attempt.type,
      score,
      max_score: maxScore,
      percentage: Math.round(score / maxScore * 100),
      completion_status: 'completed',
      completed_at: new Date().toISOString(),
    }, attempt.owner);
    const station = { 'st-checkpoint': 'verification', 'st-progress': 'progress', 'st-mastery': 'mastery' }[attempt.activity.id];
    if (attempt.type === 'assessment' && station) {
      enqueue('assessment/result', {
        event_id: uid(), station_key: station, score, max_score: maxScore,
        completed_at: new Date().toISOString(),
      }, attempt.owner);
    }
  }
  function certificate(award) {
    const owner = current;
    if (!owner || !award || !Number.isFinite(award.score)) return;
    const key = slug(award.key), score = Math.round(award.score);
    enqueue('activity/result', {
      event_id: `cert-${eventScope(owner)}-${key}-${score}`,
      activity_key: key + '-cert',
      activity_title: award.title || ('Certificate · ' + key),
      activity_type: 'certificate',
      score, max_score: 100, percentage: score,
      completion_status: 'completed', completed_at: new Date().toISOString(),
    }, owner);
  }
  function achievement(badge) {
    const owner = current;
    if (!owner || !badge || !badge.id) return;
    const key = 'badge-' + slug(badge.id);
    enqueue('activity/result', {
      event_id: `${key}-${eventScope(owner)}`,
      activity_key: key,
      activity_title: badge.name || badge.id,
      activity_type: 'achievement',
      score: 1, max_score: 1, percentage: 100,
      completion_status: 'completed', completed_at: new Date().toISOString(),
    }, owner);
  }
  function listStudents() {
    return roster.map(entry => ({ name: entry.name, school: entry.school, lastUsed: entry.lastUsed }));
  }
  function isIdentityConfirmed(pass) {
    if (!pass) return false;
    const entry = roster.find(candidate => candidate.key === studentKey(pass.name, pass.school));
    return Boolean(entry?.student_id && entry?.token);
  }

  window.BridgeClient = {
    setIdentity, start, result, certificate, achievement, flush, listStudents, isIdentityConfirmed
  };
  window.addEventListener('online', flush);
  defer(3000);
})();

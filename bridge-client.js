/* Public, write-only student API. No teacher credentials or cookies. */
(() => {
  'use strict';
  const API = 'https://schools--bridge-admin.onrender.com/api/public/';
  const uid = () => globalThis.crypto?.randomUUID?.() ||
    'ev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  const read = (store, key, fallback) => {
    try { return JSON.parse(window[store].getItem(key)) ?? fallback; } catch { return fallback; }
  };
  const write = (store, key, value) => {
    try { window[store].setItem(key, JSON.stringify(value)); } catch { /* local-only fallback */ }
  };
  let visitor = read('localStorage', 'bridge_visitor_id', null);
  if (!visitor) { visitor = 'v-' + uid(); write('localStorage', 'bridge_visitor_id', visitor); }
  // Per-tab identity/queue prevents another tab from replacing an attempt's token.
  let current = read('sessionStorage', 'bridge_identity', null);
  let queue = read('sessionStorage', 'bridge_queue', []);
  if (!Array.isArray(queue)) queue = [];
  queue = queue.filter(item => item && typeof item.path === 'string' &&
    ['student/identify', 'activity/opened', 'activity/result', 'assessment/result'].includes(item.path) &&
    item.owner && typeof item.owner.name === 'string' && typeof item.owner.school === 'string' && item.body);
  if (current && (typeof current.name !== 'string' || typeof current.school !== 'string')) current = null;
  let busy = false, timer;
  const persist = () => {
    write('sessionStorage', 'bridge_identity', current);
    write('sessionStorage', 'bridge_queue', queue);
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
      full_name: owner.name, school: owner.school, visitor_id: visitor
    });
    if (!data.student_id || !data.submission_token) throw new Error('invalid_identity_response');
    // Never replay an old student's attempt under a newly returned student id.
    if (owner.student_id && owner.student_id !== data.student_id) {
      throw Object.assign(new Error('identity_changed'), { status: 400 });
    }
    owner.student_id = data.student_id;
    owner.token = data.submission_token;
    if (current?.key === owner.key) current = owner;
    for (const item of queue) if (item.owner.key === owner.key) item.owner = owner;
    persist();
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
  function setIdentity(pass, options) {
    if (!pass) return;
    const force = options?.force === true;
    const same = current?.name === pass.name && current?.school === pass.school;
    if (!same) current = { key: uid(), name: pass.name, school: pass.school };
    // An explicit form submission must request identification even when the name/school
    // are unchanged; an identity that lost its token must be re-identified on resume.
    if (same && current.token && !force) { void flush(); return; }
    enqueue('student/identify', {}, current);
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
  window.BridgeClient = { setIdentity, start, result, flush };
  window.addEventListener('online', flush);
  defer(3000);
})();

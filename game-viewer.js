/* ==========================================================================
   Jisr Almadaris — reusable FULL-SCREEN GAME VIEWER
   --------------------------------------------------------------------------
   Two responsibilities, kept deliberately separate:

   1. launchMode(activity, options) — a pure decision. A game opens inside
      the viewer ONLY when it is explicitly marked embeddable (`embed: true`
      in the catalog) or when the verification switch `?gameViewer=embed` is
      present. Everything else keeps the original external-tab behaviour.
      Embedding is never forced on a game that has not been verified.

   2. open()/close() — the full-screen overlay: a slim bar with a clear
      "Back to Jisr Almadaris" control, an external-tab fallback, and a
      frame that fills the remaining screen (no borders, no side menus).

   The viewer never touches student identity, scoring or reporting. The
   caller (app.js) owns the attempt, the owner and the bridge; the viewer
   only reports back which iframe it created so replies can be bound to it.
   ========================================================================== */
(function (global) {
  'use strict';

  const TEST_PARAM = 'gameViewer';
  const TEST_VALUE = 'embed';

  const LABELS = {
    back: 'العودة إلى جسر المدارس',
    backEn: 'Back to Jisr Almadaris',
    external: 'فتح في تبويب جديد',
    externalEn: 'Open in a new tab',
    loading: 'جاري فتح',
  };

  let root = null, frame = null, titleEl = null, backBtn = null, extBtn = null;
  let returnFocus = null, scrollY = 0, handlers = {}, active = null;

  /* ---------------- pure decisions (unit-tested) ---------------- */

  /* Absolute https URLs only. No base URL is used: an empty or relative value
     must never resolve to this site and be embedded by accident. */
  function httpsUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value.trim());
      return url.protocol === 'https:' ? url : null;
    } catch { return null; }
  }

  function isTestMode(search) {
    try { return new URLSearchParams(search || '').get(TEST_PARAM) === TEST_VALUE; }
    catch { return false; }
  }

  /* 'embed' only for an https catalog URL that is explicitly marked
     embeddable, or during an explicit verification session. Otherwise the
     game keeps its original external-tab launch. */
  function launchMode(activity, options = {}) {
    if (!activity || !httpsUrl(activity.url)) return 'external';
    if (options.testMode === true) return 'embed';
    return activity.embed === true ? 'embed' : 'external';
  }

  /* ---------------- DOM (built lazily, only when a game opens) ---------------- */

  const ICON_BACK = '<svg viewBox="0 0 48 48" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10l14 14-14 14"/></svg>';
  const ICON_EXT = '<svg viewBox="0 0 48 48" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10h18v18M38 10L18 30M14 14H8v24h24v-6"/></svg>';

  function ensure() {
    if (root) return root;
    root = document.createElement('div');
    root.id = 'gameViewer';
    root.className = 'gv';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.innerHTML = `
      <header class="gv-bar">
        <button type="button" class="gv-back" data-gv="back" aria-label="${LABELS.back} · ${LABELS.backEn}">
          ${ICON_BACK}
          <span class="gv-back-text">
            <b class="gv-back-ar">${LABELS.back}</b>
            <span class="gv-back-en" lang="en" dir="ltr">${LABELS.backEn}</span>
          </span>
        </button>
        <span class="gv-title" data-gv="title"></span>
        <a class="gv-ext" data-gv="external" href="#" target="_blank" rel="opener" referrerpolicy="no-referrer"
           aria-label="${LABELS.external} · ${LABELS.externalEn}" title="${LABELS.external}">${ICON_EXT}</a>
      </header>
      <main class="gv-stage">
        <div class="gv-loader" aria-hidden="true"><span class="gv-ring"></span><b data-gv="loading"></b></div>
        <iframe class="gv-frame" data-gv="frame" allow="fullscreen; autoplay; gamepad" allowfullscreen
                referrerpolicy="no-referrer"></iframe>
      </main>`;
    document.body.appendChild(root);
    frame = root.querySelector('[data-gv="frame"]');
    titleEl = root.querySelector('[data-gv="title"]');
    backBtn = root.querySelector('[data-gv="back"]');
    extBtn = root.querySelector('[data-gv="external"]');
    backBtn.addEventListener('click', close);
    // The external tab is launched by the caller so the attempt stays tracked.
    extBtn.addEventListener('click', e => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // native modified clicks
      e.preventDefault();
      if (handlers.onExternal) handlers.onExternal();
    });
    global.addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen()) close(); });
    return root;
  }

  function lockScroll(on) {
    const html = document.documentElement, body = document.body;
    if (on) {
      scrollY = global.scrollY || 0;
      html.classList.add('no-scroll');
      body.style.position = 'fixed';
      body.style.top = (-scrollY) + 'px';
      body.style.left = '0';
      body.style.right = '0';
    } else {
      html.classList.remove('no-scroll');
      body.style.position = '';
      body.style.top = '';
      body.style.left = '';
      body.style.right = '';
      // 'instant': the site's CSS sets scroll-behavior:smooth, which would
      // animate back and leave the page mid-way from where the game was opened.
      const restore = () => global.scrollTo({ top: scrollY, left: 0, behavior: 'instant' });
      restore();
      if (global.requestAnimationFrame) global.requestAnimationFrame(restore);
      setTimeout(restore, 60);
    }
  }

  function isOpen() { return Boolean(root && root.classList.contains('open')); }

  /* Opens the game full-screen. Returns { frame, url } for the caller to bind
     replies to this iframe, or null when the URL is not an https URL. */
  function open(activity, options = {}) {
    const url = httpsUrl(options.url || (activity && activity.url));
    if (!url) return null;
    ensure();
    if (isOpen()) close({ silent: true });
    active = activity;
    handlers = { onExternal: options.onExternal || null, onClose: options.onClose || null };
    returnFocus = document.activeElement || null;
    const title = (activity && (activity.title || activity.name)) || '';
    titleEl.textContent = title;
    frame.title = title;
    root.querySelector('[data-gv="loading"]').textContent = `${LABELS.loading} «${title}»…`;
    extBtn.setAttribute('href', url.href);
    root.classList.add('open', 'loading');
    lockScroll(true);
    frame.onload = () => root.classList.remove('loading');
    frame.src = url.href;
    backBtn.focus({ preventScroll: true });
    return { frame, url: url.href };
  }

  /* Closing stops the game (about:blank) and restores the page exactly. It
     reports nothing: closing a game is never a completion. */
  function close(options = {}) {
    if (!isOpen()) return;
    frame.onload = null;
    frame.src = 'about:blank';
    root.classList.remove('open', 'loading');
    lockScroll(false);
    const onClose = handlers.onClose;
    active = null;
    handlers = {};
    if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus({ preventScroll: true });
    if (!options.silent && onClose) onClose();
  }

  global.GameViewer = {
    launchMode, isTestMode, isOpen, open, close,
    frame: () => frame,
    activity: () => active,
    labels: LABELS,
    TEST_PARAM, TEST_VALUE,
  };
})(window);

/* Real-browser test for the full-screen game viewer.

   Runs the actual site in headless Chromium. Game pages are served through
   request interception on their REAL arena.site URLs, so the browser sees a
   genuine cross-origin iframe and genuine postMessage traffic. The Teacher
   API is intercepted too: nothing is written to any backend.

   Usage (not part of `node --test`):
     SITE_URL=http://localhost:8080 CHROME_PATH=/path/to/chrome \
       node tests/e2e/game-viewer.e2e.mjs
   Optional: SHOT_DIR=/some/dir (writes screenshots),
             PUPPETEER_MODULE=puppeteer-core (module specifier to load).
*/
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SITE = process.env.SITE_URL || 'http://localhost:8080';
const CHROME = process.env.CHROME_PATH;
const SHOT_DIR = process.env.SHOT_DIR || '';
const API = 'https://schools-bridge-admin.onrender.com/api/public/';
const FIXTURE = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-game.html'), 'utf8');
const VIEWPORTS = {
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { width: 1366, height: 860, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
};
const GAME_ID = 'game-comparisons';
const BLOCKED_ID = 'game-possessives';

if (!CHROME) { console.error('CHROME_PATH is required'); process.exit(2); }
let puppeteer;
try { puppeteer = (await import(process.env.PUPPETEER_MODULE || 'puppeteer-core')).default; }
catch { console.error('puppeteer-core is required (npm i puppeteer-core)'); process.exit(2); }

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = async (page, name) => { if (SHOT_DIR) { mkdirSync(SHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(SHOT_DIR, name) }); } };

async function newSession(browser, viewportName, { embedMode, blockedIds = [] }) {
  // A fresh, isolated browser context per session: no stored students or progress
  // carry over between scenarios.
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport(VIEWPORTS[viewportName]);
  const api = [];
  const games = new Map();          // real arena URL -> { id, blocked }
  await page.setRequestInterception(true);
  page.on('request', req => {
    const url = req.url();
    if (url.startsWith(API)) {
      if (req.method() === 'OPTIONS') {
        return req.respond({ status: 204, headers: cors() });
      }
      const body = JSON.parse(req.postData() || '{}');
      const p = url.slice(API.length);
      api.push({ path: p, body, auth: req.headers()['authorization'] || '' });
      const payload = p === 'student/identify'
        ? { ok: true, student_id: 'stu-' + body.visitor_id, submission_token: 'tok-' + body.visitor_id }
        : { ok: true, stored: true };
      return req.respond({ status: 200, contentType: 'application/json', headers: cors(), body: JSON.stringify(payload) });
    }
    if (games.has(url)) {
      const game = games.get(url);
      const html = FIXTURE.replaceAll('__ACTIVITY__', game.id);
      const headers = { 'Content-Type': 'text/html; charset=utf-8' };
      if (game.blocked) headers['X-Frame-Options'] = 'SAMEORIGIN';   // a game that refuses framing
      return req.respond({ status: 200, headers, body: html });
    }
    if (url.startsWith(SITE)) return req.continue();
    return req.abort();             // no other network (fonts, analytics) during the test
  });
  const popups = [];
  context.on('targetcreated', t => { if (t.type() === 'page') popups.push(t); });
  // Record what the site asked window.open to open (the popup's URL is not
  // reliable here because the test does not serve popup navigations).
  await page.evaluateOnNewDocument(() => {
    window.__opened = [];
    const original = window.open;
    window.open = function (url, target, features) { window.__opened.push({ url: String(url), target: target || '', features: features || '' }); return original.apply(this, arguments); };
  });
  await page.goto(SITE + '/' + (embedMode ? '?gameViewer=embed' : ''), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#passForm');
  // catalog → interception map (real URLs, unchanged)
  const catalog = await page.evaluate(() => [...SB.data.games, ...SB.data.vocabulary].map(g => ({ id: g.id, url: g.url, title: g.title })));
  for (const g of catalog) if (g.url) games.set(g.url, { id: g.id, blocked: blockedIds.includes(g.id) });
  return { page, api, popups, catalog, context };
}

async function register(page) {
  await page.type('#studentName', 'مريم أحمد');
  await page.type('#schoolName', 'مدرسة الاختبار');
  // Submit through the button's own click (the form is long; coordinate clicks
  // race with the page's scroll position). The submit path is the same.
  await page.$eval('#passForm button[type="submit"]', el => el.click());
  await page.waitForFunction(() => window.BridgeClient && window.BridgeClient.isIdentityConfirmed(SB.pass), { timeout: 15000 });
  await sleep(300);
}

const visitorFromApi = api => api.find(a => a.path === 'student/identify')?.body.visitor_id;

/* A real mouse click on the card: popups opened from it are user-initiated,
   exactly as a student's click would be. The site uses smooth scrolling and
   reveal animations, so we retry the positioning until the card's centre is
   on screen AND is the element a finger/mouse would actually hit. */
async function openCard(page, id) {
  const card = await page.$(`.dest-link[data-card="${id}"]`);
  if (!card) throw new Error('card missing: ' + id);
  let box = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    await card.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await sleep(260);
    box = await card.evaluate(el => {
      const r = el.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, inView: y > 0 && y < innerHeight, hitsCard: !!(hit && hit.closest('.dest-link[data-card="' + el.dataset.card + '"]')) };
    });
    if (box.inView && box.hitsCard) break;
  }
  if (!box || !box.inView || !box.hitsCard) throw new Error(`card not clickable: ${id} ${JSON.stringify(box)}`);
  const scrollAtClick = await page.evaluate(() => window.scrollY);
  await page.mouse.click(box.x, box.y);
  return scrollAtClick;
}

async function run() {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    for (const vp of Object.keys(VIEWPORTS)) {
      console.log(`\n=== ${vp} ===`);

      /* ---- A. default (no verification switch): original new-tab launch ---- */
      {
        const s = await newSession(browser, vp, { embedMode: false });
        await register(s.page);
        const before = s.popups.length;
        await openCard(s.page, GAME_ID);
        await sleep(600);
        const expected = s.catalog.find(g => g.id === GAME_ID).url;
        const calls = await s.page.evaluate(() => window.__opened);
        check(`[${vp}] default: game opens in a NEW TAB with its unchanged URL`,
          calls.length === 1 && calls[0].url === expected && calls[0].target === '_blank' && s.popups.length === before + 1,
          JSON.stringify(calls));
        check(`[${vp}] default: no in-site viewer is shown`, !(await s.page.$('#gameViewer.open')));
        const gameResults = s.api.filter(a => a.path === 'activity/result' && (a.body.activity_type === 'game' || a.body.activity_type === 'certificate'));
        const gameBadges = s.api.filter(a => a.path === 'activity/result' && /badge-(learn|vocab-star)/.test(a.body.activity_key || ''));
        check(`[${vp}] default: opening alone is recorded as opened, not completed`,
          s.api.filter(a => a.path === 'activity/opened').length === 1 && gameResults.length === 0 && gameBadges.length === 0,
          s.api.filter(a => a.path === 'activity/opened').length + ' opened');
        for (const t of s.popups.slice(before)) { try { const p = await t.page(); if (p) await p.close(); } catch {} }
        await s.page.close();
        await s.context.close();
      }

      /* ---- B. verified embedding: full-screen viewer + reporting ---- */
      const s = await newSession(browser, vp, { embedMode: true, blockedIds: [BLOCKED_ID] });
      const page = s.page;
      await register(page);
      const visitor = visitorFromApi(s.api);
      const expectedUrl = s.catalog.find(g => g.id === GAME_ID).url;

      await page.evaluate(() => window.scrollTo({ top: 500, behavior: 'instant' }));
      await sleep(150);
      const popupsBefore = s.popups.length;
      const scrollBefore = await openCard(page, GAME_ID);
      await page.waitForSelector('#gameViewer.open', { timeout: 5000 });
      const handle = await page.waitForSelector('#gameViewer iframe.gv-frame');
      const frame = await handle.contentFrame();
      await frame.waitForSelector('#finish', { timeout: 10000 });
      await sleep(400);

      check(`[${vp}] embed: game is shown in the viewer, not a new tab`, s.popups.length === popupsBefore);
      const src = await page.$eval('#gameViewer iframe.gv-frame', f => f.getAttribute('src'));
      check(`[${vp}] embed: iframe uses the unchanged catalog URL`, src === expectedUrl, src);

      const geo = await page.evaluate(() => {
        const bar = document.querySelector('#gameViewer .gv-bar').getBoundingClientRect();
        const fr = document.querySelector('#gameViewer iframe.gv-frame').getBoundingClientRect();
        return { vw: innerWidth, vh: innerHeight, bar: bar.height, fx: fr.x, fy: fr.y, fw: fr.width, fh: fr.height, fb: fr.bottom, fr: fr.right,
          doc: document.documentElement.scrollWidth, ov: document.querySelector('#gameViewer').getBoundingClientRect().height };
      });
      check(`[${vp}] fullscreen: the game fills the full width`, Math.abs(geo.fw - geo.vw) < 1 && geo.fx === 0, `${geo.fw}/${geo.vw}`);
      check(`[${vp}] fullscreen: the game reaches the bottom of the screen (no gap)`, Math.abs(geo.fb - geo.vh) < 1, `bottom ${geo.fb} vs ${geo.vh}`);
      check(`[${vp}] fullscreen: the slim bar is above the game, not overlapping it`, Math.abs(geo.fy - geo.bar) < 1, `bar ${geo.bar}, frame top ${geo.fy}`);
      check(`[${vp}] fullscreen: no horizontal overflow`, geo.doc <= geo.vw + 1, `${geo.doc}`);
      await shot(page, `viewer-${vp}.png`);

      const backText = await page.$eval('#gameViewer .gv-back', el => el.innerText.replace(/\s+/g, ' ').trim());
      const englishVisible = await page.$eval('#gameViewer .gv-back-en', el => getComputedStyle(el).display !== 'none');
      check(`[${vp}] back control names the site in Arabic${vp === 'desktop' ? ' and English' : ''}`,
        backText.includes('العودة إلى جسر المدارس') && (vp === 'mobile' ? !englishVisible : backText.includes('Back to Jisr Almadaris')), backText);
      const title = await page.$eval('#gameViewer .gv-title', el => el.textContent);
      const expectedTitle = s.catalog.find(g => g.id === GAME_ID).title;
      check(`[${vp}] title shows the activity name`, title === expectedTitle, title);

      /* completion + certificate from the embedded game */
      await (await frame.$('#finish')).click();
      await sleep(900);
      await (await frame.$('#cert')).click();
      await sleep(900);
      const results1 = s.api.filter(a => a.path === 'activity/result');
      const completed = results1.find(a => a.body.activity_type === 'game');
      const cert = results1.find(a => a.body.activity_type === 'certificate');
      check(`[${vp}] completion: real score reported for this student`,
        !!completed && completed.body.score === 9 && completed.body.max_score === 10 && completed.body.percentage === 90 && completed.body.completion_status === 'completed' && completed.body.activity_key === GAME_ID,
        completed ? `${completed.body.score}/${completed.body.max_score}` : 'none');
      check(`[${vp}] completion: reported under the same student who opened it`,
        !!completed && completed.auth === 'Bearer tok-' + visitor);
      check(`[${vp}] certificate: earned award reported as its own record`,
        !!cert && cert.body.activity_key === GAME_ID + '-cert' && cert.body.score === 90 && cert.auth === 'Bearer tok-' + visitor);
      const stars = await page.$$eval(`.dest[data-id="${GAME_ID}"] .dst.on`, els => els.length);
      check(`[${vp}] card shows the stars earned by the real completion`, stars === 3, `${stars}`);
      const toastShown = await page.$eval('#toast', el => el.classList.contains('show'));
      check(`[${vp}] no reporting message is shown to the student`, !toastShown);
      const pageText = await page.evaluate(() => document.body.innerText);
      check(`[${vp}] no technical reporting text is visible`,
        !/schools-bridge-game|postMessage|activity_key|submission_token|Bearer/i.test(pageText));
      await shot(page, `viewer-after-completion-${vp}.png`);

      /* back to the site: exact restore, the game stops */
      await page.click('#gameViewer .gv-back');
      await page.waitForFunction(() => !document.querySelector('#gameViewer').classList.contains('open'));
      await sleep(150);
      const after = await page.evaluate(() => ({
        frame: document.querySelector('#gameViewer iframe.gv-frame').getAttribute('src'),
        noScroll: document.documentElement.classList.contains('no-scroll'),
        bodyPos: document.body.style.position,
        y: window.scrollY,
      }));
      check(`[${vp}] back: returns to the same place on the site`, Math.abs(after.y - scrollBefore) < 3, `${after.y} vs ${scrollBefore}`);
      check(`[${vp}] back: the game is stopped and the page scroll is unlocked`, after.frame === 'about:blank' && !after.noScroll && after.bodyPos === '');

      /* Escape also closes; reopening starts a new, separately tracked attempt */
      await openCard(page, GAME_ID);
      await page.waitForSelector('#gameViewer.open');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('#gameViewer').classList.contains('open'));
      check(`[${vp}] Escape closes the viewer`, true);
      const resultsAfterEscape = s.api.filter(a => a.path === 'activity/result').length;
      check(`[${vp}] opening and closing again adds no completion`, resultsAfterEscape === results1.length);

      /* a game that refuses framing: the viewer still works and nothing is faked */
      await openCard(page, BLOCKED_ID);
      await page.waitForSelector('#gameViewer.open');
      await sleep(1500);
      await shot(page, `viewer-blocked-${vp}.png`);
      const backWorks = await page.$('#gameViewer .gv-back');
      check(`[${vp}] refused-embed game: the Back control is still usable`, !!backWorks);
      await page.click('#gameViewer .gv-back');
      await page.waitForFunction(() => !document.querySelector('#gameViewer').classList.contains('open'));
      const blockedResults = s.api.filter(a => a.path === 'activity/result' && a.body.activity_key === BLOCKED_ID);
      check(`[${vp}] refused-embed game: opening it reports no completion`, blockedResults.length === 0);

      /* external-tab fallback from inside the viewer, tracked as the same attempt */
      await openCard(page, GAME_ID);
      await page.waitForSelector('#gameViewer.open');
      const popupsBeforeExt = s.popups.length;
      await (await page.$('#gameViewer .gv-ext')).click();
      await sleep(700);
      const extCalls = await page.evaluate(() => window.__opened);
      const extNew = extCalls.map(c => c.url);
      check(`[${vp}] external button opens the original URL in a new tab`,
        extNew.includes(expectedUrl) && s.popups.length === popupsBeforeExt + 1, JSON.stringify(extCalls));
      check(`[${vp}] external button leaves the viewer open`, !!(await page.$('#gameViewer.open')));
      for (const t of s.popups.slice(popupsBeforeExt)) { try { const p = await t.page(); if (p) await p.close(); } catch {} }
      await page.click('#gameViewer .gv-back');
      await page.waitForFunction(() => !document.querySelector('#gameViewer').classList.contains('open'));

      await s.page.close();
      await s.context.close();
    }
  } finally {
    await browser.close();
  }
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}

function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
}

run().catch(err => { console.error(err); process.exitCode = 1; });

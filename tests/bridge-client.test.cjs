const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('bridge-client.js', 'utf8');
const storage = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k,v) => m.set(k,v) }; };
function setup(handler, stores = {}, logs = []) {
  const calls = [], timers = [], listeners = {};
  const ctx = { console: {warn(...args){ logs.push(args.join(' ')); }}, AbortController, Date, Math, navigator: {onLine:true},
    localStorage: stores.localStorage || storage(), sessionStorage: stores.sessionStorage || storage(),
    setTimeout: (fn, ms) => { timers.push({fn,ms}); return timers.length; }, clearTimeout(){},
    addEventListener: (name, fn) => listeners[name] = fn,
    fetch: async (url, opts) => {
      const req = {path:url.split('/api/public/')[1], body:JSON.parse(opts.body), opts}; calls.push(req);
      const r = await handler(req, calls);
      return {ok:(r.status || 200)<400, status:r.status || 200, headers:{get:()=>r.retry || null}, json:async()=>r.body};
    }
  };
  ctx.window = ctx; vm.runInNewContext(source, ctx);
  return {ctx, client:ctx.BridgeClient, calls, timers, listeners, logs};
}
const success = req => ({body:req.path === 'student/identify'
  ? {ok:true,student_id:12,submission_token:'test-token'} : {ok:true,stored:true}});
const settle = () => new Promise(resolve => setImmediate(resolve));
const pass = {name:'سارة محمد',school:'مدرسة الاختبار'};
test('identity and result use only public contract, no cookies; result rendered twice sends once', async () => {
  const s = setup(success); s.client.setIdentity(pass);
  const a = s.client.start({id:'book-picnic',title:'Story'},'reading');
  s.client.result(a,4,5); s.client.result(a,4,5); await settle();
  assert.deepEqual(s.calls.map(c=>c.path), ['student/identify','activity/opened','activity/result']);
  assert.equal(s.calls[0].body.full_name,pass.name);
  assert.match(s.calls[0].body.visitor_id,/^[A-Za-z0-9._:\-]{6,80}$/);
  const r = s.calls[2]; assert.equal(r.body.percentage,80); assert.equal(r.body.score,4);
  assert.equal(r.opts.headers.Authorization,'Bearer test-token');
  for (const c of s.calls) { assert.equal(c.opts.credentials,'omit'); assert.equal(c.opts.cache,'no-store'); assert.equal(c.body.student_id,undefined); }
});
test('offline replay keeps event id and accepts duplicate success', async () => {
  let fail = true;
  const s = setup(req => { if(req.path === 'activity/result') { if(fail) throw Error('offline'); return {body:{ok:true,duplicate:true,stored:false}}; } return success(req); });
  s.client.setIdentity(pass); s.client.result(s.client.start({id:'book-sea'},'reading'),2,5); await settle();
  const id=s.calls.find(c=>c.path==='activity/result').body.event_id;
  fail=false; await s.client.flush();
  assert.deepEqual(s.calls.filter(c=>c.path==='activity/result').map(c=>c.body.event_id),[id,id]);
  assert.equal(JSON.parse(s.ctx.sessionStorage.getItem('bridge_queue')).length,0);
});
test('401 refreshes same visitor and retries same event once', async () => {
  let attempts=0;
  const s=setup(req=> req.path==='activity/result' && ++attempts===1 ? {status:401,body:{ok:false,error:'invalid_student_token'}} : success(req));
  s.client.setIdentity(pass); s.client.result(s.client.start({id:'book-sea'},'reading'),5,5); await settle();
  const ids=s.calls.filter(c=>c.path==='student/identify').map(c=>c.body.visitor_id);
  assert.equal(ids.length,2); assert.equal(ids[0],ids[1]);
  const results=s.calls.filter(c=>c.path==='activity/result'); assert.equal(results.length,2); assert.equal(results[0].body.event_id,results[1].body.event_id);
});
test('429 honors retry delay, 400 discarded without breaking local flow', async () => {
  const s=setup(()=>({status:429,retry:'125',body:{ok:false,error:'rate_limited'}}));
  s.client.setIdentity(pass); await settle(); assert.ok(s.timers.some(t=>t.ms===125000));
  const bad=setup(()=>({status:400,body:{ok:false,error:'invalid_name'}}));
  bad.client.setIdentity(pass); await settle(); assert.equal(JSON.parse(bad.ctx.sessionStorage.getItem('bridge_queue')).length,0);
});
test('old attempt uses captured owner after gateway edit', async () => {
  const s=setup(req=>req.path==='student/identify' ? {body:{ok:true,student_id:12,submission_token:req.body.full_name}}:success(req));
  s.client.setIdentity(pass); await settle(); const a=s.client.start({id:'book-sea'},'reading'); await settle();
  s.client.setIdentity({name:'طالبة أخرى',school:'مدرسة أخرى'}); await settle(); s.client.result(a,5,5); await settle();
  assert.equal(s.calls.find(c=>c.path==='activity/result').opts.headers.Authorization,'Bearer '+pass.name);
});
test('anonymous attempts are not assigned to a later student', async () => {
  const s=setup(success); const a=s.client.start({id:'book-sea'},'reading'); s.client.setIdentity(pass); s.client.result(a,5,5); await settle();
  assert.deepEqual(s.calls.map(c=>c.path),['student/identify']);
});
test('assessment has generic and station records with distinct event IDs; retries are separate attempts', async () => {
  const s=setup(success); s.client.setIdentity(pass);
  for(let i=0;i<2;i++) s.client.result(s.client.start({id:'st-checkpoint',name:'Station'},'assessment'),3,5);
  await settle(); const r=s.calls.filter(c=>c.path.endsWith('/result'));
  assert.equal(r.length,4); assert.equal(new Set(r.map(c=>c.body.event_id)).size,4);
  assert.equal(r[1].body.station_key,'verification');
});
test('queue survives reload and stable visitor persists', async () => {
  const s=setup(()=>{ throw Error('offline'); }); s.client.setIdentity(pass);
  s.client.result(s.client.start({id:'book-sea'},'reading'),5,5); await settle();
  assert.equal(JSON.parse(s.ctx.sessionStorage.getItem('bridge_queue')).length,3);
  const t=setup(success,s.ctx); await t.client.flush();
  assert.equal(t.calls.length,3); assert.equal(t.calls[0].body.visitor_id,JSON.parse(s.ctx.localStorage.getItem('bridge_visitor_id')));
});
test('changed server ID on recovery never receives original attempt', async () => {
  let identifies=0;
  const s=setup(req=>req.path==='student/identify' ? {body:{ok:true,student_id:++identifies,submission_token:'t'}} : req.path==='activity/result' ? {status:401,body:{ok:false}}:success(req));
  s.client.setIdentity(pass); await settle(); s.client.result(s.client.start({id:'book-sea'},'reading'),5,5); await settle();
  assert.equal(s.calls.filter(c=>c.path==='activity/result').length,1);
});
test('worksheet and external launch never invent completions', async () => {
  const s=setup(success); s.client.setIdentity(pass); s.client.start({id:'sheet-1'},'worksheet'); s.client.start({id:'game-comparisons'},'game'); await settle();
  assert.equal(s.calls.filter(c=>c.path==='activity/opened').length,2);
  assert.equal(s.calls.filter(c=>c.path==='activity/result').length,0);
});
test('503 pauses silently and keeps queued work', async () => {
  const s=setup(()=>({status:503,body:{ok:false,error:'public_api_disabled'}}));
  s.client.setIdentity(pass); await settle();
  assert.equal(JSON.parse(s.ctx.sessionStorage.getItem('bridge_queue')).length,1);
  assert.ok(s.timers.some(t=>t.ms===60000));
});
test('storage access failure does not break the activity flow', async () => {
  const denied={getItem(){throw Error('denied');},setItem(){throw Error('denied');}};
  const s=setup(success,{localStorage:denied,sessionStorage:denied});
  s.client.setIdentity(pass); s.client.result(s.client.start({id:'book-sea'},'reading'),5,5); await settle();
  assert.equal(s.calls.length,3);
});
test('explicit submission re-identifies unchanged identity and repairs a missing token', async () => {
  const s=setup(success);
  s.client.setIdentity(pass); await settle();
  assert.equal(s.calls.filter(c=>c.path==='student/identify').length,1);
  s.client.setIdentity(pass,{force:true}); await settle();
  assert.equal(s.calls.filter(c=>c.path==='student/identify').length,2);
  const stored=JSON.parse(s.ctx.sessionStorage.getItem('bridge_identity')); delete stored.token;
  s.ctx.sessionStorage.setItem('bridge_identity',JSON.stringify(stored));
  const t=setup(success,s.ctx); t.client.setIdentity(pass); await settle();
  assert.equal(t.calls.filter(c=>c.path==='student/identify').length,1);
});
test('browser offline hint does not prevent an attempted request', async () => {
  const s=setup(success); s.ctx.navigator.onLine=false;
  s.client.setIdentity(pass); s.client.result(s.client.start({id:'book-sea'},'reading'),5,5); await settle();
  assert.deepEqual(s.calls.map(c=>c.path),['student/identify','activity/opened','activity/result']);
});
test('failed requests log safe diagnostics without personal data', async () => {
  const s=setup(()=>({status:503,body:{ok:false,error:'public_api_disabled'}}));
  s.client.setIdentity(pass); await settle();
  assert.equal(s.logs.length,1);
  const text=s.logs.join('\n');
  assert.match(text,/student\/identify/); assert.match(text,/503/);
  assert.ok(!text.includes(pass.name) && !text.includes(pass.school));
});

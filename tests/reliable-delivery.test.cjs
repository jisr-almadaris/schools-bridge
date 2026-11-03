const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('bridge-client.js','utf8');
function storage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key(i) { return [...values.keys()][i] ?? null; },
    getItem(k) { return values.get(k) ?? null; },
    setItem(k,v) { values.set(k,String(v)); },
    removeItem(k) { values.delete(k); },
    pending() { return [...values.keys()].filter(k=>k.startsWith('bridge_pending_v1::')); }
  };
}
function setup(localStorage, sessionStorage, handler) {
  const reqs=[], logs=[];
  const ctx = {
    console: { warn(...args){ logs.push(args.join(' ')); }}, AbortController,
    Date, Math, navigator: {onLine:true}, localStorage, sessionStorage,
    setTimeout(){ return 1; }, clearTimeout(){},
    addEventListener(){},
    fetch: async (url, opts) => {
      const req = {path:url.split('/api/public/')[1],body:JSON.parse(opts.body), headers:opts.headers};
      reqs.push(req);
      return handler(req);
    }
  };
  ctx.window=ctx;
  vm.runInNewContext(source,ctx,{filename:'bridge-client.js'});
  return {ctx, client:ctx.BridgeClient, reqs, logs};
}
function reply(req) {
  return req.path==='student/identify'
    ? {ok:true, status:200, headers:{get:()=>null}, json:async()=>({ok:true,student_id:14,submission_token:'secure-token'})}
    : {ok:true, status:201, headers:{get:()=>null}, json:async()=>({ok:true,stored:true})};
}
const wait = () => new Promise(resolve => setImmediate(resolve));
const pass={name:'سارة أحمد خالد',school:'التاسعة والعشرون'};

test('failed saved result survives closing gateway tab, reloads from localStorage, and retains idempotency event id', async () => {
  const local=storage(), s1=storage();
  let unavailable=true;
  const original=setup(local,s1,async req=>{
    if(req.path==='activity/result' && unavailable) throw Error('offline');
    return reply(req);
  });
  original.client.setIdentity(pass);
  const attempt=original.client.start({id:'game-comparisons',title:'Comparisons'},'game');
  original.client.result(attempt,2,8);
  await wait(); await wait();
  const first=original.reqs.find(req=>req.path==='activity/result');
  assert.ok(first && first.body.event_id);
  assert.ok(local.pending().length>0, 'durable pending data exists before closing tab');
  unavailable=false;
  const recovered=setup(local,storage(),async req=>reply(req));
  await recovered.client.flush();
  const replay=recovered.reqs.find(req=>req.path==='activity/result');
  assert.ok(replay,'reload retried the result');
  assert.equal(replay.body.event_id,first.body.event_id,'same id, never duplicate real attempt');
  assert.equal(local.pending().length,0,'remove durable events only after backend OK');
});

test('validation failure never silently deletes fingerprint event', async () => {
  const local=storage(), s1=storage();
  const original=setup(local,s1,async req=>{
    if(req.path==='learning/trace') return {
      ok:false,status:400,headers:{get:()=>null},json:async()=>({ok:false,error:'invalid_learning_trace'})
    };
    return reply(req);
  });
  original.client.setIdentity(pass);
  const attempt=original.client.start({id:'game-comparisons'},'game');
  original.client.learningTrace(attempt,0,[{question_index:0,correct:false,response_ms:1000,hint_used:false}]);
  await wait(); await wait();
  assert.ok(local.pending().length>0);
  assert.ok(original.logs.some(s=>s.includes('learning/trace')));
  const recovered=setup(local,storage(),async req=>reply(req));
  await recovered.client.flush();
  assert.equal(recovered.reqs.filter(req=>req.path==='learning/trace').length,1);
  assert.equal(local.pending().length,0);
});

test('server write must finish before a confirmation promise resolves', async () => {
  const local=storage(), s1=storage();
  let completeWrite;
  const s=setup(local,s1,async req=>{
    if(req.path!=='activity/result') return reply(req);
    return new Promise(resolve => { completeWrite=()=>resolve(reply(req)); });
  });
  s.client.setIdentity(pass); await wait();
  const attempt=s.client.start({id:'game-comparisons'},'game');
  const confirmed=s.client.result(attempt,4,8,{waitForConfirmation:true});
  let received=false;
  confirmed.then(()=>{received=true;});
  await wait();
  assert.equal(received,false,'do not acknowledge queued event before server response');
  assert.ok(local.pending().length>0);
  completeWrite(); await confirmed;
  assert.equal(received,true);
  assert.equal(local.pending().length,0);
});

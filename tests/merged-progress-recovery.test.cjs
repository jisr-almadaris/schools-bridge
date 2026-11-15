'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('bridge-client.js','utf8');
const app = fs.readFileSync('app.js','utf8');
const pass = { name:'طالبة اسم ثلاثي', school:'الابتدائية التاسعة والعشرون' };
function store() {
  const m = new Map();
  return { getItem:k=>m.get(k)||null, setItem:(k,v)=>m.set(k,v), removeItem:k=>m.delete(k),
    key:i=>Array.from(m.keys())[i]||null, get length(){return m.size;} };
}
function clientMock() {
  const requests = [];
  const ctx = { Date, Math, AbortController, console: { warn(){} },
    localStorage:store(), sessionStorage:store(), addEventListener(){},
    setTimeout(){return 1;}, clearTimeout(){},
    fetch:async (url, opts) => {
      const path = url.split('/api/public/')[1];
      requests.push({path,opts,body: opts.body && JSON.parse(opts.body)});
      const identifyCalls = requests.filter(x=>x.path==='student/identify').length;
      const body = path==='student/identify' ? identifyCalls===1
        ? {ok:true,student_id:12,submission_token:'old-token',student_return_code:'ABCDEFGHJKLM'}
        : {ok:true,student_id:34,submission_token:'new-token',student_return_code:'KLMNOPQRSTUV',merged_from_student_id:12}
        : path==='student/progress' ? {ok:true,activities:[{activity_key:'game-comparisons',activity_type:'game',completed:true,best_percentage:88}],certificates:[]}
          : {ok:true,stored:true};
      return {ok:true,status:200,headers:{get(){return null}},json:async()=>body};
    }
  };
  ctx.window=ctx;
  vm.runInNewContext(source,ctx);
  return { ctx, requests };
}

test('merge redirect with old signed token retains access; later results use new student token',async()=>{
  const {ctx,requests}=clientMock();
  await ctx.BridgeClient.setIdentity(pass,{waitForConfirmation:true});
  await ctx.BridgeClient.setIdentity(pass,{waitForConfirmation:true});
  const saved = JSON.parse(ctx.localStorage.getItem('bridge_roster'))[0];
  assert.equal(saved.student_id,34);
  assert.equal(saved.token,'new-token');
  assert.equal(saved.returnCode,'KLMNOPQRSTUV');
  const data=await ctx.BridgeClient.getProgress(pass);
  assert.equal(data.activities[0].best_percentage,88);
  assert.equal(requests.find(x=>x.path==='student/progress').opts.headers.Authorization,'Bearer new-token');
});

test('student achievement recovery merges with local history without downgrading or leaking another pupil',async()=>{
  const begin=app.indexOf('SB.restoreRecordedProgress = async function (pass) {');
  const end=app.indexOf('\n};',begin);
  assert.ok(begin>0&&end>begin);
  const snippet=app.slice(begin,end+3);
  const key=(name,school)=>JSON.stringify([name.trim().toLowerCase(),school.trim().toLowerCase()]);
  const writes=[];
  const SB={ currentKey:key(pass.name,pass.school),pass,progress:{gameStars:{'game-comparisons':3,'book-sea':1},done:[],completedGames:[],scores:{}},
    cert:{awards:[]},data:{games:[{id:'game-comparisons'}],vocabulary:[],books:[{id:'book-sea',title:'A Day at the Sea'}]},
    stations:[{id:'st-progress',name:'محطة التقدّم'}], saveProgress(){writes.push('progress')},
    saveCert(){writes.push('cert')},renderAll(){writes.push('render')} };
  const ctx={ SB, console:{warn(){}}, sbStudentKey:key,
    window:{BridgeClient:{getProgress:async()=>({activities:[
      {activity_key:'game-comparisons',activity_type:'game',completed:true,best_percentage:88},
      {activity_key:'book-sea',activity_type:'reading',completed:true,best_percentage:80},
      {activity_key:'st-progress',activity_type:'assessment',completed:true,best_percentage:65}
    ],certificates:[{activity_key:'book-book-sea',earned:true,percentage:80}]})}}};
  vm.runInNewContext(snippet,ctx);
  assert.equal(await SB.restoreRecordedProgress(pass),true);
  assert.equal(SB.progress.gameStars['game-comparisons'],3); // max is preserved
  assert.equal(SB.progress.gameStars['book-sea'],3);
  assert.equal(SB.progress.scores['st-progress'],65);
  assert.ok(SB.progress.done.includes('book-book-sea'));
  assert.ok(SB.progress.completedGames.includes('game-comparisons'));
  assert.equal(SB.cert.awards.length,1);
  assert.ok(writes.includes('render'));
  const priorWrites=writes.length;
  assert.equal(await SB.restoreRecordedProgress({name:'طالبة مختلفة جدًا',school:pass.school}),false);
  assert.equal(writes.length,priorWrites);
});

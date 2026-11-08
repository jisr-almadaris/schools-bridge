const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('index.html', 'utf8');
const app = fs.readFileSync('app.js', 'utf8');
const css = fs.readFileSync('styles.css', 'utf8');

function makeUi(failure) {
  const calls = [];
  const events = new Map();
  function el(value='') {
    const error = { hidden:true, textContent:'' };
    return { value, hidden:false, disabled:false, focused:false,
      textContent:'',
      classList:{add(){},remove(){},toggle(){}},
      addEventListener(event, fn) { events.set(this._id + ':' + event, fn); },
      closest() { return {querySelector(){return error;},classList:{add(){}, remove(){}}}; },
      focus(){this.focused=true},
    };
  }
  const elems = {
    '#passForm':el(), '#studentName':el('اختبار طالبة جديدة'),
    '#schoolName':el('الابتدائية التاسعة والعشرون'),
    '#studentReturnCode':el(), '#returnRecovery':el(),
    '#passSubmitStatus':el(), '#editPass':el(),
    'button[type="submit"]':el()
  };
  for (const [k,v] of Object.entries(elems)) v._id=k;
  elems['#returnRecovery'].hidden=true;
  const state={pass:null,renderAll(){}, registerStudent(id){this.pass={...id};return true;}};
  const fetches=[];
  const context = {
    $: q => elems[q], SB:state,
    window:{BridgeClient:{async setIdentity(pass, options){calls.push({pass,options});if(failure)throw failure;return {student_id:100}}}},
    toast(){}, console:{warn(){}},
    setTimeout(){}, fetch(...args){fetches.push(args);return Promise.resolve({ok:true});},
    applyPassUI(){}
  };
  const start=app.indexOf('function initPassForm() {');
  const end=app.indexOf('\n}\n\n/* ============================================================\n   MICRO-INTERACTIONS',start);
  assert.ok(start>=0 && end>start,'can isolate the real gateway form handler');
  const fn=app.slice(start,end+2);
  vm.runInNewContext(fn+'\ninitPassForm();', context);
  const submit=events.get('#passForm:submit');
  assert.equal(typeof submit,'function');
  return {elems,calls,events,submit:()=>submit({preventDefault(){}}),state};
}

test('first-time pupil sees no return-code field and submits without code',async()=>{
  assert.match(html,/id="returnRecovery" hidden/);
  assert.match(css,/\.pass-form \.return-recovery\[hidden\]\{display:none !important\}/);
  const ui=makeUi();
  assert.equal(ui.elems['#returnRecovery'].hidden,true);
  await ui.submit();
  assert.equal(ui.calls.length,1);
  assert.equal(ui.calls[0].options.returnCode,'');
  assert.equal(ui.elems['#returnRecovery'].hidden,true);
  assert.ok(ui.state.pass);
});

test('existing-name response reveals recovery but does not create a duplicate locally',async()=>{
  const ui=makeUi({code:'student_name_already_registered',status:409});
  await ui.submit();
  assert.equal(ui.elems['#returnRecovery'].hidden,false);
  assert.equal(ui.elems['#studentReturnCode'].focused,true);
  assert.equal(ui.state.pass,null);
  assert.match(ui.elems['#passSubmitStatus'].textContent,/مسجل سابق/);
});

test('return code is passed only when supplied and is wiped after success',async()=>{
  const ui=makeUi();
  ui.elems['#returnRecovery'].hidden=false;
  ui.elems['#studentReturnCode'].value='ABC123';
  await ui.submit();
  assert.equal(ui.calls[0].options.returnCode,'ABC123');
  assert.equal(ui.elems['#studentReturnCode'].value,'');
  assert.equal(ui.elems['#returnRecovery'].hidden,true);
});

test('network failure leaves recovery hidden and does not invent a student account',async()=>{
  const ui=makeUi({code:'network_error',status:503});
  await ui.submit();
  assert.equal(ui.elems['#returnRecovery'].hidden,true);
  assert.equal(ui.state.pass,null);
});

test('two-word name is rejected before contacting identity API',async()=>{
  const ui=makeUi();
  ui.elems['#studentName'].value='اسم واحد';
  await ui.submit();
  assert.equal(ui.calls.length,0);
  assert.equal(ui.elems['#returnRecovery'].hidden,true);
});

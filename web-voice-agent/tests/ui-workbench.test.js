const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {AgentOrchestrator} = require('../server/agent-orchestrator');
const {ProcedureRegistry} = require('../server/procedure-registry');
const {ExperimentRegistry} = require('../server/experiment-registry');

function fixture() {
  const nodes = new Map();
  const make = () => ({textContent:'', className:'', hidden:false, dataset:{}, style:{}, children:[],
    append(...values) { this.children.push(...values); }, replaceChildren() { this.children=[]; },
    classList:{toggle(){}}, setAttribute(name,value) { this[name]=value; }});
  const document = {body:{dataset:{}},createElement:make,querySelector(id) {if(!nodes.has(id)) nodes.set(id,make());return nodes.get(id);}};
  const context = vm.createContext({window:{},document});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/dashboard.js'),'utf8'),context);
  const registry = new ProcedureRegistry();
  const api = context.window.VoiceDashboard;
  api.load({capabilities:{experiment_count:20,curated_question_count:52,public_source_count:48},
    experimentData:{experiments:new ExperimentRegistry().list()},
    procedureData:{procedures:registry.list().map(p=>({...p,steps:registry.getForExperiment(p.experiment_id).steps})),review_drafts:registry.listDrafts()},
    voice:{asr:{configured:true},tts:{configured:true,target_voice:'度小娇（per 5）'}}});
  return {api,nodes,document};
}
const turn = (agent,session,text) => agent.handleVoiceTurn({session,recognized_text:text});
async function started() {
  const agent = new AgentOrchestrator();
  const selected = await turn(agent,agent.createSession(),'选择水稻实验');
  return {agent,result:await turn(agent,selected.session,'开始流程')};
}

test('workbench reports missing fields without inventing values or touching the task',async()=>{
  const {agent,result} = await started();
  const partial = await turn(agent,result.session,'培养周期95天');
  const before = structuredClone(partial);
  const f = fixture(); f.api.update(partial);
  assert.deepEqual(partial,before);
  assert.equal(f.nodes.get('#reportFields').children.length,4);
  const rows = f.nodes.get('#reportFields').children;
  assert.equal(rows.filter(r=>r.className==='missing').length,3);
  assert.equal(rows[0].children[1].textContent,'95天');
  assert.equal(f.nodes.get('#exceptionBanner').hidden,true);
  assert.equal(f.nodes.get('#navExperimentCount').textContent,'20');
  assert.match(f.nodes.get('#voiceIdentity').textContent,/per 5/u);
});

test('correction shows the new readback and only independent confirmation advances the view',async()=>{
  const {agent,result} = await started();
  const pending = await turn(agent,result.session,'培养周期95天，成熟度评估已完成，种子已成熟，营养液余量40%');
  assert.equal(pending.session.step_state,'WAITING_STEP_CONFIRMATION');
  const f=fixture(); f.api.update(pending);
  assert.equal(f.document.body.dataset.taskState,'WAITING_STEP_CONFIRMATION');
  assert.match(f.nodes.get('#confirmationStatus').textContent,/独立确认/u);
  assert.equal(f.nodes.get('#stepTimeline').children.filter(row=>row.className==='complete').length,0);
  const correction=await turn(agent,pending.session,'营养液余量更正为45%');
  const before=structuredClone(correction); f.api.update(correction);
  assert.deepEqual(correction,before);
  assert.equal(correction.session.completed_steps.length,0);
  assert(f.nodes.get('#reportFields').children.some(row=>row.children[1].textContent==='百分之45'));
  const confirmed=await turn(agent,correction.session,'确认无误');f.api.update(confirmed);
  assert.equal(confirmed.session.completed_steps.length,1);
  assert.equal(f.nodes.get('#stepTimeline').children[0].className,'complete');
  assert.match(f.nodes.get('#confirmedInputs').textContent,/百分之45/u);
});

test('exception pause shows actual details and never invites a normal confirmation to resume',async()=>{
  const {agent,result}=await started();
  const paused=await turn(agent,result.session,'容器标签不一致');
  const details=await turn(agent,paused.session,'受影响对象DEMO-CONTAINER-01，异常现象标签不一致，已采取处置停止操作');
  const f=fixture(); const before=structuredClone(details); f.api.update(details);
  assert.deepEqual(details,before);
  assert.equal(f.nodes.get('#exceptionBanner').hidden,false);
  assert.match(f.nodes.get('#pauseMessage').textContent,/身份待核对/u);
  assert.match(f.nodes.get('#readbackInstruction').textContent,/不会解除/u);
  assert.equal(f.nodes.get('#exceptionReadback').hidden,false);
  assert(f.nodes.get('#exceptionDetails').children.some(p=>p.textContent.includes('DEMO-CONTAINER-01')));
  const stillPaused=await turn(agent,details.session,'继续'); f.api.update(stillPaused);
  assert.equal(f.nodes.get('#exceptionBanner').hidden,false);
  assert.equal(f.nodes.get('#confirmationStatus').textContent,'流程保持暂停');
});

test('knowledge source rendering is read-only, preserves provenance and rejects unsafe links',async()=>{
  const {agent,result}=await started();
  const answer=await turn(agent,result.session,'生命生态实验柜植物实验的温度控制范围是多少');
  const f=fixture(); const before=structuredClone(answer); f.api.update(answer);
  assert.deepEqual(answer,before);
  assert.equal(f.nodes.get('#sourceCards').children.length,1);
  assert.match(f.nodes.get('#knowledgeAnswer').textContent,/17到28/u);
  const link=f.nodes.get('#sourceCards').children[0].children[0].children[0];
  assert.match(link.href,/^https:\/\//u); assert.equal(link.rel,'noopener noreferrer');
  const unsafe=structuredClone(answer); unsafe.knowledge.matched_records[0].sources[0].url='javascript:alert(1)'; f.api.update(unsafe);
  assert.equal(f.nodes.get('#sourceCards').children[0].children[0].children.length,0);
});

test('retrieval failures clear stale citations instead of appearing as no answer',async()=>{
  const {result}=await started(); const f=fixture();
  f.api.update({...result,knowledge:{query:'测试问题',retrieval_status:'FAILED',matched_records:[]}});
  assert.equal(f.nodes.get('#sourceState').textContent,'检索失败');
  assert.match(f.nodes.get('#sourceCards').children[0].textContent,/不能.*故障当作无答案/u);
});

test('ordinary task reports do not create or replace the latest knowledge query',async()=>{
  const {agent,result}=await started(); const f=fixture();
  f.api.update(result);
  assert.equal(f.nodes.has('#knowledgeQuestion'),false);
  const answer=await turn(agent,result.session,'生命生态实验柜植物实验的温度控制范围是多少');
  f.api.update(answer);
  const lastQuestion=f.nodes.get('#knowledgeQuestion').textContent;
  const lastAnswer=f.nodes.get('#knowledgeAnswer').textContent;
  const report=await turn(agent,answer.session,'培养周期95天');
  assert.equal(report.knowledge.retrieval_status,'NOT_REQUESTED');
  f.api.update(report);
  assert.equal(f.nodes.get('#knowledgeQuestion').textContent,lastQuestion);
  assert.equal(f.nodes.get('#knowledgeAnswer').textContent,lastAnswer);
  assert.equal(f.nodes.get('#sourceCards').children.length,1);
});

test('production markup contains navigation only, not typed chat, simulated telemetry or manual step controls',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
  const css=fs.readFileSync(path.join(__dirname,'../public/styles.css'),'utf8');
  assert.doesNotMatch(html,/<input|<textarea|contenteditable|onclick=|data-fixture|ui-fixture/iu);
  const ids=[...html.matchAll(/\bid="([^"]+)"/gu)].map(m=>m[1]); assert.equal(new Set(ids).size,ids.length);
  for(const name of ['workbench','flow','reportFields','exceptionBanner','sources','records','directory','connections','boundary']) assert(ids.includes(name));
  assert.match(css,/prefers-reduced-motion/u);assert.match(css,/max-width: 720px/u);
  assert.match(css,/\[hidden\]/u);
});

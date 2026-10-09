const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {KnowledgeRetriever} = require('../server/knowledge-retriever');
const {AgentOrchestrator} = require('../server/agent-orchestrator');
const root = path.resolve(__dirname, '../..');
const expanded = JSON.parse(fs.readFileSync(path.join(root, 'knowledge_base/qa-expanded.json'), 'utf8'));

for (const record of expanded) {
  test(`${record.record_id}: sourced simulated questions preserve active task`, async () => {
    const agent = new AgentOrchestrator();
    const selection = await agent.handleVoiceTurn({session:agent.createSession(),recognized_text:'选择水稻实验'});
    const started = await agent.handleVoiceTurn({session:selection.session,recognized_text:'开始流程'});
    const before = structuredClone(started.session);
    for (const question of record.questions) {
      const query = question.replace(/[？?]/gu, '');
      const result = await agent.handleVoiceTurn({session:started.session,recognized_text:query});
      assert.equal(result.knowledge?.top_record_id, record.record_id, query);
      assert.equal(result.response_type, record.record_type === 'source_conflict' ? 'SOURCE_CONFLICT' : 'KNOWLEDGE_ANSWER');
      assert(result.speech_text.includes(record.content));
      assert(result.speech_text.includes(record.spoken_citation));
      assert.deepEqual(result.session, before, 'Research question must not change experiment state');
      const retrieved = agent.knowledgeRetriever.getRecord(record.record_id);
      assert.deepEqual(retrieved.sources.map(s=>s.id), record.source_ids);
      assert.equal(retrieved.execution_allowed, false);
    }
  });
}

test('new research context cannot answer current telemetry or task settings', async () => {
  const agent = new AgentOrchestrator();
  for (const [query,response] of [
    ['当前密闭水生生态的溶解氧读数是多少','KNOWLEDGE_NO_TELEMETRY'],
    ['KFT本次水稻样品保存应该设置成什么条件','KNOWLEDGE_SOP_REQUIRED'],
    ['APEX04本次RNA的RIN安全范围是多少','KNOWLEDGE_SOP_REQUIRED'],
    ['四周CAES实验水温该设多少','KNOWLEDGE_SOP_REQUIRED'],
  ]) {
    const result = await agent.handleVoiceTurn({session:agent.createSession(),recognized_text:query});
    assert.equal(result.response_type,response,query);
    assert.equal(result.knowledge.matched_records.length,0);
  }
});

test('expanded sources and questions stay separate from unverified task rules', () => {
  const retriever = new KnowledgeRetriever();
  assert.equal(expanded.length,16);
  assert.equal(new Set(expanded.map(r=>r.record_id)).size,16);
  assert(expanded.every(r=>r.evidence_locator && r.source_checked_on && r.questions.length===3 && r.execution_allowed===false));
  assert(retriever.records.every(r=>!r.record_id.startsWith('candidate_')));
  const procedures = JSON.parse(fs.readFileSync(path.join(root,'web-voice-agent/config/procedure-guides.json'),'utf8')).procedures;
  assert.equal(procedures.length,1);
  assert.equal(procedures[0].steps.length,9);
  assert.equal(procedures[0].steps.reduce((n,s)=>n+(s.missing_details?.length||0),0),15);
  assert.equal(procedures[0].detail_policy.flight_execution_allowed,false);
});

test('new scoped paraphrases select the correct study without numeric assumptions', () => {
  const retriever = new KnowledgeRetriever();
  for(const [query,id] of [
    ['GBCM的环境控制技术在论文摘要中如何描述','qa23_gbcm_environment_tech'],
    ['APEX04的测序数据该去哪里查编号','qa27_apex04_geo_accessions'],
    ['2025空间站斑马鱼筛选研究具体关注哪些行为','qa32_css_zebrafish_selection'],
    ['四周CAES研究的水质观测指标有哪些','qa35_caes_water_observations'],
  ]) assert.equal(retriever.search(query)[0]?.record_id,id,query);
});

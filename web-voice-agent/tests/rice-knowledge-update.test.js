const test = require('node:test');
const assert = require('node:assert/strict');
const {KnowledgeRetriever, knowledgeBoundary} = require('../server/knowledge-retriever');
const {AgentOrchestrator} = require('../server/agent-orchestrator');
const records = require('../../knowledge_base/qa-rice-2026-10.json');
const sources = require('../../knowledge_base/verified_sources.json');

for (const record of records) {
  test(`${record.record_id}: sourced answers preserve the active experiment`, async () => {
    const agent = new AgentOrchestrator();
    const selected = await agent.handleVoiceTurn({session:agent.createSession(), recognized_text:'选择水稻实验'});
    const started = await agent.handleVoiceTurn({session:selected.session, recognized_text:'开始流程'});
    const before = structuredClone(started.session);
    for (const question of record.questions) {
      const query = question.replace(/[？?]/gu, '');
      const reply = await agent.handleVoiceTurn({session:started.session, recognized_text:query});
      assert.deepEqual(reply.session, before, query);
      if (knowledgeBoundary(query)) {
        assert.equal(reply.response_type, 'KNOWLEDGE_SOP_REQUIRED', query);
        assert.equal(reply.knowledge.top_record_id, null);
        continue; // Safety-limit wording is deliberately NOT exempted by a known question.
      }
      assert.equal(reply.knowledge?.top_record_id, record.record_id, query);
      assert.equal(reply.response_type, record.record_type === 'source_conflict' ? 'SOURCE_CONFLICT' : 'KNOWLEDGE_ANSWER', query);
      assert(reply.speech_text.includes(record.content), query);
      assert(reply.speech_text.includes(record.spoken_citation), query);
      const retrieved = agent.knowledgeRetriever.getRecord(record.record_id);
      assert.deepEqual(retrieved.sources.map(s => s.id), record.source_ids);
      assert.equal(retrieved.execution_allowed, false);
    }
  });
}

test('new hardware facts retain comparison direction, units, historical scope and provenance', () => {
  const retriever = new KnowledgeRetriever();
  assert.equal(records.length, 16);
  assert.equal(new Set(records.map(r => r.record_id)).size, 16);
  assert.equal(records.filter(r => r.record_type === 'verified_qa').length, 13);
  assert.equal(records.filter(r => r.record_type === 'source_conflict').length, 3);
  assert(records.every(r => r.source_checked_on && r.evidence_locator && r.limitations && r.execution_allowed === false));
  assert.match(retriever.getRecord('rice_v2_03_resolution').answer, /不小于1024/u);
  assert.match(retriever.getRecord('rice_v2_04_frame_rate').answer, /不小于25帧每秒/u);
  assert.match(retriever.getRecord('rice_v2_08_light').answer, /不小于120微摩尔每平方米每秒/u);
  assert.match(retriever.getRecord('rice_v2_11_protons').answer, /不是人体剂量限值/u);
  assert.match(retriever.getRecord('rice_v2_14_duration_limit').answer, /不能证明.*统一最大/u);
  assert.equal(sources.length, 48);
  assert.equal(new Set(sources.map(s => s.id)).size, 48);
  assert.equal(sources.find(s => s.id === 'official_cemps_rice_shb_mirror_2022').same_work_as, 'official_cemps_rice_2022');
});

test('new records cannot authorize task settings or pretend to read sensors', async () => {
  const agent = new AgentOrchestrator();
  for (const [query, expected] of [
    ['本次水稻保存温度应该设多少', 'KNOWLEDGE_SOP_REQUIRED'],
    ['生命生态实验柜植物温度应该设置为28摄氏度吗', 'KNOWLEDGE_SOP_REQUIRED'],
    ['5到300兆电子伏是宇航员辐射安全限值吗', 'KNOWLEDGE_SOP_REQUIRED'],
    ['当前水稻培养温度是多少', 'KNOWLEDGE_NO_TELEMETRY'],
  ]) {
    const session = agent.createSession();
    const reply = await agent.handleVoiceTurn({session, recognized_text:query});
    assert.equal(reply.response_type, expected, query);
    assert.deepEqual(reply.session, session);
    assert.equal(reply.knowledge.top_record_id, null);
  }
  assert.equal(agent.knowledgeRetriever.search('临时隔热容器可以安全保存30分钟吗').length, 0);
  assert.equal(agent.knowledgeRetriever.search('水稻营养液20%是统一安全下限吗').length, 0);
});

test('new knowledge answers cannot clear an exception pause', async () => {
  const agent = new AgentOrchestrator();
  let {session} = await agent.handleVoiceTurn({session:agent.createSession(), recognized_text:'选择水稻实验'});
  ({session} = await agent.handleVoiceTurn({session, recognized_text:'开始流程'}));
  ({session} = await agent.handleVoiceTurn({session, recognized_text:'设备故障'}));
  const before = structuredClone(session);
  const answer = await agent.handleVoiceTurn({session, recognized_text:records[3].questions[0]});
  assert.equal(answer.response_type, 'KNOWLEDGE_ANSWER');
  assert.deepEqual(answer.session, before);
});

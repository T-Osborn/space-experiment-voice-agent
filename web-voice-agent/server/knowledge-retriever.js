const fs = require("node:fs");
const path = require("node:path");

const KB_PATH = path.join(__dirname, "..", "..", "knowledge_base");

function loadJson(filename) {
  return JSON.parse(fs.readFileSync(path.join(KB_PATH, filename), "utf8"));
}

function normalizeQuestion(value) {
  return String(value || "").normalize("NFKC").toLowerCase()
    .replace(/^(?:请问|请告诉我|我想知道|告诉我|请)/u, "")
    .replace(/[\s\p{P}]/gu, (character, index, text) => {
      // Do not turn -80 into 80, or 1.4 into 14, while removing question punctuation.
      if (/[.-]/u.test(character) && /\d/u.test(text[index + 1] || "")) return character;
      return "";
    });
}

// Conservative routing, not a complete semantic safety classifier.
function knowledgeBoundary(query) {
  const text = String(query || "").normalize("NFKC").toLowerCase();
  if (/(当前|现在|此刻|实时|目前).*(读数|温度|压力|流量|心率|剩余|测量值)|实时(数据|状态)|读数.*(当前|现在|实时)/u.test(text)) {
    return "NO_TELEMETRY";
  }
  if (/安全(阈值|范围|上限)|放行|报警阈值|能否继续|可以继续|能继续|设置(成|为)|设成|该设|应该设|需要调|调参|校准|操作参数|怎么(剪|封装|切|转移|消毒)|消毒.*浓度|辐射.*(上限|限值)|心率.*(上限|阈值|停止)|(本次|这次|当前任务|我们的实验).*(取样|转移|保存|培养|温度|压力|流量)/u.test(text)) {
    return "TASK_SOP_REQUIRED";
  }
  return null;
}

class KnowledgeRetriever {
  constructor({ records, sources, load = loadJson } = {}) {
    // Unverified user candidate answers are intentionally NOT loaded.
    try {
      this.records = records || [...load("records.json"), ...load("qa-core.json"), ...load("qa-expanded.json"), ...load("qa-rice-2026-10.json")];
      this.sources = new Map((sources || [
        ...load("verified_sources.json"), ...load("project_sources.json"),
      ]).map((source) => [source.id, source]));
      if (!Array.isArray(this.records)) throw new Error("KNOWLEDGE_DATA_INVALID");
      this.availability = "AVAILABLE";
    } catch {
      this.records = []; this.sources = new Map(); this.availability = "UNAVAILABLE";
    }
  }

  getStatus() {
    return { status: this.availability, available: this.availability === "AVAILABLE" };
  }

  search(query, limit = 5) {
    if (this.availability !== "AVAILABLE") throw new Error("KNOWLEDGE_UNAVAILABLE");
    const normalized = normalizeQuestion(expandQuery(query));
    const original = normalizeQuestion(query);
    if (!normalized || knowledgeBoundary(query)) return [];
    const count = Number.isFinite(limit) ? Math.max(0, Math.min(10, Math.floor(limit))) : 5;
    return this.records.map((record) => {
      const eligible = this.getRecord(record.record_id);
      if (!eligible) return null;
      const exact = (record.questions || []).some((question) => normalizeQuestion(question) === original);
      const groups = record.match_groups || [];
      const scoped = groups.length >= 2 && groups.every((group) => group.length
        && group.some((term) => normalized.includes(normalizeQuestion(term))));
      if (!exact && !scoped) return null;
      const overlap = (record.keywords || []).filter((term) => normalized.includes(normalizeQuestion(term))).length;
      const score = exact ? 1000 : 20 + groups.length * 5 + Math.min(overlap, 10);
      return {
        ...eligible, score, match_type: exact ? "EXACT_QUESTION" : "SCOPED_KEYWORDS",
      };
    }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, count);
  }

  getRecord(id) {
    const record = this.records.find((item) => item.record_id === id);
    if (!record || record.direct_answer_allowed !== true || /UNVERIFIED|CANDIDATE/u.test(record.review_status || "")) return null;
    const registered = (record.source_ids || []).map((sourceId) => this.sources.get(sourceId));
    const publicUrl = (source) => /^https:\/\//u.test(source?.url || source?.public_record || "");
    if (!registered.length || registered.some((source) => !source) || !registered.some(publicUrl)
      || (!registered.every(publicUrl) && record.record_type !== "source_conflict")) return null;
    return {
      record_id: id, record_type: record.record_type, title: record.title, answer: record.content,
      evidence_level: record.evidence_level, direct_answer_allowed: true, execution_allowed: false,
      limitations: record.limitations || "", spoken_citation: record.spoken_citation || null,
      evidence_locator: record.evidence_locator || null, source_checked_on: record.source_checked_on || null,
      sources: registered.map((source) => ({ id: source.id, title: source.title,
        evidence_level: source.evidence_level || "USER_PROVIDED_UNREVIEWED", source_type: source.source_type,
        url: source.url || source.public_record || null, doi: source.doi || null,
        checked_on: source.checked_on || null, verification_scope: source.verification_scope || null })),
    };
  }

  semanticCatalog(query) {
    if (knowledgeBoundary(query)) return [];
    const normalized = normalizeQuestion(expandQuery(query));
    return this.records.filter((record) => this.getRecord(record.record_id)
      && record.match_groups?.length >= 2
      // Require explicit subject and mission context; a model cannot fill them in.
      && record.match_groups.slice(0, -1).every((group) => group.some((term) => normalized.includes(normalizeQuestion(term)))))
      .map((record) => ({ record_id: record.record_id, title: record.title, questions: record.questions || [] }));
  }

  isKnownQuestion(query) {
    const normalized = normalizeQuestion(query);
    return !!normalized && this.records.some((record) => record.direct_answer_allowed === true
      && (record.questions || []).some((question) => normalizeQuestion(question) === normalized));
  }
}

function expandQuery(query) {
  return String(query).replace(/(?:用了|历时|耗时)/gu, "持续")
    .replace(/(?:几档|几挡|温度档位)/gu, "设定点").replace(/(?:哪儿|哪边)/gu, "哪里")
    .replace(/(?:种的是啥|种了啥)/gu, "植物是什么");
}

module.exports = { KnowledgeRetriever, normalizeQuestion, knowledgeBoundary, expandQuery };

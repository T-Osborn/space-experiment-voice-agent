const { normalizeQuestion } = require("./knowledge-retriever");
class DialogueMemory {
  constructor({ ttl = 3600000, limit = 256, now = Date.now } = {}) {
    this.ttl = ttl; this.limit = limit; this.now = now; this.entries = new Map();
  }
  clear(id) { this.entries.delete(id); }
  remember(id, record) {
    if (!id || !record) return;
    this.entries.delete(id);
    this.entries.set(id, { scope: record.match_groups?.slice(0, -1).map((group) => group[0]).join(" ") || "",
      expires: this.now() + this.ttl });
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value);
  }
  resolve(id, query, records) {
    const entry = this.entries.get(id);
    if (!entry) return query;
    if (entry.expires <= this.now()) { this.clear(id); return query; }
    if (!/(它|那次|那个研究|这项研究|刚才|那篇|那么)/u.test(query)) return query;
    const normalized = normalizeQuestion(query);
    // Explicit new subjects always win over pronouns from the previous answer.
    if (records.some((record) => record.match_groups?.[0]?.some((term) => normalized.includes(normalizeQuestion(term))))) return query;
    return entry.scope + " " + query;
  }
}
module.exports = { DialogueMemory };

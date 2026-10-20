const { normalizeQuestion } = require("./knowledge-retriever");
class DialogueMemory {
  constructor({ ttl = 3600000, limit = 256, now = Date.now } = {}) {
    this.ttl = ttl; this.limit = limit; this.now = now; this.entries = new Map();
  }
  clear(id) { this.entries.delete(id); }
  entry(id) {
    const entry = this.entries.get(id);
    if (entry && entry.expires <= this.now()) { this.clear(id); return null; }
    return entry || null;
  }
  snapshot(id) { const entry = this.entry(id); return entry ? structuredClone(entry) : null; }
  restore(id, value) {
    this.clear(id);
    if (!value || !Number.isFinite(value.expires) || value.expires <= this.now()
      || typeof value.scope !== "string" || value.scope.length > 2000) return;
    const pending = value.pending;
    if (pending && (typeof pending.query !== "string" || pending.query.length > 2000
      || !Array.isArray(pending.choices) || pending.choices.length > 3 || !Array.isArray(pending.missing_groups)
      || !pending.choices.every(item => typeof item.title === "string" && typeof item.query === "string")
      || !pending.missing_groups.every(group => Array.isArray(group.terms) && group.terms.every(term => typeof term === "string")))) return;
    this.put(id, { scope: value.scope, pending: pending || null, expires: Math.min(value.expires, this.now() + this.ttl) });
  }
  put(id, entry) {
    this.entries.delete(id); this.entries.set(id, entry);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value);
  }
  pending(id) { return this.entry(id)?.pending || null; }
  ask(id, pending) {
    this.put(id, { scope: this.entry(id)?.scope || "", pending: structuredClone(pending), expires: this.now() + this.ttl });
  }
  clearPending(id) { const entry = this.entry(id); if (entry) entry.pending = null; }
  remember(id, record) {
    if (!id || !record) return;
    this.put(id, { scope: record.match_groups?.slice(0, -1).map((group) => group[0]).join(" ") || "", pending: null,
      expires: this.now() + this.ttl });
  }
  resolve(id, query, records) {
    const entry = this.entry(id);
    if (!entry) return query;
    if (!/(它|那次|那个研究|这项研究|刚才|那篇|那么|这个|那个|还有)/u.test(query)) return query;
    const normalized = normalizeQuestion(query);
    // Explicit new subjects always win over pronouns from the previous answer.
    if (records.some((record) => record.match_groups?.[0]?.some((term) => normalized.includes(normalizeQuestion(term))))) return query;
    return entry.scope + " " + query;
  }
}
module.exports = { DialogueMemory };

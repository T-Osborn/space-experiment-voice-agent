const { normalizeQuestion, expandQuery } = require("./knowledge-retriever");
const { behaviorPolicy } = require("./behavior-policy");

function matchingTerms(group, text) {
  return group.filter(term => text.includes(normalizeQuestion(term)));
}

function broadQuestion(query, terms) {
  let text = normalizeQuestion(query);
  for (const term of [...new Set(terms)].sort((a, b) => b.length - a.length)) text = text.split(normalizeQuestion(term)).join("");
  return !text.replace(/我想了解|了解一下|介绍一下|请问|告诉我|介绍|查询|查一下|关于|知道|一下|是什么|哪些|什么|那么|刚才|这项研究|这个|那个|那次|还有|它|的|呢|吗|年|是|有/gu, "");
}

function sameYear(query, title) {
  const years = [...String(query).matchAll(/(?:19|20)\d{2}/gu)].map(match => match[0]);
  const titleYears = [...String(title).matchAll(/(?:19|20)\d{2}/gu)].map(match => match[0]);
  return years.length !== 1 || titleYears.length !== 1 || years[0] === titleYears[0];
}

// Suggestions are derived only from answerable records; no thresholds or answers are invented.
function clarificationPlan(query, results, retriever) {
  const prefix = behaviorPolicy.clarification_prefix;
  if (results.length > 1 && results[0].match_type !== "EXACT_QUESTION" && results[0].score === results[1].score
    && ![results[0].record_type, results[1].record_type].includes("source_conflict")) {
    const choices = results.slice(0, 2).map(record => ({ title: record.title, query: record.title }));
    return { query, kind: "CHOICE", choices, missing_groups: [],
      speech_text: `${prefix}要查询的是${choices[0].title}，还是${choices[1].title}。` };
  }
  if (results.length) return null;
  const normalized = normalizeQuestion(expandQuery(query));
  const partial = (retriever.records || []).flatMap(record => {
    if (!retriever.getRecord?.(record.record_id) || !sameYear(query, record.title)) return [];
    const groups = record.match_groups || [];
    if (groups.length < 2) return [];
    const matched = groups.map(group => matchingTerms(group, normalized));
    const missing = groups.map((group, index) => ({ terms: group, index })).filter(group => !matched[group.index].length);
    const scopeMatches = matched.slice(0, -1).flat();
    if (!scopeMatches.length || !missing.length) return [];
    if (!matched.at(-1).length && !broadQuestion(query, scopeMatches)) return [];
    return [{ record, missing, matched: matched.filter(terms => terms.length).length }];
  }).sort((a, b) => b.matched - a.matched || (a.record.questions ? -1 : 0) - (b.record.questions ? -1 : 0));
  if (partial.length) {
    const best = partial[0];
    // A matching topic with a missing task/subject needs only the absent scope.
    if (best.missing.every(group => group.index < best.record.match_groups.length - 1)) {
      const missingGroups = best.missing.map(group => ({
        kind: group.index === 0 ? "SUBJECT" : "CONTEXT", terms: group.terms,
      }));
      const names = missingGroups.map(group => group.kind === "SUBJECT" ? "具体实验、设备或样品对象" : "所指的任务或研究背景");
      const examples = [...new Set(missingGroups.flatMap(group => group.terms))].slice(0, 3);
      return { query, kind: "MISSING_SCOPE", choices: [], missing_groups: missingGroups,
        speech_text: `${prefix}${[...new Set(names)].join("和")}。可补充的信息例如：${examples.join("、")}。` };
    }
    const choices = partial.filter(item => item.matched === best.matched).slice(0, 3)
      .map(item => ({ title: item.record.title, query: item.record.questions?.[0] || item.record.title }));
    return { query, kind: "CHOICE", choices, missing_groups: [],
      speech_text: `${prefix}想了解哪一项：${choices.map((choice, i) => `第${i + 1}项，${choice.title}`).join("；")}。也可以直接说具体问题。` };
  }
  if (/^(?:(?:请问|我想知道)?(?:它|这个|那个|这项研究|那次实验)?的?(?:温度|时间|周期|参数|保存条件)?(?:是|有|要)?(?:多少|多久|几天|什么|哪些)(?:呢|吗)?[？?。]?)$/u.test(query)) {
    return { query, kind: "MISSING_SCOPE", choices: [], missing_groups: [{ kind: "SUBJECT", terms: [] }],
      speech_text: `${prefix}具体实验、设备或样品对象。当前还不能确定你在问什么对象。` };
  }
  return null;
}

function clarificationReply(pending, query) {
  if (!pending) return null;
  const text = normalizeQuestion(query).replace(/^(?:是|指的是|我指的是|我问的是|我想问的是|选择|选)/u, "");
  if (text === normalizeQuestion(pending.query)) return { query: pending.query, unresolved: true };
  if (/^(?:不知道|不清楚|不确定)$/u.test(text)) return { query: pending.query, unresolved: true };
  const ordinal = /^(?:第?([一二三123])(?:个|项)?|前者|后者)$/u.exec(text);
  if (ordinal) {
    const index = ordinal[1] ? "一二三".includes(ordinal[1]) ? "一二三".indexOf(ordinal[1]) : Number(ordinal[1]) - 1 : text === "前者" ? 0 : 1;
    return pending.choices[index] ? { query: pending.choices[index].query } : { query: pending.query, unresolved: true };
  }
  const choice = pending.choices.find(item => normalizeQuestion(item.title) === text || normalizeQuestion(item.query) === text);
  if (choice) return { query: choice.query };
  if (query.length > 100 || /[?？]|为什么|如何|怎么|查询|查一下/u.test(query)) return null;
  const terms = pending.missing_groups.flatMap(group => group.terms);
  if (terms.some(term => text.includes(normalizeQuestion(term)))
    || (pending.missing_groups.some(group => group.kind === "CONTEXT") && /^(?:19|20)\d{2}年?$/u.test(text))
    || (pending.missing_groups.some(group => group.kind === "SUBJECT") && !/\d|[零〇一二两三四五六七八九十]|已|未|确认|继续|恢复|暂停|读数|报告/u.test(text))) {
    return { query: `${pending.query} ${query}`.slice(0, 2000) };
  }
  return null;
}

module.exports = { clarificationPlan, clarificationReply, sameYear };

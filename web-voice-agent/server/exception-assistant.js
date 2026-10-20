// Product dialogue policy only. These routes do not prescribe physical remedies.
const ROUTES = [
  { id: "CONTAINMENT", label: "包装或液体逸出", pattern: /泄漏|洒漏|漏液|破损|破裂/u },
  { id: "IDENTITY", label: "样品或容器身份待核对", pattern: /标签.*(不一致|错|对不上|看不清|模糊|脱落)|编号.*(不一致|错|对不上|看不清|模糊)|身份.*不一致/u },
  { id: "CONTAMINATION", label: "疑似污染", pattern: /污染/u },
  { id: "EQUIPMENT", label: "设备故障或报警", pattern: /故障|报警|损坏|失灵|无法/u },
  { id: "RECORD", label: "记录缺失", pattern: /记录.*(缺失|丢失|不全)|时间.*缺失|编号.*缺失/u },
];
const FIELDS = [
  { name: "affected_item", label: "受影响对象", aliases: ["受影响对象", "异常对象"] },
  { name: "phenomenon", label: "异常现象", aliases: ["异常现象", "观察现象"] },
  { name: "actions_taken", label: "已采取处置", aliases: ["已采取处置", "已采取措施", "已经做的处理"] },
];

function actualException(query) {
  const text = String(query);
  if (/(如果|假如|假设|万一|一旦|可能会|会不会)/u.test(text) || /异常已评估|异常已处理|偏差已评估|问题已处理/u.test(text)) return false;
  if (/(为什么|为何|原理|研究|论文|介绍|有哪些|有什么|是什么|含义|通常|一般|如何预防|怎么预防|怎样预防)/u.test(text)
    && !/(出现了|发生了|发现了|报告|当前.*(?:出现|发生|发现)|现在.*(?:出现|发生|发现)|报警了|漏了|坏了|检测到|现场)/u.test(text)) return false;
  const clauses = text.split(/[，,。；;但]/u).filter((clause) => !/(无异常|没有异常|未发现异常|没有.{0,3}(泄漏|污染|故障|报警)|(?:未发现|未见).{0,3}(泄漏|污染|故障|报警)|无(泄漏|污染|故障|报警))/u.test(clause));
  return clauses.some((clause) => ROUTES.some((route) => route.pattern.test(clause))
    || /异常|不对/u.test(clause));
}

function createException(query, category = null) {
  const route = ROUTES.find((item) => item.pattern.test(query));
  return {
    category: category || route?.id || "UNKNOWN", category_name: category === "PARAMETER_DEVIATION" ? "报告值与演示核对条件不一致" : route?.label || "待评估异常",
    description: query, timestamp_utc: new Date().toISOString(), details: {},
    evidence_status: "OPERATOR_REPORTED", independently_verified: false,
    policy_source: "project_traceability_design_2026_10_07",
    technical_remedy_available: false,
  };
}

function collectExceptionDetails(exception, query) {
  const details = { ...(exception.details || {}) };
  let changed = false;
  for (const field of FIELDS) {
    const alias = field.aliases.find((word) => query.includes(word));
    if (!alias) continue;
    let value = query.slice(query.indexOf(alias) + alias.length).replace(/^[：:是为\s]+/u, "");
    const next = FIELDS.flatMap((item) => item.aliases).map((word) => value.indexOf(word)).filter((index) => index >= 0);
    if (next.length) value = value.slice(0, Math.min(...next));
    value = value.replace(/[，,。；;\s]+$/u, "").trim();
    if (value && value.length <= 240) { details[field.name] = value; changed = true; }
  }
  return { changed, exception: { ...exception, details } };
}

function exceptionPrompt(exception) {
  const missing = FIELDS.find((field) => !exception.details?.[field.name]);
  return `异常类别：${exception.category_name}。流程保持暂停。`
    + (missing ? `请报告${missing.label}。` : "异常口述已收集：" + FIELDS.map((field) => `${field.label}：${exception.details[field.name]}`).join("；") + "。")
    + "现有资料没有已审核的技术处置。请核对任务异常规程或地面指令；我不会自行给出处置或安全放行。";
}

module.exports = { actualException, createException, collectExceptionDetails, exceptionPrompt, ROUTES };

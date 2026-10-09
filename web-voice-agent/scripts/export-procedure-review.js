// Developer-only export. No cloud calls, approval mutation or voice runtime.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ProcedureRegistry } = require("../server/procedure-registry");
const { ExperimentRegistry } = require("../server/experiment-registry");
const ROOT = path.resolve(__dirname, "../..");
const REVIEW_DIR = path.join(ROOT, "deliverables/2026-10-08/多实验专家审核包");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const read = relative => JSON.parse(fs.readFileSync(path.join(ROOT, relative), "utf8"));

function buildReviewPackage() {
  const registry = new ProcedureRegistry();
  const experiments = new ExperimentRegistry().list();
  const allSources = [...read("knowledge_base/verified_sources.json"), ...read("knowledge_base/project_sources.json")];
  const sourceMap = new Map(allSources.map(s => [s.id, s]));
  const references = [...new Set(registry.drafts.flatMap(d => d.source_refs))];
  const draftIds = new Set(registry.drafts.map(d => d.experiment_id));
  return {
    schema_version: "1.0", prepared_on: "2026-10-08",
    status: "PREPARED_FOR_EXTERNAL_EXPERT_REVIEW_NOT_SUBMITTED",
    input_mode: "NO_AUDIO_AND_NO_EQUIPMENT", expert_reviews_received: 0,
    review_required_before_guidance: true, flight_execution_allowed: false,
    active_demo_procedures: registry.list(),
    summary: { registered_experiments: experiments.length, draft_procedures: registry.drafts.length,
      draft_steps: registry.drafts.reduce((n,d) => n + d.steps.length, 0),
      draft_exception_routes: registry.drafts.reduce((n,d) => n + d.exception_routes.length, 0),
      missing_task_detail_items: registry.drafts.reduce((n,d) => n + d.steps.reduce((m,s) => m + s.missing_details.length, 0), 0),
      approved_procedures: 0, public_source_inventory_count: read("knowledge_base/verified_sources.json").length,
    },
    drafts: registry.drafts.map(d => ({ ...d, content_sha256: sha(JSON.stringify(d)) })),
    source_inventory: references.map(id => sourceMap.get(id)),
    other_directory_items: experiments.filter(e => !draftIds.has(e.experiment_id)
      && !registry.getForExperiment(e.experiment_id)).map(e => ({ experiment_id: e.experiment_id,
      display_name: e.display_name, status: "PROCEDURE_NOT_COMPLETED", guidance_available: false })),
    limitations: ["32项是产品核对节点，不是32项已批准的科学动作。", "20条异常分支没有已审核技术补救，不能据此开盖、换水、调参或复位。",
      "植物草案未涵盖微小动物；蛋白质草案未涵盖生化分子组装。", "口述专家同意不会改变审核状态；没有已连接的专家签审系统。",
      "专家审核包尚未提交给任何专家，不代表专家已经接受或完成审核。"],
    provenance: ["web-voice-agent/config/procedure-review-drafts.js", "knowledge_base/verified_sources.json", "knowledge_base/project_sources.json"].map(relative => ({
      path: relative, sha256: sha(fs.readFileSync(path.join(ROOT, relative))),
    })),
  };
}

function toMarkdown(pkg) {
  const sourceMap = new Map(pkg.source_inventory.map(s => [s.id, s]));
  const sourceLink = id => { const s = sourceMap.get(id);
    return s.url ? `[${s.title}](${s.url})（${id}）` : `${s.title}（${id}；项目交互设计，不是科学操作依据）`; };
  const lines = ["# 多实验流程与异常分支：专家审核包", "", "准备日期：2026-10-08。状态：待外部专家审核，尚未提交，0份专家审核意见。", "",
    "本包供逐条检查，不是飞行SOP。只有水稻演示配置保持可用于软件联调，另外四套草案在运行时锁定。不能把专家姓名填入表格或口述同意当成实际授权。", "",
    `本轮：${pkg.summary.draft_procedures}套草案、${pkg.summary.draft_steps}个记录节点、${pkg.summary.draft_exception_routes}条异常分支、${pkg.summary.missing_task_detail_items}项节点任务细节待补。`, "",
    "## 请审核者提供", "", "请优先指定实际任务、载荷型号/版本、适用物种/材料、完整SOP及修订号。逐项将公开研究条件、硬件量程、任务限值分开。",
    "每条意见应包含：草案ID、版本与内容SHA-256、节点或异常ID、结论（接受/修改/拒绝/资料不足）、任务文件及页码、修订内容、负责人领域、机构、日期和正式签审文件引用。",
    "公开研究引用只说明对应背景；节点顺序、记录字段及暂停策略是项目设计，不冒充来自已批准操作手册。", "",
    "## 共通待审问题", "", "- 正常路径：完整前置条件、动作、参数单位、完成证据、不可跳步和结束条件。",
    "- 异常路径：识别依据、允许/禁止动作、谁负责、停止/恢复条件及重新核对范围。",
    "- 语音：否定/假设/模糊读数、编号冲突、误识别更正、读回确认及恢复授权。",
    "- 记录：原始数据、样品、容器、UTC、版本和交接能相互对应；口述不等于独立验证或设备遥测。", ""];
  for (const d of pkg.drafts) {
    lines.push(`## ${d.display_name}`, "", `流程ID：${d.procedure_id}；版本：${d.version}。`, "",
      `草案内容SHA-256：${d.content_sha256}`, "", `范围：${d.scope_note}`, "",
      `建议审核专业：${d.reviewer_roles.join("、")}。这些是领域建议，不是已联系的专家。`, "", "### 必须补齐的参数依据", "");
    for (const p of d.task_parameters) lines.push(`- ${p.name}；单位：${p.unit}。${p.reviewer_question} 当前批准值、规则与文件引用均为空。`);
    lines.push("", "### 节点逐项审查", "");
    for (const s of d.steps) {
      lines.push(`#### ${s.sequence}. ${s.name}（${s.step_id}）`, "", `待审语音稿：${s.spoken_instruction}`, "",
        `应记录：${s.required_inputs.map(f => f.label + (f.unit ? ` [${f.unit}]` : "") + ` (${f.type})`).join("；")}。`, "",
        "数值只有存在性检查，布尔项只记录操作者核对；均不代表真实操作许可或科学合格。", "",
        ...s.evidence_links.map(l => `背景出处：${sourceLink(l.source_id)}；关系：${l.relation}。支持：${l.supports}；不支持：${l.does_not_support}`), "",
        ...s.missing_details.map(x => `- 待任务确认：${x}`), "",
        "审核意见：待填写（结论、任务文件/页码、修订、责任人与日期）。", "");
    }
    lines.push("### 异常逐项审查", "");
    for (const r of d.exception_routes) {
      lines.push(`#### ${r.name}（${r.route_id}）`, "", `触发口述样例：${r.trigger_examples.join("；")}。这些是待评测例子，不是已验收的开放式识别能力。`, "",
        `软件响应设计：${r.software_response}`, "", `待审播报：${r.spoken_alert}`, "",
        `收集：${r.collect.join("；")}。`, "", `禁止助手擅自决定：${r.forbidden_actions.join("；")}。`, "",
        "技术处置：未提供，需专家用任务规程补全，不以暂停话术代替真实处置。", "",
        `恢复所需：${r.recovery_requirements.join("；")}。`, "",
        ...r.evidence_links.map(l => `背景出处：${sourceLink(l.source_id)}；关系：${l.relation}。支持：${l.supports}；不支持：${l.does_not_support}`), "",
        "审核意见：待填写（识别判据、允许动作、停止/恢复条件、任务文件/页码、签审）。", "");
    }
    lines.push("### 整体签审", "", "当前结论：NOT_REVIEWED。审核者、机构、日期、正式签审文件、任务SOP均未提供。", "",
      ...d.mandatory_review_checks.map(c => `- [ ] ${c}`), "",
      "正式签审后还需人工将任务规程转换为新的、可验证的流程版本，补全缺口并回归测试；此包不自动解锁。", "");
  }
  lines.push("## 其他仍未完成流程的目录项", "", ...pkg.other_directory_items.map(e => `- ${e.display_name}：流程未完成。`), "",
    "## 本包引用来源及访问范围", "");
  for (const s of pkg.source_inventory) lines.push(`### ${s.id}`, "", sourceLink(s.id), "",
    `核查日期：${s.checked_on || "项目设计或此前元数据未登记；不补写"}。实际范围：${s.verification_scope || s.scope || "未登记"}。`, "",
    `局限：${s.limits || s.authority || "按具体任务审核"}`, "");
  return lines.join("\n");
}

function exportReviewPackage() {
  const pkg = buildReviewPackage();
  const contents = new Map([
    ["多实验专家审核包.md", toMarkdown(pkg)],
    ["流程与异常待审快照.json", JSON.stringify(pkg, null, 2) + "\n"],
    ["专家反馈模板.json", JSON.stringify({ status: "NOT_REVIEWED", reviewed_on: null,
      reviewer: null, organization: null, signed_document_reference: null,
      instruction: "请另存副本填写。本模板不授予操作权限，也不会由产品自动加载。",
      reviews: pkg.drafts.map(d => ({ procedure_id: d.procedure_id, version: d.version,
        content_sha256: d.content_sha256, task_sop_reference: null, disposition: "NOT_REVIEWED",
        step_comments: d.steps.map(s => ({ step_id: s.step_id, disposition: "NOT_REVIEWED", authority_page: null, comment: null })),
        exception_comments: d.exception_routes.map(r => ({ route_id: r.route_id, disposition: "NOT_REVIEWED", authority_page: null,
          approved_remedy: null, recovery_conditions: null, comment: null })),
      })),
    }, null, 2) + "\n"],
  ]);
  // Resolve exact export targets and refuse overwrites, preserving reviewer edits.
  if (!REVIEW_DIR.startsWith(ROOT + path.sep)) throw new Error("EXPORT_TARGET_OUTSIDE_PROJECT");
  for (const name of contents.keys()) if (fs.existsSync(path.join(REVIEW_DIR, name))) throw new Error("REVIEW_EXPORT_EXISTS");
  fs.mkdirSync(REVIEW_DIR, { recursive: true });
  for (const [name, text] of contents) fs.writeFileSync(path.join(REVIEW_DIR, name), text, { encoding: "utf8", flag: "wx" });
  return { status: pkg.status, summary: pkg.summary, files: [...contents.keys()].map(name => ({
    path: path.join(REVIEW_DIR, name), sha256: sha(fs.readFileSync(path.join(REVIEW_DIR, name))),
  })) };
}
if (require.main === module) console.log(JSON.stringify(exportReviewPackage(), null, 2));
module.exports = { buildReviewPackage, toMarkdown, exportReviewPackage };

class SkillSafetyGate {
  evaluate({ session, experiment, skill, requestedAction }) {
    const blockers = [];

    if (!experiment) blockers.push("未选择已登记实验");
    if (!skill) blockers.push("当前实验没有加载经过任务级审核的 Skill");
    if (skill && skill.sop_status !== "APPROVED") {
      blockers.push(`Skill 审核状态为 ${skill.sop_status}`);
    }
    if (skill && skill.execution_policy !== "ALLOW_AFTER_CONFIRMATION") {
      blockers.push("Skill 执行策略未允许在当前环境执行");
    }
    if (!session?.current_step) blockers.push("当前没有经过确认的实验步骤");
    if (!requestedAction) blockers.push("语音意图尚未映射为已审核动作");
    if (skill && requestedAction && !(skill.actions || []).includes(requestedAction)) {
      blockers.push("请求动作不在 Skill 的允许动作清单中");
    }
    if (skill && skill.required_confirmations?.ground_command && session?.confirmations?.ground_command !== true) {
      blockers.push("缺少地面指令确认");
    }

    return {
      allowed: blockers.length === 0,
      blockers,
      summary: blockers.length === 0
        ? "安全闸门检查通过。"
        : `安全闸门阻断执行：${blockers.join("；")}。`,
    };
  }
}

module.exports = { SkillSafetyGate };

const { actualException } = require("./exception-assistant");

function normalizeUtterance(query) {
  return String(query || "").normalize("NFKC").trim();
}

function classifyVoiceIntent(query) {
  const text = normalizeUtterance(query);
  const command = text.replace(/[\s，。！？、,.!?]/gu, "").replace(/^请/u, "");
  if (/^(你好|您好|在吗|帮助|语音帮助|使用帮助|你是谁|你能做什么|怎么使用|我该怎么开始)$/u.test(command)) return "HELP";
  if (/^(保存记录|保存实验记录|导出记录|导出实验记录|下载记录)$/u.test(command)) return "EXPORT_RECORD";
  if (/^(历史记录|查看历史记录|查看已保存记录|查看归档记录)$/u.test(command)) return "RECORD_HISTORY";
  if (/^(重新开始|重新开始流程|重新开始实验|开始新任务)$/u.test(command)) return "RESTART_TASK";
  if (/^(确认切换|确认重新开始)$/u.test(command)) return "CONFIRM_TASK_CHANGE";
  if (/^(取消切换|取消重新开始|取消任务变更)$/u.test(command)) return "CANCEL_TASK_CHANGE";
  if (/^(查看|查询|介绍|讲解).*(流程草案|待审流程|待审核流程|审核缺口)$/u.test(command)) return "REVIEW_DRAFT";
  if (/^(当前状态|查询状态|报告状态|现在到哪一步了?|当前步骤是什么|做到哪一步了?|进度如何|我现在做到哪里了|咱们做到哪了)$/u.test(command)) return "STATUS";
  if (/^(重复|再说一遍|重复一遍|重复当前步骤|重复刚才的指令|重说一遍|没听清)$/u.test(command)) return "REPEAT";
  if (/^(总结|实验总结|总结当前进度|总结已记录数据|读回数据|汇报记录)$/u.test(command)) return "SUMMARY";
  if (/^(有哪些实验|支持哪些实验|列出实验|实验列表)$/u.test(command)) return "LIST_EXPERIMENTS";
  if (/^(受影响对象|异常对象|异常现象|观察现象|已采取处置|已采取措施|已经做的处理)/u.test(command)
    && !/[?？]|是什么|有哪些|怎么报告/u.test(text)) return "EXCEPTION_DETAILS";
  if (/^(这一步怎么做|这步要报什么|当前步骤需要什么|需要我报告什么|这一步还缺什么|本步还缺什么|具体怎么操作|怎么剪取|怎么封装)$/u.test(command)) return "STEP_HELP";
  // A real fault report remains an exception even when followed by "怎么办".
  if (actualException(text)) return "EXCEPTION";
  // Questions and hypothetical statements must never become measured values or commands.
  if (/[?？]/u.test(text) || /(为什么|为何|怎么|怎样|如何|什么|啥|哪些|哪几|哪两|哪种|哪个|哪里|哪儿|多久|几天|几档|多长|多少|能否|能不能|是否|吗|如果|假如|假设|解释|介绍|说说|讲讲|查询资料|参考来源|论文|文献)/u.test(text)) return "KNOWLEDGE";
  if (/^(重新核对本步|重新核对本步骤|重新核对当前步骤|重新报告本步|重新报告本步骤)$/u.test(command)) return "RECHECK_STEP";
  if (/^(暂停|暂停流程|暂停实验|停止|停止流程|先停一下)$/u.test(command)) return "PAUSE";
  if (/(恢复|恢复引导|恢复流程)/u.test(text)) return "RESUME";
  if (/^(确认|确认无误|确认并继续|确认完成|确认下一步|下一步|继续|继续下一步|没问题|正确|是的|对|已完成|完成)$/u.test(command)) return "CONFIRM";
  if (/(切换|选择|使用)(到)?/u.test(text) || /^进入/u.test(command)) return "SELECT";
  if (/^(开始|启动|开展|执行)/u.test(command)) return "START";
  return "FEEDBACK";
}

module.exports = { classifyVoiceIntent, normalizeUtterance };

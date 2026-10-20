const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { KnowledgeRetriever } = require('./knowledge-retriever');
const { localServiceUrl } = require('./frontend-server');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const MODULES = [
  { id: 'ui', name: 'UI设计', subtitle: '演示界面与页面资源', description: '现有普通模式页面独立运行。陪伴模式在后续阶段接入。',
    files: ['web-voice-agent/public/index.html', 'web-voice-agent/public/styles.css', 'web-voice-agent/public/app.js', 'web-voice-agent/public/dashboard.js'] },
  { id: 'knowledge', name: '知识库搭建', subtitle: '问答、出处与检索', description: '查看当前已登记知识与公开来源，保留资料的适用边界。',
    files: ['knowledge_base/records.json', 'knowledge_base/qa-core.json', 'knowledge_base/qa-expanded.json', 'knowledge_base/qa-rice-2026-10.json', 'knowledge_base/verified_sources.json', 'knowledge_base/project_sources.json'] },
  { id: 'skills', name: 'Skills增强', subtitle: '任务规则与能力配置', description: '查看任务规则、流程目录及审核状态。',
    files: ['web-voice-agent/config/SKILL_V2.md', 'web-voice-agent/config/behavior-policy.json', 'web-voice-agent/config/experiment-skills.json', 'web-voice-agent/config/procedure-guides.json'] },
  { id: 'prompts', name: '提示词工程', subtitle: '人设、表达与追问规范', description: '查看当前角色及提示词文件。实际流程同时受后端规则约束。',
    files: ['web-voice-agent/config/persona.json', 'web-voice-agent/config/persona.md', 'web-voice-agent/config/system-prompt-v2.md'] },
  { id: 'voice', name: '音色配置', subtitle: '识别、TTS与播报参数', description: '运行状态来自实际Agent服务；配置齐全后仍需录音验收。',
    files: ['web-voice-agent/config/voice.json', 'web-voice-agent/server/asr-adapters.js', 'web-voice-agent/server/tts-adapters.js', 'web-voice-agent/server/baidu-speech.js'] },
];

function readFile(relative) { return fs.readFileSync(path.join(PROJECT_ROOT, relative), 'utf8'); }
function readJson(relative) { return JSON.parse(readFile(relative)); }
function fileInfo(relative) {
  try {
    const bytes = fs.readFileSync(path.join(PROJECT_ROOT, relative));
    return { path: relative, available: true, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch { return { path: relative, available: false }; }
}

function publicSpeech(value, isTts = false) {
  return {
    configured: value?.configured === true,
    provider: typeof value?.upstream_provider === 'string' ? value.upstream_provider.slice(0, 50) : null,
    ...(isTts ? {
      voice_name: typeof value?.target_voice === 'string' ? value.target_voice.slice(0, 100) : null,
      voice_id: Number.isSafeInteger(value?.voice_id) ? value.voice_id : null,
      service: typeof value?.service === 'string' ? value.service.slice(0, 50) : null,
    } : {}),
  };
}

class AdminService {
  constructor({ backendUrl = 'http://127.0.0.1:8100/', demoUrl = 'http://127.0.0.1:8120/', request = fetch, now = () => new Date() } = {}) {
    this.backendUrl = localServiceUrl(backendUrl).origin;
    this.demoUrl = localServiceUrl(demoUrl).origin;
    this.request = request;
    this.now = now;
    this.runtimeCookie = null;
  }

  async runtime() {
    const signal = AbortSignal.timeout(2500);
    try {
      const health = await this.request(this.backendUrl + '/api/health', { signal, redirect: 'error' });
      if (!health.ok || (await health.json()).service !== 'space-experiment-voice-agent') throw new Error();
      const granted = await this.request(this.backendUrl + '/api/access', {
        method: 'POST', signal, redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'X-Voice-Agent-Request': '1', ...(this.runtimeCookie ? { Cookie: this.runtimeCookie } : {}) }, body: '{}',
      });
      if (!granted.ok) return { reachable: true, authorized: false, message: '服务可达，但当前管理检查未获访问。' };
      const cookie = granted.headers.get('set-cookie')?.split(';')[0] || this.runtimeCookie;
      if (!cookie?.startsWith('va_owner=')) throw new Error();
      this.runtimeCookie = cookie;
      // A separate, short-lived read-only visitor; never create or mutate a task.
      const [voiceReply, capsReply] = await Promise.all([
        this.request(this.backendUrl + '/api/voice/config', { headers: { Cookie: cookie }, signal, redirect: 'error' }),
        this.request(this.backendUrl + '/api/capabilities', { headers: { Cookie: cookie }, signal, redirect: 'error' }),
      ]);
      if (!voiceReply.ok || !capsReply.ok) throw new Error();
      const [voice, caps] = await Promise.all([voiceReply.json(), capsReply.json()]);
      return {
        reachable: true, authorized: true,
        version: typeof caps.application_version === 'string' ? caps.application_version.slice(0, 80) : null,
        asr: publicSpeech(voice.asr), tts: publicSpeech(voice.tts, true),
        general_llm_connected: caps.general_llm_connected === true,
        storage: ['SQLITE', 'BOUNDED_PROCESS_MEMORY'].includes(caps.session_storage) ? caps.session_storage : null,
        message: '已读取运行服务状态；未调用云语音，也未修改实验会话。',
      };
    } catch { return { reachable: false, authorized: false, message: '未连接到Agent服务，请检查语音启动窗口和服务地址。' }; }
  }

  async overview() {
    const retriever = new KnowledgeRetriever();
    const knowledge = {
      available: retriever.getStatus().available,
      question_count: retriever.records.filter(r => r.questions?.length && retriever.getRecord(r.record_id)).length,
      public_source_count: [...retriever.sources.values()].filter(s => s.url || s.public_record).length,
    };
    const procedure = readJson('web-voice-agent/config/procedure-guides.json');
    const persona = readJson('web-voice-agent/config/persona.json');
    const policy = readJson('web-voice-agent/config/behavior-policy.json');
    const experiments = readJson('web-voice-agent/config/experiments.json');
    const runtime = await this.runtime();
    return {
      stage: 'FRONTEND_ADMIN_SEPARATION', read_only: true,
      inspected_at: this.now().toISOString(),
      workspace_version: readJson('web-voice-agent/package.json').version,
      demo_url: this.demoUrl + '/', backend_url: this.backendUrl + '/', runtime,
      knowledge,
      experiments: { count: experiments.experiments.length, demo_count: procedure.procedures.filter(p => p.guidance_mode === 'PROJECT_DEMO').length,
        approved_count: procedure.procedures.filter(p => p.sop_status === 'APPROVED').length },
      persona: { name: persona.agent_name, role: persona.role, tones: persona.conversation_style.tone },
      policy: { version: policy.version, prompt_revision: policy.prompt_revision },
      modules: MODULES.map(item => ({ ...item, files: item.files.map(fileInfo), editable: false })),
    };
  }

  detail(id) {
    const item = MODULES.find(module => module.id === id);
    if (!item) return null;
    const contentFiles = id === 'skills' ? ['web-voice-agent/config/SKILL_V2.md']
      : id === 'prompts' ? ['web-voice-agent/config/system-prompt-v2.md', 'web-voice-agent/config/persona.json']
      : id === 'voice' ? ['web-voice-agent/config/voice.json'] : [];
    return { ...item, editable: false, files: item.files.map(fileInfo),
      documents: contentFiles.map(file => ({ path: file, content: readFile(file) })) };
  }
}

module.exports = { AdminService, MODULES };

const voiceButton = document.querySelector("#voiceButton");
const stopSpeakingButton = document.querySelector("#stopSpeakingButton");
const statusLabel = document.querySelector("#status");
const experimentStatus = document.querySelector("#experimentStatus");
const experimentName = document.querySelector("#experimentName");
const currentStep = document.querySelector("#currentStep");
const guidanceState = document.querySelector("#guidanceState");
const supportMessage = document.querySelector("#supportMessage");
const voiceButtonLabel = document.querySelector("#voiceButtonLabel");

let session = null;
let recognition = null;
let voiceConfig = null;
let mediaRecorder = null;
let mediaStream = null;
let currentAudio = null;
let currentAudioUrl = null;
let cancelAudioPlayback = null;
let playbackController = null;
let playbackGeneration = 0;
let recordingTimer = null;
let busy = false;
let recordDownloadUrl = null;
let browserListening = false;

const STATUS_LABELS = {
  IDLE: "等待实验",
  CONTEXT_SELECTED: "实验已选择",
  GUIDING: "步骤引导中",
  PAUSED: "流程已暂停",
  EXCEPTION_REPORTED: "异常待处理",
  COMPLETED: "交互核对已完成",
};

const RESPONSE_LABELS = {
  SESSION_LOADED: "已加载任务状态",
  VOICE_HELP: "语音使用帮助已生成",
  RECORD_EXPORT: "记录文件已生成，请确认下载成功",
  RECORD_HISTORY: "历史归档已查询，当前任务未改变",
  TASK_CHANGE_REQUIRED: "等待单独确认任务变更",
  TASK_CHANGE_CANCELLED: "任务变更已取消",
  KNOWLEDGE_QUERY_CANCELLED: "知识查询已取消，实验状态保留",
  EXPERIMENT_SELECTED: "已切换实验上下文",
  STEP_GUIDANCE: "步骤引导已生成，准备播报",
  STEP_WAITING_INPUT: "等待当前步骤反馈",
  STEP_AWAITING_CONFIRMATION: "数据读回已生成，等待语音确认",
  STEP_INPUT_AMBIGUOUS: "反馈不明确，等待补充",
  STEP_RULE_CONFLICT: "规则冲突，暂停相关判定",
  COMMAND_NOT_EXECUTED: "已保留当前任务状态",
  OUT_OF_SCOPE: "请查询在轨实验相关知识或任务",
  STEP_RECHECK_STARTED: "本步待重新报告，原报告已留痕",
  STEP_RECHECK_BLOCKED: "流程保持暂停，尚不能重新核对",
  GUIDANCE_STATUS: "当前进度已生成，准备播报",
  GUIDANCE_REPEATED: "复述内容已生成，准备播报",
  GUIDANCE_SUMMARY: "实验记录总结已生成，准备播报",
  GUIDANCE_RESUMED: "已恢复原步骤",
  EXPERIMENT_LIST: "实验目录已生成，准备播报",
  VALIDATION_FAILED: "校验失败，流程已暂停",
  GUIDANCE_PAUSED: "流程引导已暂停",
  EXCEPTION_REPORTED: "异常已记录",
  EXCEPTION_DETAILS_RECORDED: "异常详情已记录，流程保持暂停",
  STEP_HELP: "当前步骤核对说明已生成",
  PROCEDURE_REVIEW_REQUIRED: "缺少已审核任务流程，未开始真实操作引导",
  PROCEDURE_DRAFT_OVERVIEW: "待审草案说明已生成，不改变实验状态",
  PROCEDURE_VERSION_MISMATCH: "旧记录已保留；说重新开始，再单独确认新任务",
  RESUME_REQUIRES_CONFIRMATION: "等待恢复确认",
  PROCEDURE_COMPLETED: "流程已完成",
  PROCEDURE_UNAVAILABLE: "当前实验暂无可用流程",
  KNOWLEDGE_ANSWER: "有出处的知识回复已生成，准备播报",
  SOURCE_CONFLICT: "来源冲突提示已生成，准备播报",
  KNOWLEDGE_MISSING: "知识库未找到依据",
  KNOWLEDGE_UNAVAILABLE: "题库检索当前不可用",
  KNOWLEDGE_RETRIEVAL_FAILED: "本次检索失败，任务状态保留",
  KNOWLEDGE_CLARIFICATION: "等待澄清知识问题",
  KNOWLEDGE_NO_TELEMETRY: "未连接设备，等待口述读数",
  KNOWLEDGE_SOP_REQUIRED: "需要任务级审核依据",
  EXPERIMENT_UNREGISTERED: "实验未登记",
  EXPERIMENT_REQUIRED: "需要先选择实验",
};

function setStatus(message) {
  statusLabel.textContent = message;
}

function setVoicePhase(phase) { window.VoiceDashboard?.phase(phase); }

async function grantAccess() {
  const hash = window.location?.hash || "";
  let token = "";
  if (hash.startsWith("#access=")) {
    // Fragment is not sent to the server or in referrers; remove it from this history entry.
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    token = decodeURIComponent(hash.slice(8));
  }
  const response = await window.VoiceNetwork.request("/api/access", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Voice-Agent-Request": "1" },
    credentials: "same-origin", body: JSON.stringify({ token }),
  });
  if (!response.ok) throw new Error(response.status === 401 ? "DEMO_ACCESS_REQUIRED" : "ACCESS_FAILED");
}

function stopPlayback() {
  playbackGeneration += 1;
  playbackController?.abort();
  playbackController = null;
  cancelAudioPlayback?.();
  cancelAudioPlayback = null;
  currentAudio?.pause();
  currentAudio = null;
  if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
  currentAudioUrl = null;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  setVoicePhase(voiceConfig?.asr?.configured ? "READY" : "PENDING");
}

function playAudioBlob(blob, generation) {
  if (generation !== playbackGeneration) return Promise.resolve(false);
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  currentAudio = audio;
  currentAudioUrl = url;
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error = null, played = true) => {
      if (finished) return;
      finished = true;
      audio.onended = null;
      audio.onerror = null;
      URL.revokeObjectURL(url);
      if (currentAudio === audio) {
        currentAudio = null;
        currentAudioUrl = null;
        cancelAudioPlayback = null;
      }
      if (error) reject(error);
      else resolve(played);
    };
    cancelAudioPlayback = () => { audio.pause(); finish(null, false); };
    audio.onended = () => finish();
    audio.onerror = () => finish(new Error("TTS_AUDIO_PLAYBACK_FAILED"));
    audio.play().catch((error) => finish(error));
  });
}

async function speak(text) {
  stopPlayback();
  setVoicePhase("SPEAKING");
  const generation = playbackGeneration;
  let playedChunks = 0;
  if (voiceConfig?.tts?.configured === true && voiceConfig.tts.endpoint) {
    const controller = new AbortController();
    playbackController = controller;
    try {
      const chunks = voiceConfig.tts.chunking ? VoiceAudioTools.splitSpeechText(text, voiceConfig.tts.chunking) : [text];
      for (const chunk of chunks) {
        if (generation !== playbackGeneration) return;
        const response = await window.VoiceNetwork.request(voiceConfig.tts.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Voice-Agent-Request": "1" },
          body: JSON.stringify({ text: chunk }),
          signal: controller.signal,
        }, { type: "blob" });
        if (!response.ok) throw new Error("TTS_SERVER_FAILED");
        const played = await playAudioBlob(response.data, generation);
        if (!played || generation !== playbackGeneration) return;
        playedChunks += 1;
      }
      return;
    } catch {
      if (generation !== playbackGeneration || controller.signal.aborted) return;
      if (playedChunks > 0) {
        supportMessage.textContent = "后续播报中断，请重新录音说“再说一遍”。";
        return;
      }
      supportMessage.textContent = "所选音色播报失败，未切换音色；任务状态保留。请稍后说“再说一遍”。";
      return;
    } finally {
      if (playbackController === controller) playbackController = null;
      if (generation === playbackGeneration) setVoicePhase(voiceConfig?.asr?.configured ? "READY" : "PENDING");
    }
  }
  if (generation !== playbackGeneration) return;
  if (voiceConfig?.tts?.browser_playback_allowed !== true) {
    supportMessage.textContent = "所选音色尚未配置，未使用浏览器默认音色。";
    setVoicePhase("PENDING");
    return;
  }
  if (!("speechSynthesis" in window)) {
    supportMessage.textContent = "当前浏览器不支持语音播报。";
    setVoicePhase("ERROR");
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = voiceConfig?.tts?.language || "zh-CN";
  utterance.rate = voiceConfig?.tts?.rate || 0.95;
  utterance.pitch = voiceConfig?.tts?.pitch || 1;
  utterance.volume = voiceConfig?.tts?.volume || 1;
  utterance.onstart = () => { if (generation === playbackGeneration) setVoicePhase("SPEAKING"); };
  utterance.onend = () => { if (generation === playbackGeneration) setVoicePhase(voiceConfig?.asr?.configured ? "READY" : "PENDING"); };
  utterance.onerror = () => { if (generation === playbackGeneration) { setVoicePhase("ERROR"); supportMessage.textContent = "浏览器播报未完成，请检查浏览器音频支持。"; } };
  window.speechSynthesis.speak(utterance);
}

function updateSessionView(result) {
  session = result.session;
  experimentStatus.textContent = STATUS_LABELS[session.status] || session.status;
  experimentName.textContent = result.experiment?.display_name || "未选择";
  currentStep.textContent = result.procedure?.current_step_name
    || (session.current_step ? session.current_step : "等待实验选择");
  guidanceState.textContent = RESPONSE_LABELS[result.response_type] || "已收到语音响应";
  window.VoiceDashboard?.update(result);
}

async function createSession() {
  const response = await window.VoiceNetwork.request("/api/session", { method: "POST",
    headers: { "Content-Type": "application/json", "X-Voice-Agent-Request": "1" }, body: "{}" });
  if (!response.ok) throw new Error(response.data?.error || "SESSION_FAILED");
  session = response.data;
  experimentStatus.textContent = STATUS_LABELS[session.status] || session.status;
}

async function restoredProgress() {
  if (!session?.session_id) return null;
  const response = await window.VoiceNetwork.request("/api/progress?session_id=" + encodeURIComponent(session.session_id));
  if (response.status === 404) return null; // Older running 1.0 servers have no detailed-progress endpoint.
  if (!response.ok) throw new Error("PROGRESS_RESTORE_FAILED");
  return response.data.progress;
}

async function sendRecognizedText(recognizedText) {
  window.VoiceDashboard?.heard?.(recognizedText);
  setStatus("正在处理语音指令");
  setVoicePhase("PROCESSING");
  const response = await window.VoiceNetwork.voiceTurn({ session_id: session.session_id, recognized_text: recognizedText,
    request_id: window.crypto.randomUUID(), expected_revision: session.revision });
  const result = response.data;
  if (!response.ok) {
    if (response.status === 409) {
      await createSession();
      updateSessionView({ session, ...(window.VoiceDashboard?.context(session) || {}), progress: await restoredProgress(), response_type: "SESSION_LOADED" });
    }
    const error = new Error(result.error || "VOICE_TURN_FAILED");
    error.userMessage = /^RECORD_/u.test(result.error || "")
      ? "本轮记录未能保存，步骤未提交。请检查服务端存储；恢复后先查询当前状态。"
      : response.status === 401 || response.status === 404
        ? "演示访问或会话已过期，请刷新后重新核对任务状态。" : "指令未执行或结果需要重新核对，请说当前状态后再报告。";
    throw error;
  }
  updateSessionView(result);
  if (result.record_export) downloadRecord(result.record_export);
  if (result.record_history) showRecordHistory(result.record_history);
  setStatus("已收到回复，准备播报");
  speak(result.speech_text).catch(() => { supportMessage.textContent = "播报未完成，请重新报告或请求复述。"; });
}

function showRecordHistory(records) {
  const list = document.querySelector("#recordHistory");
  if (!list) return;
  list.replaceChildren();
  list.hidden = records.length === 0;
  for (const record of records) {
    if (!/^session_[a-f0-9]{48}-\d{1,16}$/u.test(record.id)) continue;
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = `/api/records/${record.id}`;
    link.textContent = `${record.experiment_name} · ${record.created_at} · 已确认${record.completed_steps}步`;
    link.download = `experiment-${record.id}.json`;
    item.append(link); list.append(item);
  }
}

function downloadRecord(record) {
  const link = document.querySelector("#recordDownload");
  if (recordDownloadUrl) URL.revokeObjectURL(recordDownloadUrl);
  recordDownloadUrl = URL.createObjectURL(new Blob([JSON.stringify(record.data, null, 2)], { type: "application/json" }));
  link.href = recordDownloadUrl;
  link.download = record.filename;
  link.hidden = false;
  link.click();
}

function setRecordingButton(isRecording) {
  voiceButton.classList.toggle("listening", isRecording);
  voiceButtonLabel.textContent = isRecording ? "提交语音" : "开始聆听";
  voiceButton.setAttribute?.("aria-pressed", String(isRecording));
  if (isRecording) setVoicePhase("LISTENING");
}

function getRecordingMimeType() {
  const preferred = voiceConfig?.asr?.input || "audio/webm;codecs=opus";
  if (window.MediaRecorder?.isTypeSupported?.(preferred)) return preferred;
  if (window.MediaRecorder?.isTypeSupported?.("audio/webm")) return "audio/webm";
  return "";
}

async function startRecording() {
  if (busy) return;
  stopPlayback();
  if (window.isSecureContext === false) {
    supportMessage.textContent = "麦克风需要安全上下文：请使用HTTPS部署地址或本机localhost。";
    setStatus("当前地址无法安全录音"); setVoicePhase("ERROR"); return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    supportMessage.textContent = "当前浏览器不支持服务端录音上传，请使用支持 MediaRecorder 的 Chrome 或 Edge。";
    setStatus("录音能力不可用");
    return;
  }

  busy = true;
  voiceButton.disabled = true;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const stream = mediaStream;
    const mimeType = getRecordingMimeType();
    mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
    const recorder = mediaRecorder;
    const chunks = [];
    let failed = false;
    const recordingFailed = () => {
      if (failed || mediaRecorder !== recorder) return;
      failed = true;
      clearTimeout(recordingTimer); recordingTimer = null;
      recorder.onstop = null;
      if (recorder.state === "recording") { try { recorder.stop(); } catch {} }
      stream.getTracks().forEach(track => track.stop());
      if (mediaStream === stream) mediaStream = null;
      chunks.length = 0;
      setRecordingButton(false);
      busy = false; voiceButton.disabled = false;
      setStatus("录音中断，请重新录音");
      supportMessage.textContent = "这段录音没有提交，实验步骤保持原状态。请检查麦克风连接后重新报告。";
      setVoicePhase("ERROR");
    };
    recorder.onerror = recordingFailed;
    stream.getTracks().forEach(track => track.addEventListener?.("ended", () => {
      if (recorder.state === "recording") recordingFailed();
    }, { once: true }));
    recorder.ondataavailable = (event) => {
      if (!failed && event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      if (failed || mediaRecorder !== recorder) return;
      clearTimeout(recordingTimer);
      recordingTimer = null;
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      stream.getTracks().forEach((track) => track.stop());
      if (mediaStream === stream) mediaStream = null;
      if (!blob.size) {
        busy = false; voiceButton.disabled = false;
        setRecordingButton(false); setVoicePhase("ERROR");
        setStatus("未采集到录音，请重新报告");
        return;
      }
      uploadRecording(blob).catch((error) => {
        if (error.message === "ASR_NOT_CONFIGURED") {
          setStatus("服务端 ASR 尚未配置");
          supportMessage.textContent = "录音已上传，但服务端还没有配置实际语音识别供应商。";
        } else {
          setStatus("语音上传失败");
          const messages = {
            AUDIO_CONVERSION_UNAVAILABLE: "当前浏览器不支持录音转换，请使用较新的Chrome或Edge。",
            AUDIO_DECODE_FAILED: "录音无法转换，请重新录音或换用Chrome、Edge。",
            ASR_AUDIO_TOO_LONG: "单次录音过长，请分段报告。",
          };
          supportMessage.textContent = error.userMessage || messages[error.message] || "请检查服务端语音识别配置或网络连接。";
        }
        busy = false;
        voiceButton.disabled = false;
        setVoicePhase("ERROR");
      });
    };
    mediaRecorder.start();
    if (voiceConfig?.asr?.max_recording_seconds) {
      recordingTimer = setTimeout(() => stopRecording(), voiceConfig.asr.max_recording_seconds * 1000);
    }
    setRecordingButton(true);
    setStatus("请说话，再次点击结束聆听");
  } catch (error) {
    clearTimeout(recordingTimer);
    recordingTimer = null;
    mediaStream?.getTracks().forEach((track) => track.stop());
    mediaStream = null;
    setRecordingButton(false);
    setVoicePhase("ERROR");
    if (error.name === "NotAllowedError") {
      setStatus("麦克风权限未允许");
      supportMessage.textContent = "请在浏览器地址栏中允许本页面使用麦克风。";
    } else {
      setStatus("无法开始录音");
      supportMessage.textContent = error.message || "当前浏览器无法访问麦克风。";
    }
  } finally { busy = false; voiceButton.disabled = false; }
}

function stopRecording() {
  clearTimeout(recordingTimer);
  recordingTimer = null;
  if (mediaRecorder?.state === "recording") {
    setRecordingButton(false);
    setStatus("正在上传语音");
    setVoicePhase("PROCESSING");
    busy = true;
    voiceButton.disabled = true;
    mediaRecorder.stop();
  }
}

async function uploadRecording(blob) {
  if (voiceConfig?.asr?.upstream_provider === "baidu") {
    setStatus("正在处理录音");
    blob = await VoiceAudioTools.toBaiduPcm(blob);
  }
  const response = await window.VoiceNetwork.request(voiceConfig?.asr?.endpoint || "/api/asr/transcribe", {
    method: "POST",
    headers: { "Content-Type": blob.type || "audio/webm", "X-Voice-Agent-Request": "1" },
    body: blob,
  });
  const result = response.data;
  if (!response.ok) {
    const error = new Error(result.error || "ASR_UPLOAD_FAILED");
    error.userMessage = result.message;
    throw error;
  }
  if (!result.text) throw new Error("ASR_EMPTY_RESULT");
  await sendRecognizedText(result.text);
  busy = false;
  voiceButton.disabled = false;
}

function buildBrowserRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return null;
  const instance = new Recognition();
  instance.lang = voiceConfig?.asr?.language || "zh-CN";
  instance.continuous = voiceConfig?.asr?.continuous || false;
  instance.interimResults = voiceConfig?.asr?.interim_results || false;
  instance.maxAlternatives = voiceConfig?.asr?.max_alternatives || 1;
  instance.onstart = () => {
    browserListening = true;
    setRecordingButton(true);
    setStatus("请说话");
  };
  instance.onend = () => { browserListening = false; setRecordingButton(false); };
  instance.onerror = (event) => {
    setRecordingButton(false);
    const message = event.error === "network"
      ? "浏览器语音服务连接失败，请改用服务端 ASR。"
      : `浏览器语音识别失败：${event.error}`;
    setStatus(message);
  };
  instance.onresult = (event) => {
    const text = event.results[0][0].transcript;
    busy = true;
    voiceButton.disabled = true;
    sendRecognizedText(text)
      .catch(() => setStatus("服务端暂时不可用"))
      .finally(() => {
        busy = false;
        voiceButton.disabled = false;
      });
  };
  return instance;
}

voiceButton.addEventListener("click", () => {
  if (busy) return;
  if (!voiceConfig || (voiceConfig.asr?.provider !== "browser" && !voiceConfig.asr?.configured)) {
    setStatus("语音配置暂缓，其他模块可检查"); setVoicePhase("PENDING"); return;
  }
  if (voiceConfig?.asr?.provider === "browser") {
    if (!recognition) {
      setStatus("当前浏览器不支持语音识别");
      return;
    }
    stopPlayback();
    try {
      if (browserListening) recognition.stop();
      else { browserListening = true; recognition.start(); }
    } catch { browserListening = false; setStatus("无法启动识别，请稍后重试"); }
    return;
  }
  if (mediaRecorder?.state === "recording") stopRecording();
  else startRecording();
});

stopSpeakingButton.addEventListener("click", () => {
  stopPlayback();
  setStatus("已停止播报");
});

async function bootstrap() {
  await grantAccess();
  const [configResponse, capabilitiesResponse, experimentsResponse, proceduresResponse, readinessResponse] = await Promise.all([
    window.VoiceNetwork.request("/api/voice/config"),
    window.VoiceNetwork.request("/api/capabilities"), window.VoiceNetwork.request("/api/experiments"), window.VoiceNetwork.request("/api/procedures"),
    window.VoiceNetwork.request("/api/readiness"),
    createSession(),
  ]);
  if (![configResponse, capabilitiesResponse, experimentsResponse, proceduresResponse, readinessResponse].every((response) => response.ok)) throw new Error("VOICE_CONFIG_FAILED");
  voiceConfig = configResponse.data;
  window.VoiceDashboard?.load({ voice: voiceConfig, capabilities: capabilitiesResponse.data,
    experimentData: experimentsResponse.data, procedureData: proceduresResponse.data });
  const context = window.VoiceDashboard?.context(session) || {};
  updateSessionView({ session, ...context, progress: await restoredProgress(), response_type: "SESSION_LOADED" });
  voiceButton.disabled = true;
  if (!readinessResponse.data.configuration_ready) {
    supportMessage.textContent = `${readinessResponse.data.message}接齐配置并重启服务后，刷新本页。`;
    voiceButtonLabel.textContent = "语音待接入";
    setVoicePhase("PENDING");
  } else if (voiceConfig.asr?.provider === "browser") {
    recognition = buildBrowserRecognition();
    voiceButton.disabled = !recognition;
    if (!recognition) supportMessage.textContent = "当前浏览器没有提供语音识别能力，请更换支持语音输入的浏览器。";
  } else if (window.isSecureContext === false || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    supportMessage.textContent = "当前浏览器不支持服务端录音上传，请更换支持 MediaRecorder 的浏览器。";
  } else if (voiceConfig.asr?.configured !== true) {
    supportMessage.textContent = "语音配置暂缓。知识、流程与部署准备已加载；当前不会录音或上传。";
    voiceButtonLabel.textContent = "语音待接入";
  } else { voiceButton.disabled = false; voiceButtonLabel.textContent = "开始聆听"; }
  setStatus(voiceButton.disabled ? "语音尚不可用，可查看已加载内容" : "等待语音报告");
}

window.addEventListener?.("pagehide", () => {
  clearTimeout(recordingTimer);
  if (mediaRecorder) { mediaRecorder.onstop = null; if (mediaRecorder.state === "recording") mediaRecorder.stop(); }
  mediaStream?.getTracks().forEach(track => track.stop());
  recognition?.abort();
  stopPlayback();
  if (recordDownloadUrl) URL.revokeObjectURL(recordDownloadUrl);
});

const bootstrapReady = bootstrap().catch((error) => {
  voiceButton.disabled = true; setVoicePhase("ERROR");
  setStatus(error.message === "DEMO_ACCESS_REQUIRED" ? "需要演示访问授权" : "服务检查未完成");
  supportMessage.textContent = error.message === "DEMO_ACCESS_REQUIRED"
    ? "请使用负责人提供的受限演示链接；页面没有文字聊天入口。"
    : /^RECORD_/u.test(error.message) ? "保存的记录暂时无法读取。请保留数据文件并检查服务端存储，未创建替代任务。"
    : "请检查本地服务或部署配置，然后刷新页面。";
});

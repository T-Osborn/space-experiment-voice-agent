function summarizeReadiness({ asr, tts, demoProcedureAvailable }) {
  const recognitionReady = asr?.configured === true || asr?.provider === "browser";
  const playbackReady = tts?.configured === true || tts?.browser_playback_allowed === true;
  const missing = [];
  if (!recognitionReady) missing.push({ code: "ASR_CONFIGURATION_REQUIRED", label: "语音识别配置" });
  if (!playbackReady) missing.push({ code: "SELECTED_VOICE_CONFIGURATION_REQUIRED", label: "所选音色配置" });
  if (!demoProcedureAvailable) missing.push({ code: "DEMO_PROCEDURE_REQUIRED", label: "可用演示流程" });
  return {
    configuration_ready: missing.length === 0,
    recognition_configured: recognitionReady,
    playback_configured: playbackReady,
    demo_procedure_available: Boolean(demoProcedureAvailable),
    missing,
    message: missing.length ? `还需补齐：${missing.map(item => item.label).join("、")}。`
      : "所需配置已齐全，请实际测试录音、识别和所选音色播报。",
    live_speech_verified: false,
    microphone_verified: false,
    cloud_requests: false,
  };
}

module.exports = { summarizeReadiness };

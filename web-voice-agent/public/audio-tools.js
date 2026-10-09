(function (root, factory) {
  const tools = factory();
  if (typeof module === "object" && module.exports) module.exports = tools;
  else root.VoiceAudioTools = tools;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function encodePcm16(channels) {
    if (!channels.length || !channels[0].length || channels.some((channel) => channel.length !== channels[0].length)) throw new Error("AUDIO_DECODE_FAILED");
    const output = new ArrayBuffer(channels[0].length * 2);
    const view = new DataView(output);
    for (let i = 0; i < channels[0].length; i += 1) {
      let sample = channels.reduce((sum, channel) => sum + channel[i], 0) / channels.length;
      sample = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
      view.setInt16(i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    }
    return output;
  }

  async function toBaiduPcm(blob) {
    const Context = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!Context) throw new Error("AUDIO_CONVERSION_UNAVAILABLE");
    let decoded;
    try {
      // decodeAudioData resamples complete recorded files to this context's sample rate.
      decoded = await new Context(1, 1, 16000).decodeAudioData(await blob.arrayBuffer());
    } catch { throw new Error("AUDIO_DECODE_FAILED"); }
    if (decoded.sampleRate !== 16000 || !decoded.length) throw new Error("AUDIO_DECODE_FAILED");
    if (decoded.duration > 60) throw new Error("ASR_AUDIO_TOO_LONG");
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
    return new Blob([encodePcm16(channels)], { type: "audio/pcm;rate=16000" });
  }

  function splitSpeechText(text, { max_utf8_bytes = 900, max_characters = 450 } = {}) {
    if (max_utf8_bytes < 4 || max_characters < 1) throw new Error("TTS_CHUNK_CONFIG_INVALID");
    const encoder = new TextEncoder();
    const chunks = [];
    let chunk = "";
    let bytes = 0;
    let characters = 0;
    for (const character of text) {
      const size = encoder.encode(character).length;
      if (chunk && (bytes + size > max_utf8_bytes || characters + 1 > max_characters)) {
        chunks.push(chunk);
        chunk = ""; bytes = 0; characters = 0;
      }
      chunk += character; bytes += size; characters += 1;
      if (/[。！？\n]/u.test(character)) {
        chunks.push(chunk);
        chunk = ""; bytes = 0; characters = 0;
      }
    }
    if (chunk) chunks.push(chunk);
    return chunks;
  }

  return { encodePcm16, toBaiduPcm, splitSpeechText };
});

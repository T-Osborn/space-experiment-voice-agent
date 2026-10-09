const fs = require("node:fs");
const path = require("node:path");

const VOICE_CONFIG_PATH = path.join(__dirname, "..", "config", "voice.json");

class VoiceAdapterRegistry {
  constructor() {
    this.config = JSON.parse(fs.readFileSync(VOICE_CONFIG_PATH, "utf8"));
  }

  getPublicConfig() {
    return this.config;
  }

  describe() {
    return {
      asr: {
        provider: this.config.asr.provider,
        mode: this.config.asr.mode,
        language: this.config.asr.language,
        endpoint: this.config.asr.endpoint,
        input: this.config.asr.input,
      },
      tts: {
        provider: this.config.tts.provider,
        mode: this.config.tts.mode,
        language: this.config.tts.language,
        target_voice: this.config.tts.target_voice
      }
    };
  }
}

module.exports = { VoiceAdapterRegistry };

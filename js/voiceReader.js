import { splitIntoSentences } from "./utils.js";

// Wraps the Web Speech API (free, offline, built into the browser) to read page
// content aloud, sentence by sentence, highlighting + auto-scrolling to the block
// currently being read. Also supports one-off "read this text back" calls (used for
// reading a highlighted selection or an AI response) that don't touch page highlighting.
export class VoiceReader {
  constructor({ playBtn, stopBtn, voiceSelect, rateSlider, rateReadout, pitchSlider, pitchReadout, autoScrollCheckbox }) {
    this.synth = window.speechSynthesis;
    this.playBtn = playBtn;
    this.stopBtn = stopBtn;
    this.voiceSelect = voiceSelect;
    this.autoScrollCheckbox = autoScrollCheckbox;

    this.rate = parseFloat(rateSlider.value);
    this.pitch = parseFloat(pitchSlider.value);
    this.textBlocks = [];
    this.queue = [];
    this.queuePos = 0;
    this.speaking = false;
    this.keepAliveTimer = null;
    this.onBeforeStart = null; // hook: e.g. pause the scroll player
    this.onBlockChange = null; // hook(blockIndex)

    rateSlider.addEventListener("input", () => {
      this.rate = parseFloat(rateSlider.value);
      rateReadout.textContent = `${this.rate.toFixed(1)}×`;
    });
    pitchSlider.addEventListener("input", () => {
      this.pitch = parseFloat(pitchSlider.value);
      pitchReadout.textContent = this.pitch.toFixed(1);
    });

    this._loadVoices();
    if ("onvoiceschanged" in this.synth) {
      this.synth.onvoiceschanged = () => this._loadVoices();
    }

    stopBtn.addEventListener("click", () => this.stop());
  }

  _loadVoices() {
    this.voices = this.synth.getVoices();
    if (!this.voices.length) return;
    const prevValue = this.voiceSelect.value;
    this.voiceSelect.innerHTML = "";
    this.voices.forEach((v, i) => {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = `${v.name} (${v.lang})`;
      this.voiceSelect.appendChild(opt);
    });
    if (prevValue) this.voiceSelect.value = prevValue;
  }

  setTextBlocks(blocks) {
    this.textBlocks = blocks;
  }

  get selectedVoice() {
    const idx = parseInt(this.voiceSelect.value, 10);
    return this.voices[idx] || null;
  }

  isSpeaking() {
    return this.speaking;
  }

  readFrom(startIndex = 0) {
    this.stop();
    this.onBeforeStart?.();
    this.queue = [];
    for (let i = startIndex; i < this.textBlocks.length; i++) {
      const sentences = splitIntoSentences(this.textBlocks[i].text);
      sentences.forEach((s) => this.queue.push({ blockIndex: i, text: s }));
    }
    if (!this.queue.length) return;
    this.queuePos = 0;
    this.speaking = true;
    this.playBtn.textContent = "⏸ Pause";
    this.stopBtn.disabled = false;
    this._keepAlive();
    this._speakNext();
  }

  pauseResume() {
    if (!this.speaking) return;
    if (this.synth.paused) {
      this.synth.resume();
      this.playBtn.textContent = "⏸ Pause";
    } else {
      this.synth.pause();
      this.playBtn.textContent = "▶ Resume";
    }
  }

  stop() {
    this.synth.cancel();
    this._clearKeepAlive();
    this.speaking = false;
    this.queue = [];
    this.playBtn.textContent = "🔊 Read Aloud";
    this.stopBtn.disabled = true;
    this._clearHighlight();
  }

  // Reads arbitrary text (selection, AI response) without touching page highlighting.
  speakAdHoc(text, { onDone } = {}) {
    this.stop();
    const sentences = splitIntoSentences(text);
    if (!sentences.length) return;
    let i = 0;
    this._keepAlive();
    const next = () => {
      if (i >= sentences.length) {
        this._clearKeepAlive();
        onDone?.();
        return;
      }
      const u = new SpeechSynthesisUtterance(sentences[i++]);
      this._applyVoiceParams(u);
      u.onend = next;
      u.onerror = next;
      this.synth.speak(u);
    };
    next();
  }

  _applyVoiceParams(utterance) {
    if (this.selectedVoice) utterance.voice = this.selectedVoice;
    utterance.rate = this.rate;
    utterance.pitch = this.pitch;
  }

  _speakNext() {
    if (this.queuePos >= this.queue.length) {
      this.stop();
      return;
    }
    const item = this.queue[this.queuePos];
    this._highlightBlock(item.blockIndex);

    const u = new SpeechSynthesisUtterance(item.text);
    this._applyVoiceParams(u);
    u.onend = () => {
      this.queuePos++;
      this._speakNext();
    };
    u.onerror = () => {
      this.queuePos++;
      this._speakNext();
    };
    this.synth.speak(u);
  }

  _highlightBlock(index) {
    if (index === this._lastHighlighted) return;
    this._clearHighlight();
    const block = this.textBlocks[index];
    if (!block) return;
    block.el.classList.add("reading-active");
    this._lastHighlighted = index;
    if (this.autoScrollCheckbox.checked) {
      block.el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    this.onBlockChange?.(index);
  }

  _clearHighlight() {
    if (this._lastHighlighted != null && this.textBlocks[this._lastHighlighted]) {
      this.textBlocks[this._lastHighlighted].el.classList.remove("reading-active");
    }
    this._lastHighlighted = null;
  }

  // Chrome (desktop) silently stops speaking after ~15s on some platforms unless
  // nudged; pausing/resuming periodically is the standard workaround.
  _keepAlive() {
    this._clearKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (this.synth.speaking && !this.synth.paused) {
        this.synth.pause();
        this.synth.resume();
      }
    }, 9000);
  }

  _clearKeepAlive() {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }
}

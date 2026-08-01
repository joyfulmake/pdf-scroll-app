// Drives auto-scroll ("scrolling video" mode) over the reader pane at an adjustable
// pixels-per-second speed, and keeps a progress bar in sync in both directions.

export class ScrollPlayer {
  constructor({ scrollEl, playBtn, speedSlider, speedReadout, progressBar, pageReadout }) {
    this.scrollEl = scrollEl;
    this.playBtn = playBtn;
    this.speedSlider = speedSlider;
    this.speedReadout = speedReadout;
    this.progressBar = progressBar;
    this.pageReadout = pageReadout;

    this.playing = false;
    this.speed = parseFloat(speedSlider.value); // px/sec
    this.rafId = null;
    this.lastT = null;
    this.seeking = false;
    this.textBlocks = [];
    this.onBeforeStart = null; // hook: e.g. stop the voice reader

    this.playBtn.addEventListener("click", () => this.toggle());
    this.speedSlider.addEventListener("input", () => {
      this.speed = parseFloat(this.speedSlider.value);
      this.speedReadout.textContent = `${this.speed} px/s`;
    });
    this.progressBar.addEventListener("input", () => {
      this.seeking = true;
      const frac = this.progressBar.value / 1000;
      const max = this.scrollEl.scrollHeight - this.scrollEl.clientHeight;
      this.scrollEl.scrollTop = frac * Math.max(max, 0);
    });
    this.progressBar.addEventListener("change", () => { this.seeking = false; });

    this.scrollEl.addEventListener("scroll", () => this._onScroll());
  }

  setTextBlocks(blocks) {
    this.textBlocks = blocks;
  }

  reset() {
    this.pause();
    this.scrollEl.scrollTop = 0;
    this.progressBar.value = 0;
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  play() {
    if (this.playing) return;
    this.onBeforeStart?.();
    this.playing = true;
    this.playBtn.textContent = "⏸ Pause";
    this.lastT = null;
    this.rafId = requestAnimationFrame((t) => this._tick(t));
  }

  pause() {
    this.playing = false;
    this.playBtn.textContent = "▶ Play";
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  _tick(t) {
    if (!this.playing) return;
    if (this.lastT == null) this.lastT = t;
    const dt = (t - this.lastT) / 1000;
    this.lastT = t;

    const max = this.scrollEl.scrollHeight - this.scrollEl.clientHeight;
    if (max <= 0) {
      this.pause();
      return;
    }
    this.scrollEl.scrollTop += this.speed * dt;
    if (this.scrollEl.scrollTop >= max - 1) {
      this.scrollEl.scrollTop = max;
      this.pause();
    }
    this.rafId = requestAnimationFrame((tt) => this._tick(tt));
  }

  _onScroll() {
    const max = this.scrollEl.scrollHeight - this.scrollEl.clientHeight;
    const frac = max > 0 ? this.scrollEl.scrollTop / max : 0;
    if (!this.seeking) this.progressBar.value = Math.round(frac * 1000);

    if (this.textBlocks.length) {
      const idx = this._currentBlockIndex();
      if (idx >= 0) {
        this.pageReadout.textContent = `${this.textBlocks[idx].label || idx + 1} / ${this.textBlocks.length}`;
      }
    }
  }

  _currentBlockIndex() {
    const paneTop = this.scrollEl.getBoundingClientRect().top;
    const focusY = paneTop + this.scrollEl.clientHeight * 0.3;
    let best = 0;
    for (let i = 0; i < this.textBlocks.length; i++) {
      const rect = this.textBlocks[i].el.getBoundingClientRect();
      if (rect.top <= focusY) best = i;
      else break;
    }
    return best;
  }

  currentBlockIndex() {
    return this._currentBlockIndex();
  }
}

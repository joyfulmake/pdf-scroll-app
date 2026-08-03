const STORAGE_KEY = "pdfScrollApp.sidebarWidth";
const MIN_WIDTH = 300;
const MAX_WIDTH = 720;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// Drag the handle on the sidebar's left edge to resize it — persisted in localStorage
// (a UI preference, like the theme) so it stays put across visits instead of forcing
// everyone back to a fixed width that needs internal scrolling to see settings/notes.
export class SidebarResizer {
  constructor({ panel, handle }) {
    this.panel = panel;
    this.handle = handle;

    const saved = this.savedWidth();
    if (saved) panel.style.width = `${saved}px`;

    handle.addEventListener("pointerdown", (e) => this.startDrag(e));
  }

  savedWidth() {
    try {
      const v = parseInt(localStorage.getItem(STORAGE_KEY), 10);
      return Number.isFinite(v) ? clamp(v, MIN_WIDTH, MAX_WIDTH) : null;
    } catch {
      return null;
    }
  }

  startDrag(e) {
    e.preventDefault();
    this.handle.classList.add("dragging");
    this.panel.classList.add("resizing");
    document.body.classList.add("sidebar-resizing");
    this.handle.setPointerCapture(e.pointerId);

    const onMove = (ev) => {
      const rect = this.panel.getBoundingClientRect();
      // Panel is pinned to the right edge, so its width is the distance from the
      // pointer back to the panel's fixed right edge.
      const maxAllowed = Math.min(MAX_WIDTH, window.innerWidth * 0.7);
      const newWidth = clamp(rect.right - ev.clientX, MIN_WIDTH, maxAllowed);
      this.panel.style.width = `${newWidth}px`;
    };

    const onUp = () => {
      this.handle.classList.remove("dragging");
      this.panel.classList.remove("resizing");
      document.body.classList.remove("sidebar-resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const finalWidth = parseInt(this.panel.style.width, 10);
      if (Number.isFinite(finalWidth)) {
        try { localStorage.setItem(STORAGE_KEY, String(finalWidth)); } catch { /* private mode etc. */ }
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }
}

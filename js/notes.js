import { downloadTextFile, timestamp, showToast } from "./utils.js";

const STORAGE_KEY = "pdfScrollApp.notes";

// Session-only notes: persisted to sessionStorage (survives an accidental reload of
// the same tab) but never written anywhere durable — closing the tab clears it for
// good, which is why a "download" button exists for anyone who wants to keep it.
export class NotesPanel {
  constructor({ textarea, downloadBtn, clearBtn }) {
    this.textarea = textarea;
    this.textarea.value = sessionStorage.getItem(STORAGE_KEY) || "";

    this.textarea.addEventListener("input", () => this._save());
    downloadBtn.addEventListener("click", () => this.download());
    clearBtn.addEventListener("click", () => this.clear());
  }

  _save() {
    sessionStorage.setItem(STORAGE_KEY, this.textarea.value);
  }

  append(heading, body) {
    const block = `\n\n---\n**${heading}** _(${timestamp()})_\n\n${body.trim()}\n`;
    this.textarea.value = (this.textarea.value + block).replace(/^\n+/, "");
    this._save();
    this.textarea.scrollTop = this.textarea.scrollHeight;
  }

  download() {
    downloadTextFile("notes.md", this.textarea.value || "(no notes yet)");
    showToast("Notes downloaded");
  }

  clear() {
    if (this.textarea.value.trim() && !confirm("Clear all notes for this session?")) return;
    this.textarea.value = "";
    this._save();
  }
}

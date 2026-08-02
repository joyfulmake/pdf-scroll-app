import { loadPdf } from "./loaders/pdfLoader.js";
import { loadDocx } from "./loaders/docxLoader.js";
import { loadPptx } from "./loaders/pptxLoader.js";
import { loadText } from "./loaders/textLoader.js";
import { loadHtml } from "./loaders/htmlLoader.js";
import { ScrollPlayer } from "./scrollPlayer.js";
import { VoiceReader } from "./voiceReader.js";
import { NotesPanel } from "./notes.js";
import { explainSelection, summarizeText } from "./aiClient.js";
import { exportVideo } from "./videoExport.js";
import { showToast } from "./utils.js";

const $ = (id) => document.getElementById(id);

const readerPane = $("reader-pane");
const dropZone = $("drop-zone");
const pagesContainer = $("pages-container");
const fileInput = $("file-input");

const scrollControls = $("scroll-controls");
const voiceControls = $("voice-controls");
const progressWrap = $("progress-wrap");
const exportVideoBtn = $("export-video-btn");

const selectionToolbar = $("selection-toolbar");
const askAiBtn = $("ask-ai-btn");
const noteSelectionBtn = $("note-selection-btn");
const readSelectionBtn = $("read-selection-btn");

let currentDoc = null;
let pendingSelectionText = "";

// ---------- Notes ----------

const notes = new NotesPanel({
  textarea: $("notes-text"),
  downloadBtn: $("notes-download-btn"),
  clearBtn: $("notes-clear-btn"),
});

// ---------- Scroll player / voice reader ----------

const scrollPlayer = new ScrollPlayer({
  scrollEl: readerPane,
  playBtn: $("play-pause"),
  speedSlider: $("scroll-speed"),
  speedReadout: $("speed-readout"),
  progressBar: $("progress-bar"),
  pageReadout: $("page-readout"),
});

const voiceReader = new VoiceReader({
  playBtn: $("voice-play"),
  stopBtn: $("voice-stop"),
  voiceSelect: $("voice-select"),
  rateSlider: $("voice-rate"),
  rateReadout: $("voice-rate-readout"),
  pitchSlider: $("voice-pitch"),
  pitchReadout: $("voice-pitch-readout"),
  autoScrollCheckbox: $("voice-auto-scroll"),
});

scrollPlayer.onBeforeStart = () => voiceReader.stop();
voiceReader.onBeforeStart = () => scrollPlayer.pause();

$("voice-play").addEventListener("click", () => {
  if (!currentDoc) return;
  if (!voiceReader.isSpeaking()) {
    voiceReader.readFrom(Math.max(0, scrollPlayer.currentBlockIndex()));
  } else {
    voiceReader.pauseResume();
  }
});

// ---------- File loading ----------

function resetReader() {
  voiceReader.stop();
  scrollPlayer.reset();
  pagesContainer.innerHTML = "";
  currentDoc = null;
  scrollControls.hidden = true;
  voiceControls.hidden = true;
  progressWrap.hidden = true;
  exportVideoBtn.hidden = true;
  $("summarize-btn").disabled = true;
  setAiOutput("", "");
  aiStatus.textContent = "";
}

function onDocLoaded(doc, fallbackTitle) {
  currentDoc = doc;
  if (!currentDoc.title) currentDoc.title = fallbackTitle;

  dropZone.hidden = true;
  scrollControls.hidden = false;
  voiceControls.hidden = false;
  progressWrap.hidden = false;
  exportVideoBtn.hidden = false;
  $("summarize-btn").disabled = false;

  scrollPlayer.setTextBlocks(currentDoc.textBlocks);
  voiceReader.setTextBlocks(currentDoc.textBlocks);
  scrollPlayer.reset();

  showToast(`Loaded "${currentDoc.title}" — ${currentDoc.textBlocks.length} section(s)`);
}

async function loadFile(file) {
  if (!file) return;
  resetReader();
  const ext = file.name.split(".").pop().toLowerCase();
  const nameNoExt = file.name.replace(/\.[^.]+$/, "");

  try {
    let doc;
    if (ext === "pdf") {
      const buf = await file.arrayBuffer();
      doc = await loadPdf(buf, pagesContainer);
    } else if (ext === "docx") {
      const buf = await file.arrayBuffer();
      doc = await loadDocx(buf, pagesContainer, nameNoExt);
    } else if (ext === "pptx") {
      const buf = await file.arrayBuffer();
      doc = await loadPptx(buf, pagesContainer, nameNoExt);
    } else if (ext === "md" || ext === "markdown") {
      doc = await loadText(await file.text(), true, pagesContainer, nameNoExt);
    } else if (ext === "txt") {
      doc = await loadText(await file.text(), false, pagesContainer, nameNoExt);
    } else if (ext === "html" || ext === "htm") {
      doc = await loadHtml(await file.text(), pagesContainer, nameNoExt);
    } else if (ext === "doc" || ext === "ppt") {
      showToast(`Legacy .${ext} (Office 97–2003) isn't supported — please save/export as .${ext === "doc" ? "docx" : "pptx"} and try again.`, 5000);
      return;
    } else {
      showToast("Unsupported file type — use PDF, DOCX, PPTX, TXT, MD, or HTML.");
      return;
    }
    onDocLoaded(doc, nameNoExt);
  } catch (err) {
    console.error(err);
    showToast(`Couldn't load "${file.name}": ${err.message}`);
  }
}

fileInput.addEventListener("change", () => loadFile(fileInput.files[0]));

["dragenter", "dragover"].forEach((evt) =>
  readerPane.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  })
);
["dragleave", "drop"].forEach((evt) =>
  readerPane.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
  })
);
readerPane.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files?.[0];
  if (file) loadFile(file);
});

// ---------- Side panel tabs ----------

const sidePanel = $("side-panel");
const panelNotes = $("panel-notes");
const panelSettings = $("panel-settings");

function showPanel(which) {
  const isOpen = !sidePanel.hidden && ((which === "notes" && !panelNotes.hidden) || (which === "settings" && !panelSettings.hidden));
  if (isOpen) {
    sidePanel.hidden = true;
    return;
  }
  sidePanel.hidden = false;
  panelNotes.hidden = which !== "notes";
  panelSettings.hidden = which !== "settings";
}
$("tab-notes-btn").addEventListener("click", () => showPanel("notes"));
$("tab-settings-btn").addEventListener("click", () => showPanel("settings"));

// ---------- Text selection toolbar ----------

let selTimer = null;
document.addEventListener("selectionchange", () => {
  clearTimeout(selTimer);
  selTimer = setTimeout(positionSelectionToolbar, 60);
});
selectionToolbar.addEventListener("mousedown", (e) => e.preventDefault());

function positionSelectionToolbar() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    selectionToolbar.hidden = true;
    return;
  }
  const range = sel.getRangeAt(0);
  if (!readerPane.contains(range.commonAncestorContainer)) {
    selectionToolbar.hidden = true;
    return;
  }
  const text = sel.toString().trim();
  if (!text) {
    selectionToolbar.hidden = true;
    return;
  }
  pendingSelectionText = text;
  selectionToolbar.hidden = false;

  const rect = range.getBoundingClientRect();
  const paneRect = readerPane.getBoundingClientRect();
  const top = rect.top - paneRect.top + readerPane.scrollTop - selectionToolbar.offsetHeight - 8;
  const left = rect.left - paneRect.left + rect.width / 2 - selectionToolbar.offsetWidth / 2;
  selectionToolbar.style.top = `${Math.max(4, top)}px`;
  selectionToolbar.style.left = `${Math.max(4, left)}px`;
}

function contextForSelection() {
  const sel = window.getSelection();
  if (sel && sel.rangeCount) {
    const node = sel.getRangeAt(0).commonAncestorContainer;
    const block = currentDoc?.textBlocks.find((b) => b.el.contains(node));
    if (block) return block.text;
  }
  return currentDoc?.textBlocks[0]?.text || "";
}

readSelectionBtn.addEventListener("click", () => {
  if (pendingSelectionText) voiceReader.speakAdHoc(pendingSelectionText);
});
noteSelectionBtn.addEventListener("click", () => {
  if (pendingSelectionText) {
    notes.append("Note (highlighted text)", pendingSelectionText);
    showToast("Added to notes");
  }
});

// ---------- AI panel ----------

const aiStatus = $("ai-status");
const aiOutput = $("ai-output");
const aiSaveBtn = $("ai-save-btn");
const aiReadBtn = $("ai-read-btn");
const summarizeBtn = $("summarize-btn");
const summarizeScope = $("summarize-scope");

let lastAiHeading = "";

function setAiOutput(heading, text) {
  lastAiHeading = heading;
  aiOutput.textContent = text;
  aiSaveBtn.disabled = !text;
  aiReadBtn.disabled = !text;
}

askAiBtn.addEventListener("click", async () => {
  if (!pendingSelectionText) return;
  showPanel("notes");
  aiStatus.textContent = "Thinking…";
  setAiOutput("AI explanation", "");
  try {
    const answer = await explainSelection(pendingSelectionText, contextForSelection());
    setAiOutput(`AI explanation of: "${pendingSelectionText.slice(0, 60)}${pendingSelectionText.length > 60 ? "…" : ""}"`, answer);
    aiStatus.textContent = "";
  } catch (err) {
    aiStatus.textContent = err.message;
  }
});

summarizeBtn.addEventListener("click", async () => {
  if (!currentDoc) return;
  const scope = summarizeScope.value;
  const text = scope === "document"
    ? currentDoc.textBlocks.map((b) => b.text).join("\n\n")
    : currentDoc.textBlocks[Math.max(0, scrollPlayer.currentBlockIndex())]?.text || "";

  if (!text.trim()) {
    showToast("Nothing to summarize yet.");
    return;
  }

  setAiOutput("Summary", "");
  try {
    const summary = await summarizeText(text, {
      title: currentDoc.title,
      onProgress: (step, total) => { aiStatus.textContent = total > 1 ? `Summarizing… (${step}/${total})` : "Summarizing…"; },
    });
    setAiOutput(scope === "document" ? "Summary of whole document" : "Summary of current view", summary);
    aiStatus.textContent = "";
  } catch (err) {
    aiStatus.textContent = err.message;
  }
});

aiSaveBtn.addEventListener("click", () => {
  notes.append(lastAiHeading, aiOutput.textContent);
  showToast("Saved to notes");
});
aiReadBtn.addEventListener("click", () => voiceReader.speakAdHoc(aiOutput.textContent));

// ---------- Video export ----------

const exportModal = $("export-modal");
const exportForm = $("export-form");
const exportLive = $("export-live");
const exportResult = $("export-result");
const exportStatus = $("export-status");
const exportCanvas = $("export-canvas");
const exportMusicToggle = $("export-music-toggle");
const exportMusicField = $("export-music-field");
const exportSpeedSlider = $("export-speed");
const exportSpeedReadout = $("export-speed-readout");
const exportSpeedField = $("export-speed-field");
const exportAnimationSelect = $("export-animation");

let exportCancelToken = null;

function syncExportSpeedFieldVisibility() {
  exportSpeedField.hidden = exportAnimationSelect.value === "slides";
}

exportVideoBtn.addEventListener("click", () => {
  if (!currentDoc) return;
  exportModal.hidden = false;
  exportForm.hidden = false;
  document.querySelector("#export-modal .modal-actions").hidden = false;
  exportLive.hidden = true;
  exportResult.hidden = true;
  // Default the export's scroll speed to whatever the reading pane is currently set to.
  exportSpeedSlider.value = scrollPlayer.speed;
  exportSpeedReadout.textContent = `${scrollPlayer.speed} px/s`;
  syncExportSpeedFieldVisibility();
});
$("export-cancel-btn").addEventListener("click", () => { exportModal.hidden = true; });
$("export-close-btn").addEventListener("click", () => { exportModal.hidden = true; });
exportMusicToggle.addEventListener("change", () => { exportMusicField.hidden = !exportMusicToggle.checked; });
exportSpeedSlider.addEventListener("input", () => { exportSpeedReadout.textContent = `${exportSpeedSlider.value} px/s`; });
exportAnimationSelect.addEventListener("change", syncExportSpeedFieldVisibility);

$("export-start-btn").addEventListener("click", async () => {
  exportForm.hidden = true;
  document.querySelector("#export-modal .modal-actions").hidden = true;
  exportLive.hidden = false;
  exportCancelToken = { cancelled: false };

  const musicFile = exportMusicToggle.checked ? $("export-music-file").files[0] || null : null;

  try {
    const blob = await exportVideo({
      pagesContainer,
      doc: currentDoc,
      previewCanvas: exportCanvas,
      aspect: $("export-aspect").value,
      animation: exportAnimationSelect.value,
      theme: $("export-theme").value,
      speed: parseFloat(exportSpeedSlider.value),
      wantTitleCard: $("export-title-card").checked,
      wantCaptions: $("export-captions").checked,
      wantMic: $("export-mic").checked,
      musicFile,
      cancelToken: exportCancelToken,
      onStatus: (msg) => { exportStatus.textContent = msg; },
    });

    const url = URL.createObjectURL(blob);
    $("export-preview-video").src = url;
    $("export-download-link").href = url;
    const safeName = (currentDoc.title || "reading").replace(/[^\w-]+/g, "-").slice(0, 60);
    $("export-download-link").download = `${safeName}.webm`;
    exportLive.hidden = true;
    exportResult.hidden = false;
  } catch (err) {
    console.error(err);
    showToast(`Export failed: ${err.message}`);
    exportModal.hidden = true;
  }
});

$("export-stop-btn").addEventListener("click", () => {
  if (exportCancelToken) exportCancelToken.cancelled = true;
});

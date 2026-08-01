const KEY_STORAGE = "pdfScrollApp.apiKey";
const MODEL_STORAGE = "pdfScrollApp.model";

// API key + model choice, kept only in sessionStorage (this tab, this session only —
// never sent anywhere except directly to Anthropic's API when you use Ask AI/Summarize).
export class Settings {
  constructor({ apiKeyInput, modelSelect }) {
    this.apiKeyInput = apiKeyInput;
    this.modelSelect = modelSelect;

    apiKeyInput.value = sessionStorage.getItem(KEY_STORAGE) || "";
    const savedModel = sessionStorage.getItem(MODEL_STORAGE);
    if (savedModel) modelSelect.value = savedModel;

    apiKeyInput.addEventListener("input", () => {
      sessionStorage.setItem(KEY_STORAGE, apiKeyInput.value.trim());
    });
    modelSelect.addEventListener("change", () => {
      sessionStorage.setItem(MODEL_STORAGE, modelSelect.value);
    });
  }

  get apiKey() {
    return this.apiKeyInput.value.trim();
  }

  get model() {
    return this.modelSelect.value;
  }

  hasApiKey() {
    return this.apiKey.length > 0;
  }
}

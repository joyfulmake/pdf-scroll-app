const STORAGE_KEY = "pdfScrollApp.theme";

// Persisted in localStorage (not sessionStorage) since it's a pure UI preference with
// no content/privacy implications — unlike notes or the AI key this app used to ask
// for, there's no reason to make someone re-pick their theme every time they visit.
export class ThemeSwitcher {
  constructor({ grid }) {
    this.buttons = Array.from(grid.querySelectorAll(".theme-swatch"));
    this.buttons.forEach((btn) => {
      btn.addEventListener("click", () => this.apply(btn.dataset.theme));
    });
    this.syncActive(this.current());
  }

  current() {
    try {
      return localStorage.getItem(STORAGE_KEY) || "auto";
    } catch {
      return "auto";
    }
  }

  apply(theme) {
    if (theme === "auto") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", theme);
    }
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* localStorage unavailable (private mode etc.) — theme still applies for this load */
    }
    this.syncActive(theme);
  }

  syncActive(theme) {
    this.buttons.forEach((btn) => btn.classList.toggle("active", btn.dataset.theme === theme));
  }
}

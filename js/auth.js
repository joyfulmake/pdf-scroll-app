// Full-app Google sign-in gate + the 90-day upgrade-nudge banner. app.js awaits
// requireSession() before instantiating any other feature (ScrollPlayer, NotesPanel,
// file loading, etc.) so nothing on the page is interactive pre-auth.
export class AuthGate {
  constructor({ overlay, banner, bannerDismissBtn, accountBtn, accountEmail }) {
    this.overlay = overlay;
    this.banner = banner;
    this.accountEmail = accountEmail;
    this.user = null;

    bannerDismissBtn?.addEventListener("click", () => this.dismissBanner());
    accountBtn?.addEventListener("click", () => this.signOut());
  }

  // Resolves once a real session is confirmed. If there's no session, shows the
  // full-screen gate and never resolves on this page load — pointer-events on
  // everything behind it are already blocked by .modal-overlay's layout, and no
  // other feature's event listeners get attached at all since app.js's init halts
  // here. The only way past it is the Google OAuth redirect round-trip, which
  // reloads the page and re-runs this from scratch, this time getting a 200.
  async requireSession() {
    const res = await fetch("/api/auth/me");
    if (res.status !== 200) {
      if (this.overlay) this.overlay.hidden = false;
      return new Promise(() => {}); // deliberately never resolves — see comment above
    }
    const { user } = await res.json();
    this.user = user;
    if (this.accountEmail) this.accountEmail.textContent = user.email;
    if (user.showUpgradeBanner) this.showBanner();
    return user;
  }

  showBanner() {
    if (this.banner) this.banner.hidden = false;
  }

  dismissBanner() {
    if (this.banner) this.banner.hidden = true; // optimistic, matches this app's existing eager-UI-update style (see showToast)
    fetch("/api/auth/dismiss-upgrade-banner", { method: "POST" }).catch(() => {});
  }

  async signOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    location.reload();
  }
}

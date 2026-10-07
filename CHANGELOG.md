# Changelog

Small fixes and new recommendations bump the last number (1.0.1, 1.0.2…), and big features bump the middle one (1.1.0). Your userscript manager only offers an update when the version goes up.

## 1.0.0 — 2026-10-07

First public release.

- **Get APK** button next to Install on every Google Play app page, plus top results on search pages. It stays visible on signed-in pages ("Install on more devices") and when Play redraws its button row.
- **Direct downloads** from APKPure (APK and XAPK), APKCombo, Aptoide (including split APKs and OBB files), F-Droid, IzzyOnDroid, the Guardian Project repo and the F-Droid archive (off by default), with background availability and version checks.
- **Store links:** APKMirror, Uptodown (checked, links the exact app page), Evozi, APKFab and GitHub.
- **Morphe patches:** a badge and a menu section when community or official Morphe patches exist for the app. Re-checked every 30 minutes and applied to the open page without a reload. Recommended bundles are listed first and link to their repos:
  - piko (X, Instagram);
  - the Hush bundles by SysAdminDoc (Facebook, Messenger, Instagram, TikTok, Threads, Telegram, Pinterest);
  - Gboard patches by jasonwu1994;
  - Heval.
- **Open-source alternatives** for selected apps (e.g. NewPipe for YouTube).
- **Opt-in modded-APK search links** with a malware warning (off by default). Searches use a readable name even on non-English Play pages.
- **Material 3 menu** that follows Play's light and dark theme, with keyboard navigation, a filter box, copy package ID and a banner for region-locked apps.
- **Copy diagnostics** command in the userscript manager menu, for bug reports.
- Settings for every section and source.

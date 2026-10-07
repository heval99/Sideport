# Changelog

## 1.1.0 — 2026-10-07

- **Fixed:** the button could disappear on pages where Play keeps redrawing its button row (seen on YouTube when signed in). Sideport now moves the button next to the app title instead of giving up.
- **New sources:**
  - Uptodown is now checked in the background and links straight to the app's page.
  - The Guardian Project repo is a new direct source (Signal, Orbot and more).
  - The F-Droid archive is a new direct source, off by default.
- **Recommended Morphe bundles** are listed first, with a link to their repos: piko (X, Instagram), the Hush bundles by SysAdminDoc (Facebook, Messenger, Instagram, TikTok, Threads, Telegram, Pinterest) and Heval.
- **New "Copy diagnostics" command** in the userscript manager menu, for bug reports.
- **Better mod-site searches on non-English Play pages:** if the app name is shown in a non-Latin script, the search uses a readable part of the package ID instead.
- **ReVanced links removed** from the alternatives.

## 1.0.0 — 2026-10-07

First public release.

- **Get APK** button next to Install on every Google Play app page, plus top results on search pages.
- Direct downloads from APKPure (APK and XAPK), APKCombo, Aptoide (including split APKs and OBB files), F-Droid and IzzyOnDroid, with background availability and version checks.
- Store links: APKMirror, Uptodown, Evozi, APKFab and GitHub.
- **Morphe patches:** a badge and a menu section when community or official Morphe patches exist for the app. Re-checked every 30 minutes and applied to the open page without a reload.
- Open-source alternatives for selected apps (ReVanced, NewPipe, ReVanced Extended).
- Opt-in modded-APK search links with a malware warning (off by default).
- Material 3 menu that follows Play's light and dark theme, with keyboard navigation, a filter box, copy package ID and a banner for region-locked apps.
- Settings for every section and source.

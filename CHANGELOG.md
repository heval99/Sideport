# Changelog

Small fixes and new recommendations bump the last number (1.0.1, 1.0.2…), and big features bump the middle one (1.1.0). Your userscript manager only offers an update when the version goes up.

## 1.2.0 — 2026-10-11

Fixes from a code review and testing pass. (The version jumps from 1.0.0 to 1.2.0 because test builds numbered 1.1.0–1.1.2 were briefly published before 1.0.0; this makes sure every install gets the update.)

- **APKPure XAPK** no longer says *Available* for apps that have no XAPK (APKPure quietly sends the plain APK instead), and an error at the end of APKPure's redirect is no longer counted as available.
- **Guardian Project** downloads start again instead of always stopping at "Unrecognised download host": the repo now serves files from GitLab Pages and its own GitHub repo.
- **Aptoide:** a listing that Aptoide's own malware check ranks as trusted is preferred, and anything else is shown with that rank instead of opening straight away.
- **Paid apps:** after moving between apps inside Play, the previous app's price no longer decides whether the next one counts as paid. When Play shows its Install button late, Sideport moves next to it and reads its price.
- **Availability results:** a failed check (for example a Cloudflare check you have since passed) is tried again the next time you open the menu, *Available* answers are refreshed after 30 minutes, and download links older than 10 minutes are fetched again before use.
- **Morphe patches:** the badge shows the largest single bundle instead of adding up bundles that repackage the same patches, rows say which app version a bundle was made for (or *any version*), pre-releases no longer rank above releases, and YouTube's "full APK only" requirement is shown.
- "Not found" now only appears when a source clearly says so; an unexpected page shows *Couldn't check*.
- Settings changed in one Play tab are no longer undone by another tab.
- **Faster:** the button appears as soon as Play's page is ready (no fixed 150 ms wait), all availability checks run at once, and the F-Droid archive's 1 MB page is read without building a whole page in memory.
- Two installed copies of Sideport no longer add two buttons; the script starts even if the userscript manager provides no `GM` object.
- "Open APK sources" from the userscript manager's menu works when the button is scrolled out of view, and brings the button back after you dismissed the banner.
- **Accessibility and layout:** better contrast on the Morphe badge and on *Not found* rows, a screen-reader summary when the checks finish, the button follows Play's own theme switch, and right-to-left pages are laid out correctly.
- **Looks right on the real Play page:** the Get APK button and the menu's footer buttons keep their intended weight and colour (a style rule was overriding them), and the button matches the height of Play's own.
- **Right app name:** after moving between apps inside Play, the menu (and mod-site searches) no longer use the previous app's name, and on search pages they use the top result's name instead of your search words.
- **Clearer menu:** status lines wrap instead of being cut off (so "Cloudflare check — open the site" is readable), the filter ignores punctuation ("fdroid" finds F-Droid) and tells screen readers how many sources match, *Not found* rows no longer show a Download badge, Reset asks once more before wiping your settings, and the banner says when Google Play doesn't list an app at all.
- **Hardening:** responses from source sites are parsed in time proportional to their size (crafted ones could freeze the tab), oversized answers are refused, shared cloud storage is trusted only when the source itself links there, and *Copy diagnostics* keeps only the app id from the Play URL.

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

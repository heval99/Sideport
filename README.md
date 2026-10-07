# Sideport

**Get any Google Play app as an APK — one button on every app page.**

Sideport is a userscript that adds a **Get APK** button next to *Install* on Google Play. It finds the app on trusted APK sources, checks which ones actually have it, and downloads it in one click. It also tells you when [Morphe](https://morphe.software/) patches exist for the app.

<!-- Screenshots: add docs/button.png and docs/menu.png, then uncomment:
![Get APK button and Morphe badge](docs/button.png)
![Sources menu](docs/menu.png)
-->

## Install

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/), [Violentmonkey](https://violentmonkey.github.io/) or [Greasemonkey](https://www.greasespot.net/) (Chrome, Edge, Firefox).
2. **[Click here to install Sideport](https://github.com/heval99/sideport/raw/main/sideport.user.js)** and confirm in the manager.
3. Open any app on [play.google.com](https://play.google.com/store/apps).

The first time Sideport checks a source, your userscript manager asks whether the script may connect to that site. Choose **Always allow** (or allow each domain once). Updates install automatically through your userscript manager.

## What it does

**Get APK menu**, next to Play's Install button:

| Section | Sources |
|---|---|
| **Direct download** | APKPure, APKPure XAPK, APKCombo, Aptoide, F-Droid, IzzyOnDroid |
| **Stores & mirrors** | APKMirror, Uptodown, Evozi, APKFab, GitHub (off by default) |
| **Morphe patches** | Community patch bundles and official Morphe patches for the app |
| **Open-source alternatives** | e.g. ReVanced and NewPipe for YouTube |
| **Modded APKs** | Off by default; see [Safety](#safety) |

- **Availability check:** when the menu opens, every direct source is checked in the background and shows *Available · v1.2.3* or *Not found*.
- **One-click downloads:** the file starts in a new tab. Apps that ship as split APKs (Aptoide) or come in several variants (APKCombo) show a list so you can pick the right file.
- **Morphe badge:** if the app has [Morphe](https://morphe-patches.software/#apps) patches, a *Morphe · N patches* button appears next to Get APK and links straight to the app's patch page. The patch list stays fresh: Sideport checks Morphe for changes every 30 minutes, which costs a few hundred bytes when nothing changed.
- **Also:** follows Play's light and dark theme, full keyboard navigation (arrow keys, Home/End, Esc), a filter box, copy package ID, and a banner for apps that aren't available in your country.
- **Paid apps:** only store links are shown; direct downloads and mod sites are hidden.

## Settings

Open the menu → **Settings**, or use your userscript manager's menu:

- Show modded APK sites (off by default)
- Show Morphe patches
- Check availability automatically
- Open downloads in a new tab
- Turn individual sources on or off
- Refresh the Morphe patch list now

## Privacy

- No analytics, no tracking, no accounts, no servers of its own.
- Sideport only talks to the sources listed above, and only when you're on a Play app page. Requests go straight from your browser to those sites.
- It stores two things in your userscript manager's local storage: your settings, and a compact summary of Morphe's patch list (about 180 KB).

## Safety

- APK files come from third-party sites, not from Google. Prefer the original-release sources, and check signatures or scan files when in doubt.
- **Modded APKs** are unverified, repackaged files, and several mod sites are known for adware or malware. That's why the section is **off by default** and carries a warning. Sideport only links to their search pages; it never downloads from them.
- Sideport only opens `https://` links, and for direct downloads it checks that the file comes from the source's own domains.

## FAQ

**A source says "Couldn't check · Cloudflare check".** The site is asking for a browser check. Click the ↗ icon to open the site once; afterwards background checks usually work again.

**The button doesn't appear.** Google sometimes changes Play's layout. Please [open an issue](https://github.com/heval99/sideport/issues) with the app link.

**Can I add a source?** Yes, [open an issue](https://github.com/heval99/sideport/issues) or a pull request.

## Support

Sideport is free, with no ads or tracking. If it saves you time, you can support development on **[Ko-fi ♥](https://ko-fi.com/heval99)**. You'll also find a *Support* link in the menu and your userscript manager's menu.

## Credits

- Google Play install-button detection and the price-tag check are adapted from [Direct download from Google Play](https://greasyfork.org/scripts/33005) by **StephenP**, the userscript that inspired Sideport.
- Patch data comes from [Morphe](https://morphe.software/) and its community bundle index at [morphe-patches.software](https://morphe-patches.software/).

## License

Sideport is **source-available** under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). You may use, modify and share it for any **non-commercial** purpose. Selling it or using it commercially is not allowed. (This is not an OSI "open source" license.)

Sideport is not affiliated with Google, Morphe, or any of the listed sources. Google Play is a trademark of Google LLC.

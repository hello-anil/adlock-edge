# AdLock

> **Official extension:** [Install from Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/dknkhicpaggioijaimoapfdmcgggcbkm).

AdLock blocks ads, trackers, unwanted popups, and advertising redirects. Settings and blocking data stay on your device.

## Features

- Relaxed, Balanced, and Strict protection.
- Global and per-site pause controls.
- Custom filters and settings backup.
- Compact red-and-blue popup with a golden spider web.

Version **2.1.8** adds a larger original logo, locally bundled Bangers font, red/gold controls, and an **OFF** indicator while protection is paused. See [release notes](CHANGELOG.md).

## Install

Use the official Edge Add-ons link above, or download the ZIP from [GitHub Releases](https://github.com/hello-anil/adlock-edge/releases/tag/v2.1.8).

For an unpacked installation, extract the ZIP, open `edge://extensions` or `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**. Select the folder containing `manifest.json`.

To update, replace files in the existing extension folder and click **Reload**. Keep the same registration to retain settings. If a site breaks, choose Balanced or pause protection for that site. Some first-party and embedded video ads may remain.

## Development

Requires Node.js 22 or newer.

```sh
npm ci
npx playwright install chromium
npm test
npm run release
```

Builds are saved to `dist/`. Source code is [MIT licensed](LICENSE); the Bangers font uses the [SIL Open Font License](ui/fonts/bangers/OFL.txt).

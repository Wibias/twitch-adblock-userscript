# Twitch Adblock Userscript

Maintained Twitch ad-blocking userscript based on the archived `vaft` implementation from [pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions).

This fork keeps the original HLS interception approach, ports proven fixes from maintained descendants, and adds reliability hardening, configurable ad fallback behavior, automatic quality handling, and runtime diagnostics.

## Install

1. Install [Violentmonkey](https://violentmonkey.github.io/) or [Tampermonkey](https://www.tampermonkey.net/).
2. Disable or remove any other `vaft` copy first, including userscripts or the uBO `vaft-ublock-origin.js` scriptlet. A different filename will not be replaced automatically.
3. Open **[twitch-adblock.user.js](https://raw.githubusercontent.com/Wibias/twitch-adblock-userscript/main/twitch-adblock.user.js)** and confirm installation.

Updates are delivered through the userscript `@version` metadata.

> The internal `ourTwitchAdSolutionsVersion=24` guard prevents multiple incompatible VAFT copies from running at the same time. It is not the public release version.

## Features

### VAFT core

- Detects Twitch stitched-ad HLS playlists.
- Tries clean backup player feeds while preserving the current resolution where possible.
- Uses `embed` and `popout` Source feeds first, with optional `autoplay` 360p fallback.
- Strips remaining ad segments when required.
- Reloads the player only when necessary, otherwise uses pause/play recovery after ads.

### Ad fallback mode

A small control is added next to Twitch's Share button:

- **360p**: use the 360p backup stream if both Source backup feeds still contain ads.
- **Source**: never intentionally downscale to 360p. If all Source feeds are tainted, the picture may freeze until the ad window ends.

The setting is stored as `localStorage.adBackupMode` and synchronized between tabs.

Console API:

```js
setAdBackupMode('360p')
setAdBackupMode('source')
```

### Automatic quality

The same control bar includes **Auto / Off** quality handling.

When enabled, VAFT prefers:

```text
1440p60 > 1080p60 > 1440p > 1080p
```

It only intervenes when the current video is below 1080p. Temporary UI failures are retried instead of permanently marking the attempt as complete.

Console API:

```js
setAutoQuality('on')
setAutoQuality('off')
getAutoQuality()
```

### Playback recovery

- Suppresses Twitch ad banner/countdown UI.
- Uses pause/play after an ad when a full reload is unnecessary.
- Reloads after stripped segments or HEVC-specific transitions when required.
- Detects stuck playback and attempts recovery.
- After returning to a backgrounded tab, catches up excessive live latency with pause/play when needed.

## Diagnostics

Run this in the Twitch page console:

```js
vaftStatus()
```

Example:

```js
{
  version: '37.4.1',
  workerCount: 2,
  backupMode: '360p',
  autoQuality: 'on',
  channel: 'examplechannel',
  showingAd: false,
  strippingSegments: false,
  backupPlayerType: null,
  lastPlayerReload: 1729200000000,
  numStrippedAdSegments: 0,
  isMidroll: false,
  lastUpdate: 1729200001000
}
```

Fields:

- `workerCount`: currently tracked Twitch workers.
- `channel`: channel reported by the active worker stream state.
- `showingAd`: whether the worker currently sees an ad window.
- `strippingSegments`: whether ad segments are currently being stripped.
- `backupPlayerType`: active backup player type, such as `embed`, `popout`, or `autoplay`.
- `lastPlayerReload`: timestamp of the most recent VAFT-triggered player reload.
- `numStrippedAdSegments`: number of stripped ad segments in the current state.
- `isMidroll`: whether the current ad state is a midroll.
- `lastUpdate`: timestamp of the most recent worker-to-page diagnostics update.

Since 37.4.1, these stream fields come from the worker that actually processes the HLS playlists instead of the page-local `StreamInfos` copy.

## Troubleshooting

### Script appears inactive

Make sure no second VAFT-based userscript or uBO scriptlet is loading first. The internal conflict guard intentionally disables duplicate copies.

Check:

```js
vaftStatus()
```

A non-zero `workerCount` means the worker hook is active.

### Ads cause a quality drop

Use **Source** mode if you prefer freezing over falling back to the 360p backup feed:

```js
setAdBackupMode('source')
```

Switch back with:

```js
setAdBackupMode('360p')
```

### Player hangs or reloads unexpectedly

Capture `vaftStatus()` while the issue is happening and include relevant console messages when reporting the problem. In particular, note:

- `channel`
- `showingAd`
- `strippingSegments`
- `backupPlayerType`
- `lastPlayerReload`
- `numStrippedAdSegments`
- `lastUpdate`

## Reliability hardening

Compared with the archived VAFT 37.0.0 baseline, this maintained version includes fixes and hardening such as:

- Safe handling when `SERVER-TIME` is missing.
- Correct application of ad tracking URL rewrites.
- Playlist request failures reject instead of hanging forever.
- Reduced React-tree scanning on pages without video.
- Safe cached playlist freshness checks through `getFirstM3u8Url()`.
- Native hidden-tab detection preserved even though Twitch visibility state is patched.
- Fetch handling supports strings, `Request`, `URL`, `Headers`, and missing `init` values more safely.
- Malformed PlaybackAccessToken JSON no longer breaks the fetch hook.
- Worker blob URLs are revoked after construction.
- Terminated or inactive workers are removed from tracking.
- Worker-to-page fetch requests time out after 15 seconds instead of leaking forever.
- Signed/query-string `.m3u8` URLs are accepted.
- Missing codec metadata is tolerated.
- `RequestedAds` is bounded to avoid unbounded growth.
- Auto-quality retries after transient failures and always clears its busy state.
- Worker-side runtime state is bridged into `vaftStatus()`.

## Development

Run the regression checks with:

```bash
node check.js
```

The test suite covers the main hardening paths, including fetch normalization, HLS parsing, codec guards, worker lifecycle expectations, auto-quality state handling, and the runtime diagnostics bridge.

Versioning:

- `@version` is the public userscript release version and must be bumped for user-visible changes.
- `ourTwitchAdSolutionsVersion=24` is an internal compatibility/conflict guard and should only change if that protocol changes.

Typical release flow:

```bash
node check.js
git commit
git tag vX.Y.Z
git push
git push origin vX.Y.Z
```

## Provenance

This repository is a focused maintained userscript, not a full fork of the original `TwitchAdSolutions` repository structure.

Lineage:

```text
pixeltris/TwitchAdSolutions vaft 37.0.0 (archived)
        -> proven fixes from maintained descendants
        -> Wibias/twitch-adblock-userscript reliability and diagnostics work
```

The archived upstream remains the baseline and primary provenance source. Credit is preserved for the original VAFT and VideoAdBlockForTwitch contributors.

## Limits

- Targets Twitch pages under `*.twitch.tv`, primarily desktop `www.twitch.tv`.
- Twitch changes its player and delivery stack frequently, so breakage can happen without warning.
- This project is not affiliated with Twitch.

Credits: [pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions) and [VideoAdBlockForTwitch](https://github.com/cleanlock/VideoAdBlockForTwitch#credits).

License: [MIT](LICENSE)

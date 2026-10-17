# Twitch Adblock Userscript

Maintained Twitch ad-blocking userscript based on the archived `vaft` implementation from [pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions).

This maintained version keeps the original HLS interception approach, ports proven fixes from maintained descendants, and adds reliability hardening, safer codec handling, standalone ad-video resilience, configurable fallback behavior, automatic quality handling, and runtime diagnostics.

## Install

1. Install [Violentmonkey](https://violentmonkey.github.io/) or [Tampermonkey](https://www.tampermonkey.net/).
2. Disable or remove any other `vaft` copy first, including userscripts or the uBO `vaft-ublock-origin.js` scriptlet. A different filename will not be replaced automatically.
3. Open **[twitch-adblock.user.js](https://raw.githubusercontent.com/Wibias/twitch-adblock-userscript/main/twitch-adblock.user.js)** and confirm installation.

Updates are delivered through the userscript `@version` metadata.

> The internal `ourTwitchAdSolutionsVersion=24` guard prevents multiple incompatible VAFT copies from running at the same time. It is not the public release version.

## Features

### VAFT core

- Detects Twitch stitched-ad HLS playlists.
- Tries clean backup player feeds while preserving resolution and codec family where possible.
- Uses `embed` and `popout` Source feeds first, with optional `autoplay` 360p fallback.
- Strips remaining ad segments when required.
- Treats AVC, HEVC, and AV1 explicitly instead of assuming every high-quality stream is AVC/HEVC.
- Never injects the hard-coded AVC blank segment into an HEVC/AV1 playlist.
- Reloads the player only when necessary, otherwise uses pause/play recovery after ads.

### Standalone Twitch ad videos

Twitch can render client-side ad `<video>` elements beside the player or in chat, outside the HLS stream VAFT normally processes.

The maintained userscript:

- identifies these standalone videos by Twitch's `media-amazon.com` ad-CDN source;
- hides, mutes, and pauses them without targeting the real player;
- avoids treating the first `<video>` in DOM order as the primary stream;
- restores a video node if Twitch later recycles it for normal content;
- routes auto-quality and visibility recovery through the actual player video.

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

It only intervenes when the current player video is below 1080p. Temporary UI failures are retried instead of permanently marking the attempt as complete.

Console API:

```js
setAutoQuality('on')
setAutoQuality('off')
getAutoQuality()
```

### Playback recovery

- Suppresses Twitch ad banner/countdown UI.
- Uses pause/play after an ad when a full reload is unnecessary.
- Reloads after stripped segments or enhanced-codec transitions when required.
- Detects stuck playback and attempts recovery.
- After returning to a backgrounded tab, catches up excessive live latency with pause/play when needed.
- Avoids injecting VAFT hooks a second time into a Twitch worker that already carries them.

## CSAI diagnostics and optional blocking

Twitch also makes client-side ad requests to `edge.ads.twitch.tv`. These requests are outside the HLS/SSAI path.

Since 37.6.0, VAFT observes and counts these requests for both `fetch` and `XMLHttpRequest`. **Blocking is off by default.** This gives useful field diagnostics without automatically taking on the detection/compatibility trade-off of network-level CSAI blocking.

Enable blocking explicitly:

```js
setCsaiBlocking(true)
```

Disable it again:

```js
setCsaiBlocking(false)
```

Check the current setting:

```js
getCsaiBlocking()
```

The setting is persisted as:

```text
localStorage.twitchAdSolutions_blockCsaiAdRequests
```

When enabled, matching Fetch requests reject like a network failure and matching XHR requests finish with a network-error-style `status: 0` path. Non-CSAI requests, including Twitch GQL, continue through the normal hook.

## Diagnostics

Run this in the Twitch page console:

```js
vaftStatus()
```

Example:

```js
{
  version: '37.6.0',
  workerCount: 2,
  backupMode: '360p',
  autoQuality: 'on',
  blockCsaiAdRequests: false,
  csai: {
    total: 3,
    blocked: 0,
    allowed: 3,
    fetch: 2,
    xhr: 1,
    preroll: 1,
    midroll: 2,
    unknown: 0
  },
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
- `backupMode`: current Source/360p fallback policy.
- `autoQuality`: automatic quality mode.
- `blockCsaiAdRequests`: whether optional CSAI network blocking is enabled.
- `csai.total`: observed `edge.ads.twitch.tv` requests in this page session.
- `csai.blocked` / `csai.allowed`: observed requests split by action.
- `csai.fetch` / `csai.xhr`: observed requests split by transport.
- `csai.preroll` / `csai.midroll` / `csai.unknown`: observed requests split by break type.
- `channel`: channel reported by the active worker stream state.
- `showingAd`: whether the worker currently sees an HLS ad window.
- `strippingSegments`: whether HLS ad segments are currently being stripped.
- `backupPlayerType`: active backup player type, such as `embed`, `popout`, or `autoplay`.
- `lastPlayerReload`: timestamp of the most recent VAFT-triggered player reload.
- `numStrippedAdSegments`: number of stripped ad segments in the current state.
- `isMidroll`: whether the current worker ad state is a midroll.
- `lastUpdate`: timestamp of the most recent worker-to-page diagnostics update.

Since 37.4.1, the HLS stream fields come from the worker that actually processes the playlists instead of the page-local `StreamInfos` copy.

Debug helpers:

```js
simulateAds(1)          // simulate backup-player depth
simulateAds(0)          // disable simulation
allSegmentsAreAdSegments()
reloadTwitchPlayer()
```

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

### Side/chat ad slot appears

Check `vaftStatus().csai`. A rising CSAI counter with no corresponding HLS `showingAd` state indicates client-side ad activity that the playlist layer does not see.

Standalone `media-amazon.com` ad videos are hidden automatically. If you explicitly want to test network-level CSAI blocking as well:

```js
setCsaiBlocking(true)
```

If Twitch behavior becomes worse, disable it again and include the `csai` counters in the bug report.

### Player hangs, goes black, or reloads unexpectedly

Capture `vaftStatus()` while the issue is happening and include relevant console messages. In particular, note:

- `channel`
- `showingAd`
- `strippingSegments`
- `backupPlayerType`
- `lastPlayerReload`
- `numStrippedAdSegments`
- `blockCsaiAdRequests`
- `csai`
- `lastUpdate`

For HEVC/AV1 issues, also mention the selected Twitch quality and browser.

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
- Workers already containing VAFT hooks are not injected a second time.
- Signed/query-string `.m3u8` URLs are accepted.
- Missing or mixed-order codec metadata is tolerated.
- AVC, HEVC, and AV1 are classified explicitly.
- Same-family backup renditions are preferred before cross-codec fallback.
- Enhanced-codec playlists never receive the AVC blank segment.
- Standalone Twitch ad videos cannot become the primary-video target merely because of DOM order.
- Recycled ad video nodes are restored when Twitch reuses them for content.
- `RequestedAds` is bounded to avoid unbounded growth.
- Auto-quality retries after transient failures and always clears its busy state.
- Worker-side runtime state is bridged into `vaftStatus()`.
- CSAI requests are counted by transport and break type, with optional explicit network blocking.

## Development

Run the regression checks with:

```bash
node check.js
```

The suite covers fetch normalization, HLS parsing, codec-family safety, enhanced-segment handling, worker lifecycle behavior, standalone-video targeting/restoration, CSAI Fetch/XHR handling, auto-quality state, and runtime diagnostics.

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
- CSAI network blocking is experimental and intentionally opt-in.
- Page-context code cannot control every browser-, extension-, or cross-origin-frame behavior Twitch may use.
- Twitch changes its player and delivery stack frequently, so breakage can happen without warning.
- This project is not affiliated with Twitch.

Credits: [pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions) and [VideoAdBlockForTwitch](https://github.com/cleanlock/VideoAdBlockForTwitch#credits).

License: [MIT](LICENSE)

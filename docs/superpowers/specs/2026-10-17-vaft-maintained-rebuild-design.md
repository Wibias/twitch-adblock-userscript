# VAFT Maintained Rebuild Design

## Goal

Reconstruct `0rpi/twitch-adblock-userscript` from the archived `pixeltris/TwitchAdSolutions` VAFT 37.0.0 code baseline, reapply the fork's proven 37.2/37.3 changes as an explicit layer, then add a small 37.4 reliability layer without changing the core ad-blocking strategy.

## Lineage

The working branch stays based on `origin/main` so it remains mergeable with the existing repository. Its first code commit replaces the userscript with the archived upstream VAFT 37.0.0 file. The next commit restores the current maintained fork. This gives a visible code-state lineage without introducing unrelated-history merges.

## 37.4 scope

- Preserve the browser's native hidden-tab getter before VAFT overrides `document.hidden`; use the preserved getter for VAFT's own background guards.
- Make auto-quality mark an attempt complete only when `setQuality()` succeeds; always clear the busy flag with `finally`.
- Normalize Fetch API input for string URLs, `URL`, `Request`, `Headers`, missing `init`, and malformed playback-token JSON.
- Replace retained Worker array state with a `Set`, revoke generated Worker blob URLs, remove terminated/dead workers, and bound worker-to-page fetch bridges with a 15 s timeout.
- Accept signed/query-string HTTPS `.m3u8` URLs and tolerate missing codec metadata.
- Cap the per-stream `RequestedAds` set at 100 entries.
- Add local, read-only diagnostics at `window.vaftStatus()`.
- Keep the existing 360p/Source fallback, auto-quality toggle, latency catch-up, player reload behavior, and upstream anti-conflict version protocol.

## Non-goals

No new ad endpoint, proxy, DNS strategy, telemetry, external service, large UI redesign, or speculative Twitch experiment handling is added. `ourTwitchAdSolutionsVersion` stays at 24 because the compatibility protocol does not change.

## Verification

The existing `check.js` remains the main test entrypoint. It is updated for version 37.4 and the native hidden-state guard, then loads `check-hardening.js`, which tests the new invariants and exercises HLS URL parsing and Fetch API normalization under Node 20.

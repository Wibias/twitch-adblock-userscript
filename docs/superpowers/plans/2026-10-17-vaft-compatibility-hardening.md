# VAFT Compatibility Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the maintained VAFT userscript in three independently testable releases: codec safety, standalone Twitch video-ad resilience, and CSAI observability/blocking.

**Architecture:** Keep the existing single-userscript architecture and add narrowly scoped helpers rather than importing whole downstream forks. Each release lands independently behind its own branch/PR and preserves the 37.x public-version line and internal VAFT mutex semantics.

**Tech Stack:** JavaScript userscript, Node.js assertions/smoke tests, GitHub Actions.

**Spec:** Approved conversation design: 37.5.0 Codec Safety → 37.5.1 separate-video resilience → 37.6 CSAI.

## Global Constraints

- Preserve `ourTwitchAdSolutionsVersion = 24` unless the conflict protocol itself changes.
- Bump userscript `@version` for every runtime-visible release.
- No broad selector/blocklist imports from downstream forks.
- Every runtime change must have a RED→GREEN regression test and pass `node check.js` plus syntax/version CI.
- Keep `window.vaftStatus()` useful for field diagnostics.

## Review Focus

- Missing, mixed-order, uppercase, or unrecognised `CODECS` attributes must never throw or silently classify as AVC.
- HEVC/AV1 playlists must never receive the hard-coded AVC blank segment.
- A standalone ad `<video>` must never be mistaken for the primary player, and a recycled node must be restored.
- Re-entering an already-hooked Twitch worker must not install hooks twice.
- CSAI interception must support string, URL, Request, fetch and XHR paths without breaking Twitch GQL handling.

---

### Task 1: 37.5.0 Codec Safety

**Files:**
- Modify: `twitch-adblock.user.js`
- Modify: `check-hardening.js`
- Modify: `check.js` only if required by the test harness

**Interfaces:**
- Produces: `videoCodecFamily(codecs)` returning `avc`, `hevc`, `av1`, or `unknown`.
- Consumes: existing stream-resolution, modified-master, media-playlist, ad-segment-cache paths.

- [ ] Add failing tests for AVC/HEVC/AV1/missing/mixed-order CODECS classification and enhanced-codec blank-segment protection.
- [ ] Run CI and confirm the new tests fail for the current 37.4.1 implementation.
- [ ] Implement codec-family classification, AV1 parity, same-family backup preference, and no AVC blank injection into enhanced playlists.
- [ ] Bump public version to `37.5.0` without changing internal mutex `24`.
- [ ] Run full checks and open a PR only after GREEN.

### Task 2: 37.5.1 Standalone Video Resilience

**Files:**
- Modify: `twitch-adblock.user.js`
- Modify: `check-hardening.js`

**Interfaces:**
- Produces: primary-player video helper plus standalone ad-video hide/restore guard.
- Consumes: existing buffer monitor, auto-quality, visibility/refocus, worker constructor paths.

- [ ] Add failing tests proving the first DOM video can be an ad, marked ad videos are skipped, recycled nodes restore, and an already-hooked worker is not re-injected.
- [ ] Implement the smallest safe helpers and route existing raw first-video lookups through them.
- [ ] Bump public version to `37.5.1`.
- [ ] Run full checks and open a PR only after GREEN.

### Task 3: 37.6 CSAI Observability and Optional Blocking

**Files:**
- Modify: `twitch-adblock.user.js`
- Modify: `check-hardening.js`
- Modify: `README.md`

**Interfaces:**
- Produces: CSAI counters in `vaftStatus()` and opt-out-controlled `edge.ads.twitch.tv` request blocking across fetch/XHR.
- Consumes: current hardened fetch wrapper and diagnostics state.

- [ ] Add failing tests for string/URL/Request fetch detection, XHR detection, counters, and block opt-out.
- [ ] Add diagnostics first; then implement network-filter-like blocking with `twitchAdSolutions_blockCsaiAdRequests=false` as the opt-out.
- [ ] Preserve GQL handling and malformed-input safety.
- [ ] Bump public version to `37.6.0`, update English README diagnostics/config docs.
- [ ] Run full checks and open a PR only after GREEN.

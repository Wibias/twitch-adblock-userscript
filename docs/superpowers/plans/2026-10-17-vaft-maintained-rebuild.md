# VAFT Maintained Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconstruct the maintained userscript lineage and ship VAFT 37.4 reliability hardening with regression coverage.

**Architecture:** Keep the repository mergeable by creating the reconstruction branch from `origin/main`, commit an exact archived VAFT 37.0.0 userscript state, then restore the fork's current 37.3.0 state before applying 37.4 changes. Do not change the ad-blocking algorithm; harden lifecycle, Fetch compatibility, background-state handling, HLS parsing, and tests.

**Tech Stack:** JavaScript userscript, Node.js 20 assertions, Git, PowerShell 7.

**Spec:** `docs/superpowers/specs/2026-10-17-vaft-maintained-rebuild-design.md`

## Global Constraints

- Upstream code baseline: `pixeltris/TwitchAdSolutions` `vaft/vaft.user.js` version 37.0.0.
- Public release after hardening: `@version 37.4.0`.
- Internal anti-conflict version remains `ourTwitchAdSolutionsVersion = 24`.
- No external runtime dependencies or telemetry.
- Existing fallback and quality preferences remain compatible with current localStorage keys.

## Review Focus

- Hidden tabs must use the captured native visibility getter, not VAFT's patched `document.hidden` value.
- `fetch()` must not throw when `init` or headers are missing, or when input is a `Request`.
- Worker bridge promises must reject instead of remaining pending forever.
- Signed `.m3u8?token=...` URLs must pass freshness parsing.
- A temporary auto-quality failure must be retryable and must not leave `busy = true`.

---

### Task 1: Reconstruct explicit baseline

**Files:**
- Modify: `twitch-adblock.user.js`

**Interfaces:**
- Consumes: archived upstream `vaft/vaft.user.js`.
- Produces: a branch commit whose userscript is VAFT 37.0.0.

- [ ] Fetch `origin/main` and `pixeltris/TwitchAdSolutions` `master`.
- [ ] Create `rebuild/vaft-maintained-37.4` from `origin/main` with a clean worktree.
- [ ] Replace only `twitch-adblock.user.js` with upstream `vaft/vaft.user.js` and verify `@version 37.0.0`.
- [ ] Commit `baseline: restore archived vaft 37.0.0`.

### Task 2: Reapply proven maintained-fork layer

**Files:**
- Modify: `twitch-adblock.user.js`

**Interfaces:**
- Consumes: Task 1 baseline and `origin/main:twitch-adblock.user.js`.
- Produces: the current 37.3.0 behavior as one explicit port commit.

- [ ] Restore `twitch-adblock.user.js` from `origin/main`.
- [ ] Verify `@version 37.3.0`.
- [ ] Run the existing `node check.js` suite.
- [ ] Commit `port: reapply maintained fork improvements through 37.3.0`.

### Task 3: Add 37.4 regression tests

**Files:**
- Create: `check-hardening.js`
- Modify: `check.js`

**Interfaces:**
- Produces: `runHardeningChecks(src)` and a `check.js` hook that executes it.

- [ ] Update `check.js` to expect 37.4 and reject direct `document.hidden` interval guards.
- [ ] Add checks for native hidden-state access, Worker cleanup/timeouts, Fetch normalization, HLS query URLs, codec safety, bounded `RequestedAds`, diagnostics, and auto-quality cleanup.
- [ ] Run the hardening checker against a pre-hardening fixture and verify RED.

### Task 4: Implement 37.4 hardening

**Files:**
- Modify: `twitch-adblock.user.js`
- Modify: `README.md`

**Interfaces:**
- Produces: `window.vaftIsDocumentHidden()`, robust `hookFetch()`, Worker lifecycle cleanup, `window.vaftStatus()`.

- [ ] Capture native hidden getters and route internal hidden-tab guards through them.
- [ ] Add 15 s worker bridge timeout, timeout cleanup, Worker `Set`, blob URL revocation, and terminate/dead-worker cleanup.
- [ ] Normalize Fetch input/headers and protect playback-token JSON parsing.
- [ ] Parse HTTPS HLS URLs with `URL`, tolerate absent codec metadata, cap `RequestedAds` at 100.
- [ ] Make auto-quality set `done` from the real result and clear `busy` in `finally`.
- [ ] Add `window.vaftStatus()` and README notes.
- [ ] Run `node check.js`, `node --check twitch-adblock.user.js`, and `git diff --check`.
- [ ] Commit `feat: harden maintained vaft 37.4.0`.

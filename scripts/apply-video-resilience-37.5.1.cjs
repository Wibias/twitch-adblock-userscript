const fs = require('node:fs');

function replaceOnce(src, from, to, label) {
    const first = src.indexOf(from);
    if (first === -1) throw new Error(`missing patch anchor: ${label}`);
    if (src.indexOf(from, first + from.length) !== -1) throw new Error(`ambiguous patch anchor: ${label}`);
    return src.slice(0, first) + to + src.slice(first + from.length);
}

function replaceRegexOnce(src, regex, to, label) {
    const flags = regex.flags.includes('g') ? regex.flags : regex.flags + 'g';
    const matches = [...src.matchAll(new RegExp(regex.source, flags))];
    if (matches.length !== 1) throw new Error(`expected one regex match for ${label}, got ${matches.length}`);
    return src.replace(regex, to);
}

const userscriptPath = 'twitch-adblock.user.js';
let src = fs.readFileSync(userscriptPath, 'utf8');

src = replaceOnce(src, '// @version      37.5.0', '// @version      37.5.1', 'public version');
src = replaceOnce(src, "version: '37.5.0',", "version: '37.5.1',", 'status version');

const hookMarkerHelper = `    function hasVaftWorkerHooks(workerSource) {
        return typeof workerSource === 'string'
            && workerSource.includes('hookWorkerFetch (vaft)')
            && workerSource.includes('processM3U8');
    }
`;
src = replaceOnce(src, '    function hookWindowWorker() {', hookMarkerHelper + '    function hookWindowWorker() {', 'worker hook marker helper');

const oldWorkerBlock = /                const newBlobStr = `\n[\s\S]*?                const workerBlobUrl = URL\.createObjectURL\(new Blob\(\[newBlobStr\]\)\);\n                try \{\n                    super\(workerBlobUrl, options\);\n                \} finally \{\n                    URL\.revokeObjectURL\(workerBlobUrl\);\n                \}/;
const newWorkerBlock = `                let prefetchedWorkerJs = null;
                try {
                    prefetchedWorkerJs = getWasmWorkerJs(twitchBlobUrl);
                } catch (error) {
                    console.debug('[vaft] could not inspect Twitch worker before injection', error);
                }
                const alreadyHooked = hasVaftWorkerHooks(prefetchedWorkerJs);
                if (!prefetchedWorkerJs) {
                    super(twitchBlobUrl, options);
                } else if (alreadyHooked) {
                    super(twitchBlobUrl, options);
                    console.debug('[vaft] Twitch worker already carries VAFT hooks; skipping reinjection');
                } else {
                    const workerSourceLiteral = JSON.stringify(prefetchedWorkerJs);
                    const newBlobStr = \`
                    const pendingFetchRequests = new Map();
                    \${stripAdSegments.toString()}
                    \${videoCodecFamily.toString()}
                    \${getStreamUrlForResolution.toString()}
                    \${processM3U8.toString()}
                    \${hookWorkerFetch.toString()}
                    \${declareOptions.toString()}
                    \${getAccessToken.toString()}
                    \${gqlRequest.toString()}
                    \${parseAttributes.toString()}
                    \${getServerTimeFromM3u8.toString()}
                    \${replaceServerTimeInM3u8.toString()}
                    \${getFirstM3u8Url.toString()}
                    const workerString = \${workerSourceLiteral};
                    declareOptions(self);
                    BackupPlayerTypes = \${JSON.stringify(BackupPlayerTypes)};
                    GQLDeviceID = \${GQLDeviceID ? "'" + GQLDeviceID + "'" : null};
                    AuthorizationHeader = \${AuthorizationHeader ? "'" + AuthorizationHeader + "'" : undefined};
                    ClientIntegrityHeader = \${ClientIntegrityHeader ? "'" + ClientIntegrityHeader + "'" : null};
                    ClientVersion = \${ClientVersion ? "'" + ClientVersion + "'" : null};
                    ClientSession = \${ClientSession ? "'" + ClientSession + "'" : null};
                    self.addEventListener('message', function(e) {
                        if (e.data.key == 'UpdateClientVersion') {
                            ClientVersion = e.data.value;
                        } else if (e.data.key == 'UpdateClientSession') {
                            ClientSession = e.data.value;
                        } else if (e.data.key == 'UpdateClientId') {
                            ClientID = e.data.value;
                        } else if (e.data.key == 'UpdateDeviceId') {
                            GQLDeviceID = e.data.value;
                        } else if (e.data.key == 'UpdateClientIntegrityHeader') {
                            ClientIntegrityHeader = e.data.value;
                        } else if (e.data.key == 'UpdateAuthorizationHeader') {
                            AuthorizationHeader = e.data.value;
                        } else if (e.data.key == 'FetchResponse') {
                            const responseData = e.data.value;
                            if (pendingFetchRequests.has(responseData.id)) {
                                const { resolve, reject, timeoutId } = pendingFetchRequests.get(responseData.id);
                                pendingFetchRequests.delete(responseData.id);
                                clearTimeout(timeoutId);
                                if (responseData.error) {
                                    reject(new Error(responseData.error));
                                } else {
                                    const response = new Response(responseData.body, {
                                        status: responseData.status,
                                        statusText: responseData.statusText,
                                        headers: responseData.headers
                                    });
                                    resolve(response);
                                }
                            }
                        } else if (e.data.key == 'TriggeredPlayerReload') {
                            HasTriggeredPlayerReload = true;
                        } else if (e.data.key == 'SimulateAds') {
                            SimulatedAdsDepth = e.data.value;
                            console.log('SimulatedAdsDepth: ' + SimulatedAdsDepth);
                        } else if (e.data.key == 'AllSegmentsAreAdSegments') {
                            AllSegmentsAreAdSegments = !AllSegmentsAreAdSegments;
                            console.log('AllSegmentsAreAdSegments: ' + AllSegmentsAreAdSegments);
                        } else if (e.data.key == 'UpdateBackupPlayerTypes') {
                            BackupPlayerTypes = e.data.value;
                        }
                    });
                    hookWorkerFetch();
                    eval(workerString);
                    \`;
                    const workerBlobUrl = URL.createObjectURL(new Blob([newBlobStr]));
                    try {
                        super(workerBlobUrl, options);
                    } finally {
                        URL.revokeObjectURL(workerBlobUrl);
                    }
                }`;
src = replaceRegexOnce(src, oldWorkerBlock, newWorkerBlock, 'worker reinjection block');

const videoHelpers = `    function isStandaloneTwitchAdVideo(video) {
        if (!video) return false;
        const videoSrc = video.currentSrc || video.getAttribute?.('src') || '';
        if (!videoSrc || videoSrc.startsWith('blob:')) return false;
        try {
            const host = new URL(videoSrc, document.location.href).hostname.toLowerCase();
            return host === 'media-amazon.com' || host.endsWith('.media-amazon.com');
        } catch {
            return false;
        }
    }
    function getPlayerVideoElement() {
        const knownPlayerVideo = playerForMonitoringBuffering?.player?.getHTMLVideoElement?.();
        if (knownPlayerVideo && !isStandaloneTwitchAdVideo(knownPlayerVideo)) {
            return knownPlayerVideo;
        }
        const videos = document.getElementsByTagName('video');
        for (let i = 0; i < videos.length; i++) {
            const video = videos[i];
            if (!video.dataset.vaftAdHidden && !isStandaloneTwitchAdVideo(video)) {
                return video;
            }
        }
        return null;
    }
    window.vaftGetPlayerVideoElement = getPlayerVideoElement;
    function hideStandaloneTwitchVideoAds() {
        const primaryVideo = playerForMonitoringBuffering?.player?.getHTMLVideoElement?.();
        const videos = document.getElementsByTagName('video');
        for (let i = 0; i < videos.length; i++) {
            const video = videos[i];
            const isAdVideo = isStandaloneTwitchAdVideo(video);
            if (isAdVideo && video !== primaryVideo) {
                if (!video.dataset.vaftAdHidden) {
                    video.dataset.vaftAdHidden = '1';
                    video.dataset.vaftAdWasMuted = video.muted ? '1' : '0';
                }
                video.style.setProperty('display', 'none', 'important');
                try {
                    video.muted = true;
                    if (!video.paused) video.pause();
                } catch {}
            } else if (video.dataset.vaftAdHidden && !isAdVideo) {
                const wasMuted = video.dataset.vaftAdWasMuted === '1';
                delete video.dataset.vaftAdHidden;
                delete video.dataset.vaftAdWasMuted;
                video.style.removeProperty('display');
                try { video.muted = wasMuted; } catch {}
            }
        }
    }
`;
src = replaceOnce(src, '    function monitorPlayerBuffering() {', videoHelpers + '    function monitorPlayerBuffering() {\n        hideStandaloneTwitchVideoAds();', 'standalone video helpers');
src = replaceOnce(src, "        if (!playerForMonitoringBuffering && document.querySelector('video')) {", '        if (!playerForMonitoringBuffering && getPlayerVideoElement()) {', 'monitor first-video guard');

const oldVisibility = `            const videos = document.getElementsByTagName('video');
            if (videos.length > 0) {
                if (isDocumentActuallyHidden()) {
                    wasVideoPlaying = !videos[0].paused && !videos[0].ended;
                } else {
                    if (!playerBufferState.hasStreamStarted) {
                        playerBufferState.hasStreamStarted = true;
                    }
                    if (isChrome && wasVideoPlaying && !videos[0].ended && videos[0].paused && videos[0].muted) {
                        videos[0].play();
                    }`;
const newVisibility = `            const video = getPlayerVideoElement();
            if (video) {
                if (isDocumentActuallyHidden()) {
                    wasVideoPlaying = !video.paused && !video.ended;
                } else {
                    if (!playerBufferState.hasStreamStarted) {
                        playerBufferState.hasStreamStarted = true;
                    }
                    if (isChrome && wasVideoPlaying && !video.ended && video.paused && video.muted) {
                        video.play();
                    }`;
src = replaceOnce(src, oldVisibility, newVisibility, 'visibility player video lookup');
src = replaceOnce(src, "    const v = q('video');", '    const v = window.vaftGetPlayerVideoElement?.();', 'auto-quality video lookup');

fs.writeFileSync(userscriptPath, src);

const checkPath = 'check.js';
let check = fs.readFileSync(checkPath, 'utf8');
check = replaceOnce(check, "assert(versionMatch[1] === '37.5.0', `expected @version 37.5.0, got ${versionMatch[1]}`);", "assert(versionMatch[1] === '37.5.1', `expected @version 37.5.1, got ${versionMatch[1]}`);", 'check version');
fs.writeFileSync(checkPath, check);

const hardeningPath = 'check-hardening.js';
let hardening = fs.readFileSync(hardeningPath, 'utf8');
hardening = replaceOnce(hardening, "assert(/\\/\\/ @version\\s+37\\.5\\.0/.test(src), '37.5.0 version missing');", "assert(/\\/\\/ @version\\s+37\\.5\\.1/.test(src), '37.5.1 version missing');", 'hardening version');
fs.writeFileSync(hardeningPath, hardening);

console.log('standalone video resilience patch applied');
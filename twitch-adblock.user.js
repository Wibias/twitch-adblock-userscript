// ==UserScript==
// @name         Twitch Adblock Userscript
// @namespace    https://github.com/0rpi/twitch-adblock-userscript
// @version      37.6.1
// @description  Blocks Twitch ads (fork of vaft from pixeltris/TwitchAdSolutions) with a 360p/Source ad fallback toggle and auto 1440p60/1080p60 quality (toggleable)
// @author       0rpi, pixeltris/TwitchAdSolutions contributors, VideoAdBlockForTwitch contributors (https://github.com/cleanlock/VideoAdBlockForTwitch#credits)
// @license      MIT
// @homepageURL  https://github.com/Wibias/twitch-adblock-userscript
// @supportURL   https://github.com/Wibias/twitch-adblock-userscript/issues
// @updateURL    https://raw.githubusercontent.com/Wibias/twitch-adblock-userscript/main/twitch-adblock.user.js
// @downloadURL  https://raw.githubusercontent.com/Wibias/twitch-adblock-userscript/main/twitch-adblock.user.js
// @match        *://*.twitch.tv/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// ==/UserScript==
(function() {
    'use strict';
    // Versioning note: @version above (37.x) is the public release number used by
    // Violentmonkey/Tampermonkey for auto-update. Bump it on every user-visible change.
    // ourTwitchAdSolutionsVersion below is an INTERNAL anti-conflict guard (upstream vaft
    // compat): only bump it if the conflict protocol with other vaft copies changes.
    const ourTwitchAdSolutionsVersion = 24;// Used to prevent conflicts with outdated versions of the scripts
    if (typeof window.twitchAdSolutionsVersion !== 'undefined' && window.twitchAdSolutionsVersion >= ourTwitchAdSolutionsVersion) {
        console.log("skipping vaft as there's another script active. ourVersion:" + ourTwitchAdSolutionsVersion + " activeVersion:" + window.twitchAdSolutionsVersion);
        window.twitchAdSolutionsVersion = ourTwitchAdSolutionsVersion;
        return;
    }
    window.twitchAdSolutionsVersion = ourTwitchAdSolutionsVersion;
    function declareOptions(scope) {
        scope.AdSignifier = 'stitched';
        scope.ClientID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
        scope.BackupPlayerTypes = [
            'embed',//Source
            'popout',//Source
            'autoplay',//360p
            //'picture-by-picture-CACHED'//360p (-CACHED is an internal suffix and is removed)
        ];
        scope.FallbackPlayerType = 'embed';
        scope.ForceAccessTokenPlayerType = 'popout';
        scope.SkipPlayerReloadOnHevc = false;// If true this will skip player reload on streams which have 2k/4k quality (if you enable this and you use the 2k/4k quality setting you'll get error #4000 / #3000 / spinning wheel on chrome based browsers)
        scope.AlwaysReloadPlayerOnAd = false;// Always pause/play when entering/leaving ads
        scope.ReloadPlayerAfterAd = false;// After the ad finishes do a player reload instead of pause/play
        scope.PlayerReloadMinimalRequestsTime = 1500;
        scope.PlayerReloadMinimalRequestsPlayerIndex = 0;
        scope.HasTriggeredPlayerReload = false;
        scope.StreamInfos = [];
        scope.StreamInfosByUrl = [];
        scope.GQLDeviceID = null;
        scope.ClientVersion = null;
        scope.ClientSession = null;
        scope.ClientIntegrityHeader = null;
        scope.AuthorizationHeader = undefined;
        scope.SimulatedAdsDepth = 0;
        scope.PlayerBufferingFix = true;// If true this will pause/play the player when it gets stuck buffering
        scope.PlayerBufferingDelay = 600;// How often should we check the player state (in milliseconds)
        scope.PlayerBufferingSameStateCount = 3;// How many times of seeing the same player state until we trigger pause/play (it will only trigger it one time until the player state changes again)
        scope.PlayerBufferingDangerZone = 1;// The buffering time left (in seconds) when we should ignore the players playback position in the player state check
        scope.PlayerBufferingDoPlayerReload = false;// If true this will do a player reload instead of pause/play (player reloading is better at fixing the playback issues but it takes slightly longer)
        scope.PlayerBufferingMinRepeatDelay = 8000;// Minimum delay (in milliseconds) between each pause/play (this is to avoid over pressing pause/play when there are genuine buffering problems)
        scope.PlayerBufferingPrerollCheckEnabled = false;// Enable this if you're getting an immediate pause/play/reload as you open a stream (which is causing the stream to take longer to load). One problem with this being true is that it can cause the player to get stuck in some instances requiring the user to press pause/play
        scope.PlayerBufferingPrerollCheckOffset = 5;// How far the stream need to move before doing the buffering mitigation (depends on PlayerBufferingPrerollCheckEnabled being true)
        scope.V2API = false;
        scope.IsAdStrippingEnabled = true;
        scope.AdSegmentCache = new Map();
        scope.AllSegmentsAreAdSegments = false;
        scope.WorkerFetchTimeoutMs = 15000;
        scope.BlockCsaiAdRequests = false;// CSAI observation is always on; active blocking is opt-in.
    }
    let isActivelyStrippingAds = false;
    let localStorageHookFailed = false;
    const nativeHiddenGetter = document.__lookupGetter__('hidden');
    const nativeWebkitHiddenGetter = document.__lookupGetter__('webkitHidden');
    function isDocumentActuallyHidden() {
        try {
            if (nativeHiddenGetter) {
                return nativeHiddenGetter.call(document) === true;
            }
            if (nativeWebkitHiddenGetter) {
                return nativeWebkitHiddenGetter.call(document) === true;
            }
        } catch {}
        return false;
    }
    window.vaftIsDocumentHidden = isDocumentActuallyHidden;
    const twitchWorkers = new Set();
    const csaiRequestStats = {
        total: 0,
        blocked: 0,
        allowed: 0,
        fetch: 0,
        xhr: 0,
        preroll: 0,
        midroll: 0,
        unknown: 0
    };
    function getCsaiRequestType(requestUrl) {
        if (typeof requestUrl !== 'string' || !requestUrl) return null;
        try {
            const parsed = new URL(requestUrl);
            if (parsed.hostname.toLowerCase() !== 'edge.ads.twitch.tv') return null;
            const breakPosition = parsed.searchParams.get('bp');
            if (breakPosition === 'midroll') return 'midroll';
            if (breakPosition === 'preroll') return 'preroll';
            return 'unknown';
        } catch {
            return null;
        }
    }
    function recordCsaiRequest(type, transport, blocked) {
        const normalizedType = type === 'preroll' || type === 'midroll' ? type : 'unknown';
        const normalizedTransport = transport === 'xhr' ? 'xhr' : 'fetch';
        csaiRequestStats.total++;
        csaiRequestStats[normalizedType]++;
        csaiRequestStats[normalizedTransport]++;
        csaiRequestStats[blocked ? 'blocked' : 'allowed']++;
        if (csaiRequestStats.total === 1 || csaiRequestStats.total % 10 === 0) {
            console.debug('[vaft] CSAI request', {
                type: normalizedType,
                transport: normalizedTransport,
                blocked: Boolean(blocked),
                total: csaiRequestStats.total
            });
        }
    }
    function getCsaiStatsSnapshot() {
        return {
            total: csaiRequestStats.total,
            blocked: csaiRequestStats.blocked,
            allowed: csaiRequestStats.allowed,
            fetch: csaiRequestStats.fetch,
            xhr: csaiRequestStats.xhr,
            preroll: csaiRequestStats.preroll,
            midroll: csaiRequestStats.midroll,
            unknown: csaiRequestStats.unknown
        };
    }

    const vaftRuntimeStatus = {
        channel: null,
        showingAd: false,
        strippingSegments: false,
        backupPlayerType: null,
        lastPlayerReload: null,
        numStrippedAdSegments: 0,
        isMidroll: false,
        lastUpdate: null
    };
    function updateVaftRuntimeStatus(nextStatus) {
        if (!nextStatus || typeof nextStatus !== 'object') {
            return;
        }
        Object.assign(vaftRuntimeStatus, nextStatus);
        vaftRuntimeStatus.lastUpdate = Date.now();
    }
    const workerStringConflicts = [
        'twitch',
        'isVariantA'// TwitchNoSub
    ];
    const workerStringAllow = [];
    const workerStringReinsert = [
        'isVariantA',// TwitchNoSub (prior to (0.9))
        'besuper/',// TwitchNoSub (0.9)
        '${patch_url}'// TwitchNoSub (0.9.1)
    ];
    function getCleanWorker(worker) {
        let root = null;
        let parent = null;
        let proto = worker;
        while (proto) {
            const workerString = proto.toString();
            if (workerStringConflicts.some((x) => workerString.includes(x)) && !workerStringAllow.some((x) => workerString.includes(x))) {
                if (parent !== null) {
                    Object.setPrototypeOf(parent, Object.getPrototypeOf(proto));
                }
            } else {
                if (root === null) {
                    root = proto;
                }
                parent = proto;
            }
            proto = Object.getPrototypeOf(proto);
        }
        return root;
    }
    function getWorkersForReinsert(worker) {
        const result = [];
        let proto = worker;
        while (proto) {
            const workerString = proto.toString();
            if (workerStringReinsert.some((x) => workerString.includes(x))) {
                result.push(proto);
            }
            proto = Object.getPrototypeOf(proto);
        }
        return result;
    }
    function reinsertWorkers(worker, reinsert) {
        let parent = worker;
        for (let i = 0; i < reinsert.length; i++) {
            Object.setPrototypeOf(reinsert[i], parent);
            parent = reinsert[i];
        }
        return parent;
    }
    function isValidWorker(worker) {
        const workerString = worker.toString();
        return !workerStringConflicts.some((x) => workerString.includes(x))
            || workerStringAllow.some((x) => workerString.includes(x))
            || workerStringReinsert.some((x) => workerString.includes(x));
    }
    function hasVaftWorkerHooks(workerSource) {
        return typeof workerSource === 'string'
            && workerSource.includes('hookWorkerFetch (vaft)')
            && workerSource.includes('processM3U8');
    }
    function hookWindowWorker() {
        const reinsert = getWorkersForReinsert(window.Worker);
        const newWorker = class Worker extends getCleanWorker(window.Worker) {
            constructor(twitchBlobUrl, options) {
                let isTwitchWorker = false;
                try {
                    isTwitchWorker = new URL(twitchBlobUrl).origin.endsWith('.twitch.tv');
                } catch {}
                if (!isTwitchWorker) {
                    super(twitchBlobUrl, options);
                    return;
                }
                let prefetchedWorkerJs = null;
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
                    const newBlobStr = `
                    const pendingFetchRequests = new Map();
                    ${stripAdSegments.toString()}
                    ${videoCodecFamily.toString()}
                    ${getStreamUrlForResolution.toString()}
                    ${processM3U8.toString()}
                    ${hookWorkerFetch.toString()}
                    ${declareOptions.toString()}
                    ${getAccessToken.toString()}
                    ${gqlRequest.toString()}
                    ${parseAttributes.toString()}
                    ${getServerTimeFromM3u8.toString()}
                    ${replaceServerTimeInM3u8.toString()}
                    ${getFirstM3u8Url.toString()}
                    const workerString = ${workerSourceLiteral};
                    declareOptions(self);
                    BackupPlayerTypes = ${JSON.stringify(BackupPlayerTypes)};
                    GQLDeviceID = ${GQLDeviceID ? "'" + GQLDeviceID + "'" : null};
                    AuthorizationHeader = ${AuthorizationHeader ? "'" + AuthorizationHeader + "'" : undefined};
                    ClientIntegrityHeader = ${ClientIntegrityHeader ? "'" + ClientIntegrityHeader + "'" : null};
                    ClientVersion = ${ClientVersion ? "'" + ClientVersion + "'" : null};
                    ClientSession = ${ClientSession ? "'" + ClientSession + "'" : null};
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
                    `;
                    const workerBlobUrl = URL.createObjectURL(new Blob([newBlobStr]));
                    try {
                        super(workerBlobUrl, options);
                    } finally {
                        URL.revokeObjectURL(workerBlobUrl);
                    }
                }
                twitchWorkers.add(this);
                const realTerminate = this.terminate.bind(this);
                this.terminate = () => {
                    twitchWorkers.delete(this);
                    realTerminate();
                };
                this.addEventListener('message', (e) => {
                    if (e.data.key == 'UpdateAdBlockBanner') {
                        updateVaftRuntimeStatus(e.data.runtimeStatus);
                        updateAdblockBanner(e.data);
                    } else if (e.data.key == 'PauseResumePlayer') {
                        doTwitchPlayerTask(true, false);
                    } else if (e.data.key == 'ReloadPlayer') {
                        doTwitchPlayerTask(false, true);
                    }
                });
                this.addEventListener('message', async event => {
                    if (event.data.key == 'FetchRequest') {
                        const fetchRequest = event.data.value;
                        const responseData = await handleWorkerFetchRequest(fetchRequest);
                        this.postMessage({
                            key: 'FetchResponse',
                            value: responseData
                        });
                    }
                });
            }
        };
        let workerInstance = reinsertWorkers(newWorker, reinsert);
        Object.defineProperty(window, 'Worker', {
            get: function() {
                return workerInstance;
            },
            set: function(value) {
                if (isValidWorker(value)) {
                    workerInstance = value;
                } else {
                    console.log('Attempt to set twitch worker denied');
                }
            }
        });
    }
    function getWasmWorkerJs(twitchBlobUrl) {
        const req = new XMLHttpRequest();
        req.open('GET', twitchBlobUrl, false);
        req.overrideMimeType("text/javascript");
        req.send();
        return req.responseText;
    }
    function hookWorkerFetch() {
        console.log('hookWorkerFetch (vaft)');
        const realFetch = fetch;
        fetch = async function(url, options) {
            if (typeof url === 'string') {
                const adCacheEntry = AdSegmentCache.get(url);
                if (adCacheEntry !== undefined) {
                    if (adCacheEntry.enhanced) {
                        return new Response('', { status: 403, statusText: 'ad segment blocked' });
                    }
                    return new Promise(function(resolve, reject) {
                        const send = function() {
                            return realFetch('data:video/mp4;base64,AAAAKGZ0eXBtcDQyAAAAAWlzb21tcDQyZGFzaGF2YzFpc282aGxzZgAABEltb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAYagAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAABqHRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAURtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAALuAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAADvbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAACzc3RibAAAAGdzdHNkAAAAAAAAAAEAAABXbXA0YQAAAAAAAAABAAAAAAAAAAAAAgAQAAAAALuAAAAAAAAzZXNkcwAAAAADgICAIgABAASAgIAUQBUAAAAAAAAAAAAAAAWAgIACEZAGgICAAQIAAAAQc3R0cwAAAAAAAAAAAAAAEHN0c2MAAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAAeV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAoAAAAFoAAAAAAGBbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAA9CQAAAAABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABLG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAOxzdGJsAAAAoHN0c2QAAAAAAAAAAQAAAJBhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAoABaABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAOmF2Y0MBTUAe/+EAI2dNQB6WUoFAX/LgLUBAQFAAAD6AAA6mDgAAHoQAA9CW7y4KAQAEaOuPIAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAASG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAC4AAAAAAoAAAAAAACB0cmV4AAAAAAAAAAIAAAABAACCNQAAAAACQAAA', options).then(function(response) {
                                resolve(response);
                            })['catch'](function(err) {
                                reject(err);
                            });
                        };
                        send();
                    });
                }
                url = url.trimEnd();
                if (url.endsWith('m3u8')) {
                    return new Promise(function(resolve, reject) {
                        const processAfter = async function(response) {
                            if (response.status === 200) {
                                resolve(new Response(await processM3U8(url, await response.text(), realFetch)));
                            } else {
                                resolve(response);
                            }
                        };
                        const send = function() {
                            return realFetch(url, options).then(processAfter)['catch'](function(err) {
                                reject(err);
                            });
                        };
                        send();
                    });
                } else if (url.includes('/channel/hls/') && !url.includes('picture-by-picture')) {
                    V2API = url.includes('/api/v2/');
                    const channelName = (new URL(url)).pathname.match(/([^\/]+)(?=\.\w+$)/)[0];
                    if (ForceAccessTokenPlayerType) {
                        const tempUrl = new URL(url);
                        tempUrl.searchParams.delete('parent_domains');
                        url = tempUrl.toString();
                    }
                    return new Promise(function(resolve, reject) {
                        const processAfter = async function(response) {
                            if (response.status == 200) {
                                const encodingsM3u8 = await response.text();
                                const serverTime = getServerTimeFromM3u8(encodingsM3u8);
                                let streamInfo = StreamInfos[channelName];
                                if (streamInfo != null && streamInfo.EncodingsM3U8 != null) {
                                    const prevM3u8Url = getFirstM3u8Url(streamInfo.EncodingsM3U8);
                                    if (!prevM3u8Url || (await realFetch(prevM3u8Url)).status !== 200) {
                                        streamInfo = null;
                                    }
                                }
                                if (streamInfo == null || streamInfo.EncodingsM3U8 == null) {
                                    StreamInfos[channelName] = streamInfo = {
                                        ChannelName: channelName,
                                        IsShowingAd: false,
                                        LastPlayerReload: 0,
                                        EncodingsM3U8: encodingsM3u8,
                                        ModifiedM3U8: null,
                                        IsUsingModifiedM3U8: false,
                                        UsherParams: (new URL(url)).search,
                                        RequestedAds: new Set(),
                                        Urls: [],
                                        ResolutionList: [],
                                        BackupEncodingsM3U8Cache: [],
                                        ActiveBackupPlayerType: null,
                                        IsMidroll: false,
                                        IsStrippingAdSegments: false,
                                        NumStrippedAdSegments: 0
                                    };
                                    const lines = encodingsM3u8.replaceAll('\r', '').split('\n');
                                    for (let i = 0; i < lines.length - 1; i++) {
                                        if (lines[i].startsWith('#EXT-X-STREAM-INF') && lines[i + 1].includes('.m3u8')) {
                                            const attributes = parseAttributes(lines[i]);
                                            const resolution = attributes['RESOLUTION'];
                                            if (resolution) {
                                                const resolutionInfo = {
                                                    Resolution: resolution,
                                                    FrameRate: attributes['FRAME-RATE'],
                                                    Codecs: attributes['CODECS'] || '',
                                                    Url: lines[i + 1]
                                                };
                                                streamInfo.Urls[lines[i + 1]] = resolutionInfo;
                                                streamInfo.ResolutionList.push(resolutionInfo);
                                            }
                                            StreamInfosByUrl[lines[i + 1]] = streamInfo;
                                        }
                                    }
                                    const decodableResolutionList = streamInfo.ResolutionList.filter((element) => videoCodecFamily(element.Codecs) === 'avc');
                                    const hasEnhancedVariant = streamInfo.ResolutionList.some((element) => { const family = videoCodecFamily(element.Codecs); return family === 'hevc' || family === 'av1'; });
                                    if (AlwaysReloadPlayerOnAd || (decodableResolutionList.length > 0 && hasEnhancedVariant && !SkipPlayerReloadOnHevc)) {
                                        if (decodableResolutionList.length > 0) {
                                            for (let i = 0; i < lines.length - 1; i++) {
                                                if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                                                    const resSettings = parseAttributes(lines[i].substring(lines[i].indexOf(':') + 1));
                                                    const codecsKey = 'CODECS';
                                                    const codecs = resSettings[codecsKey] || '';
                                                    const codecFamily = videoCodecFamily(codecs);
                                                    if (codecFamily === 'hevc' || codecFamily === 'av1') {
                                                        const oldResolution = resSettings['RESOLUTION'];
                                                        const [targetWidth, targetHeight] = oldResolution.split('x').map(Number);
                                                        const newResolutionInfo = decodableResolutionList.slice().sort((a, b) => {
                                                            const [streamWidthA, streamHeightA] = a.Resolution.split('x').map(Number);
                                                            const [streamWidthB, streamHeightB] = b.Resolution.split('x').map(Number);
                                                            return Math.abs((streamWidthA * streamHeightA) - (targetWidth * targetHeight)) - Math.abs((streamWidthB * streamHeightB) - (targetWidth * targetHeight));
                                                        })[0];
                                                        console.log('ModifiedM3U8 swap ' + resSettings[codecsKey] + ' to ' + newResolutionInfo.Codecs + ' oldRes:' + oldResolution + ' newRes:' + newResolutionInfo.Resolution);
                                                        lines[i] = lines[i].replace(/CODECS="[^"]+"/, `CODECS="${newResolutionInfo.Codecs}"`);
                                                        lines[i + 1] = newResolutionInfo.Url + ' '.repeat(i + 1);
                                                    }
                                                }
                                            }
                                        }
                                        if (decodableResolutionList.length > 0 || AlwaysReloadPlayerOnAd) {
                                            streamInfo.ModifiedM3U8 = lines.join('\n');
                                        }
                                    }
                                }
                                streamInfo.LastPlayerReload = Date.now();
                                resolve(new Response(replaceServerTimeInM3u8(streamInfo.IsUsingModifiedM3U8 ? streamInfo.ModifiedM3U8 : streamInfo.EncodingsM3U8, serverTime)));
                            } else {
                                resolve(response);
                            }
                        };
                        const send = function() {
                            return realFetch(url, options).then(processAfter)['catch'](function(err) {
                                reject(err);
                            });
                        };
                        send();
                    });
                }
            }
            return realFetch.apply(this, arguments);
        };
    }
    function getServerTimeFromM3u8(encodingsM3u8) {
        if (V2API) {
            const matches = encodingsM3u8.match(/#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="([^"]+)"/);
            return matches ? matches[1] : null;
        }
        const matches = encodingsM3u8.match('SERVER-TIME="([0-9.]+)"');
        return matches ? matches[1] : null;
    }
    function replaceServerTimeInM3u8(encodingsM3u8, newServerTime) {
        if (V2API) {
            return newServerTime ? encodingsM3u8.replace(/(#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE=")[^"]+(")/, `$1${newServerTime}$2`) : encodingsM3u8;
        }
        return newServerTime ? encodingsM3u8.replace(new RegExp('(SERVER-TIME=")[0-9.]+"'), `SERVER-TIME="${newServerTime}"`) : encodingsM3u8;
    }
    function getFirstM3u8Url(encodingsM3u8) {
        if (typeof encodingsM3u8 !== 'string') {
            return null;
        }
        const lines = encodingsM3u8.replaceAll('\r', '').split('\n');
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) continue;
            try {
                const parsed = new URL(line);
                if (parsed.protocol === 'https:' && parsed.pathname.endsWith('.m3u8')) {
                    return line;
                }
            } catch {}
        }
        return null;
    }
    function videoCodecFamily(codecs) {
        if (typeof codecs !== 'string' || !codecs.trim()) {
            return 'unknown';
        }
        const entries = codecs.toLowerCase().split(',').map((entry) => entry.trim());
        for (const codec of entries) {
            if (codec.startsWith('avc1') || codec.startsWith('avc3')) return 'avc';
            if (codec.startsWith('hev1') || codec.startsWith('hvc1')) return 'hevc';
            if (codec.startsWith('av01') || codec.startsWith('av0')) return 'av1';
        }
        return 'unknown';
    }
    function stripAdSegments(textStr, stripAllSegments, streamInfo, isEnhancedPlaylist = false) {
        let hasStrippedAdSegments = false;
        const lines = textStr.replaceAll('\r', '').split('\n');
        const newAdUrl = 'https://twitch.tv';
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            line = line
                .replaceAll(/(X-TV-TWITCH-AD-URL=")(?:[^"]*)(")/g, `$1${newAdUrl}$2`)
                .replaceAll(/(X-TV-TWITCH-AD-CLICK-TRACKING-URL=")(?:[^"]*)(")/g, `$1${newAdUrl}$2`);
            lines[i] = line;
            if (i < lines.length - 1 && line.startsWith('#EXTINF') && (!line.includes(',live') || stripAllSegments || AllSegmentsAreAdSegments)) {
                const segmentUrl = lines[i + 1];
                if (!AdSegmentCache.has(segmentUrl)) {
                    streamInfo.NumStrippedAdSegments++;
                }
                AdSegmentCache.set(segmentUrl, { timestamp: Date.now(), enhanced: Boolean(isEnhancedPlaylist) });
                hasStrippedAdSegments = true;
            }
            if (line.includes(AdSignifier)) {
                hasStrippedAdSegments = true;
            }
        }
        if (hasStrippedAdSegments) {
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith('#EXT-X-TWITCH-PREFETCH:')) {
                    lines[i] = '';
                }
            }
        } else {
            streamInfo.NumStrippedAdSegments = 0;
        }
        streamInfo.IsStrippingAdSegments = hasStrippedAdSegments;
        AdSegmentCache.forEach((value, key, map) => {
            if ((value?.timestamp ?? value) < Date.now() - 120000) {
                map.delete(key);
            }
        });
        return lines.join('\n');
    }
    function getStreamUrlForResolution(encodingsM3u8, resolutionInfo, selectionOut = null) {
        const encodingsLines = encodingsM3u8.replaceAll('\r', '').split('\n');
        const [targetWidth, targetHeight] = resolutionInfo.Resolution.split('x').map(Number);
        const targetFamily = videoCodecFamily(resolutionInfo.Codecs);
        let bestSameFamily = null;
        let bestSameFamilyScore = Infinity;
        let bestAny = null;
        let bestAnyScore = Infinity;
        for (let i = 0; i < encodingsLines.length - 1; i++) {
            if (!encodingsLines[i].startsWith('#EXT-X-STREAM-INF') || !encodingsLines[i + 1].includes('.m3u8')) continue;
            const attributes = parseAttributes(encodingsLines[i]);
            const resolution = attributes['RESOLUTION'];
            if (!resolution) continue;
            const frameRate = attributes['FRAME-RATE'];
            const codecs = attributes['CODECS'] || '';
            const family = videoCodecFamily(codecs);
            const [width, height] = resolution.split('x').map(Number);
            const difference = Math.abs((width * height) - (targetWidth * targetHeight));
            const exactResolutionPenalty = resolution === resolutionInfo.Resolution ? 0 : 1e12;
            const frameRatePenalty = frameRate == resolutionInfo.FrameRate ? 0 : 1;
            const score = exactResolutionPenalty + difference + frameRatePenalty;
            const candidate = { url: encodingsLines[i + 1], codecs, resolution, frameRate, family };
            if (score < bestAnyScore) {
                bestAny = candidate;
                bestAnyScore = score;
            }
            if (targetFamily !== 'unknown' && family === targetFamily && score < bestSameFamilyScore) {
                bestSameFamily = candidate;
                bestSameFamilyScore = score;
            }
        }
        const selected = bestSameFamily || bestAny;
        if (selectionOut && selected) {
            selectionOut.url = selected.url;
            selectionOut.codecs = selected.codecs;
            selectionOut.resolution = selected.resolution;
            selectionOut.frameRate = selected.frameRate;
            selectionOut.family = selected.family;
        }
        return selected?.url ?? null;
    }
    async function processM3U8(url, textStr, realFetch) {
        const streamInfo = StreamInfosByUrl[url];
        if (!streamInfo) {
            return textStr;
        }
        if (HasTriggeredPlayerReload) {
            HasTriggeredPlayerReload = false;
            streamInfo.LastPlayerReload = Date.now();
        }
        const haveAdTags = textStr.includes(AdSignifier) || SimulatedAdsDepth > 0;
        if (haveAdTags) {
            streamInfo.IsMidroll = textStr.includes('"MIDROLL"') || textStr.includes('"midroll"');
            if (!streamInfo.IsShowingAd) {
                streamInfo.IsShowingAd = true;
                postMessage({
                    key: 'UpdateAdBlockBanner',
                    isMidroll: streamInfo.IsMidroll,
                    hasAds: streamInfo.IsShowingAd,
                    isStrippingAdSegments: false,
                    runtimeStatus: {
                        channel: streamInfo.ChannelName ?? null,
                        showingAd: streamInfo.IsShowingAd ?? false,
                        strippingSegments: false,
                        backupPlayerType: streamInfo.ActiveBackupPlayerType ?? null,
                        lastPlayerReload: streamInfo.LastPlayerReload ?? null,
                        numStrippedAdSegments: streamInfo.NumStrippedAdSegments ?? 0,
                        isMidroll: streamInfo.IsMidroll ?? false
                    }
                });
            }
            if (!streamInfo.IsMidroll) {
                const lines = textStr.replaceAll('\r', '').split('\n');
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (line.startsWith('#EXTINF') && lines.length > i + 1) {
                        if (!line.includes(',live') && !streamInfo.RequestedAds.has(lines[i + 1])) {
                            streamInfo.RequestedAds.add(lines[i + 1]);
                            if (streamInfo.RequestedAds.size > 100) {
                                streamInfo.RequestedAds.delete(streamInfo.RequestedAds.values().next().value);
                            }
                            fetch(lines[i + 1]).then((response)=>{response.blob()});
                            break;
                        }
                    }
                }
            }
            const currentResolution = streamInfo.Urls[url];
            if (!currentResolution) {
                console.log('Ads will leak due to missing resolution info for ' + url);
                return textStr;
            }
            const currentCodecs = currentResolution.Codecs || '';
            const currentCodecFamily = videoCodecFamily(currentCodecs);
            const isEnhanced = currentCodecFamily === 'hevc' || currentCodecFamily === 'av1';
            if (((isEnhanced && !SkipPlayerReloadOnHevc) || AlwaysReloadPlayerOnAd) && streamInfo.ModifiedM3U8 && !streamInfo.IsUsingModifiedM3U8) {
                streamInfo.IsUsingModifiedM3U8 = true;
                streamInfo.LastPlayerReload = Date.now();
                postMessage({
                    key: 'ReloadPlayer'
                });
            }
            let backupPlayerType = null;
            let backupM3u8 = null;
            let fallbackM3u8 = null;
            let backupCodecFamily = 'unknown';
            let fallbackCodecFamily = 'unknown';
            let startIndex = 0;
            let isDoingMinimalRequests = false;
            if (streamInfo.LastPlayerReload > Date.now() - PlayerReloadMinimalRequestsTime) {
                startIndex = PlayerReloadMinimalRequestsPlayerIndex;
                isDoingMinimalRequests = true;
            }
            for (let playerTypeIndex = startIndex; !backupM3u8 && playerTypeIndex < BackupPlayerTypes.length; playerTypeIndex++) {
                const playerType = BackupPlayerTypes[playerTypeIndex];
                const realPlayerType = playerType.replace('-CACHED', '');
                const isFullyCachedPlayerType = playerType != realPlayerType;
                for (let i = 0; i < 2; i++) {
                    let isFreshM3u8 = false;
                    let encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType];
                    if (!encodingsM3u8) {
                        isFreshM3u8 = true;
                        try {
                            const accessTokenResponse = await getAccessToken(streamInfo.ChannelName, realPlayerType);
                            if (accessTokenResponse.status === 200) {
                                const accessToken = await accessTokenResponse.json();
                                const urlInfo = new URL('https://usher.ttvnw.net/api/' + (V2API ? 'v2/' : '') + 'channel/hls/' + streamInfo.ChannelName + '.m3u8' + streamInfo.UsherParams);
                                urlInfo.searchParams.set('sig', accessToken.data.streamPlaybackAccessToken.signature);
                                urlInfo.searchParams.set('token', accessToken.data.streamPlaybackAccessToken.value);
                                const encodingsM3u8Response = await realFetch(urlInfo.href);
                                if (encodingsM3u8Response.status === 200) {
                                    encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType] = await encodingsM3u8Response.text();
                                }
                            }
                        } catch (err) {}
                    }
                    if (encodingsM3u8) {
                        try {
                            const selectedBackup = {};
                            const streamM3u8Url = getStreamUrlForResolution(encodingsM3u8, currentResolution, selectedBackup);
                            const streamM3u8Response = await realFetch(streamM3u8Url);
                            if (streamM3u8Response.status == 200) {
                                const m3u8Text = await streamM3u8Response.text();
                                if (m3u8Text) {
                                    if (playerType == FallbackPlayerType) {
                                        fallbackM3u8 = m3u8Text;
                                        fallbackCodecFamily = videoCodecFamily(selectedBackup.codecs);
                                    }
                                    if ((!m3u8Text.includes(AdSignifier) && (SimulatedAdsDepth == 0 || playerTypeIndex >= SimulatedAdsDepth - 1)) || (!fallbackM3u8 && playerTypeIndex >= BackupPlayerTypes.length - 1)) {
                                        backupPlayerType = playerType;
                                        backupM3u8 = m3u8Text;
                                        backupCodecFamily = videoCodecFamily(selectedBackup.codecs);
                                        break;
                                    }
                                    if (isFullyCachedPlayerType) {
                                        break;
                                    }
                                    if (isDoingMinimalRequests) {
                                        backupPlayerType = playerType;
                                        backupM3u8 = m3u8Text;
                                        backupCodecFamily = videoCodecFamily(selectedBackup.codecs);
                                        break;
                                    }
                                }
                            }
                        } catch (err) {}
                    }
                    streamInfo.BackupEncodingsM3U8Cache[playerType] = null;
                    if (isFreshM3u8) {
                        break;
                    }
                }
            }
            if (!backupM3u8 && fallbackM3u8) {
                backupPlayerType = FallbackPlayerType;
                backupM3u8 = fallbackM3u8;
                backupCodecFamily = fallbackCodecFamily;
            }
            if (backupM3u8) {
                textStr = backupM3u8;
                if (streamInfo.ActiveBackupPlayerType != backupPlayerType) {
                    streamInfo.ActiveBackupPlayerType = backupPlayerType;
                    console.log(`Blocking${(streamInfo.IsMidroll ? ' midroll ' : ' ')}ads (${backupPlayerType})`);
                }
            }
            const effectiveCodecFamily = backupM3u8 ? backupCodecFamily : currentCodecFamily;
            const effectiveIsEnhanced = effectiveCodecFamily === 'hevc' || effectiveCodecFamily === 'av1';
            const stripEnhanced = isEnhanced && streamInfo.ModifiedM3U8;
            if (IsAdStrippingEnabled || stripEnhanced) {
                textStr = stripAdSegments(textStr, stripEnhanced, streamInfo, effectiveIsEnhanced);
            }
        } else if (streamInfo.IsShowingAd) {
            console.log('Finished blocking ads');
            const wasStrippingAdSegments = streamInfo.IsStrippingAdSegments;
            streamInfo.IsShowingAd = false;
            streamInfo.IsStrippingAdSegments = false;
            streamInfo.NumStrippedAdSegments = 0;
            streamInfo.ActiveBackupPlayerType = null;
            if (streamInfo.IsUsingModifiedM3U8 || ReloadPlayerAfterAd || wasStrippingAdSegments) {
                streamInfo.IsUsingModifiedM3U8 = false;
                streamInfo.LastPlayerReload = Date.now();
                postMessage({
                    key: 'ReloadPlayer'
                });
            } else {
                postMessage({
                    key: 'PauseResumePlayer'
                });
            }
        }
        postMessage({
            key: 'UpdateAdBlockBanner',
            isMidroll: streamInfo.IsMidroll,
            hasAds: streamInfo.IsShowingAd,
            isStrippingAdSegments: streamInfo.IsStrippingAdSegments,
            numStrippedAdSegments: streamInfo.NumStrippedAdSegments,
            runtimeStatus: {
                channel: streamInfo.ChannelName ?? null,
                showingAd: streamInfo.IsShowingAd ?? false,
                strippingSegments: streamInfo.IsStrippingAdSegments ?? false,
                backupPlayerType: streamInfo.ActiveBackupPlayerType ?? null,
                lastPlayerReload: streamInfo.LastPlayerReload ?? null,
                numStrippedAdSegments: streamInfo.NumStrippedAdSegments ?? 0,
                isMidroll: streamInfo.IsMidroll ?? false
            }
        });
        return textStr;
    }
    function parseAttributes(str) {
        return Object.fromEntries(
            str.split(/(?:^|,)((?:[^=]*)=(?:"[^"]*"|[^,]*))/)
            .filter(Boolean)
            .map(x => {
                const idx = x.indexOf('=');
                const key = x.substring(0, idx);
                const value = x.substring(idx + 1);
                const num = Number(value);
                return [key, Number.isNaN(num) ? value.startsWith('"') ? JSON.parse(value) : value : num];
            }));
    }
    function getAccessToken(channelName, playerType) {
        const body = {
            operationName: 'PlaybackAccessToken',
            variables: {
                isLive: true,
                login: channelName,
                isVod: false,
                vodID: "",
                playerType: playerType,
                platform: playerType == 'autoplay' ? 'android' : 'web'
            },
            extensions: {
                persistedQuery: {
                    version:1,
                    sha256Hash:"ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9"
                }
            }
        };
        return gqlRequest(body, playerType);
    }
    function gqlRequest(body, playerType) {
        if (!GQLDeviceID) {
            GQLDeviceID = '';
            const dcharacters = 'abcdefghijklmnopqrstuvwxyz0123456789';
            const dcharactersLength = dcharacters.length;
            for (let i = 0; i < 32; i++) {
                GQLDeviceID += dcharacters.charAt(Math.floor(Math.random() * dcharactersLength));
            }
        }
        let headers = {
            'Client-ID': ClientID,
            'X-Device-Id': GQLDeviceID,
            'Authorization': AuthorizationHeader,
            ...(ClientIntegrityHeader && {'Client-Integrity': ClientIntegrityHeader}),
            ...(ClientVersion && {'Client-Version': ClientVersion}),
            ...(ClientSession && {'Client-Session-Id': ClientSession})
        };
        return new Promise((resolve, reject) => {
            const requestId = Math.random().toString(36).substring(2, 15);
            const fetchRequest = {
                id: requestId,
                url: 'https://gql.twitch.tv/gql',
                options: {
                    method: 'POST',
                    body: JSON.stringify(body),
                    headers
                }
            };
            const timeoutId = setTimeout(() => {
                const pending = pendingFetchRequests.get(requestId);
                if (!pending) return;
                pendingFetchRequests.delete(requestId);
                pending.reject(new Error('VAFT worker fetch request timed out'));
            }, WorkerFetchTimeoutMs);
            pendingFetchRequests.set(requestId, {
                resolve,
                reject,
                timeoutId
            });
            postMessage({
                key: 'FetchRequest',
                value: fetchRequest
            });
        });
    }
    let playerForMonitoringBuffering = null;
    const playerBufferState = {
        channelName: null,
        hasStreamStarted: false,
        position: 0,
        bufferedPosition: 0,
        bufferDuration: 0,
        numSame: 0,
        lastFixTime: 0,
        isLive: true
    };
    function isStandaloneTwitchAdVideo(video) {
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
    function monitorPlayerBuffering() {
        hideStandaloneTwitchVideoAds();
        if (playerForMonitoringBuffering) {
            try {
                const player = playerForMonitoringBuffering.player;
                const state = playerForMonitoringBuffering.state;
                if (!player.core) {
                    playerForMonitoringBuffering = null;
                } else if (state.props?.content?.type === 'live' && !player.isPaused() && !player.getHTMLVideoElement()?.ended && playerBufferState.lastFixTime <= Date.now() - PlayerBufferingMinRepeatDelay && !isActivelyStrippingAds) {
                    const m3u8Url = player.core?.state?.path;
                    if (m3u8Url) {
                        const fileName = new URL(m3u8Url).pathname.split('/').pop();
                        if (fileName?.endsWith('.m3u8')) {
                            const channelName = fileName.slice(0, -5);
                            if (playerBufferState.channelName != channelName) {
                                playerBufferState.channelName = channelName;
                                playerBufferState.hasStreamStarted = false;
                                playerBufferState.numSame = 0;
                            }
                        }
                    }
                    if (player.getState() === 'Playing') {
                        playerBufferState.hasStreamStarted = true;
                    }
                    const position = player.core?.state?.position;
                    const bufferedPosition = player.core?.state?.bufferedPosition;
                    const bufferDuration = player.getBufferDuration();
                    if (position !== undefined && bufferedPosition !== undefined) {
                        if (playerBufferState.hasStreamStarted &&
                            (!PlayerBufferingPrerollCheckEnabled || position > PlayerBufferingPrerollCheckOffset) &&
                            (playerBufferState.position == position || bufferDuration < PlayerBufferingDangerZone) &&
                            playerBufferState.bufferedPosition == bufferedPosition &&
                            playerBufferState.bufferDuration >= bufferDuration &&
                            (position != 0 || bufferedPosition != 0 || bufferDuration != 0)
                        ) {
                            playerBufferState.numSame++;
                            if (playerBufferState.numSame == PlayerBufferingSameStateCount) {
                                console.log('Attempt to fix buffering position:' + playerBufferState.position + ' bufferedPosition:' + playerBufferState.bufferedPosition + ' bufferDuration:' + playerBufferState.bufferDuration);
                                const isPausePlay = !PlayerBufferingDoPlayerReload;
                                const isReload = PlayerBufferingDoPlayerReload;
                                doTwitchPlayerTask(isPausePlay, isReload);
                                playerBufferState.lastFixTime = Date.now();
                                playerBufferState.numSame = 0;
                            }
                        } else {
                            playerBufferState.numSame = 0;
                        }
                        playerBufferState.position = position;
                        playerBufferState.bufferedPosition = bufferedPosition;
                        playerBufferState.bufferDuration = bufferDuration;
                    } else {
                        playerBufferState.numSame = 0;
                    }
                }
            } catch (err) {
                console.error('error when monitoring player for buffering: ' + err);
                playerForMonitoringBuffering = null;
            }
        }
        if (!playerForMonitoringBuffering && getPlayerVideoElement()) {
            const playerAndState = getPlayerAndState();
            if (playerAndState && playerAndState.player && playerAndState.state) {
                playerForMonitoringBuffering = {
                    player: playerAndState.player,
                    state: playerAndState.state
                };
            }
        }
        const isLive = playerForMonitoringBuffering?.state?.props?.content?.type === 'live';
        if (playerBufferState.isLive && !isLive) {
            updateAdblockBanner({
                hasAds: false
            });
        }
        playerBufferState.isLive = isLive;
        setTimeout(monitorPlayerBuffering, PlayerBufferingDelay);
    }
    function updateAdblockBanner(data) {
        const playerRootDiv = document.querySelector('.video-player');
        if (playerRootDiv != null) {
            let adBlockDiv = null;
            adBlockDiv = playerRootDiv.querySelector('.adblock-overlay');
            if (adBlockDiv == null) {
                adBlockDiv = document.createElement('div');
                adBlockDiv.className = 'adblock-overlay';
                adBlockDiv.innerHTML = '<div class="player-adblock-notice" style="color: white; background-color: rgba(0, 0, 0, 0.8); position: absolute; top: 0px; left: 0px; padding: 5px;"><p></p></div>';
                adBlockDiv.style.display = 'none';
                adBlockDiv.P = adBlockDiv.querySelector('p');
                playerRootDiv.appendChild(adBlockDiv);
            }
            if (adBlockDiv != null) {
                isActivelyStrippingAds = data.isStrippingAdSegments;
                adBlockDiv.P.textContent = 'Blocking' + (data.isMidroll ? ' midroll' : '') + ' ads' + (data.isStrippingAdSegments ? ' (stripping)' : '');
                adBlockDiv.style.display = data.hasAds && playerBufferState.isLive ? 'block' : 'none';
            }
        }
    }
    function getPlayerAndState() {
        function findReactNode(root, constraint) {
            if (root.stateNode && constraint(root.stateNode)) {
                return root.stateNode;
            }
            let node = root.child;
            while (node) {
                const result = findReactNode(node, constraint);
                if (result) {
                    return result;
                }
                node = node.sibling;
            }
            return null;
        }
        function findReactRootNode() {
            let reactRootNode = null;
            const rootNode = document.querySelector('#root');
            if (rootNode && rootNode._reactRootContainer && rootNode._reactRootContainer._internalRoot && rootNode._reactRootContainer._internalRoot.current) {
                reactRootNode = rootNode._reactRootContainer._internalRoot.current;
            }
            if (reactRootNode == null && rootNode != null) {
                const containerName = Object.keys(rootNode).find(x => x.startsWith('__reactContainer'));
                if (containerName != null) {
                    reactRootNode = rootNode[containerName];
                }
            }
            return reactRootNode;
        }
        const reactRootNode = findReactRootNode();
        if (!reactRootNode) {
            return null;
        }
        let player = findReactNode(reactRootNode, node => node.setPlayerActive && node.props && node.props.mediaPlayerInstance);
        player = player && player.props && player.props.mediaPlayerInstance ? player.props.mediaPlayerInstance : null;
        if (player?.playerInstance) {
            player = player.playerInstance;
        }
        const playerState = findReactNode(reactRootNode, node => node.setSrc && node.setInitialPlaybackSettings);
        return {
            player: player,
            state: playerState
        };
    }
    function pickPreferredPlayerQuality(qualities) {
        if (!Array.isArray(qualities)) return null;
        const offered = qualities.filter((quality) => quality && typeof quality === 'object');
        const normalizedName = (quality) => String(quality.name || '').toLowerCase().replace(/\s+/g, '');
        for (const preferredName of ['1440p60', '1080p60', '1440p', '1080p']) {
            const match = offered.find((quality) => normalizedName(quality).startsWith(preferredName));
            if (match) return match;
        }
        for (const preferredHeight of [1440, 1080]) {
            const matches = offered
                .filter((quality) => Number(quality.height) === preferredHeight)
                .sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0));
            if (matches.length) return matches[0];
        }
        return null;
    }
    function setPreferredPlayerQuality() {
        const player = getPlayerAndState()?.player;
        if (!player || typeof player.getQualities !== 'function' || typeof player.setQuality !== 'function') {
            return false;
        }
        try {
            const target = pickPreferredPlayerQuality(player.getQualities());
            if (!target) return false;
            if (typeof player.getQuality === 'function' && player.getQuality() === target) return true;
            player.setQuality(target, true);
            return true;
        } catch (error) {
            console.debug('[vaft] player API auto-quality attempt failed', error);
            return false;
        }
    }
    window.vaftSetPreferredQuality = setPreferredPlayerQuality;

    function doTwitchPlayerTask(isPausePlay, isReload) {
        const playerAndState = getPlayerAndState();
        if (!playerAndState) {
            console.log('Could not find react root');
            return;
        }
        const player = playerAndState.player;
        const playerState = playerAndState.state;
        if (!player) {
            console.log('Could not find player');
            return;
        }
        if (!playerState) {
            console.log('Could not find player state');
            return;
        }
        if (player.isPaused() || player.core?.paused) {
            return;
        }
        playerBufferState.lastFixTime = Date.now();
        playerBufferState.numSame = 0;
        if (isPausePlay) {
            player.pause();
            player.play();
            return;
        }
        if (isReload) {
            const lsKeyQuality = 'video-quality';
            const lsKeyMuted = 'video-muted';
            const lsKeyVolume = 'volume';
            let currentQualityLS = null;
            let currentMutedLS = null;
            let currentVolumeLS = null;
            try {
                currentQualityLS = localStorage.getItem(lsKeyQuality);
                currentMutedLS = localStorage.getItem(lsKeyMuted);
                currentVolumeLS = localStorage.getItem(lsKeyVolume);
                if (localStorageHookFailed && player?.core?.state) {
                    localStorage.setItem(lsKeyMuted, JSON.stringify({default:player.core.state.muted}));
                    localStorage.setItem(lsKeyVolume, player.core.state.volume);
                }
                if (localStorageHookFailed && player?.core?.state?.quality?.group) {
                    localStorage.setItem(lsKeyQuality, JSON.stringify({default:player.core.state.quality.group}));
                }
            } catch {}
            console.log('Reloading Twitch player');
            playerState.setSrc({ isNewMediaPlayerInstance: true, refreshAccessToken: true });
            postTwitchWorkerMessage('TriggeredPlayerReload');
            player.play();
            if (localStorageHookFailed && (currentQualityLS || currentMutedLS || currentVolumeLS)) {
                setTimeout(() => {
                    try {
                        if (currentQualityLS) {
                            localStorage.setItem(lsKeyQuality, currentQualityLS);
                        }
                        if (currentMutedLS) {
                            localStorage.setItem(lsKeyMuted, currentMutedLS);
                        }
                        if (currentVolumeLS) {
                            localStorage.setItem(lsKeyVolume, currentVolumeLS);
                        }
                    } catch {}
                }, 3000);
            }
            return;
        }
    }
    window.reloadTwitchPlayer = () => {
        doTwitchPlayerTask(false, true);
    };
    function postTwitchWorkerMessage(key, value) {
        twitchWorkers.forEach((worker) => {
            try {
                worker.postMessage({key: key, value: value});
            } catch (error) {
                twitchWorkers.delete(worker);
                console.debug('[vaft] removed inactive worker', error);
            }
        });
    }
    async function handleWorkerFetchRequest(fetchRequest) {
        try {
            const response = await window.realFetch(fetchRequest.url, fetchRequest.options);
            const responseBody = await response.text();
            return {
                id: fetchRequest.id,
                status: response.status,
                statusText: response.statusText,
                headers: Object.fromEntries(response.headers.entries()),
                body: responseBody
            };
        } catch (error) {
            return {
                id: fetchRequest.id,
                error: error.message
            };
        }
    }
    function hookFetch() {
        const realFetch = window.fetch;
        window.realFetch = realFetch;
        window.fetch = function(input, init, ...args) {
            const isRequest = typeof Request !== 'undefined' && input instanceof Request;
            const isUrlObject = typeof URL !== 'undefined' && input instanceof URL;
            const requestUrl = typeof input === 'string' ? input : isRequest ? input.url : isUrlObject ? input.href : '';
            const csaiType = getCsaiRequestType(requestUrl);
            if (csaiType) {
                const blocked = BlockCsaiAdRequests === true;
                recordCsaiRequest(csaiType, 'fetch', blocked);
                if (blocked) {
                    return Promise.reject(new TypeError('Failed to fetch'));
                }
            }
            let requestHeaders;
            try {
                requestHeaders = new Headers(init?.headers ?? (isRequest ? input.headers : undefined));
            } catch {
                requestHeaders = new Headers();
            }
            let nextInit = init;
            if (requestUrl.includes('gql')) {
                const deviceId = requestHeaders.get('X-Device-Id') ?? requestHeaders.get('Device-ID');
                if (typeof deviceId === 'string' && GQLDeviceID != deviceId) {
                    GQLDeviceID = deviceId;
                    postTwitchWorkerMessage('UpdateDeviceId', GQLDeviceID);
                }
                const clientVersion = requestHeaders.get('Client-Version');
                if (typeof clientVersion === 'string' && clientVersion !== ClientVersion) {
                    postTwitchWorkerMessage('UpdateClientVersion', ClientVersion = clientVersion);
                }
                const clientSession = requestHeaders.get('Client-Session-Id');
                if (typeof clientSession === 'string' && clientSession !== ClientSession) {
                    postTwitchWorkerMessage('UpdateClientSession', ClientSession = clientSession);
                }
                const clientIntegrity = requestHeaders.get('Client-Integrity');
                if (typeof clientIntegrity === 'string' && clientIntegrity !== ClientIntegrityHeader) {
                    postTwitchWorkerMessage('UpdateClientIntegrityHeader', ClientIntegrityHeader = clientIntegrity);
                }
                const authorization = requestHeaders.get('Authorization');
                if (typeof authorization === 'string' && authorization !== AuthorizationHeader) {
                    postTwitchWorkerMessage('UpdateAuthorizationHeader', AuthorizationHeader = authorization);
                }

                const body = typeof nextInit?.body === 'string' ? nextInit.body : null;
                if (body?.includes('PlaybackAccessToken') && body.includes('picture-by-picture')) {
                    nextInit = {...(nextInit || {}), body: ''};
                } else if (ForceAccessTokenPlayerType && body?.includes('PlaybackAccessToken')) {
                    try {
                        let replacedPlayerType = '';
                        const newBody = JSON.parse(body);
                        const operations = Array.isArray(newBody) ? newBody : [newBody];
                        for (const operation of operations) {
                            if (operation?.variables?.playerType && operation.variables.playerType !== ForceAccessTokenPlayerType) {
                                replacedPlayerType = operation.variables.playerType;
                                operation.variables.playerType = ForceAccessTokenPlayerType;
                            }
                        }
                        if (replacedPlayerType) {
                            console.log(`Replaced '${replacedPlayerType}' player type with '${ForceAccessTokenPlayerType}' player type`);
                            nextInit = {...(nextInit || {}), body: JSON.stringify(newBody)};
                        }
                    } catch (error) {
                        console.debug('[vaft] ignored malformed PlaybackAccessToken request body', error);
                    }
                }
            }
            return realFetch.call(this, input, nextInit, ...args);
        };
    }
    function hookXHR() {
        if (typeof XMLHttpRequest === 'undefined') return;
        const realOpen = XMLHttpRequest.prototype.open;
        const realSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url, ...args) {
            const requestUrl = typeof url === 'string' ? url : (typeof URL !== 'undefined' && url instanceof URL ? url.href : '');
            const csaiType = getCsaiRequestType(requestUrl);
            this.__vaftCsaiType = csaiType;
            this.__vaftBlockCsai = Boolean(csaiType && BlockCsaiAdRequests === true);
            if (csaiType) {
                recordCsaiRequest(csaiType, 'xhr', this.__vaftBlockCsai);
            }
            return realOpen.call(this, method, url, ...args);
        };
        XMLHttpRequest.prototype.send = function(...args) {
            if (!this.__vaftBlockCsai) {
                return realSend.apply(this, args);
            }
            const xhr = this;
            setTimeout(() => {
                const emptyResponse = xhr.responseType === '' || xhr.responseType === 'text' ? '' : null;
                const finalState = {
                    readyState: 4,
                    status: 0,
                    statusText: '',
                    response: emptyResponse,
                    responseText: '',
                    responseURL: ''
                };
                for (const [key, value] of Object.entries(finalState)) {
                    try {
                        Object.defineProperty(xhr, key, { value, configurable: true });
                    } catch {}
                }
                try { xhr.dispatchEvent(new Event('readystatechange')); } catch {}
                try { xhr.dispatchEvent(new ProgressEvent('error')); } catch {}
                try { xhr.dispatchEvent(new ProgressEvent('loadend')); } catch {}
            }, 0);
            return undefined;
        };
    }
    function onContentLoaded() {
        try {
            Object.defineProperty(document, 'visibilityState', {
                get() {
                    return 'visible';
                }
            });
        } catch {}
        try {
            Object.defineProperty(document, 'hidden', {
                get() {
                    return false;
                }
            });
        } catch {}
        const block = e => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        };
        let wasVideoPlaying = true;
        let latencyTimer = null;
        const visibilityChange = e => {
            const isChrome = typeof chrome !== 'undefined';
            const video = getPlayerVideoElement();
            if (video) {
                if (isDocumentActuallyHidden()) {
                    wasVideoPlaying = !video.paused && !video.ended;
                } else {
                    if (!playerBufferState.hasStreamStarted) {
                        playerBufferState.hasStreamStarted = true;
                    }
                    if (isChrome && wasVideoPlaying && !video.ended && video.paused && video.muted) {
                        video.play();
                    }
                    clearTimeout(latencyTimer);
                    latencyTimer = setTimeout(() => {
                        try {
                            if (isDocumentActuallyHidden() || isActivelyStrippingAds || playerBufferState.lastFixTime > Date.now() - PlayerBufferingMinRepeatDelay) {
                                return;
                            }
                            const playerAndState = playerForMonitoringBuffering || getPlayerAndState();
                            const player = playerAndState?.player;
                            if (!player?.getLiveLatency || playerAndState.state?.props?.content?.type !== 'live') {
                                return;
                            }
                            if (player.getLiveLatency() > (player.isLiveLowLatency?.() ? 5 : 15)) {
                                doTwitchPlayerTask(true, false);
                            }
                        } catch {}
                    }, 3000);
                }
            }
            block(e);
        };
        document.addEventListener('visibilitychange', visibilityChange, true);
        document.addEventListener('webkitvisibilitychange', visibilityChange, true);
        document.addEventListener('mozvisibilitychange', visibilityChange, true);
        document.addEventListener('hasFocus', block, true);
        try {
            if (/Firefox/.test(navigator.userAgent)) {
                Object.defineProperty(document, 'mozHidden', {
                    get() {
                        return false;
                    }
                });
            } else {
                Object.defineProperty(document, 'webkitHidden', {
                    get() {
                        return false;
                    }
                });
            }
        } catch {}
        try {
            const keysToCache = [
                'video-quality',
                'video-muted',
                'volume',
                'lowLatencyModeEnabled',
                'persistenceEnabled',
            ];
            const cachedValues = new Map();
            for (let i = 0; i < keysToCache.length; i++) {
                cachedValues.set(keysToCache[i], localStorage.getItem(keysToCache[i]));
            }
            const realSetItem = localStorage.setItem;
            localStorage.setItem = function(key, value) {
                if (cachedValues.has(key)) {
                    cachedValues.set(key, value);
                }
                realSetItem.apply(this, arguments);
            };
            const realGetItem = localStorage.getItem;
            localStorage.getItem = function(key) {
                if (cachedValues.has(key)) {
                    return cachedValues.get(key);
                }
                return realGetItem.apply(this, arguments);
            };
            if (!localStorage.getItem.toString().includes(Object.keys({cachedValues})[0])) {
                localStorageHookFailed = true;
            }
        } catch (err) {
            console.log('localStorageHooks failed ' + err);
            localStorageHookFailed = true;
        }
    }
    declareOptions(window);
    try {
        BlockCsaiAdRequests = localStorage.getItem('twitchAdSolutions_blockCsaiAdRequests') === 'true';
    } catch {}
    const allBackupPlayerTypes = BackupPlayerTypes;
    const applyAdBackupMode = (mode) => {
        BackupPlayerTypes = mode === 'source' ? allBackupPlayerTypes.filter((x) => x !== 'autoplay') : allBackupPlayerTypes;
    };
    try {
        applyAdBackupMode(localStorage.getItem('adBackupMode'));
    } catch {}
    hookWindowWorker();
    hookFetch();
    hookXHR();
    if (PlayerBufferingFix) {
        monitorPlayerBuffering();
    }
    if (document.readyState === "complete" || document.readyState === "loaded" || document.readyState === "interactive") {
        onContentLoaded();
    } else {
        window.addEventListener("DOMContentLoaded", function() {
            onContentLoaded();
        });
    }
    window.simulateAds = (depth) => {
        if (depth === undefined || depth < 0) {
            console.log('Ad depth paramter required (0 = no simulated ad, 1+ = use backup player for given depth)');
            return;
        }
        postTwitchWorkerMessage('SimulateAds', depth);
    };
    window.allSegmentsAreAdSegments = () => {
        postTwitchWorkerMessage('AllSegmentsAreAdSegments');
    };
    window.setAdBackupMode = (mode) => {
        applyAdBackupMode(mode);
        try {
            localStorage.setItem('adBackupMode', mode);
        } catch {}
        postTwitchWorkerMessage('UpdateBackupPlayerTypes', BackupPlayerTypes);
    };
    // Auto-quality preference: 'on' (default) or 'off'. Stored separately so
    // disabling it never changes the ad fallback mode above.
    function getAutoQualityMode() {
        try {
            return localStorage.getItem('vaftAutoQuality') === 'off' ? 'off' : 'on';
        } catch {
            return 'on';
        }
    }
    window.getAutoQuality = getAutoQualityMode;
    window.getCsaiBlocking = () => BlockCsaiAdRequests === true;
    window.setCsaiBlocking = (enabled) => {
        BlockCsaiAdRequests = enabled === true || enabled === 'true' || enabled === 'on';
        try {
            localStorage.setItem('twitchAdSolutions_blockCsaiAdRequests', BlockCsaiAdRequests ? 'true' : 'false');
        } catch {}
        return BlockCsaiAdRequests;
    };
    window.setAutoQuality = (mode) => {
        try {
            localStorage.setItem('vaftAutoQuality', mode === 'off' ? 'off' : 'on');
        } catch {}
    };
    window.vaftStatus = () => {
        return {
            version: '37.6.1',
            workerCount: twitchWorkers.size,
            backupMode: BackupPlayerTypes.includes('autoplay') ? '360p' : 'source',
            autoQuality: getAutoQualityMode(),
            blockCsaiAdRequests: BlockCsaiAdRequests,
            csai: getCsaiStatsSnapshot(),
            ...vaftRuntimeStatus
        };
    };
    window.addEventListener('storage', (e) => {
        if (e.key === 'adBackupMode') {
            applyAdBackupMode(e.newValue);
            postTwitchWorkerMessage('UpdateBackupPlayerTypes', BackupPlayerTypes);
        } else if (e.key === 'twitchAdSolutions_blockCsaiAdRequests') {
            BlockCsaiAdRequests = e.newValue === 'true';
        }
    });
})();

(() => {
  if (window.self !== window.top || typeof window.setAdBackupMode !== 'function') return;
  document.addEventListener('DOMContentLoaded', () => document.head.insertAdjacentHTML('beforeend', '<style>.player-adblock-notice,[data-a-target="video-ad-label"],div:has(> [data-a-target="video-ad-label"]),[data-a-target="video-ad-countdown"],[data-test-selector="ad-banner-default-text"]{display:none!important}#vaft-ad-mode{display:inline-flex;align-items:center;gap:2px;margin-right:8px;font-size:12px;font-weight:600}#vaft-ad-mode span{margin-right:4px;color:var(--color-text-alt-2,#adadb8)}#vaft-ad-mode button{padding:3px 8px;border:0;border-radius:4px;cursor:pointer;background:var(--color-background-button-secondary-default,#2f2f35);color:var(--color-text-button-secondary,#efeff1)}#vaft-ad-mode button[aria-pressed="true"]{background:var(--color-background-button-primary-default,#9147ff);color:var(--color-text-button-primary,#fff)}#vaft-ad-mode .vaft-sep{margin:0 6px;opacity:.5}</style>'));
  let lastUrl = '';
  let done = false;

  const q = s => document.querySelector(s);
  const isAutoQualityOn = () => {
    try {
      if (typeof window.getAutoQuality === 'function') return window.getAutoQuality() !== 'off';
      return localStorage.getItem('vaftAutoQuality') !== 'off';
    } catch {
      return true;
    }
  };

  async function setQuality() {
    return typeof window.vaftSetPreferredQuality === 'function'
      && window.vaftSetPreferredQuality();
  }

  function renderModes(box) {
    const adMode = window.BackupPlayerTypes?.includes('autoplay') ? '360p' : 'source';
    const qMode = isAutoQualityOn() ? 'on' : 'off';
    box.querySelectorAll('button[data-kind="ad"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === adMode)));
    box.querySelectorAll('button[data-kind="quality"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === qMode)));
  }

  function ensureAdModeButtons() {
    if (typeof window.vaftIsDocumentHidden === 'function' && window.vaftIsDocumentHidden()) return;
    const share = q('[data-a-target="share-button"]');
    if (!share || typeof window.setAdBackupMode !== 'function') return;
    const existing = q('#vaft-ad-mode');
    if (existing) { renderModes(existing); return; }
    const box = document.createElement('div');
    box.id = 'vaft-ad-mode';
    const fr = navigator.language.startsWith('fr');
    box.innerHTML = `<span>${fr ? 'Pub' : 'Ad'}</span>`
      + `<button type="button" data-kind="ad" data-mode="360p" title="${fr ? 'Si les flux Source ont la pub : passage au flux 360p' : 'If both Source streams carry the ad: switch to the 360p stream'}">360p</button>`
      + `<button type="button" data-kind="ad" data-mode="source" title="${fr ? 'Toujours en Source : si les flux Source ont la pub, image figée pendant la pub' : 'Always Source: if both Source streams carry the ad, the picture freezes during the ad'}">Source</button>`
      + `<span class="vaft-sep">|</span><span>${fr ? 'Qualité' : 'Quality'}</span>`
      + `<button type="button" data-kind="quality" data-mode="on" title="${fr ? 'Qualité auto 1080p60 activée' : 'Auto 1080p60 quality on'}">Auto</button>`
      + `<button type="button" data-kind="quality" data-mode="off" title="${fr ? 'Qualité auto désactivée : ne touche pas à ton réglage' : 'Auto quality off: leaves your setting alone'}">Off</button>`;
    box.addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.kind === 'ad') {
        window.setAdBackupMode?.(btn.dataset.mode);
      } else if (btn.dataset.kind === 'quality') {
        if (typeof window.setAutoQuality === 'function') window.setAutoQuality(btn.dataset.mode);
        else try { localStorage.setItem('vaftAutoQuality', btn.dataset.mode === 'off' ? 'off' : 'on'); } catch {}
        if (btn.dataset.mode === 'on') done = false;
      }
      renderModes(box);
    });
    share.before(box);
    renderModes(box);
  }

  window.addEventListener('storage', (e) => {
    if (e.key === 'vaftAutoQuality' || e.key === 'adBackupMode') {
      const box = q('#vaft-ad-mode');
      if (box) renderModes(box);
      if (e.key === 'vaftAutoQuality' && e.newValue !== 'off') done = false;
    }
  });

  setInterval(ensureAdModeButtons, 1000);

  try {
    if (isAutoQualityOn()) localStorage.setItem('video-quality', JSON.stringify({ default: 'chunked' }));
  } catch {}

  let busy = false;
  setInterval(async () => {
    if (typeof window.vaftIsDocumentHidden === 'function' && window.vaftIsDocumentHidden()) return;
    if (!isAutoQualityOn()) return;
    const v = window.vaftGetPlayerVideoElement?.();
    if (busy || !v) return;
    if (location.href !== lastUrl) { lastUrl = location.href; done = false; }
    if (q('.adblock-overlay')?.style.display === 'block') { done = false; return; }
    if (done || v.readyState < 2 || v.videoHeight >= 1080) return;
    busy = true;
    try {
      done = await setQuality();
    } catch (error) {
      done = false;
      console.debug('[vaft] auto-quality attempt failed', error);
    } finally {
      busy = false;
    }
  }, 3000);
})();

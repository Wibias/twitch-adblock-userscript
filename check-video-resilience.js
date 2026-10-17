const assert = require('assert');

function extractFunction(src, name) {
    const start = src.indexOf(`function ${name}(`);
    assert(start !== -1, `missing function ${name}`);
    let depth = 0;
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    const braceStart = src.indexOf('{', start);
    for (let i = braceStart; i < src.length; i++) {
        const ch = src[i];
        const next = src[i + 1];
        if (lineComment) {
            if (ch === '\n') lineComment = false;
            continue;
        }
        if (blockComment) {
            if (ch === '*' && next === '/') { blockComment = false; i++; }
            continue;
        }
        if (quote) {
            if (escaped) { escaped = false; continue; }
            if (ch === '\\') { escaped = true; continue; }
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
        if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
        if (ch === '{') depth++;
        if (ch === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`unbalanced braces in ${name}`);
}

function makeVideo(src, muted = false) {
    return {
        currentSrc: src,
        muted,
        paused: false,
        ended: false,
        dataset: {},
        style: {
            display: '',
            setProperty(name, value) { if (name === 'display') this.display = value; },
            removeProperty(name) { if (name === 'display') this.display = ''; }
        },
        getAttribute(name) { return name === 'src' ? this.currentSrc : null; },
        pause() { this.paused = true; }
    };
}

function runVideoResilienceChecks(src) {
    const classifier = new Function('URL', 'document', `${extractFunction(src, 'isStandaloneTwitchAdVideo')}\nreturn isStandaloneTwitchAdVideo;`)(URL, { location: { href: 'https://www.twitch.tv/test' } });
    assert.strictEqual(classifier(makeVideo('https://video.media-amazon.com/path/ad.mp4')), true);
    assert.strictEqual(classifier(makeVideo('https://media-amazon.com/ad.mp4')), true);
    assert.strictEqual(classifier(makeVideo('blob:https://www.twitch.tv/abc')), false);
    assert.strictEqual(classifier(makeVideo('https://vod-secure.twitch.tv/live.mp4')), false);

    const factory = new Function('URL', `
        let playerForMonitoringBuffering = null;
        const videos = [];
        const document = {
            location: { href: 'https://www.twitch.tv/test' },
            getElementsByTagName(name) { return name === 'video' ? videos : []; }
        };
        ${extractFunction(src, 'isStandaloneTwitchAdVideo')}
        ${extractFunction(src, 'getPlayerVideoElement')}
        ${extractFunction(src, 'hideStandaloneTwitchVideoAds')}
        return {
            videos,
            getPlayerVideoElement,
            hideStandaloneTwitchVideoAds,
            setPlayerVideo(video) {
                playerForMonitoringBuffering = video ? { player: { getHTMLVideoElement: () => video } } : null;
            }
        };
    `);
    const scope = factory(URL);
    const adVideo = makeVideo('https://cdn.media-amazon.com/ad.mp4', false);
    const realVideo = makeVideo('blob:https://www.twitch.tv/live', true);
    scope.videos.push(adVideo, realVideo);

    assert.strictEqual(scope.getPlayerVideoElement(), realVideo, 'first standalone ad video must not be selected as player');
    scope.hideStandaloneTwitchVideoAds();
    assert.strictEqual(adVideo.dataset.vaftAdHidden, '1');
    assert.strictEqual(adVideo.style.display, 'none');
    assert.strictEqual(adVideo.muted, true);
    assert.strictEqual(adVideo.paused, true);
    assert.strictEqual(realVideo.style.display, '');
    assert.strictEqual(realVideo.muted, true, 'real player mute state must be untouched');

    adVideo.currentSrc = 'blob:https://www.twitch.tv/recycled';
    scope.hideStandaloneTwitchVideoAds();
    assert.strictEqual(adVideo.dataset.vaftAdHidden, undefined, 'recycled video marker must be removed');
    assert.strictEqual(adVideo.style.display, '', 'recycled video must be visible again');
    assert.strictEqual(adVideo.muted, false, 'recycled video original mute state must be restored');

    scope.setPlayerVideo(realVideo);
    assert.strictEqual(scope.getPlayerVideoElement(), realVideo, 'known Twitch player video should win');

    const workerMarker = new Function(`${extractFunction(src, 'hasVaftWorkerHooks')}\nreturn hasVaftWorkerHooks;`)();
    assert.strictEqual(workerMarker('hookWorkerFetch (vaft) processM3U8'), true);
    assert.strictEqual(workerMarker('normal Twitch worker source'), false);

    assert(src.includes('const alreadyHooked = hasVaftWorkerHooks(prefetchedWorkerJs);'), 'worker reinjection guard missing');
    assert(src.includes('if (alreadyHooked) {'), 'already-hooked worker branch missing');
    assert(src.includes('super(twitchBlobUrl, options);'), 'already-hooked worker must reuse original blob');
    assert(src.includes('window.vaftGetPlayerVideoElement = getPlayerVideoElement;'), 'player video helper is not exposed to quality UI');
    assert(!src.includes("document.querySelector('video')"), 'raw first-video query remains');
    assert(!src.includes("const v = q('video');"), 'auto-quality still targets the first DOM video');
    assert(!src.includes('videos[0]'), 'visibility handling still targets the first DOM video');
}

module.exports = { runVideoResilienceChecks };
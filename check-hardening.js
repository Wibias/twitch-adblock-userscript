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

function runBehaviorChecks(src) {
    const getFirst = new Function(`${extractFunction(src, 'getFirstM3u8Url')}\nreturn getFirstM3u8Url;`)();
    assert.strictEqual(
        getFirst('#EXTM3U\nhttps://example.com/live.m3u8?token=abc&expires=123'),
        'https://example.com/live.m3u8?token=abc&expires=123'
    );
    assert.strictEqual(getFirst('#EXTM3U\n# only comments'), null);
    assert.strictEqual(getFirst('http://example.com/live.m3u8'), null);

    const hookFactory = new Function('Headers', 'Request', 'URL', `
        const messages = [];
        let GQLDeviceID = null;
        let ClientVersion = null;
        let ClientSession = null;
        let ClientIntegrityHeader = null;
        let AuthorizationHeader = undefined;
        const ForceAccessTokenPlayerType = 'popout';
        let BlockCsaiAdRequests = false;
        function getCsaiRequestType() { return null; }
        function recordCsaiRequest() {}
        const window = {
            fetch: function(...args) { return { args, receiver: this }; }
        };
        function postTwitchWorkerMessage(key, value) { messages.push([key, value]); }
        ${extractFunction(src, 'hookFetch')}
        hookFetch();
        return { window, messages };
    `);
    const hookScope = hookFactory(Headers, Request, URL);

    assert.doesNotThrow(() => hookScope.window.fetch('https://gql.twitch.tv/gql'));

    const request = new Request('https://gql.twitch.tv/gql', {
        headers: { 'X-Device-Id': 'request-device' }
    });
    hookScope.window.fetch(request);
    assert(hookScope.messages.some(([key, value]) => key === 'UpdateDeviceId' && value === 'request-device'));

    const body = JSON.stringify({ operationName: 'PlaybackAccessToken', variables: { playerType: 'site' } });
    const result = hookScope.window.fetch('https://gql.twitch.tv/gql', {
        headers: new Headers({ 'Client-Version': 'v1' }),
        body
    });
    assert.strictEqual(JSON.parse(result.args[1].body).variables.playerType, 'popout');
    assert(hookScope.messages.some(([key, value]) => key === 'UpdateClientVersion' && value === 'v1'));

    assert.doesNotThrow(() => hookScope.window.fetch('https://gql.twitch.tv/gql', {
        headers: {},
        body: 'PlaybackAccessToken{not-json'
    }));
}

function runRuntimeStatusChecks(src) {
    const factory = new Function(`
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
        ${extractFunction(src, 'updateVaftRuntimeStatus')}
        return { vaftRuntimeStatus, updateVaftRuntimeStatus };
    `);
    const scope = factory();
    const before = Date.now();
    scope.updateVaftRuntimeStatus({
        channel: 'example_channel',
        showingAd: true,
        strippingSegments: true,
        backupPlayerType: 'autoplay',
        lastPlayerReload: 123,
        numStrippedAdSegments: 4,
        isMidroll: true
    });
    assert.strictEqual(scope.vaftRuntimeStatus.channel, 'example_channel');
    assert.strictEqual(scope.vaftRuntimeStatus.showingAd, true);
    assert.strictEqual(scope.vaftRuntimeStatus.strippingSegments, true);
    assert.strictEqual(scope.vaftRuntimeStatus.backupPlayerType, 'autoplay');
    assert.strictEqual(scope.vaftRuntimeStatus.lastPlayerReload, 123);
    assert.strictEqual(scope.vaftRuntimeStatus.numStrippedAdSegments, 4);
    assert.strictEqual(scope.vaftRuntimeStatus.isMidroll, true);
    assert(scope.vaftRuntimeStatus.lastUpdate >= before, 'runtime status timestamp not refreshed');

    const snapshot = { ...scope.vaftRuntimeStatus };
    scope.updateVaftRuntimeStatus(null);
    assert.deepStrictEqual(scope.vaftRuntimeStatus, snapshot, 'invalid runtime status should be ignored');

    assert(src.includes('runtimeStatus: {'), 'worker runtime status payload missing');
    assert(src.includes('updateVaftRuntimeStatus(e.data.runtimeStatus);'), 'worker runtime status is not applied on page');
    assert(src.includes('...vaftRuntimeStatus'), 'vaftStatus does not expose bridged worker state');
}

function runCodecSafetyChecks(src) {
    const codecFamily = new Function(`${extractFunction(src, 'videoCodecFamily')}\nreturn videoCodecFamily;`)();
    assert.strictEqual(codecFamily('avc1.64002A,mp4a.40.2'), 'avc');
    assert.strictEqual(codecFamily('mp4a.40.2,av01.0.08M.08'), 'av1');
    assert.strictEqual(codecFamily('MP4A.40.2,HVC1.2.4.L150.B0'), 'hevc');
    assert.strictEqual(codecFamily(undefined), 'unknown');
    assert.strictEqual(codecFamily(''), 'unknown');
    assert.strictEqual(codecFamily('vp09.00.10.08'), 'unknown');

    const selectStream = new Function(`
        function parseAttributes(line) {
            const body = line.substring(line.indexOf(':') + 1);
            return Object.fromEntries(body.split(',').map((part) => {
                const [key, ...rest] = part.split('=');
                return [key, rest.join('=').replace(/^"|"$/g, '')];
            }));
        }
        ${extractFunction(src, 'videoCodecFamily')}
        ${extractFunction(src, 'getStreamUrlForResolution')}
        return getStreamUrlForResolution;
    `)();
    const master = [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:RESOLUTION=1920x1080,FRAME-RATE=60,CODECS="avc1.64002A"',
        'https://example.com/avc-1080.m3u8',
        '#EXT-X-STREAM-INF:RESOLUTION=1280x720,FRAME-RATE=60,CODECS="hvc1.2.4.L150.B0"',
        'https://example.com/hevc-720.m3u8',
        '#EXT-X-STREAM-INF:RESOLUTION=854x480,FRAME-RATE=30,CODECS="av01.0.08M.08"',
        'https://example.com/av1-480.m3u8'
    ].join('\n');
    const hevcSelection = {};
    assert.strictEqual(
        selectStream(master, { Resolution: '1920x1080', FrameRate: 60, Codecs: 'hvc1.2.4.L150.B0' }, hevcSelection),
        'https://example.com/hevc-720.m3u8',
        'same-family HEVC backup must beat a closer AVC rendition'
    );
    assert.strictEqual(codecFamily(hevcSelection.codecs), 'hevc');
    const avcSelection = {};
    assert.strictEqual(
        selectStream(master, { Resolution: '1920x1080', FrameRate: 60, Codecs: 'avc1.64002A' }, avcSelection),
        'https://example.com/avc-1080.m3u8'
    );
    assert.strictEqual(codecFamily(avcSelection.codecs), 'avc');

    const stripFactory = new Function(`
        let AllSegmentsAreAdSegments = false;
        const AdSignifier = 'stitched';
        const AdSegmentCache = new Map();
        ${extractFunction(src, 'stripAdSegments')}
        return { stripAdSegments, AdSegmentCache };
    `);
    const stripScope = stripFactory();
    const info = { NumStrippedAdSegments: 0 };
    stripScope.stripAdSegments('#EXTM3U\n#EXTINF:2.0,ad\nhttps://example.com/ad.ts', false, info, true);
    assert.strictEqual(stripScope.AdSegmentCache.get('https://example.com/ad.ts').enhanced, true, 'enhanced playlist cache entry must be tagged');

    assert(src.includes('${videoCodecFamily.toString()}') || src.includes('videoCodecFamily.toString()'), 'codec helper not injected into worker');
    assert(src.includes('adCacheEntry.enhanced'), 'enhanced cached segments are not guarded');
    assert(/status:\s*403/.test(src), 'enhanced cached segments must not receive the AVC blank MP4');
}

function runHardeningChecks(src, options = {}) {
    const behavior = options.behavior !== false;
    const strictRepo = options.strictRepo !== false;
    assert(/\/\/ @version\s+37\.6\.1/.test(src), '37.6.1 version missing');
    assert(src.includes('scope.WorkerFetchTimeoutMs = 15000;'), 'worker fetch timeout missing');
    assert(src.includes('const twitchWorkers = new Set();'), 'worker Set missing');
    assert(src.includes('URL.revokeObjectURL(workerBlobUrl);'), 'worker blob URL cleanup missing');
    assert(src.includes('twitchWorkers.delete(this);'), 'terminated worker cleanup missing');
    assert(src.includes('clearTimeout(timeoutId);'), 'pending request timeout cleanup missing');
    assert(src.includes('VAFT worker fetch request timed out'), 'pending request timeout rejection missing');
    assert(src.includes('window.vaftIsDocumentHidden = isDocumentActuallyHidden;'), 'native hidden-state helper missing');
    assert(!src.includes('if (document.hidden) return;'), 'patched document.hidden guard still present');
    assert(src.includes("new Headers(init?.headers ?? (isRequest ? input.headers : undefined))"), 'Fetch Headers normalization missing');
    assert(src.includes("input instanceof Request"), 'Fetch Request normalization missing');
    assert(src.includes('done = await setQuality();'), 'auto-quality result is not respected');
    assert(/finally\s*\{\s*busy = false;\s*\}/.test(src), 'auto-quality busy cleanup missing');
    assert(src.includes('window.vaftStatus = () =>'), 'vaftStatus diagnostics missing');
    assert(src.includes('new URL(line);'), 'HLS URL parsing missing');
    assert(src.includes('// @homepageURL  https://github.com/Wibias/twitch-adblock-userscript'), 'homepageURL must point to Wibias repo');
    assert(src.includes('// @supportURL   https://github.com/Wibias/twitch-adblock-userscript/issues'), 'supportURL must point to Wibias repo');
    assert(src.includes('// @updateURL    https://raw.githubusercontent.com/Wibias/twitch-adblock-userscript/main/twitch-adblock.user.js'), 'updateURL must point to Wibias main');
    assert(src.includes('// @downloadURL  https://raw.githubusercontent.com/Wibias/twitch-adblock-userscript/main/twitch-adblock.user.js'), 'downloadURL must point to Wibias main');
    if (strictRepo) {
        assert(src.includes('streamInfo.RequestedAds.size > 100'), 'RequestedAds bound missing');
        runRuntimeStatusChecks(src);
        runCodecSafetyChecks(src);
    }
    if (behavior) runBehaviorChecks(src);
    return true;
}

module.exports = { runHardeningChecks, extractFunction, runRuntimeStatusChecks, runCodecSafetyChecks };
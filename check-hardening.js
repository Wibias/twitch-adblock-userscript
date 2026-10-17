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

function runHardeningChecks(src, options = {}) {
    const behavior = options.behavior !== false;
    const strictRepo = options.strictRepo !== false;
    assert(/\/\/ @version\s+37\.4\.1/.test(src), '37.4.1 version missing');
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
        assert(src.includes("element.Codecs?.startsWith('avc')"), 'missing-codec protection missing');
        assert(src.includes("streamInfo.ResolutionList.some((element) => element.Codecs?.startsWith('hev') || element.Codecs?.startsWith('hvc'))"), 'HEVC missing-codec protection missing');
        assert(src.includes('streamInfo.RequestedAds.size > 100'), 'RequestedAds bound missing');
        runRuntimeStatusChecks(src);
    }
    if (behavior) runBehaviorChecks(src);
    return true;
}

module.exports = { runHardeningChecks, extractFunction, runRuntimeStatusChecks };

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
        if (lineComment) { if (ch === '\n') lineComment = false; continue; }
        if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++; } continue; }
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

async function runCsaiChecks(src) {
    const classify = new Function(`${extractFunction(src, 'getCsaiRequestType')}\nreturn getCsaiRequestType;`)();
    assert.strictEqual(classify('https://edge.ads.twitch.tv/ads?bp=midroll'), 'midroll');
    assert.strictEqual(classify('https://edge.ads.twitch.tv/ads?bp=preroll'), 'preroll');
    assert.strictEqual(classify('https://edge.ads.twitch.tv/ads'), 'unknown');
    assert.strictEqual(classify('https://gql.twitch.tv/gql'), null);

    const statsFactory = new Function(`
        const csaiRequestStats = { total: 0, blocked: 0, allowed: 0, fetch: 0, xhr: 0, preroll: 0, midroll: 0, unknown: 0 };
        ${extractFunction(src, 'recordCsaiRequest')}
        ${extractFunction(src, 'getCsaiStatsSnapshot')}
        return { recordCsaiRequest, getCsaiStatsSnapshot };
    `);
    const stats = statsFactory();
    stats.recordCsaiRequest('midroll', 'fetch', false);
    stats.recordCsaiRequest('preroll', 'xhr', true);
    assert.deepStrictEqual(stats.getCsaiStatsSnapshot(), {
        total: 2, blocked: 1, allowed: 1, fetch: 1, xhr: 1, preroll: 1, midroll: 1, unknown: 0
    });

    const fetchFactory = new Function('Headers', 'Request', 'URL', `
        const nativeCalls = [];
        const records = [];
        let BlockCsaiAdRequests = false;
        let GQLDeviceID = null;
        let ClientVersion = null;
        let ClientSession = null;
        let ClientIntegrityHeader = null;
        let AuthorizationHeader = undefined;
        const ForceAccessTokenPlayerType = 'popout';
        const window = {
            fetch: function(...args) { nativeCalls.push(args); return Promise.resolve({ ok: true }); }
        };
        function postTwitchWorkerMessage() {}
        ${extractFunction(src, 'getCsaiRequestType')}
        function recordCsaiRequest(type, transport, blocked) { records.push({ type, transport, blocked }); }
        ${extractFunction(src, 'hookFetch')}
        hookFetch();
        return {
            window,
            nativeCalls,
            records,
            setBlocking(value) { BlockCsaiAdRequests = value; }
        };
    `);
    const fetchScope = fetchFactory(Headers, Request, URL);
    await fetchScope.window.fetch('https://edge.ads.twitch.tv/ads?bp=midroll');
    await fetchScope.window.fetch(new URL('https://edge.ads.twitch.tv/ads?bp=preroll'));
    await fetchScope.window.fetch(new Request('https://edge.ads.twitch.tv/ads'));
    assert.strictEqual(fetchScope.nativeCalls.length, 3, 'CSAI should be observable but allowed by default');
    assert.deepStrictEqual(fetchScope.records.map(x => x.type), ['midroll', 'preroll', 'unknown']);
    assert(fetchScope.records.every(x => x.transport === 'fetch' && x.blocked === false));

    fetchScope.setBlocking(true);
    await assert.rejects(
        fetchScope.window.fetch('https://edge.ads.twitch.tv/ads?bp=midroll'),
        (error) => error instanceof TypeError
    );
    assert.strictEqual(fetchScope.nativeCalls.length, 3, 'blocked CSAI fetch must not reach native fetch');
    assert.strictEqual(fetchScope.records.at(-1).blocked, true);

    await assert.doesNotReject(fetchScope.window.fetch('https://gql.twitch.tv/gql', { headers: {} }));
    assert.strictEqual(fetchScope.nativeCalls.length, 4, 'non-CSAI GQL fetch must still pass through');

    class FakeProgressEvent { constructor(type) { this.type = type; } }
    class FakeEvent { constructor(type) { this.type = type; } }
    class FakeXHR {
        constructor() { this.events = []; this.nativeSendCount = 0; this.responseType = ''; }
        open(method, url) { this.method = method; this.url = url; this.readyState = 1; }
        send() { this.nativeSendCount++; }
        dispatchEvent(event) { this.events.push(event.type); return true; }
    }
    const xhrFactory = new Function('XMLHttpRequest', 'URL', 'Event', 'ProgressEvent', 'setTimeout', `
        const records = [];
        let BlockCsaiAdRequests = false;
        ${extractFunction(src, 'getCsaiRequestType')}
        function recordCsaiRequest(type, transport, blocked) { records.push({ type, transport, blocked }); }
        ${extractFunction(src, 'hookXHR')}
        hookXHR();
        return { records, setBlocking(value) { BlockCsaiAdRequests = value; } };
    `);
    const xhrScope = xhrFactory(FakeXHR, URL, FakeEvent, FakeProgressEvent, setTimeout);
    const allowedXhr = new FakeXHR();
    allowedXhr.open('GET', 'https://edge.ads.twitch.tv/ads?bp=preroll');
    allowedXhr.send();
    assert.strictEqual(allowedXhr.nativeSendCount, 1);
    assert.strictEqual(xhrScope.records.at(-1).blocked, false);

    xhrScope.setBlocking(true);
    const blockedXhr = new FakeXHR();
    blockedXhr.open('GET', new URL('https://edge.ads.twitch.tv/ads?bp=midroll'));
    blockedXhr.send();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.strictEqual(blockedXhr.nativeSendCount, 0);
    assert.strictEqual(blockedXhr.readyState, 4);
    assert.strictEqual(blockedXhr.status, 0);
    assert.deepStrictEqual(blockedXhr.events, ['readystatechange', 'error', 'loadend']);
    assert.strictEqual(xhrScope.records.at(-1).blocked, true);

    assert(src.includes('blockCsaiAdRequests: BlockCsaiAdRequests'), 'vaftStatus blocking state missing');
    assert(src.includes('csai: getCsaiStatsSnapshot()'), 'vaftStatus CSAI counters missing');
    assert(src.includes('window.setCsaiBlocking ='), 'CSAI blocking setter missing');
    assert(src.includes("twitchAdSolutions_blockCsaiAdRequests"), 'CSAI blocking persistence key missing');
}

module.exports = { runCsaiChecks };
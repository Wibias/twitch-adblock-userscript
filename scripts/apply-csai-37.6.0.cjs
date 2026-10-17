const fs = require('node:fs');

function replaceOnce(src, from, to, label) {
    const first = src.indexOf(from);
    if (first === -1) throw new Error(`missing patch anchor: ${label}`);
    if (src.indexOf(from, first + from.length) !== -1) throw new Error(`ambiguous patch anchor: ${label}`);
    return src.slice(0, first) + to + src.slice(first + from.length);
}

const path = 'twitch-adblock.user.js';
let src = fs.readFileSync(path, 'utf8');

src = replaceOnce(src, '// @version      37.5.1', '// @version      37.6.0', 'public version');
src = replaceOnce(src, "version: '37.5.1',", "version: '37.6.0',", 'status version');
src = replaceOnce(src, '        scope.WorkerFetchTimeoutMs = 15000;', "        scope.WorkerFetchTimeoutMs = 15000;\n        scope.BlockCsaiAdRequests = false;// CSAI observation is always on; active blocking is opt-in.", 'CSAI option');

const csaiHelpers = `    const csaiRequestStats = {
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
`;
src = replaceOnce(src, '    const twitchWorkers = new Set();', '    const twitchWorkers = new Set();\n' + csaiHelpers, 'CSAI helpers');

const fetchNeedle = "            const requestUrl = typeof input === 'string' ? input : isRequest ? input.url : isUrlObject ? input.href : '';\n            let requestHeaders;";
const fetchReplacement = "            const requestUrl = typeof input === 'string' ? input : isRequest ? input.url : isUrlObject ? input.href : '';\n            const csaiType = getCsaiRequestType(requestUrl);\n            if (csaiType) {\n                const blocked = BlockCsaiAdRequests === true;\n                recordCsaiRequest(csaiType, 'fetch', blocked);\n                if (blocked) {\n                    return Promise.reject(new TypeError('Failed to fetch'));\n                }\n            }\n            let requestHeaders;";
src = replaceOnce(src, fetchNeedle, fetchReplacement, 'fetch CSAI interception');

const xhrHook = `    function hookXHR() {
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
`;
src = replaceOnce(src, '    function onContentLoaded() {', xhrHook + '    function onContentLoaded() {', 'XHR hook');

src = replaceOnce(src, '    declareOptions(window);\n    const allBackupPlayerTypes = BackupPlayerTypes;', "    declareOptions(window);\n    try {\n        BlockCsaiAdRequests = localStorage.getItem('twitchAdSolutions_blockCsaiAdRequests') === 'true';\n    } catch {}\n    const allBackupPlayerTypes = BackupPlayerTypes;", 'CSAI persisted config');
src = replaceOnce(src, '    hookWindowWorker();\n    hookFetch();', '    hookWindowWorker();\n    hookFetch();\n    hookXHR();', 'XHR activation');

src = replaceOnce(src, "    window.getAutoQuality = getAutoQualityMode;", `    window.getAutoQuality = getAutoQualityMode;
    window.getCsaiBlocking = () => BlockCsaiAdRequests === true;
    window.setCsaiBlocking = (enabled) => {
        BlockCsaiAdRequests = enabled === true || enabled === 'true' || enabled === 'on';
        try {
            localStorage.setItem('twitchAdSolutions_blockCsaiAdRequests', BlockCsaiAdRequests ? 'true' : 'false');
        } catch {}
        return BlockCsaiAdRequests;
    };`, 'CSAI console controls');

src = replaceOnce(src, "            autoQuality: getAutoQualityMode(),\n            ...vaftRuntimeStatus", "            autoQuality: getAutoQualityMode(),\n            blockCsaiAdRequests: BlockCsaiAdRequests,\n            csai: getCsaiStatsSnapshot(),\n            ...vaftRuntimeStatus", 'CSAI diagnostics');

src = replaceOnce(src, "        if (e.key === 'adBackupMode') {\n            applyAdBackupMode(e.newValue);\n            postTwitchWorkerMessage('UpdateBackupPlayerTypes', BackupPlayerTypes);\n        }", "        if (e.key === 'adBackupMode') {\n            applyAdBackupMode(e.newValue);\n            postTwitchWorkerMessage('UpdateBackupPlayerTypes', BackupPlayerTypes);\n        } else if (e.key === 'twitchAdSolutions_blockCsaiAdRequests') {\n            BlockCsaiAdRequests = e.newValue === 'true';\n        }", 'CSAI cross-tab config');

fs.writeFileSync(path, src);

const checkPath = 'check.js';
let check = fs.readFileSync(checkPath, 'utf8');
check = replaceOnce(check, "assert(versionMatch[1] === '37.5.1', `expected @version 37.5.1, got ${versionMatch[1]}`);", "assert(versionMatch[1] === '37.6.0', `expected @version 37.6.0, got ${versionMatch[1]}`);", 'check version');
fs.writeFileSync(checkPath, check);

const hardeningPath = 'check-hardening.js';
let hardening = fs.readFileSync(hardeningPath, 'utf8');
hardening = replaceOnce(hardening, "assert(/\\/\\/ @version\\s+37\\.5\\.1/.test(src), '37.5.1 version missing');", "assert(/\\/\\/ @version\\s+37\\.6\\.0/.test(src), '37.6.0 version missing');", 'hardening version');
fs.writeFileSync(hardeningPath, hardening);

console.log('CSAI observability patch applied');
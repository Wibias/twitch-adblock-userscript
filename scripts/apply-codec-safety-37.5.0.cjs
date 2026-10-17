const fs = require('node:fs');

function replaceOnce(src, from, to, label) {
    const first = src.indexOf(from);
    if (first === -1) throw new Error(`missing patch anchor: ${label}`);
    if (src.indexOf(from, first + from.length) !== -1) throw new Error(`ambiguous patch anchor: ${label}`);
    return src.slice(0, first) + to + src.slice(first + from.length);
}

function replaceAllChecked(src, from, to, expected, label) {
    const count = src.split(from).length - 1;
    if (count !== expected) throw new Error(`expected ${expected} occurrences for ${label}, got ${count}`);
    return src.split(from).join(to);
}

function replaceRegexOnce(src, regex, to, label) {
    const matches = [...src.matchAll(new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g'))];
    if (matches.length !== 1) throw new Error(`expected one regex match for ${label}, got ${matches.length}`);
    return src.replace(regex, to);
}

const userscriptPath = 'twitch-adblock.user.js';
let src = fs.readFileSync(userscriptPath, 'utf8');

src = replaceOnce(src, '// @version      37.4.1', '// @version      37.5.0', 'public version');
src = replaceOnce(src, "version: '37.4.1',", "version: '37.5.0',", 'vaftStatus version');

src = replaceOnce(
    src,
    '                    ${stripAdSegments.toString()}\n                    ${getStreamUrlForResolution.toString()}',
    '                    ${stripAdSegments.toString()}\n                    ${videoCodecFamily.toString()}\n                    ${getStreamUrlForResolution.toString()}',
    'worker codec helper serialization'
);

src = replaceOnce(
    src,
    "            if (typeof url === 'string') {\n                if (AdSegmentCache.has(url)) {",
    "            if (typeof url === 'string') {\n                const adCacheEntry = AdSegmentCache.get(url);\n                if (adCacheEntry !== undefined) {\n                    if (adCacheEntry.enhanced) {\n                        return new Response('', { status: 403, statusText: 'ad segment blocked' });\n                    }",
    'enhanced blank-segment guard'
);

const codecHelper = `    function videoCodecFamily(codecs) {
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
`;
src = replaceOnce(src, '    function stripAdSegments(textStr, stripAllSegments, streamInfo) {', codecHelper + '    function stripAdSegments(textStr, stripAllSegments, streamInfo, isEnhancedPlaylist = false) {', 'codec helper and strip signature');
src = replaceOnce(src, '                AdSegmentCache.set(segmentUrl, Date.now());', '                AdSegmentCache.set(segmentUrl, { timestamp: Date.now(), enhanced: Boolean(isEnhancedPlaylist) });', 'segment codec context');
src = replaceOnce(src, '            if (value < Date.now() - 120000) {', '            if ((value?.timestamp ?? value) < Date.now() - 120000) {', 'segment cache pruning');

const newSelector = `    function getStreamUrlForResolution(encodingsM3u8, resolutionInfo, selectionOut = null) {
        const encodingsLines = encodingsM3u8.replaceAll('\\r', '').split('\\n');
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
`;
src = replaceRegexOnce(
    src,
    /    function getStreamUrlForResolution\(encodingsM3u8, resolutionInfo\) \{[\s\S]*?\n    \}\n    async function processM3U8/,
    newSelector + '    async function processM3U8',
    'codec-aware backup selector'
);

src = replaceOnce(src, "                                                    Codecs: attributes['CODECS'],", "                                                    Codecs: attributes['CODECS'] || '',", 'CODECS fallback');
src = replaceOnce(src, "                                    const nonHevcResolutionList = streamInfo.ResolutionList.filter((element) => element.Codecs?.startsWith('avc') || element.Codecs?.startsWith('av0'));", "                                    const decodableResolutionList = streamInfo.ResolutionList.filter((element) => videoCodecFamily(element.Codecs) === 'avc');", 'AVC-only decodable list');
src = replaceOnce(src, "                                    if (AlwaysReloadPlayerOnAd || (nonHevcResolutionList.length > 0 && streamInfo.ResolutionList.some((element) => element.Codecs?.startsWith('hev') || element.Codecs?.startsWith('hvc')) && !SkipPlayerReloadOnHevc)) {", "                                    const hasEnhancedVariant = streamInfo.ResolutionList.some((element) => { const family = videoCodecFamily(element.Codecs); return family === 'hevc' || family === 'av1'; });\n                                    if (AlwaysReloadPlayerOnAd || (decodableResolutionList.length > 0 && hasEnhancedVariant && !SkipPlayerReloadOnHevc)) {", 'enhanced master detection');
src = replaceAllChecked(src, 'nonHevcResolutionList.length > 0', 'decodableResolutionList.length > 0', 2, 'decodable list length');
src = replaceOnce(src, 'const newResolutionInfo = nonHevcResolutionList.sort((a, b) => {', 'const newResolutionInfo = decodableResolutionList.slice().sort((a, b) => {', 'AVC replacement selection');
src = replaceOnce(src, "                                                    if (codecs.startsWith('hev') || codecs.startsWith('hvc')) {", "                                                    const codecFamily = videoCodecFamily(codecs);\n                                                    if (codecFamily === 'hevc' || codecFamily === 'av1') {", 'master enhanced rewrite');

src = replaceOnce(
    src,
    "            const currentCodecs = currentResolution.Codecs || '';\n            const isHevc = currentCodecs.startsWith('hev') || currentCodecs.startsWith('hvc');\n            if (((isHevc && !SkipPlayerReloadOnHevc) || AlwaysReloadPlayerOnAd) && streamInfo.ModifiedM3U8 && !streamInfo.IsUsingModifiedM3U8) {",
    "            const currentCodecs = currentResolution.Codecs || '';\n            const currentCodecFamily = videoCodecFamily(currentCodecs);\n            const isEnhanced = currentCodecFamily === 'hevc' || currentCodecFamily === 'av1';\n            if (((isEnhanced && !SkipPlayerReloadOnHevc) || AlwaysReloadPlayerOnAd) && streamInfo.ModifiedM3U8 && !streamInfo.IsUsingModifiedM3U8) {",
    'media enhanced detection'
);
src = replaceOnce(src, '            let fallbackM3u8 = null;\n            let startIndex = 0;', "            let fallbackM3u8 = null;\n            let backupCodecFamily = 'unknown';\n            let fallbackCodecFamily = 'unknown';\n            let startIndex = 0;", 'backup codec state');
src = replaceOnce(src, '                            const streamM3u8Url = getStreamUrlForResolution(encodingsM3u8, currentResolution);', '                            const selectedBackup = {};\n                            const streamM3u8Url = getStreamUrlForResolution(encodingsM3u8, currentResolution, selectedBackup);', 'backup selection metadata');
src = replaceOnce(src, '                                        fallbackM3u8 = m3u8Text;', '                                        fallbackM3u8 = m3u8Text;\n                                        fallbackCodecFamily = videoCodecFamily(selectedBackup.codecs);', 'fallback codec family');
src = replaceAllChecked(src, '                                        backupM3u8 = m3u8Text;\n                                        break;', "                                        backupM3u8 = m3u8Text;\n                                        backupCodecFamily = videoCodecFamily(selectedBackup.codecs);\n                                        break;", 2, 'selected backup codec family');
src = replaceOnce(src, '                backupM3u8 = fallbackM3u8;', '                backupM3u8 = fallbackM3u8;\n                backupCodecFamily = fallbackCodecFamily;', 'fallback commit codec family');
src = replaceOnce(
    src,
    '            const stripHevc = isHevc && streamInfo.ModifiedM3U8;\n            if (IsAdStrippingEnabled || stripHevc) {\n                textStr = stripAdSegments(textStr, stripHevc, streamInfo);\n            }',
    "            const effectiveCodecFamily = backupM3u8 ? backupCodecFamily : currentCodecFamily;\n            const effectiveIsEnhanced = effectiveCodecFamily === 'hevc' || effectiveCodecFamily === 'av1';\n            const stripEnhanced = isEnhanced && streamInfo.ModifiedM3U8;\n            if (IsAdStrippingEnabled || stripEnhanced) {\n                textStr = stripAdSegments(textStr, stripEnhanced, streamInfo, effectiveIsEnhanced);\n            }",
    'enhanced strip protection'
);

fs.writeFileSync(userscriptPath, src);

const checkPath = 'check.js';
let check = fs.readFileSync(checkPath, 'utf8');
check = replaceOnce(check, "assert(versionMatch[1] === '37.4.1', `expected @version 37.4.1, got ${versionMatch[1]}`);", "assert(versionMatch[1] === '37.5.0', `expected @version 37.5.0, got ${versionMatch[1]}`);", 'check.js version');
fs.writeFileSync(checkPath, check);

const hardeningPath = 'check-hardening.js';
let hardening = fs.readFileSync(hardeningPath, 'utf8');
hardening = replaceOnce(hardening, "assert(/\\/\\/ @version\\s+37\\.4\\.1/.test(src), '37.4.1 version missing');", "assert(/\\/\\/ @version\\s+37\\.5\\.0/.test(src), '37.5.0 version missing');", 'hardening version');
fs.writeFileSync(hardeningPath, hardening);

console.log('codec safety patch applied');
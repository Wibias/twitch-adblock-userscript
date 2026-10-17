const fs = require('node:fs');
const path = 'check-hardening.js';
let src = fs.readFileSync(path, 'utf8');

const oldFactory = `    const selectStream = new Function(\`\n        \${extractFunction(src, 'parseAttributes')}\n        \${extractFunction(src, 'videoCodecFamily')}\n        \${extractFunction(src, 'getStreamUrlForResolution')}\n        return getStreamUrlForResolution;\n    \`)();`;
const newFactory = `    const selectStream = new Function(\`\n        function parseAttributes(line) {\n            const body = line.substring(line.indexOf(':') + 1);\n            return Object.fromEntries(body.split(',').map((part) => {\n                const [key, ...rest] = part.split('=');\n                return [key, rest.join('=').replace(/^\"|\"$/g, '')];\n            }));\n        }\n        \${extractFunction(src, 'videoCodecFamily')}\n        \${extractFunction(src, 'getStreamUrlForResolution')}\n        return getStreamUrlForResolution;\n    \`)();`;
if (!src.includes(oldFactory)) throw new Error('selector factory anchor missing');
src = src.replace(oldFactory, newFactory);
src = src.replace('CODECS="avc1.64002A,mp4a.40.2"', 'CODECS="avc1.64002A"');
src = src.replace('CODECS="mp4a.40.2,hvc1.2.4.L150.B0"', 'CODECS="hvc1.2.4.L150.B0"');
src = src.replace('CODECS="av01.0.08M.08,mp4a.40.2"', 'CODECS="av01.0.08M.08"');
fs.writeFileSync(path, src);
console.log('codec selector test harness isolated');
const fs = require('node:fs');
const path = 'check-hardening.js';
let src = fs.readFileSync(path, 'utf8');
const from = "        const ForceAccessTokenPlayerType = 'popout';\n        const window = {";
const to = "        const ForceAccessTokenPlayerType = 'popout';\n        let BlockCsaiAdRequests = false;\n        function getCsaiRequestType() { return null; }\n        function recordCsaiRequest() {}\n        const window = {";
if (!src.includes(from)) throw new Error('legacy fetch harness anchor missing');
src = src.replace(from, to);
fs.writeFileSync(path, src);
console.log('legacy fetch harness CSAI dependencies supplied');
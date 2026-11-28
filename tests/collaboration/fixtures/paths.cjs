'use strict';

const path = require('node:path');
const CHAT = process.env.VCP_COLLABORATION_DESKTOP || path.resolve(__dirname, '../../../apps/desktop');
const BOX = process.env.VCP_COLLABORATION_SERVER;
if (!BOX || !path.isAbsolute(BOX)) throw Error('Start collaboration tests through npm run test:collaboration');
module.exports = { BOX, CHAT };

'use strict';
const { custom } = require('../core/define');
module.exports = {
    handlers: ['main.js'],
    roles: ['chat'],
    api: {
        getComposerScope: custom('query', 'native-sync:composer-scope', () => {
            const scope = process.env.VCPCHAT_COMPOSER_SCOPE_ID||'profile';
            return () => scope;
        }),
    },
};

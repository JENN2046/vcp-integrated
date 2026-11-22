'use strict';

// Extra measurement command for the disposable Electron integration fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const target = path.resolve(process.cwd(), '../../tests/integration/electron.cjs');
const compile = Module._extensions['.cjs'] || Module._extensions['.js'];
Module._extensions['.cjs'] = function (module, name) {
    if (name !== target) return compile(module, name);
    const needle = "        if (action === 'trace') detailed = true;";
    const main = fs.readFileSync(name, 'utf8');
    assert.equal(main.split(needle).length, 2);
    module._compile(main.replace(needle, `        if (action === 'watch-visibility') {
            result = { visible: win.isVisible(), focused: win.isFocused(), minimized: win.isMinimized(), bounds: win.getBounds() };
            result.renderer = await win.webContents.executeJavaScript(` + JSON.stringify(`new Promise(resolve => {
                const started = performance.now();
                requestAnimationFrame(() => {
                    const first = performance.now();
                    requestAnimationFrame(() => resolve({
                        visibilityState: document.visibilityState, hasFocus: document.hasFocus(),
                        firstFrameMs: first - started, twoFramesMs: performance.now() - started,
                    }));
                });
            })`) + `);
        }
` + needle), name);
};
require(target);

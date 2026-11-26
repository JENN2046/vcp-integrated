'use strict';
const path = require('node:path');
const { WineVmManager } = require(path.join(process.cwd(), 'node_modules/app-builder-lib/out/vm/WineVm'));
const { UninstallerReader } = require(path.join(process.cwd(), 'node_modules/app-builder-lib/out/targets/nsis/nsisUtil'));
const original = WineVmManager.prototype.exec;
WineVmManager.prototype.exec = function (file, args, options, ...rest) {
    if (args.length === 0 && options?.env?.__COMPAT_LAYER === 'RunAsInvoker' && path.extname(file) === '.exe') {
        const target = path.join(path.dirname(file), path.basename(file, 'exe') + '__uninstaller.exe');
        return UninstallerReader.exec(file, target);
    }
    return original.call(this, file, args, options, ...rest);
};

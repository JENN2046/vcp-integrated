'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { restoreProfile } = require('../integration/profile.cjs');

async function main() {
    const [snapshot, target] = process.argv.slice(2);
    if (process.platform !== 'win32' || !snapshot || !target || process.argv.length !== 4) {
        throw Error('Use native Windows Node with: node tests/hardware/prepare-windows.cjs <desktopB seed> <new isolated profile>');
    }
    const profile = path.resolve(target);
    if (fs.existsSync(profile)) throw Error('The Windows test profile must be new');
    const source = path.resolve(snapshot);
    const connection = JSON.parse(fs.readFileSync(path.join(source,'.native-sync','connection.json'),'utf8'));
    if (connection.sourceId !== 'sourceB' || connection.deviceId !== 'deviceB' ||
        connection.sharedSpaceId !== 'sharedAB' || connection.serverUrl !== 'https://synthetic-shared.invalid') {
        throw Error('Seed is not from this synthetic fixture');
    }
    await restoreProfile(source, profile, 'https://127.0.0.1:18443', 'B');
    const settings = path.join(profile, 'settings.json');
    const settingsData = JSON.parse(fs.readFileSync(settings,'utf8'));
    fs.writeFileSync(settings, JSON.stringify({ ...settingsData, disableUpdateCheck:true }));
    console.log('Windows synthetic profile ready');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

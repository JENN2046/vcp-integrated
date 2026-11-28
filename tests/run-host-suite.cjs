'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function runSuite(suite, args) {
    if (!['native', 'collaboration'].includes(suite)) throw Error('Expected native or collaboration');
    const testDir = path.join(__dirname, suite);
    const separator = args.indexOf('--');
    const testFiles = separator < 0 ? null : args.slice(separator + 1);
    if (testFiles && (!testFiles.length || testFiles.some(file => path.basename(file) !== file || !file.endsWith('.test.cjs')))) {
        throw Error('Supply test basenames after --');
    }
    const nodeArgs = separator < 0 ? args : args.slice(0, separator);
    const root = path.resolve(__dirname, '..');
    const source = path.join(root, 'apps/server');
    const run = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-'+suite+'-'));
    const server = path.join(run, 'server');
    const browser = process.env.CHROME_BIN || '/opt/google/chrome/chrome';
    const cds = path.join(root, 'apps/desktop/modules/services/chatDataService/bin', process.platform + '-' + process.arch,
        'vcp_chat_data_service' + (process.platform === 'win32' ? '.exe' : ''));


    try {
        if (process.versions.node.split('.')[0] !== '24') throw Error('Use Node 24 for host validation');
        if (suite === 'collaboration') fs.accessSync(browser, fs.constants.X_OK);
        const files = execFileSync('git', ['ls-files', '-z', '--cached', '--', '.'], { cwd: source }).toString().split('\0').filter(Boolean);
        for (const file of new Set(files)) {
            const target = path.join(server, file);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(path.join(source, file), target);
        }
        for (const rel of [
            'node_modules',
            'Plugin/NativeSync/mobile-dist',
            'Plugin/NativeSync/sync/contracts.generated.cjs',
            'rust-vexus-lite/vexus-lite.linux-x64-gnu.node',
        ]) {
            const entry = path.join(source, rel);
            if (fs.existsSync(entry) && !fs.existsSync(path.join(server, rel))) {
                fs.symlinkSync(entry, path.join(server, rel));
            }
        }
        fs.accessSync(path.join(server, 'Plugin/NativeSync/mobile-dist/index.html'));
        fs.writeFileSync(path.join(server, 'config/tool-call-records.config.json'), JSON.stringify({
            enabled: true, captureMultimodal: false, autoCleanupEnabled: false,
        }));
        const tests = (testFiles || fs.readdirSync(testDir).filter(file => file.endsWith('.test.cjs')).sort())
            .map(file => path.join(testDir, file));
        const result = spawnSync(process.execPath, ['--require', path.join(__dirname, 'collaboration/fixtures/loopback.cjs'), '--test', '--test-concurrency=1', ...nodeArgs, ...tests], {
            cwd: run,
            stdio: 'inherit',
            env: {
                PATH: process.env.PATH,
                HOME: run,
                CHROME_BIN: browser,
                LANG: 'C.UTF-8',
                TMPDIR: run,
                FIX03_FIXTURE_ROOT: run,
                ...(fs.existsSync(cds) && { VCP_CORE_CDS_BINARY: cds }),
                VCP_TEST_SERVER: server,
                VCP_COLLABORATION_SERVER: server,
            },
        });
        if (result.error) throw result.error;
        process.exitCode = result.status ?? 1;
    } finally {
        fs.rmSync(run, { recursive: true, force: true });
    }
}

module.exports = runSuite;
if (require.main === module) runSuite(process.argv[2], process.argv.slice(3));

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (Number(process.versions.node.split('.')[0]) !== 24) throw Error('Run npm run deps under Node 24');
for (const name of ['desktop','server','mobile']) {
    const args = [process.env.npm_execpath,'ci','--no-audit','--no-fund'];
    // Desktop's postinstall also builds optional native components. Prepare
    // Electron explicitly; build:cds and the sandbox preloads are built later.
    if (name === 'desktop') args.push('--ignore-scripts');
    const cwd = path.join(root,'apps',name);
    const env = {...process.env, PUPPETEER_SKIP_DOWNLOAD:'1'};
    function execute(argv) {
        const child = spawnSync(process.execPath, argv, {cwd, env, stdio:'inherit'});
        if (child.error) throw child.error;
        if (child.status !== 0) throw Error('Dependency setup failed for ' + name);
    }
    execute(args);
    if (name === 'desktop') execute(['node_modules/electron/install.js']);
}

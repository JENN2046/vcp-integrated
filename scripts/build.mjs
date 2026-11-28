import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const app = name => path.join(root, 'apps', name);
const mobile = app('mobile');
const desktop = app('desktop');
const server = app('server');
const local = createRequire(path.join(mobile, 'package.json'));
if (Number(process.versions.node.split('.')[0]) !== 24) throw Error('Use Node 24 to build this checkout');
if (process.argv.slice(2).some(x => x !== '--mobile')) throw Error('Usage: node scripts/build.mjs [--mobile]');

function run(script, args, cwd) {
    const child = spawnSync(process.execPath, [script, ...args], { cwd, stdio: 'inherit' });
    if (child.error) throw child.error;
    if (child.status !== 0) throw Error('Build failed: ' + script);
}

const input = path.join(root, 'packages/sync-contracts/src/contracts.mjs');
const modelCatalogInput = path.join(path.dirname(input), 'chatModelCatalog.mjs');
const modelCatalogSource = await readFile(modelCatalogInput);
const hash = createHash('sha256').update(await readFile(input)).update(modelCatalogSource).digest('hex');
const lock = JSON.parse(await readFile(path.join(mobile, 'package-lock.json')));
const compiler = local.resolve('rolldown/package.json');
if (local(compiler).version !== lock.packages['node_modules/rolldown'].version) throw Error('Use locked mobile dependencies');
const { rolldown } = await import(pathToFileURL(path.join(path.dirname(compiler), 'dist/index.mjs')));
const bundle = await rolldown({ cwd: root, input, platform: 'neutral' });
try {
    for (const [format, files] of [
        ['cjs', [path.join(desktop,'modules/services/nativeSync/contracts.generated.cjs'), path.join(server,'Plugin/NativeSync/sync/contracts.generated.cjs')]],
        ['es', [path.join(mobile,'src/contracts.generated.js')]],
    ]) {
        const { output } = await bundle.generate({format, file:'contracts.'+(format==='cjs'?'cjs':'js'), sourcemap:false, minify:false});
        if (output.length !== 1 || output[0].type !== 'chunk' || output[0].imports.length || output[0].dynamicImports.length) throw Error('Contract must be standalone');
        const bytes = '// Generated during release assembly; source SHA256 '+hash+'\n'+output[0].code;
        for (const file of files) {
            await mkdir(path.dirname(file), {recursive:true});
            await writeFile(file, bytes);
        }
    }
} finally { await bundle.close(); }

// The standalone workflow editor uses classic scripts, including on file URLs.
const workflowBundle = await rolldown({ cwd: root, input: modelCatalogInput, platform: 'neutral' });
try {
    const { output } = await workflowBundle.generate({ format:'iife', name:'VCPChatModelCatalog', sourcemap:false });
    if (output.length !== 1 || output[0].type !== 'chunk' || output[0].imports.length || output[0].dynamicImports.length) {
        throw Error('Workflow model catalog must be standalone');
    }
    const workflowHash = createHash('sha256').update(modelCatalogSource).digest('hex');
    await writeFile(path.join(desktop,'VCPHumanToolBox/WorkflowEditormodules/ai/modelCatalog.generated.js'),
        '// Generated during release assembly; source SHA256 '+workflowHash+'\n'+output[0].code);
} finally { await workflowBundle.close(); }

// Stage a complete PWA before replacing the server's build output.
const parent = path.join(server, 'Plugin/NativeSync');
const output = path.join(parent, 'mobile-dist');
const staging = path.join(parent, '.mobile-build-' + process.pid);
const vite = path.join(path.dirname(local.resolve('vite/package.json')), 'bin/vite.js');
try {
    run(vite, ['build','--outDir',staging], mobile);
    await stat(path.join(staging, 'index.html'));
    await rm(output, {recursive:true, force:true});
    await rename(staging, output);
} finally { await rm(staging, {recursive:true,force:true}); }
if (!process.argv.includes('--mobile')) {
    run(path.join(desktop,'scripts/build-shared-renderer-rules.cjs'), [], desktop);
    run(path.join(desktop,'scripts/build-portable-agent-owner.cjs'), [desktop], desktop);
    run(path.join(desktop,'scripts/build-sandbox-preloads.cjs'), [desktop], desktop);
    run(path.join(desktop,'rust_chat_data_service/build-runtime.js'), [], desktop);
    if (process.platform !== 'linux' || process.arch !== 'x64') {
        throw Error('The integrated server build currently targets Linux x64 GNU. Build the desktop separately on its target OS.');
    }
    const native = spawnSync('bash', [path.join(server,'scripts/build-vexus.sh')], {cwd:server,stdio:'inherit'});
    if (native.error) throw native.error;
    if (native.status !== 0) throw Error('Vexus build failed');
    const serverRequire = createRequire(path.join(server,'package.json'));
    const db = new (serverRequire('better-sqlite3'))(':memory:');
    try { db.prepare('SELECT 1').get(); } finally { db.close(); }
}

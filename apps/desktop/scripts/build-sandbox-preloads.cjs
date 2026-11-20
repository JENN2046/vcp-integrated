'use strict';
// Reuses the role registry and Feature policy; no Electron launch or dependency download.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const webpack = require('webpack');
const args = process.argv.slice(2);
const source = path.resolve(args[0] || path.join(__dirname, '..'));
const output = path.resolve(args[1] || path.join(source, 'preloads/bundled'));
const generated = path.join(output, 'generated');
const dist = path.join(output, 'dist');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function replaceOnce(text, before, after) {
    if (text.split(before).length !== 2) throw new Error('Candidate source contract drift: ' + before.slice(0, 80));
    return text.replace(before, after);
}
fs.mkdirSync(generated, { recursive: true });
fs.mkdirSync(dist, { recursive: true });
const domains = fs.readdirSync(path.join(source, 'preloads/api')).filter(x => x.endsWith('.js')).sort()
    .map(name => ({ domain: name.slice(0, -3), where: 'preloads/api/' + name, feature: null, file: path.join(source, 'preloads/api', name) }));
for (const entry of fs.readdirSync(path.join(source, 'modules'), { withFileTypes: true }).filter(x => x.isDirectory()).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const file = path.join(source, 'modules', entry.name, 'preloadApi.js');
    if (fs.existsSync(file)) domains.push({ domain: entry.name, where: 'modules/' + entry.name + '/preloadApi.js', feature: entry.name, file });
}
const registryPath = path.join(source, 'preloads/core/registry.js');
const scopePath = path.join(source, 'preloads/api/nativeComposer.js');
const virtualRegistry = path.join(generated, 'registry.cjs');
const virtualScope = path.join(generated, 'nativeComposer-preloadApi.cjs');
let registry = fs.readFileSync(registryPath, 'utf8');
registry = replaceOnce(registry, "const fs = require('fs');\nconst path = require('path');\n", '');
registry = replaceOnce(registry, "require('./define')", 'require(' + JSON.stringify(path.join(source, 'preloads/core/define.js')) + ')');
const begin = registry.indexOf('const API_DIR = '), end = registry.indexOf('\nfunction assertRoles(', begin);
if (begin < 0 || end < 0) throw new Error('Static registry boundaries drifted');
const staticRows = domains.map(d => '{domain:' + JSON.stringify(d.domain) + ',where:' + JSON.stringify(d.where) + ',feature:' + JSON.stringify(d.feature) + ',load:()=>require(' + JSON.stringify(d.file) + ')}');
registry = registry.slice(0, begin) + 'const DOMAIN_FILES = [\n' + staticRows.join(',\n') + '\n];\nfunction listDomainFiles(skipFeatures = []) { return DOMAIN_FILES.filter(row => !row.feature || !skipFeatures.includes(row.feature)); }\n' + registry.slice(end);
registry = replaceOnce(registry, 'for (const { domain, file, where } of listDomainFiles(skipFeatures)) {\n        const definition = require(file);', 'for (const { domain, load, where } of listDomainFiles(skipFeatures)) {\n        const definition = load();');
fs.writeFileSync(virtualRegistry, registry);
let scope = fs.readFileSync(scopePath, 'utf8');
scope = replaceOnce(scope, "require('../core/define')", 'require(' + JSON.stringify(path.join(source, 'preloads/core/define.js')) + ')');
scope = replaceOnce(scope, "process.env.VCPCHAT_COMPOSER_SCOPE_ID||'profile'", 'readCandidateComposerScope()');
scope += `
function readCandidateComposerScope() {
    const prefix = '--nativesync-composer-scope=';
    const values = process.argv.filter(value => typeof value === 'string' && value.startsWith(prefix));
    if (values.length !== 1) throw new Error('CANDIDATE_COMPOSER_SCOPE_REQUIRED');
    const value = JSON.parse(decodeURIComponent(values[0].slice(prefix.length)));
    if (!value || typeof value.scope !== 'string' || !value.scope || value.scope.length > 4096 || value.scope.includes('\\0') || !/^[a-f0-9]{64}$/.test(value.profile)) throw new Error('CANDIDATE_COMPOSER_SCOPE_REQUIRED');
    const expected = require('electron').ipcRenderer.sendSync('native-sync:composer-scope');
    if (!expected || expected.scope !== value.scope || expected.profile !== value.profile) throw new Error('CANDIDATE_COMPOSER_IDENTITY_MISMATCH');
    return value.scope;
}
`;
fs.writeFileSync(virtualScope, scope);
const replacements = new Map([[registryPath, virtualRegistry], [scopePath, virtualScope]]);
const replacementPlugin = {
    apply(compiler) {
        compiler.hooks.normalModuleFactory.tap('StaticPreloadCandidate', factory => {
            factory.hooks.beforeResolve.tap('StaticPreloadCandidate', data => {
                if (!data || !(data.request.startsWith('.') || path.isAbsolute(data.request))) return;
                let resolved = path.resolve(data.context, data.request);
                if (!path.extname(resolved)) resolved += '.js';
                if (replacements.has(resolved)) data.request = replacements.get(resolved);
            });
        });
    },
};
const config = {
    mode: 'none', target: ['web', 'es2020'], devtool: false,
    context: source, entry: Object.fromEntries(['chat', 'auxiliary-chat', 'utility', 'desktop'].map(role => [role, path.join(source, 'preloads', role + '.js')])),
    output: { path: dist, filename: '[name].cjs', iife: true },
    externals: { electron: 'commonjs electron' },
    plugins: [replacementPlugin], optimization: { minimize: false },
    performance: { hints: false }, cache: false,
};
const compiler = webpack(config);
compiler.run((error, stats) => {
    compiler.close(closeError => {
        if (error || closeError || stats.hasErrors()) {
            process.stderr.write(String(error || closeError || stats.toString({ all: false, errors: true })) + '\n');
            process.exitCode = 1; return;
        }
        const info = stats.toJson({ all: false, modules: true });
        const resources = [...new Set([registryPath, scopePath, ...info.modules.map(m => m.nameForCondition).filter(file => file && !file.startsWith(generated + path.sep))])].sort();
        const manifest = {
            status: 'BUNDLED', source: '.', webpack: require('webpack/package.json').version, builderSHA256: hash(fs.readFileSync(__filename)),
            domains: domains.map(({ file, ...d }) => ({ ...d, file: path.relative(source, file).split(path.sep).join('/'), sha256: hash(fs.readFileSync(file)) })),
            inputs: resources.map(file => ({ file: path.relative(source, file).split(path.sep).join('/'), sha256: hash(fs.readFileSync(file)) })),
            bundles: ['chat', 'auxiliary-chat', 'utility', 'desktop'].map(role => ({ role, file: 'preloads/bundled/dist/' + role + '.cjs', sha256: hash(fs.readFileSync(path.join(dist, role + '.cjs'))) })),
            externalModules: info.modules.filter(m => m.name?.startsWith('external ')).map(m => m.name),
        };
        fs.writeFileSync(path.join(output, 'BUILD-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
        process.stdout.write(JSON.stringify({ status: manifest.status, roles: 4, domains: domains.length, externalModules: manifest.externalModules }) + '\n');
    });
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const docx=fs.readFileSync('modules/ipc/docxHandlers.js','utf8'),desktop=fs.readFileSync('modules/ipc/desktopHandlers.js','utf8');
test('all Scriptorium writable library roots stay in the supplied userData profile',()=>{
 const start=docx.indexOf('    documentLibraryRoots = ['),end=docx.indexOf('\n    ];',start)+7,ctx={params:{projectRoot:'/readonly/app.asar',appDataRoot:'/synthetic-profile'},path};
 vm.runInNewContext('let documentLibraryRoots;'+docx.slice(start,end)+';this.roots=documentLibraryRoots;',ctx);
 assert.equal(ctx.roots.find(v=>v.id==='presentations').path,path.join('/synthetic-profile','ScriptoriumDocument','VPPTX'));
 for(const root of ctx.roots)assert(root.path.startsWith('/synthetic-profile/'));
});
// Actual Electron R2 ASAR observation: access/pathExists is false while
// existsSync/stat/readdir succeed. Keep that distinction in this fixture.
function scanContext(packaged=true){const calls=[];return {calls,path,PROJECT_ROOT:'/readonly/app.asar',console,app:{isPackaged:packaged},fs:{pathExists:async()=>false,existsSync:file=>!file.endsWith('.block')&&!file.endsWith('config.env'),ensureDir:async dir=>{calls.push(dir);if(packaged)throw Object.assign(Error('ASAR cannot mkdir'),{code:'ENOTDIR'})},readdir:async()=>[{name:'NormalPlugin',isDirectory:()=>true}],readJson:async()=>({name:'NormalPlugin',frontend:{script:'normal.js'}}),readFile:async file=>{assert(file.endsWith('plugin-manifest.json'));return JSON.stringify({name:'NormalPlugin',pluginType:'renderer'})}},resolveFrontendPluginResource:()=> 'normal.js'};}
test('existing bundled frontend plugin scan never mkdirs the ASAR directory',async()=>{
 const ctx=scanContext(),start=desktop.indexOf('async function listEnabledFrontendPlugins()'),end=desktop.indexOf('async function readVcpPluginEntry(',start);
 vm.runInNewContext(desktop.slice(start,end)+';this.read=listEnabledFrontendPlugins;',ctx);const plugins=await ctx.read();assert.equal(plugins.length,1);assert.equal(ctx.calls.length,0);
});
test('normal plugin-manager bundled listing remains read-only and still includes app features',async()=>{
 const ctx=scanContext();Object.assign(ctx,{ipcMain:{handle:(name,fn)=>{assert.equal(name,'plugin-manager-list-plugins');ctx.handler=fn}},readVcpPluginEntry:async()=>({folderName:'NormalPlugin',manifest:{name:'NormalPlugin'}}),listAppFeaturesForPluginManager:()=>[{folderName:'feature:normal',manifest:{name:'normal'}}]});
 const start=desktop.indexOf("    ipcMain.handle('plugin-manager-list-plugins'"),end=desktop.indexOf("    ipcMain.handle('plugin-manager-save-manifest'",start);vm.runInNewContext(desktop.slice(start,end),ctx);const result=await ctx.handler();assert.equal(result.success,true,result.error);assert.equal(result.plugins.length,2);assert.equal(ctx.calls.length,0);
});

test('ASAR manifest checks use readable archive metadata without access false negatives',async()=>{
 const ctx=scanContext(),start=desktop.indexOf('async function readVcpPluginEntry('),end=desktop.indexOf('function isSafeWidgetFileName(',start);vm.runInNewContext(desktop.slice(start,end)+';this.read=readVcpPluginEntry;',ctx);const result=await ctx.read({name:'NormalPlugin'},'/readonly/app.asar/VCPDistributedServer/Plugin');assert.equal(result?.manifest.name,'NormalPlugin');assert.equal(result.enabled,true);assert.equal(result.hasConfigEnv,false);assert.equal(ctx.calls.length,0);
});
test('development discovery retains initialization of its writable plugin directory',async()=>{
 const ctx=scanContext(false),start=desktop.indexOf('async function listEnabledFrontendPlugins()'),end=desktop.indexOf('async function readVcpPluginEntry(',start);vm.runInNewContext(desktop.slice(start,end)+';this.read=listEnabledFrontendPlugins;',ctx);await ctx.read();assert.deepEqual(ctx.calls,['/readonly/app.asar/VCPDistributedServer/Plugin']);
});

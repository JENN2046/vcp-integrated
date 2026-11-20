'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
test('locked Pyodide loader initializes in an opaque browser without storage access',()=>{
 const dom=new JSDOM('<!doctype html><body></body>',{runScripts:'outside-only'});
 try{
  assert.throws(()=>dom.window.sessionStorage,{name:'SecurityError'});
  assert.doesNotThrow(()=>dom.window.eval(fs.readFileSync('vendor/pyodide.js','utf8')));
  assert.equal(typeof dom.window.loadPyodide,'function');
 }finally{dom.window.close();}
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entriesOf, collectStreamToolCalls, admitNativeCalls, buildNativeToolMessages, NATIVE_CALL_ID } = require('../modules/nativeToolLoop');
const f = (name, args, id) => ({ id, function:{name, arguments:args} });
const frame = delta => 'data: '+JSON.stringify({choices:[{index:0,delta}]});
test('mixed batch: unique canonical IDs only for admitted calls; next turn independent', () => {
 const good = f('vcptools',{tool_name:'Demo', items:[1,2]},'x');
 const batch = admitNativeCalls([good,f('vcptools','{','bad'),{functionCall:{name:'Demo',args:{x:1}},id:'x'},f('missing',{}),f('Demo',{tool_name:'other'})], n=>n==='Demo');
 assert.deepEqual(batch.rejected,['1:invalid_json','3:unknown_or_conflicting_name','4:unknown_or_conflicting_name']);
 const ids = batch.calls.map(c=>c.id);
 assert.equal(ids[0],'x'); assert.notEqual(ids[1],'x');
 assert.deepEqual(batch.normalized.map(c=>c[NATIVE_CALL_ID]),ids);
 assert.deepEqual(buildNativeToolMessages(batch.calls,[]).map(m=>m.tool_call_id),ids);
 assert.deepEqual(admitNativeCalls([good]).calls[0].id,'x');
});
test('interleaved slots: malformed object/string mix poisons only its slot',()=>{
 const entries = collectStreamToolCalls([frame({tool_calls:[{index:0,...f('vcptools','{"tool_')},{index:2,...f('vcptools',{})}]}),frame({tool_calls:[{index:2,function:{arguments:'x'}},{index:0,function:{arguments:'name":"Demo"}'}}]})]);
 const batch = admitNativeCalls(entries); assert.equal(batch.calls.length,1); assert.equal(batch.normalized[0].name,'Demo'); assert.deepEqual(batch.rejected,['1:fragment_conflict']);
});
test('legacy string fragments, object singleton and missing ID',()=>{
 const entries = collectStreamToolCalls([frame({function_call:{name:'vcptools',arguments:'{"JEV":'}}),frame({function_call:{arguments:'"demo"}'}})]);
 assert.equal(admitNativeCalls(entries).normalized[0].name,'JEV');
 assert.ok(admitNativeCalls(entriesOf({tool_calls:f('vcptools',{tool_name:'Demo'})})).calls[0].id);
});
test('streamed metadata stays with its indexed call and matches non-stream admission', () => {
    const signature = '  opaque+/=\n' + '签'.repeat(4096);
    const extra = { vendor: { flags: [1, null] }, google: { thought_signature: signature } };
    const other = { google: { thought_signature: 'second' } };
    const first = { ...f('vcptools', '{"tool_name":"Demo"}', 'first'), extra_content: extra };
    const second = { ...f('vcptools', '{"tool_name":"Demo"}', 'second'), extra_content: other };
    const entries = collectStreamToolCalls([
        frame({ tool_calls: [{ index: 7, ...second }, { index: 2, extra_content: extra }] }),
        frame({ tool_calls: [{ index: 2, ...first, extra_content: { google: extra.google, vendor: extra.vendor } }] })
    ]);
    const streamed = admitNativeCalls(entries);
    assert.deepEqual(streamed.calls, [first, second].map(call => ({ ...call, type: 'function' })));
    assert.deepEqual(streamed, admitNativeCalls([first, second]));
});

test('conflicting extra_content rejects only that call and keeps the first value', () => {
    const call = f('vcptools', '{"tool_name":"Demo"}', 'conflict');
    const original = { google: { thought_signature: 'one' } };
    const entries = collectStreamToolCalls([
        frame({ tool_calls: [{ index: 0, ...call, extra_content: original }] }),
        frame({ tool_calls: [{ index: 0, extra_content: { google: { thought_signature: 'two' } } },
            { index: 1, ...call, id: 'valid' }] })
    ]);
    assert.deepEqual(entries[0].extra_content, original);
    const batch = admitNativeCalls(entries);
    assert.deepEqual(batch.rejected, ['0:fragment_conflict']);
    assert.deepEqual(batch.calls.map(entry => entry.id), ['valid']);
    assert.equal(Object.hasOwn(batch.calls[0], 'extra_content'), false);
});

test('explicit null metadata remains distinct from an omitted field', () => {
    const call = { ...f('vcptools', '{"tool_name":"Demo"}', 'single'), extra_content: null };
    const entries = collectStreamToolCalls([frame({ tool_calls: [{ index: 0, ...call }] })]);
    assert.deepEqual(admitNativeCalls(entries).calls[0], { ...call, type: 'function' });
    assert.deepEqual(admitNativeCalls(entries), admitNativeCalls([call]));
});

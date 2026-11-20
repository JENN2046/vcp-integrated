import test from 'node:test';
import assert from 'node:assert/strict';
import { createNonStreamingEventConsumer } from '../modules/renderer/nonStreamingEventConsumer.js';

test('non-streaming consumer projects only already-persisted current-surface events', async () => {
    const calls = [];
    const renderTarget = {
        root: {},
        removeMessage(id, save) { calls.push(['remove', id, save]); },
    };
    const messageRenderer = {
        renderFullMessageProjection(...args) { calls.push(['full', ...args]); return Promise.resolve(); },
    };
    const consumer = createNonStreamingEventConsumer({
        renderTarget,
        messageRenderer,
        viewAuthority: { isCurrent: context => context?.topicId === 'current' },
    });
    assert.equal(await consumer.consume({ type: 'full_response', messageId: 'm1', fullResponse: 'ok', context: { topicId: 'background' } }), true);
    assert.equal(await consumer.consume({ type: 'full_response', messageId: 'm1', fullResponse: 'ok', context: { topicId: 'current' } }), true);
    assert.equal(await consumer.consume({ type: 'remove_message', messageId: 'm1', context: { topicId: 'current' } }), true);
    assert.deepEqual(calls.map(call => call[0]), ['full', 'remove']);
    assert.equal(calls[1][2], false);
    consumer.dispose();
    assert.equal(await consumer.consume({ type: 'remove_message', messageId: 'm2', context: { topicId: 'current' } }), false);
});

test('producer-committed full response retires thinking without a second persistence or late resurrection',async()=>{
 const {createVcpStreamBridge}=await import('../modules/chat/vcpStreamBridge.js');
 let writes=0,discarded=0,projected=0,buttonUpdates=0;
 const bridge=createVcpStreamBridge({createConsumer:()=>({prepare(){},consume(){},persist(){writes++;throw Error('already committed');}})});
 bridge.accept({type:'agent_thinking',messageId:'group-reply',context:{groupId:'g',topicId:'t'}});
 const consumer=createNonStreamingEventConsumer({renderTarget:{root:{}},messageRenderer:{renderFullMessageProjection:async()=>{projected++;}},viewAuthority:{isCurrent:()=>true},disposeStream:(...args)=>bridge.disposeOperation(...args),streamProjection:{discardStreamingMessage:()=>{discarded++;}},notifySendStateChanged:()=>{buttonUpdates++;}});
 assert.equal(bridge.isOperationActive('group-reply'),true);
 assert.equal(await consumer.consume({type:'full_response',messageId:'group-reply',fullResponse:'durable reply',context:{groupId:'g',topicId:'t'}}),true);
 assert.equal(bridge.isOperationActive('group-reply'),false);assert.equal(writes,0);assert.equal(projected,1);assert.equal(discarded,1);assert.equal(buttonUpdates,1);
 assert.equal(bridge.accept({type:'agent_thinking',messageId:'group-reply'}),false);
 consumer.dispose();await bridge.dispose();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { extractTopicRiverQuote, renderTopicRiverQuote } from '../../apps/desktop/modules/renderer/topicRiverQuote.mjs';

const require = createRequire(import.meta.url);
const quoteWriters = [
    require('../../apps/desktop/modules/services/nativeSync/topicRiverQuote'),
    require('../../apps/server/Plugin/NativeSync/sync/topicRiverQuote'),
];
const v2 = '原留言\n\n[VCP_TOPIC_RIVER_V2]\n#### 1 · 小&#38;青（助手）\n> &#60;示例&#62;\n[/VCP_TOPIC_RIVER_V2]';

test('an author V2 receipt decodes once and safely displays the original name and text', () => {
    const { source, rows } = extractTopicRiverQuote(v2);
    assert.equal(source, '原留言');
    assert.deepEqual(rows, [{ role: 'assistant', name: '小&青', content: '<示例>' }]);
    const html = renderTopicRiverQuote(rows);
    assert.ok(html.includes('小&amp;青（助手）'));
    assert.ok(html.includes('&lt;示例&gt;'));
});

test('forwarding a message with an existing quote preserves only its own dialogue', () => {
    for (const { formatTopicRiverQuote } of quoteWriters) {
        const initial = { role: 'assistant', name: '  成员甲  ', content: v2 };
        const once = formatTopicRiverQuote([initial]);
        const twice = formatTopicRiverQuote([{ ...initial, content: '原留言\n\n' + once }]);
        assert.equal(once, twice);
        assert.deepEqual(extractTopicRiverQuote('送达\n\n' + once).rows, [
            { role: 'assistant', name: '成员甲', content: '原留言' },
        ]);
    }
});

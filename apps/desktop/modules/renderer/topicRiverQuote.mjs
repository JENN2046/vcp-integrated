// VCPChat e9f8f283, modules/renderer/renderTemplateCompiler.js.
import { escapeHtml as escapeTopicQuoteHtml } from '../ui-system/text-escape.js';

export function extractTopicRiverQuote(text) {
    if (typeof text !== 'string') return null;
    const start = Math.max(text.lastIndexOf('\n\n[VCP_TOPIC_RIVER_V1]'), text.lastIndexOf('\r\n\r\n[VCP_TOPIC_RIVER_V1]'));
    if (start === -1) return null;
    // Return-address footer stays in the body for its existing display-only filter.
    const suffix = /^(?:\r?\n){2}\[VCP_TOPIC_RIVER_V1\]\r?\n([\s\S]+?)\r?\n\[\/VCP_TOPIC_RIVER_V1\]((?:\r?\n){2}\[该发言发送自[^\r\n\]]+话题\])?[ \t\r\n]*$/.exec(text.slice(start));
    if (!suffix) return null;
    try {
        const rows = suffix[1].split(/\r?\n/).map(line => JSON.parse(line));
        if (!rows.every(row => (row?.role === 'user' || row?.role === 'assistant')
            && typeof row.content === 'string' && row.content.trim())) return null;
        return { source: text.slice(0, start) + (suffix[2] || ''), rows };
    } catch {
        return null;
    }
}

export function renderTopicRiverQuote(rows) {
    const body = rows.map(({ role, content }) => {
        const label = role === 'user' ? '用户' : '助手';
        const preview = content.trim().split(/\r?\n/, 1)[0];
        const summary = `${label}：${preview.slice(0, 72)}${preview.length > 72 ? '…' : ''}`;
        return `<details class="vcp-topic-river-row"><summary class="vcp-topic-river-row-summary">${escapeTopicQuoteHtml(summary)}</summary><div class="vcp-topic-river-text">${escapeTopicQuoteHtml(content)}</div></details>`;
    }).join('');
    return `<details class="vcp-topic-river" data-vcp-block-type="topic-river" data-vcp-preserve-children="true"><summary class="vcp-topic-river-summary">随附上下文 · ${rows.length} 条</summary><div class="vcp-topic-river-body">${body}</div></details>`;
}

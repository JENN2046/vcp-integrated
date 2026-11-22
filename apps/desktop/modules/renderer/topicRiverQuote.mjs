// VCPChat 8a937038, modules/renderer/renderTemplateCompiler.js.
import { escapeHtml as escapeTopicQuoteHtml } from '../ui-system/text-escape.js';

// Decode one layer only. The result is escaped as HTML by renderTopicRiverQuote.
const decodeTopicQuoteText = text => text.replace(/&#(\d{1,5});/g, (entity, digits) => {
    const code = Number(digits);
    return code <= 127 || code === 8232 || code === 8233 ? String.fromCharCode(code) : entity;
});

function parseTopicRiverMarkdown(body) {
    const rows = [];
    for (const block of body.split(/\r?\n\r?\n/)) {
        const [heading, ...lines] = block.split(/\r?\n/);
        const header = /^#### ([1-9]\d*) · (?:(.+)（(用户|助手|工具结果)）|(用户|助手))$/u.exec(heading);
        if (!header || header[1] !== String(rows.length + 1)
            || !lines.length || lines.some(line => line !== '>' && !line.startsWith('> '))) return null;
        const content = decodeTopicQuoteText(lines.map(line => line.slice(2)).join('\n'));
        if (!content.trim()) return null;
        const name = header[2] ? decodeTopicQuoteText(header[2]) : '';
        const kind = header[3] || header[4];
        rows.push({ role: kind === '工具结果' ? 'tool' : kind === '用户' ? 'user' : 'assistant',
            content, ...(name ? { name } : {}) });
    }
    return rows;
}

export function extractTopicRiverQuote(text) {
    if (typeof text !== 'string') return null;
    let start = -1;
    for (const version of ['V1', 'V2']) {
        const marker = `[VCP_TOPIC_RIVER_${version}]`;
        start = Math.max(start, text.lastIndexOf(`\n\n${marker}`), text.lastIndexOf(`\r\n\r\n${marker}`));
    }
    if (start === -1) return null;
    // Return-address footer stays in the body for its existing display-only filter.
    const suffix = /^(?:\r?\n){2}\[VCP_TOPIC_RIVER_(V[12])\]\r?\n([\s\S]+?)\r?\n\[\/VCP_TOPIC_RIVER_\1\]((?:\r?\n){2}\[该发言发送自[^\r\n\]]+话题\])?[ \t\r\n]*$/.exec(text.slice(start));
    if (!suffix) return null;
    try {
        const rows = suffix[1] === 'V2'
            ? parseTopicRiverMarkdown(suffix[2])
            : suffix[2].split(/\r?\n/).map(line => JSON.parse(line));
        if (!rows?.length || !rows.every(row => (row?.role === 'user' || row?.role === 'assistant'
            || (suffix[1] === 'V2' && row?.role === 'tool'))
            && typeof row.content === 'string' && row.content.trim())) return null;
        return { source: text.slice(0, start) + (suffix[3] || ''), rows };
    } catch {
        return null;
    }
}

export function renderTopicRiverQuote(rows) {
    const body = rows.map(({ role, name, content }) => {
        const fallback = role === 'tool' ? '工具结果' : role === 'user' ? '用户' : '助手';
        const label = typeof name === 'string' && name.trim() ? `${name}（${fallback}）` : fallback;
        const preview = content.trim().split(/\r?\n/, 1)[0];
        const summary = `${label}：${preview.slice(0, 72)}${preview.length > 72 ? '…' : ''}`;
        return `<details class="vcp-topic-river-row"><summary class="vcp-topic-river-row-summary">${escapeTopicQuoteHtml(summary)}</summary><div class="vcp-topic-river-text">${escapeTopicQuoteHtml(content)}</div></details>`;
    }).join('');
    return `<details class="vcp-topic-river" data-vcp-block-type="topic-river" data-vcp-preserve-children="true"><summary class="vcp-topic-river-summary">随附上下文 · ${rows.length} 条</summary><div class="vcp-topic-river-body">${body}</div></details>`;
}

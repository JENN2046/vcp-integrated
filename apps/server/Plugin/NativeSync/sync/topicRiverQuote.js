'use strict';

const HEADER = '[VCP_TOPIC_RIVER_V1]';
const FOOTER = '[/VCP_TOPIC_RIVER_V1]';
const INTERNAL_BLOCKS = [
    /<!--\s*VCP_RAG_BLOCK_START\b[\s\S]*?<!--\s*VCP_RAG_BLOCK_END\s*-->/gi,
    /<<<\[TOOL_REQUEST\]>>>[\s\S]*?<<<\[END_TOOL_REQUEST\]>>>/g,
    /\[\[VCP调用结果信息汇总:[\s\S]*?VCP调用结果结束\]\]/g,
    /\[本轮工具调用摘要:\][\s\S]*?\[本轮工具调用摘要结束\]/g,
    /<(style|script|think|thinking)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,
];

function projectText(content) {
    let text = typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter(part => part?.type === 'text' && typeof part.text === 'string')
            .map(part => part.text).join('\n')
        : '';
    if (/^\s*<!--\s*VCP_TOOL_PAYLOAD\s*-->/.test(text)
        || /^\s*\[(?:系统提示|系统邀请指令)[:：]?\]/.test(text)) return '';

    // Avoid exponential growth when a previously delivered quote is forwarded.
    text = text.replace(/^\[VCP_TOPIC_RIVER_(V[12])\]\r?\n[\s\S]*?^\[\/VCP_TOPIC_RIVER_\1\][ \t]*$/gm, '');
    for (const block of INTERNAL_BLOCKS) text = text.replace(block, '');
    return text.replace(/data:[^,\s"'<>]*;base64,[A-Za-z0-9+/_=-]*/gi, '').trim();
}

function projectRiverRow(message) {
    const role = message?.role;
    if (role !== 'user' && role !== 'assistant') return null;
    const content = projectText(message.content);
    if (!content) return null;
    const name = typeof message.name === 'string' ? message.name.replace(/\s+/gu, ' ').trim() : '';
    return name ? { role, name, content } : { role, content };
}

function formatTopicRiverQuote(messages) {
    if (!Array.isArray(messages)) return '';
    const rows = [];
    for (const message of messages) {
        const row = projectRiverRow(message);
        if (!row) continue;
        // Keep rows single-line and prevent HTML/protocol tags from being interpreted
        // when this text travels through an older renderer or an upstream processor.
        rows.push(JSON.stringify(row)
            .replace(/[<>&\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`));
    }
    return rows.length ? [HEADER, ...rows, FOOTER].join('\n') : '';
}

module.exports = { formatTopicRiverQuote, projectRiverRow, projectText };

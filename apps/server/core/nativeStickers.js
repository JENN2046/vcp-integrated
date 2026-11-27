'use strict';

const fs = require('node:fs');
const path = require('node:path');

const unavailable = '表情包暂不可用';
const maxStickers = 24;
const maxSize = 8 * 1024 * 1024;
const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const imageTag = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const sourceAttribute = /(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

function displayText(value) {
    // Image-server URL credentials never belong in the phone projection.
    return value.replace(/\/pw=[^/\s"'<>]*/gi, '/pw=[已隐藏]');
}

function pieces(content, preview = false) {
    const parts = [];
    let start = 0;
    let index = 0;
    function tailText(raw) {
        // A streamed IMG can be split across chunks. Hide the partial tag until
        // the original message has a stable reference to its native asset.
        return displayText(raw.replace(/<img\b[^]*$/i, '').replace(preview ? /<(?:i(?:m)?)?$/i : /$^/, ''));
    }
    for (const match of content.matchAll(imageTag)) {
        if (match.index > start) parts.push({ text: displayText(content.slice(start, match.index)) });
        parts.push({ index: index++, src: sourceAttribute.exec(match[0])?.slice(1).find(x => x !== undefined) });
        start = match.index + match[0].length;
    }
    if (start < content.length) {
        const rest = content.slice(start);
        const text = tailText(rest);
        if (text) parts.push({ text });
        if (!preview && /<img\b/i.test(rest)) parts.push({ index: index++ });
    }
    return parts;
}

function originForNativeImages(env) {
    try {
        const url = new URL(env.VarHttpUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
        if (!url.port && /^\d{1,5}$/.test(env.Port || env.PORT || '')) url.port = env.Port || env.PORT;
        return url.origin;
    } catch {
        return null;
    }
}

function cleanSegment(part) {
    try {
        const decoded = decodeURIComponent(part);
        if (!decoded || decoded === '.' || decoded === '..' || /[\/\\\0]/.test(decoded)) return null;
        return decoded;
    } catch {
        return null;
    }
}

function nativePath(src, { origin, imageKey } = {}) {
    if (!src || !origin || !imageKey) return null;
    try {
        const url = new URL(src);
        if (url.origin !== origin || url.username || url.password || url.search || url.hash) return null;
        const matched = /^\/pw=([^/]+)\/images\/([^/]+)\/([^/]+)$/.exec(url.pathname);
        if (!matched || decodeURIComponent(matched[1]) !== imageKey) return null;
        const category = cleanSegment(matched[2]);
        const file = cleanSegment(matched[3]);
        const type = file && types[path.extname(file).slice(1).toLowerCase()];
        return category?.endsWith('表情包') && file && type ? { category, file, type } : null;
    } catch {
        return null;
    }
}

function matchesImage(type, bytes) {
    if (type === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    if (type === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (type === 'image/gif') return ['GIF87a','GIF89a'].includes(bytes.subarray(0, 6).toString());
    return bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
}

function sourceOptions(source) {
    try {
        return { origin: source?.origin, imageKey: source?.imageKey?.() };
    } catch {
        return {};
    }
}

function projectMessage(message, source) {
    if (typeof message.content !== 'string' || !/<img\b|\/pw=/i.test(message.content)) return message;
    const options = sourceOptions(source);
    const segments = pieces(message.content).map(part => part.text !== undefined ? part
        : { sticker: part.index < maxStickers && nativePath(part.src, options) ? part.index : null });
    const content = segments.map(part => part.text ?? unavailable).join('');
    return { ...message, content, ...(segments.some(part => part.sticker !== undefined) && { nativeStickerParts: segments }) };
}

function projectPreview(text) {
    if (typeof text !== 'string' || text.length >= 256 * 1024) return '';
    return pieces(text, true).map(part => part.text ?? '').join('');
}

function readSticker(content, index, source) {
    if (!source?.root || !Number.isInteger(index) || index < 0 || index >= maxStickers || typeof content !== 'string') return null;
    const part = pieces(content).find(x => x.index === index);
    const image = nativePath(part?.src, sourceOptions(source));
    if (!image) return null;
    let fd;
    try {
        const root = fs.realpathSync(source.root);
        const category = path.join(root, image.category);
        const file = path.join(category, image.file);
        if (fs.realpathSync(category) !== category) return null;
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size < 8 || stat.size > maxSize) return null;
        const bytes = Buffer.alloc(stat.size);
        if (fs.readSync(fd, bytes, 0, bytes.length, null) !== bytes.length || !matchesImage(image.type, bytes)) return null;
        return { type: image.type, bytes };
    } catch {
        return null;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

module.exports = { originForNativeImages, projectMessage, projectPreview, readSticker };

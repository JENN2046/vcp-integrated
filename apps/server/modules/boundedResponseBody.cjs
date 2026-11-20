'use strict';

const abortError = () => Object.assign(new Error('RESPONSE_READ_CANCELLED'), { name: 'AbortError', code: 'RESPONSE_READ_CANCELLED' });
function dispose(body, error) {
    if (typeof body?.destroy === 'function') body.destroy(error);
    else if (typeof body?.cancel === 'function') void Promise.resolve(body.cancel(error)).catch(() => {});
}

async function readBoundedBody(response, { maxBytes = 32 * 1024 * 1024, timeoutMs = 900000, signal } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('INVALID_RESPONSE_READ_BUDGET');
    signal?.throwIfAborted();
    let timer, cancel;
    const read = async () => {
        const chunks = []; let size = 0;
        if (response.body?.[Symbol.asyncIterator]) {
            for await (const value of response.body) {
                signal?.throwIfAborted();
                const chunk = Buffer.from(value); size += chunk.length;
                if (size > maxBytes) throw Object.assign(new Error('RESPONSE_BODY_TOO_LARGE'), { code: 'RESPONSE_BODY_TOO_LARGE' });
                chunks.push(chunk);
            }
        } else {
            const chunk = typeof response.arrayBuffer === 'function' ? Buffer.from(await response.arrayBuffer()) : Buffer.from(await response.text());
            if (chunk.length > maxBytes) throw Object.assign(new Error('RESPONSE_BODY_TOO_LARGE'), { code: 'RESPONSE_BODY_TOO_LARGE' });
            chunks.push(chunk);
        }
        signal?.throwIfAborted();
        return Buffer.concat(chunks);
    };
    const stopped = new Promise((_, reject) => {
        cancel = () => reject(abortError());
        signal?.addEventListener('abort', cancel, { once: true });
        timer = setTimeout(() => reject(Object.assign(new Error('RESPONSE_BODY_TIMEOUT'), { code: 'RESPONSE_BODY_TIMEOUT' })), timeoutMs);
        if (signal?.aborted) cancel();
    });
    try { return await Promise.race([read(), stopped]); }
    catch (error) { dispose(response.body, error); throw error; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

function failurePayload({ code = 'VCP_UPSTREAM_ERROR', status, model = 'unknown', message = '上游响应未能正常完成，已保留收到的内容。' } = {}) {
    return {
        id: `chatcmpl-vcp-error-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
        error: { type: 'upstream_error', code, ...(Number.isInteger(status) && status >= 400 && status <= 599 ? { status } : {}), message },
        choices: [{ index: 0, delta: { content: message }, finish_reason: 'stop' }],
    };
}

module.exports = { readBoundedBody, failurePayload };

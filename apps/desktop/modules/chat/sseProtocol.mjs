const failure = (code, status) => Object.assign(new Error(Number.isInteger(status) && status >= 400 && status <= 599
    ? `上游API请求失败（HTTP ${status}）` : code === 'VCP_UPSTREAM_ERROR' ? '上游API返回错误，本次回复未完成。' : '回复连接中断或数据不完整，已保留收到的内容。'), { code, ...(status ? { status } : {}) });

/** Shared transport semantics for desktop IPC, group calls and compaction. */
export function createSseDecoder({ onData = () => {}, onDone = () => {} } = {}) {
    const decoder = new TextDecoder('utf-8',{fatal:true});
    let buffer = '', ended = false, terminal = false, payload = false, broken = null, finishReason = null;
    const frame = text => {
        const data = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim();
        if (!data || ended) return;
        if (data === '[DONE]') {
            if (!payload) throw failure('MODEL_RESPONSE_EMPTY');
            ended = true; onDone({ finishReason }); return;
        }
        let value;
        try { value = JSON.parse(data); } catch { throw failure('STREAM_MALFORMED'); }
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('STREAM_MALFORMED');
        if(value.error?.code==='WORK_STEERING_PENDING')throw Object.assign(new Error('补充已收到，正在按新指令调整。'),{code:'WORK_STEERING_PENDING'});
        if (value.error) throw failure(/^[A-Z][A-Z0-9_]{0,79}$/.test(value.error.code||'')?value.error.code:'VCP_UPSTREAM_ERROR', Number(value.error.status || value.error.code));
        if (!Array.isArray(value.choices)) throw failure('STREAM_MALFORMED');
        if(value.choices.some(v=>!v||typeof v!=='object'||Array.isArray(v)))throw failure('STREAM_MALFORMED');
        if(value.choices.length)payload=true;
        for (const choice of value.choices) if (typeof choice.finish_reason === 'string' && choice.finish_reason) { terminal = true; finishReason = choice.finish_reason; }
        onData(value);
    };
    const drain = () => {
        let separator;
        while (!ended && (separator = /\r?\n\r?\n/.exec(buffer))) {
            frame(buffer.slice(0, separator.index)); buffer = buffer.slice(separator.index + separator[0].length);
        }
    };
    return Object.freeze({
        push(bytes) {
            if (broken) throw broken;
            if (ended) return;
            try { buffer += typeof bytes === 'string' ? bytes : decoder.decode(bytes, { stream: true }); drain(); }
            catch (error) { broken = error.code&&!error.code.startsWith('ERR_ENCODING_')?error:failure('STREAM_MALFORMED'); throw broken; }
        },
        finish() {
            if (broken) throw broken;
            if (ended) return;
            try {
                buffer += decoder.decode(); drain();
                if (!ended && buffer.trim()) frame(buffer);
                if (ended) return;
                if (!payload || !terminal) throw failure('STREAM_INCOMPLETE');
                ended = true; onDone({ finishReason });
            } catch (error) { broken = error.code&&!error.code.startsWith('ERR_ENCODING_')?error:failure('STREAM_MALFORMED'); throw broken; }
        },
        get done() { return ended; },
    });
}

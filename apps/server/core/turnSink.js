'use strict';

class CoreTurnSink {
    constructor({ signal, observe, present, commit }) {
        this.signal = signal;
        this.observe = observe;
        this.commit = commit;
        this.present = present;
    }

    isClosed() { return this.signal.aborted; }
    hasEnded() { return this.signal.aborted; }
    isDestroyed() { return false; }
    disableReplay() {}
    onProtocolFrame() {}
    endStream() {}
    onNonStreamResponse() {}

    onDelta({ textDelta, reasoningDelta, displayDelta }) {
        if (typeof displayDelta === 'string' && displayDelta && !this.signal.aborted) {
            this.observe('delta', { text: displayDelta, textDelta, reasoningDelta, displayDelta });
        }
    }

    onToolBatchDisplay(content) {
        if (!this.signal.aborted) this.observe('tool_display', { content });
    }

    createPresentationSink({ type, validate }) {
        let emitted = false;
        return async presentation => {
            this.signal.throwIfAborted();
            if (emitted) throw new Error('TURN_PRESENTATION_ALREADY_EMITTED');
            this.present(type, validate(presentation));
            emitted = true;
            return true;
        };
    }

    async beginUpstream(response) {
        if (response.ok) return true;
        this.onUpstreamError({ status: response.status, phase: 'initial' });
        await response.text();
        return false;
    }

    onUpstreamError({ status, phase }) {
        this.errorCode = 'UPSTREAM_ERROR';
        this.observe('upstream_error', { status, phase });
    }

    onExecutionError(error) { this.errorCode = error.code || 'TURN_FAILED'; }
    onModelFinal(outcome) {
        this.signal.throwIfAborted();
        this.committed = this.commit(outcome.content) !== false;
    }

    beginInteraction({ oneRingModule, oneRingMeta, messages, tavernInteraction }) {
        let settled = false;
        const run = (label, action) => {
            Promise.resolve().then(action).catch(error => console.error(`[${label}] Core interaction settlement failed`, error));
        };
        const settle = (completed, aiText) => {
            if (settled) return;
            settled = true;
            if (oneRingModule) {
                run('OneRing', () => {
                    if (!completed && typeof oneRingModule.markAIResponseAborted === 'function') {
                        return oneRingModule.markAIResponseAborted(oneRingMeta);
                    }
                    return oneRingMeta && typeof oneRingModule.recordAIResponseWithMeta === 'function'
                        ? oneRingModule.recordAIResponseWithMeta(oneRingMeta, aiText, { completed })
                        : oneRingModule.recordAIResponseFromMessages?.(messages, aiText, { completed });
                });
            }
            if (completed && typeof tavernInteraction?.commit === 'function') run('VCPTavern', () => tavernInteraction.commit());
        };
        return {
            accept: outcome => settle(this.committed === true, this.committed ? outcome.aiText : ''),
            fail: () => settle(false, '')
        };
    }
}

module.exports = { CoreTurnSink };

import { normalizeStreamChunk } from './contentRuntime.js';

// Provider metadata is opaque JSON. Key order may differ between equal fragments.
function sameMetadata(left, right) {
    if (Object.is(left, right)) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object'
        || Array.isArray(left) !== Array.isArray(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length
        && keys.every(key => Object.hasOwn(right, key) && sameMetadata(left[key], right[key]));
}

/** One assembler per stream operation. This projects calls; it never executes them. */
export function createNativeToolCallStream() {
    const pending = new Map();
    const rejected = new Set();

    function flush() {
        const calls = [...pending]
            .filter(([index]) => !rejected.has(index))
            .sort(([a], [b]) => a - b)
            .map(([, call]) => call);
        pending.clear();
        const valid = calls.length > 0
            && new Set(calls.map(call => call.id)).size === calls.length
            && calls.every(call => call.id && call.type === 'function' && call.function.name
                && call.function.arguments);
        rejected.clear();
        return valid ? [{ vcpHostedToolCalls: calls }] : [];
    }

    function append(parts, complete) {
        if (!Array.isArray(parts)) return;
        for (const [position, part] of parts.entries()) {
            const index = part?.index ?? position;
            if (!part || !Number.isSafeInteger(index) || index < 0 || index >= 1024) {
                continue;
            }
            if (rejected.has(index)) continue;
            const call = pending.get(index) ?? { id: '', type: '', function: { name: '', arguments: '' } };
            // Array order is sufficient for full messages and legacy unsigned deltas.
            // Never associate a signed delta by its position within one partial frame.
            if (!complete && part.index == null &&
                (Object.hasOwn(part, 'extra_content') || Object.hasOwn(call, 'extra_content'))) continue;
            for (const key of ['id', 'type']) {
                if (part[key] === undefined) continue;
                if (typeof part[key] !== 'string' || (call[key] && call[key] !== part[key])) rejected.add(index);
                else call[key] = part[key];
            }
            if (Object.hasOwn(part, 'extra_content')) {
                if (!Object.hasOwn(call, 'extra_content')) call.extra_content = structuredClone(part.extra_content);
                else if (!sameMetadata(call.extra_content, part.extra_content)) rejected.add(index);
            }
            for (const key of ['name', 'arguments']) {
                if (part.function?.[key] === undefined) continue;
                if (typeof part.function[key] !== 'string') rejected.add(index);
                else if (complete) call.function[key] = part.function[key];
                else call.function[key] += part.function[key];
            }
            pending.set(index, call);
        }
    }

    return {
        push(chunk) {
            const choice = chunk?.choices?.find?.(choice => (choice?.index ?? 0) === 0);
            const text = choice && choice !== chunk.choices[0]
                ? normalizeStreamChunk({ choices: [choice] })
                : chunk?.choices?.length && !choice ? '' : normalizeStreamChunk(chunk);
            const calls = choice?.message?.tool_calls ?? choice?.delta?.tool_calls;
            const output = [];
            // A following text frame is a hard boundary even when the provider
            // omits an intermediate finish_reason in a multi-round response.
            if (text && !calls?.length) output.push(...flush());
            if (text) output.push(text);
            append(calls, Boolean(choice?.message));
            if (choice?.message?.tool_calls || choice?.finish_reason === 'tool_calls' || choice?.finish_reason === 'stop') {
                output.push(...flush());
            }
            return output;
        },
        flush,
    };
}
'use strict';

function stringContent(value) {
    return typeof value === 'string' ? value : '';
}

/** Read the first non-empty text field from a decoded, client-facing frame. */
function groupStreamDelta(frame) {
    return (Array.isArray(frame.choices) && stringContent(frame.choices[0]?.delta?.content))
        || stringContent(frame.delta?.content)
        || stringContent(frame.content)
        || stringContent(frame.message?.content);
}

module.exports = { groupStreamDelta };

'use strict';

// The History/roster supplies the speaker. Text can already carry its own prefix.
function withGroupSpeaker(text, speaker) {
    const tag = `[${speaker}的发言]`;
    return text.startsWith(tag) ? text : `${tag}: ${text}`;
}

module.exports = { withGroupSpeaker };

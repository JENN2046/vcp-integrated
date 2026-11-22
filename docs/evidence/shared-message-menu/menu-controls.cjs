'use strict';

module.exports = function menuControls({ id, waitUntil, click }) {
    const evalIn = (client, source) => client.command('eval', source);
    const selector = '#chatMessages .message-item[data-message-id="' + id + '"]';
    const visible = (client, expected) => waitUntil(() => evalIn(client, `(() => {
        const matches = [...document.querySelectorAll(${JSON.stringify(selector)})];
        if (${expected === null}) return matches.length === 0;
        return matches.length === 1 && matches[0].checkVisibility() && matches[0].innerText.includes(${JSON.stringify(expected)});
    })()`), 'visible expected reply ' + expected, 12000);
    const rightClick = async client => {
        const point = await waitUntil(() => evalIn(client, `(() => {
            const item = document.querySelector(${JSON.stringify(selector)});
            if (!item || !item.checkVisibility()) return false;
            item.scrollIntoView({block:"center",behavior:"instant"});
            const rect = item.getBoundingClientRect();
            const x = Math.round(rect.left + rect.width/2);
            const y = Math.round(rect.top + rect.height/2);
            return item.contains(document.elementFromPoint(x,y)) && {x,y};
        })()`), 'reply hit target', 5000);
        await client.command('mouse-right', point);
    };
    async function edit(client, edited) {
        await click(client, '#chatContextMenu .context-menu-item', '编辑消息');
        await evalIn(client, `(() => {
            const input = document.querySelector('.message-edit-textarea');
            input.value = ${JSON.stringify(edited)};
            input.dispatchEvent(new Event('input', {bubbles:true}));
            return true;
        })()`);
        await click(client, '.message-edit-controls button', '保存');
    }
    return { visible, rightClick, edit };
};

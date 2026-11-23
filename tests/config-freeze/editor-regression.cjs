'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const { createRequire } = require('node:module');
const path = require('node:path');
const { sharedConfig } = require('../../apps/server/Plugin/NativeSync/sync/contracts.generated.cjs');

const root = path.resolve(__dirname, '../..');
const editorPath = 'apps/desktop/modules/nativeSyncSettings/sharedEditor.js';
const baselineRevision = 'f67c546c8a425ef2b31c198b329a3461c5111e7a';
const baseline = execFileSync('git', ['show', baselineRevision + ':' + editorPath], { cwd: root });
const candidate = fs.readFileSync(path.join(root, editorPath));
const contracts = fs.readFileSync(path.join(root, 'apps/mobile/src/contracts.generated.js'));
const puppet = createRequire(path.join(root, 'apps/server/package.json'))('puppeteer');
const sparse = { name: 'Synthetic sparse Agent', model: 'synthetic', systemPrompt: 'SYNTHETIC_OLD_PROMPT' };
const promptChange = { ...sparse, systemPrompt: 'SYNTHETIC_NEW_PROMPT' };
const digest = value => createHash('sha256').update(value).digest('hex');
const space = 'synthetic-shared';

function fixture(editor) {
    const submissions = [];
    const hash = config => digest(JSON.stringify(config));
    let owner = {
        id: 'synthetic-sparse-agent', kind: 'agent', sharedSpaceId: space,
        version: 1, configHash: hash(sparse), config: sharedConfig('agent', sparse),
    };
    const globalRules = {
        id: 'synthetic-rules', kind: 'rules', sharedSpaceId: space,
        config: sharedConfig('rules', { name: 'Synthetic global rules', tavernRules: [{
            id: 'synthetic-global', name: 'Synthetic global', type: 'system_suffix',
            content: 'Synthetic global suffix', source: 'user',
        }] }),
    };
    const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
        <style>label{display:block} input,textarea,button,select{margin:4px}</style>
        <main id="editor"></main>
        <script type="module">
            import {mountSharedEditor} from '/editor.js';
            import {sharedConfig} from '/contracts.js';
            const api = async (route, body) => {
                const response = await fetch('/' + route, body && {
                    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
                });
                if (!response.ok) throw Error('Fixture config request failed');
                return response.json();
            };
            mountSharedEditor(document.querySelector('#editor'), {
                api, normalize:sharedConfig,
                topic:{sharedSpaceId:${JSON.stringify(space)},sharedOwnerId:${JSON.stringify(owner.id)}},
                context:{entryId:'synthetic-entry',sessionMarker:'synthetic-session'},
            });
        </script></html>`;
    const json = (res, value) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    const server = http.createServer(async (req, res) => {
        const route = new URL(req.url, 'http://127.0.0.1').pathname;
        if (route === '/') return res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }).end(html);
        if (route === '/editor.js' || route === '/contracts.js') {
            return res.writeHead(200, { 'Content-Type': 'application/javascript' })
                .end(route === '/editor.js' ? editor : contracts);
        }
        if (route === '/shared/directory') return json(res, { objects: [owner, globalRules], hasMore: false });
        if (route !== '/shared/config') return res.writeHead(404).end();
        if (req.method === 'GET') return json(res, { object: owner });
        try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks));
            assert.equal(body.sharedSpaceId, space);
            assert.equal(body.sharedId, owner.id);
            assert.equal(body.expectedVersion, owner.version);
            const config = sharedConfig('agent', body.config);
            submissions.push(config);
            owner = { ...owner, config, version: owner.version + 1, configHash: hash(config) };
            return json(res, { object: owner, replayed: false });
        } catch {
            return res.writeHead(400).end();
        }
    });
    return { server, submissions };
}

async function fill(page, selector, value) {
    await page.focus(selector);
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.type(value);
    assert.equal(await page.$eval(selector, node => node.value), value);
}

async function openSection(page, summary) {
    const section = await page.waitForSelector('details > summary::-p-text(' + summary + ')');
    const opened = await section.evaluate(node => node.parentElement.open);
    if (!opened) await section.click();
    assert.equal(await section.evaluate(node => node.parentElement.open), true);
}

async function save(page, submissions, expectedCount) {
    await page.click('#shared-config-save');
    await page.waitForFunction(() => document.querySelector('#editor [role=status]')?.textContent.includes('共享配置已保存'));
    assert.equal(submissions.length, expectedCount);
    return submissions.at(-1);
}

async function verifyRules(page, submissions) {
    await openSection(page, '生效规则');
    await page.click('button::-p-text(添加规则)');
    await openSection(page, '生效规则');
    await fill(page, 'details .rule textarea', 'Synthetic suffix');
    await openSection(page, '原生正则规则');
    await page.click('#shared-config-add-regex');
    await openSection(page, '原生正则规则');
    const regex = 'details:has(#shared-config-add-regex) .rule > label';
    await fill(page, regex + ':nth-child(1) input', 'Synthetic regex');
    await fill(page, regex + ':nth-child(2) input', 'TEST_TARGET');
    await fill(page, regex + ':nth-child(3) input', 'TEST_REPLACEMENT');
    await openSection(page, '此会话的全局规则覆盖');
    await page.select('#editor details > label > select', 'false');
    const added = await save(page, submissions, 2);
    assert.equal(added.tavernRules.length, 1);
    assert.equal(added.tavernRules[0].content, 'Synthetic suffix');
    assert.equal(added.stripRegexes.length, 1);
    assert.equal(added.stripRegexes[0].title, 'Synthetic regex');
    assert.equal(added.stripRegexes[0].findPattern, 'TEST_TARGET');
    assert.equal(added.stripRegexes[0].replaceWith, 'TEST_REPLACEMENT');
    assert.deepEqual(added.ruleOverrides, { 'user:synthetic-global': false });

    await openSection(page, '生效规则');
    await fill(page, 'details .rule textarea', 'Synthetic edited suffix');
    await openSection(page, '原生正则规则');
    await fill(page, regex + ':nth-child(3) input', 'TEST_EDIT');
    await openSection(page, '此会话的全局规则覆盖');
    await page.select('#editor details > label > select', 'true');
    const edited = await save(page, submissions, 3);
    assert.deepEqual(edited, {
        ...added,
        tavernRules: [{ ...added.tavernRules[0], content: 'Synthetic edited suffix' }],
        stripRegexes: [{ ...added.stripRegexes[0], replaceWith: 'TEST_EDIT' }],
        ruleOverrides: { 'user:synthetic-global': true },
    });
    return { explicitRulesSaved: true, existingRuleIdentitiesPreserved: true, saves: submissions.length };
}

async function run(browser, editor, checkRules) {
    const { server, submissions } = fixture(editor);
    const page = await browser.newPage();
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.waitForSelector('#shared-config-prompt:not([disabled])');
        await fill(page, '#shared-config-prompt', promptChange.systemPrompt);
        const config = await save(page, submissions, 1);
        const addedCollectionDefaults = Object.keys(config).filter(key => !Object.hasOwn(sparse, key)).sort();
        if (checkRules) {
            assert.deepEqual(config, promptChange);
        } else {
            assert.deepEqual(config, { ...promptChange, stripRegexes: [], tavernRules: [], ruleOverrides: {} });
        }
        const rules = checkRules ? await verifyRules(page, submissions) : undefined;
        assert.deepEqual(errors, []);
        return { editorSha256: digest(editor), promptSave: { saves: 1, addedCollectionDefaults }, ...(rules && { rules }) };
    } finally {
        await page.close();
        await new Promise(resolve => server.close(resolve));
    }
}

(async () => {
    const browser = await puppet.launch({
        executablePath: process.env.CHROME_BIN || '/opt/google/chrome/chrome', headless: true,
        args: ['--disable-background-networking', '--no-first-run', '--no-proxy-server',
            '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
    });
    try {
        const oldEditor = await run(browser, baseline, false);
        const fixedEditor = await run(browser, candidate, true);
        console.log(JSON.stringify({
            browser: await browser.version(), baselineRevision, before: oldEditor, after: fixedEditor,
        }, null, 2));
    } finally {
        await browser.close();
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

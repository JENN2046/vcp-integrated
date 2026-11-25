'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const WebSocket = require('../../../apps/server/node_modules/ws');

const packageName = 'dev.nativesync.qa.send';
const activity = packageName + '/.TestWindow';
const pickerPackages = ['com.google.android.documentsui', 'com.android.documentsui'];
const [port, action, ...args] = process.argv.slice(2);
assert.match(port ?? '', /^\d{4,5}$/);
const origin = 'https://127.0.0.1:' + port;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const adb = (...command) => execFileSync('adb', command, { timeout: 15000 });
const adbText = (...command) => adb(...command).toString().trim();

async function waitFor(check, description) {
  for (let attempt = 0; attempt < 75; attempt++) {
    const result = await check();
    if (result) return result;
    await sleep(200);
  }
  throw Error(description);
}

function focusedWindow() {
  const dump = adbText('shell', 'dumpsys', 'window');
  return dump.split('\n').find((row) => row.includes('mCurrentFocus=')) ?? '';
}

function isForeground() {
  return focusedWindow().includes(packageName);
}

function isSystemPicker() {
  const focus = focusedWindow();
  return pickerPackages.some((name) => focus.includes(' ' + name + '/')) && focus.includes('PickActivity');
}

function assertForeground() {
  assert(isForeground(), 'The temporary Android activity must be in the foreground');
}

async function withPage(job) {
  const pid = await waitFor(() => adbText('shell', 'pidof', packageName), 'Temporary WebView process unavailable');
  assert.match(pid, /^\d+$/);
  const forward = adbText('forward', 'tcp:0', 'localabstract:webview_devtools_remote_' + pid);
  const cdpOrigin = 'http://127.0.0.1:' + forward;
  let ws;
  try {
    const target = await waitFor(async () => {
      try {
        const rows = await (await fetch(cdpOrigin + '/json/list')).json();
        return rows.find((entry) => entry.type === 'page' && new URL(entry.url).origin === origin);
      } catch {
        return undefined;
      }
    }, 'No fixture page appeared in the isolated Android WebView');
    const socketUrl = new URL(target.webSocketDebuggerUrl);
    socketUrl.hostname = '127.0.0.1';
    socketUrl.port = forward;
    ws = new WebSocket(socketUrl);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const pending = new Map();
    let sequence = 0;
    ws.on('message', (data) => {
      const message = JSON.parse(data);
      const handler = pending.get(message.id);
      if (handler) handler(message);
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(Error('CDP timed out on ' + method));
      }, 10000);
      pending.set(id, (message) => {
        clearTimeout(timeout);
        pending.delete(id);
        if (message.error) reject(Error('CDP failed on ' + method));
        else resolve(message.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (fn, ...values) => {
      const expression = '(' + fn + ')(...' + JSON.stringify(values) + ')';
      const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert(!result.exceptionDetails, 'Evaluation failed inside the isolated PWA');
      return result.result.value;
    };
    await waitFor(() => evaluate(() => isSecureContext && (
      document.querySelector('header strong')?.textContent === 'VCP Mobile' ||
      Boolean(document.querySelector('#agent-select'))
    )),
      'Secure fixture PWA failed to load');
    await job(evaluate, call);
  } finally {
    ws?.close();
    adb('forward', '--remove', 'tcp:' + forward);
  }
}

function snapshot() {
  const read = (selector) => document.querySelector(selector);
  const messages = [...document.querySelectorAll('#history [data-message-id]')].map((entry) => ({
    id: entry.dataset.messageId,
    role: entry.classList.contains('user') ? 'user' : 'assistant',
    text: entry.querySelector('.bubble')?.innerText,
    attachments: [...entry.querySelectorAll('.attachment')].map((attachment) => attachment.innerText),
  }));
  return {
    secure: isSecureContext,
    origin: location.origin,
    bundle: document.querySelector('script[type=module][src]')?.getAttribute('src') ?? null,
    paired: Boolean(read('#agent-select')),
    visible: document.visibilityState === 'visible',
    connection: read('.connection')?.textContent,
    selectedAgent: read('#agent-select')?.selectedOptions[0]?.textContent,
    selectedTopic: read('#topic-select')?.value,
    progress: read('.history-progress')?.textContent ?? null,
    text: read('#message-text')?.value ?? null,
    editable: read('#message-text')?.disabled === false,
    sendEnabled: read('#send')?.disabled === false,
    retryEnabled: read('#retry-last')?.disabled === false,
    files: [...document.querySelectorAll('.pending-file')].map((entry) => entry.querySelector('span')?.innerText),
    status: read('#send-state')?.textContent ?? null,
    attachmentPreview: read('dialog[open]')?.innerText ?? null,
    pending: read('#pending-submission')?.dataset.requestId ?? null,
    accepted: read('#accepted-submission')?.dataset.requestId ?? null,
    jobs: [...document.querySelectorAll('[data-exec-id]')].map((entry) => ({id: entry.dataset.execId, state: entry.dataset.state})),
    messages,
    liveReplies: [...document.querySelectorAll('[aria-label="正在生成的共享回复"] .bubble')].map(node => node.innerText),
  };
}

async function main() {
  if (action === 'start' || action === 'reopen') {
    assert.match(adbText('shell', 'pm', 'path', packageName), /^package:/);
    adb('shell', 'am', 'force-stop', packageName);
    assert.equal(adbText('shell', 'pidof', packageName + ' || true'), '', 'Old application process did not stop');
    adb('shell', 'am', 'start', '-W', '-n', activity);
    await waitFor(isForeground, 'The temporary Android activity did not reach the foreground');
    return;
  }
  assertForeground();
  await withPage(async (evaluate, call) => {
    async function click(selector) {
      const point = await evaluate((target) => {
        const button = document.querySelector(target);
        if (!button || button.disabled) return null;
        button.scrollIntoView({ block: 'nearest' });
        const rect = button.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        return button.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
      }, selector);
      assert(point, 'Unavailable button ' + selector);
      await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    async function select(selector, name) {
      await waitFor(() => evaluate((target, label) => {
        const selectBox = document.querySelector(target);
        const option = [...(selectBox?.options ?? [])].find((entry) => entry.textContent.trim().startsWith(label));
        if (!option) return false;
        if (selectBox.value !== option.value) {
          selectBox.value = option.value;
          selectBox.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return true;
      }, selector, name), 'Fixture selection unavailable ' + selector);
    }

    if (action === 'pair' || action === 'pair-stop') {
      await call('Page.navigate', { url: origin + '/__hardware/pair' });
      await waitFor(() => evaluate(() => document.querySelector('#pair-code')?.value.length === 32),
        'One-time pairing form did not appear');
      await click('#pair-submit');
      if (action === 'pair-stop') {
        await evaluate(() => new Promise(resolve => {
          const check = () => {
            if (document.querySelector('.connection')?.textContent === '已连接') resolve(true);
            else requestAnimationFrame(check);
          };
          check();
        }));
        const observedAt = performance.now();
        adb('shell', 'am', 'force-stop', packageName);
        const stopMs = Math.round(performance.now() - observedAt);
        assert.equal(adbText('shell', 'pidof', packageName + ' || true'), '');
        console.log(JSON.stringify({ observed: 'first connected indicator', stopMs, processStopped: true }));
      } else {
        await waitFor(() => evaluate(() => Boolean(document.querySelector('#agent-select'))), 'Pairing did not connect');
      }
    } else if (action === 'select' || action === 'select-readonly') {
      assert.equal(args.length, 2);
      await select('#agent-select', args[0]);
      await select('#topic-select', args[1]);
      await waitFor(() => evaluate((readonly) => {
        const composer = document.querySelector('#message-text');
        return composer && (readonly || !composer.disabled) && !document.querySelector('.history-progress');
      }, action === 'select-readonly'), 'Selected conversation history did not load');
    } else if (action === 'open-picker') {
      await click('input[type=file]');
      await waitFor(isSystemPicker, 'The system DocumentsUI picker did not take focus');
      const hierarchy = adbText('exec-out', 'uiautomator', 'dump', '/proc/self/fd/1');
      assert(isSystemPicker(), 'The system picker lost focus');
      assert(hierarchy.includes('text="NativeSync synthetic fixtures"'), 'The synthetic DocumentsProvider directory did not open');
      assert(hierarchy.includes('text="fixture-note.txt"'), 'Expected the one synthetic text file in DocumentsUI');
      console.log(JSON.stringify({ picker: 'Android DocumentsUI', directory: 'NativeSync synthetic fixtures', file: 'fixture-note.txt' }));
    } else if (action === 'compose') {
      assert(args.length === 1 || args.length === 2);
      if (args[1]) {
        const fixture = fs.readFileSync(args[1]);
        assert(fixture.length > 0 && fixture.length < 1024, 'Expected a tiny synthetic attachment');
        assert(await evaluate((name, encoded) => {
          const picker = document.querySelector('input[type=file]');
          if (!picker || picker.disabled) return false;
          const contents = new DataTransfer();
          contents.items.add(new File([Uint8Array.from(atob(encoded), (byte) => byte.charCodeAt(0))], name, { type: 'text/plain' }));
          picker.files = contents.files;
          picker.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }, path.basename(args[1]), fixture.toString('base64')), 'Attachment picker unavailable');
      }
      assert(await evaluate((value) => {
        const composer = document.querySelector('#message-text');
        if (!composer || composer.disabled) return false;
        composer.value = value;
        composer.dispatchEvent(new InputEvent('input', { data: value, bubbles: true, inputType: 'insertText' }));
        return true;
      }, args[0]), 'Composer unavailable');
    } else if (action === 'send' || action === 'retry') {
      await click(action === 'send' ? '#send' : '#retry-last');
    } else if (action === 'preview') {
      await click('#history .attachment-open');
    } else if (action === 'wait') {
      const [value, field] = args;
      assert(value, 'Provide the expected evidence text');
      await waitFor(async () => {
        const current = await evaluate(snapshot);
        if (field === 'pending' || field === 'accepted') return current[field] === value;
        const observed = field ? current[field] : current;
        return observed != null && JSON.stringify(observed).includes(value);
      }, 'Expected evidence did not arrive: ' + value);
    } else if (action === 'capture' || action === 'state' || action === 'probe') {
      const current = await evaluate(snapshot);
      assert(current.secure && (action === 'probe' || current.paired) && current.origin === origin && current.visible);
      if (action === 'capture') {
        const destination = path.resolve(args[0]);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        assertForeground();
        const display = adbText('shell', 'dumpsys', 'window', 'displays');
        const top = display.match(/type=statusBars frame=\[0,0\]\[\d+,(\d+)\] visible=true/);
        const bottom = display.match(/type=navigationBars frame=\[0,(\d+)\]\[\d+,\d+\] visible=true/);
        assert(top && bottom, 'Expected visible Android status and navigation bars');
        const image = adb('exec-out', 'screencap', '-p');
        assertForeground();
        execFileSync('python3', ['-c', [
          'import io, sys',
          'from PIL import Image',
          'image = Image.open(io.BytesIO(sys.stdin.buffer.read()))',
          'width, height = image.size',
          'top, bottom = map(int, sys.argv[2:])',
          'assert 0 < top < bottom < height',
          'image.crop((0, top, width, bottom)).save(sys.argv[1])',
        ].join('\n'), destination + '.png', top[1], bottom[1]], { input: image, timeout: 10000 });
        fs.writeFileSync(destination + '.json', JSON.stringify(current, null, 2) + '\n');
      }
      console.log(JSON.stringify(current));
    } else {
      throw Error('Unknown action');
    }
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

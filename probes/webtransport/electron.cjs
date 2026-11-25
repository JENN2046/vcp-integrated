'use strict';

const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
const { X509Certificate, createHash } = require('node:crypto');
const { app, BrowserWindow } = require('electron');

const [port, certFile] = process.argv.slice(-2);
const cert = new X509Certificate(readFileSync(certFile));
const fingerprint = [...createHash('sha256').update(cert.raw).digest()];
const bootstrap = createServer((_req, res) => res.end('<!doctype html><title>WebTransport probe</title>'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  await new Promise(resolve => bootstrap.listen(0, '127.0.0.1', resolve));
  const window = new BrowserWindow({ show: false });
  await window.loadURL('http://127.0.0.1:' + bootstrap.address().port);
  const result = await window.webContents.executeJavaScript(`(async () => {
    const url = 'https://127.0.0.1:${Number(port)}/observe';
    const options = { serverCertificateHashes: [{ algorithm: 'sha-256', value: new Uint8Array(${JSON.stringify(fingerprint)}) }] };
    const replies = [];
    for (const cursor of [0, 1]) {
      const transport = new WebTransport(url, options);
      await transport.ready;
      const stream = await transport.createBidirectionalStream();
      const writer = stream.writable.getWriter();
      await writer.write(new TextEncoder().encode(JSON.stringify({ cursor })));
      const reader = stream.readable.getReader();
      let text = '';
      while (!text.endsWith('}')) {
        const { value, done } = await reader.read();
        if (done) throw new Error('Stream closed early');
        text += new TextDecoder().decode(value);
      }
      if (JSON.parse(text).cursor !== cursor) throw new Error('Round trip mismatch');
      replies.push(cursor);
      transport.close();
      await transport.closed;
    }
    return replies;
  })()`);
  console.log(JSON.stringify({ electron: process.versions.electron, replies: result }));
}).then(() => app.exit(0), error => {
  console.error(error);
  app.exit(1);
});
setTimeout(() => app.exit(2), 15000).unref();

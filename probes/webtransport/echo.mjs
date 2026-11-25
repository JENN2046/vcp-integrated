import { readFileSync } from 'node:fs';

const [candidate, certFile, keyFile] = process.argv.slice(2);
const endpoint = '/observe';
if (candidate === 'quiche') {
  const { Http3Server } = await import('@fails-components/webtransport');
  const server = new Http3Server({
    host: '127.0.0.1', port: 0, secret: 'isolated-probe',
    cert: readFileSync(certFile), privKey: readFileSync(keyFile)
  });
  const sessions = server.sessionStream(endpoint);
  server.startServer();
  await server.ready;
  console.log('PORT', server.address().port);
  for await (const session of sessions) {
    void (async () => {
      for await (const stream of session.incomingBidirectionalStreams) {
        await stream.readable.pipeTo(stream.writable);
      }
    })().catch(console.error);
  }
} else if (candidate === 'http3') {
  const { HTTP3Server } = await import('@http3-server/server');
  const server = new HTTP3Server().handle({
    error: console.error,
    session(session) { return session.path === endpoint; },
    webTransportData(stream, data) { stream.send(data); }
  });
  await server.start({
    address: '127.0.0.1', port: 0, certificateFile: certFile, privateKeyFile: keyFile
  });
  console.log('PORT', server.port);
  await new Promise(resolve => process.once('SIGTERM', resolve));
  await server.stop();
} else {
  throw new Error('Expected quiche or http3');
}

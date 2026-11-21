'use strict';

const assert = require('node:assert/strict');
const {readFile} = require('node:fs/promises');
const {createServer} = require('node:http');
const path = require('node:path');
const test = require('node:test');
const puppeteer = require('../../apps/server/node_modules/puppeteer');

test('PWA commits proof before pairing and recovers only the enrolled device on cold session checks', {timeout:30000}, async t => {
    const script = await readFile(path.join(__dirname,'../../apps/mobile/src/pairRecovery.js'));
    const server = createServer((request,response) => {
        if (request.url === '/pairRecovery.js') {
            response.setHeader('Content-Type','text/javascript');
            response.end(script);
        } else {
            response.setHeader('Content-Type','text/html');
            response.end('<!doctype html><title>Device pairing fixture</title>');
        }
    });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    t.after(() => new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
    }));
    const firefox = process.env.FIREFOX_BIN;
    const browser = await puppeteer.launch({
        executablePath: firefox || process.env.CHROME_BIN || '/opt/google/chrome/chrome',
        browser: firefox ? 'firefox' : 'chrome',
        headless: true,
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const origin = 'http://127.0.0.1:' + server.address().port;
    await page.goto(origin);
    const enrolled = await page.evaluate(async () => {
        const {createPairRecovery} = await import('/pairRecovery.js');
        const pairing = createPairRecovery({origin:location.origin,indexedDB,crypto,locks:navigator.locks,secureContext:isSecureContext});
        let savedKey;
        await pairing.withSessionLock(() => pairing.pair(async (route,body) => {
            const stored = await new Promise((resolve,reject) => {
                const request = indexedDB.open('vcp-mobile-pair-recovery',1);
                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const db = request.result;
                    const transaction = db.transaction('credentials','readonly');
                    const get = transaction.objectStore('credentials').get('paired-device');
                    transaction.oncomplete = () => {db.close();resolve(get.result);};
                    transaction.onabort = () => {db.close();reject(transaction.error);};
                };
            });
            if (stored.credential.publicKey !== body.recoveryPublicKey || stored.credential.privateKey.extractable) {
                throw Error('Committed nonextractable credential was not available before pairing');
            }
            if (JSON.stringify(stored).includes('synthetic-pair-code')) throw Error('Pair code was persisted');
            savedKey = body.recoveryPublicKey;
            return {authenticated:true,recoveryEnrolled:true};
        },'synthetic-pair-code'));
        return savedKey;
    });
    assert.equal(Buffer.from(enrolled,'base64url').length,65);
    await page.reload();
    const result = await page.evaluate(async enrolled => {
        const {createPairRecovery} = await import('/pairRecovery.js');
        const pairing = createPairRecovery({origin:location.origin,indexedDB,crypto,locks:navigator.locks,secureContext:isSecureContext});
        const pairRequired = () => Object.assign(Error('Pair required'),{status:401,code:'PAIR_REQUIRED'});
        const denied = code => Object.assign(Error(code),{status:401,code});
        const challenge = 'A'.repeat(43);
        const requests = [];
        let authenticated = false;
        let signatureVerified = false;
        const api = async (route,body) => {
            requests.push(route);
            if (route==='session') {
                if (!authenticated) throw pairRequired();
                return {authenticated:true};
            }
            if (body.recoveryPublicKey!==enrolled) throw pairRequired();
            if (route==='pair/challenge') return {challenge};
            const decode = value => Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
            const publicKey = await crypto.subtle.importKey('raw',decode(enrolled),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
            const payload = new TextEncoder().encode(JSON.stringify(['vcp-mobile-pair-recovery-v1',location.origin,challenge]));
            signatureVerified = body.challenge===challenge && await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},publicKey,decode(body.signature),payload);
            authenticated = signatureVerified;
            return {authenticated};
        };
        async function codeOf(operation) {
            try { await operation(); return null; } catch (error) { return error.code || error.message; }
        }

        const [restored,concurrentTab] = await Promise.all([pairing.openSession(api),pairing.openSession(api)]);
        const firstRequests = requests.splice(0);
        await pairing.openSession(api);
        const alreadyActiveRequests = requests.splice(0);
        authenticated = false;
        const temporaryFailure = await codeOf(() => pairing.openSession(async route => {
            if (route==='session') throw pairRequired();
            throw Error('Synthetic network unavailable');
        }));
        const concurrentCookie = await pairing.openSession(async route => {
            if (route==='session') return api(route);
            authenticated = true;
            throw Object.assign(Error('Different tab already authenticated'),{status:409,code:'MOBILE_SESSION_ALREADY_AUTHENTICATED'});
        });
        const concurrentCookieRequests = requests.splice(0);
        const rejectedPair = await codeOf(() => pairing.withSessionLock(() => pairing.pair(async () => {throw denied('INVALID_PAIRING');},'synthetic-invalid-code')));
        const rejectedDisconnect = await codeOf(() => pairing.withSessionLock(() => pairing.changeSession(async () => {throw pairRequired();})));
        authenticated = false;
        const restoredAfterRejections = await pairing.openSession(api);
        const rejectionRequests = requests.splice(0);
        authenticated = false;
        await codeOf(() => pairing.withSessionLock(() => pairing.pair(async () => {throw Error('Lost response');},'synthetic-ambiguous-code')));
        const ambiguousPair = await codeOf(() => pairing.openSession(api));
        const ambiguousRequests = requests.splice(0);
        await pairing.withSessionLock(() => pairing.changeSession(async () => ({disconnected:true})));
        const afterDisconnect = await codeOf(() => pairing.openSession(api));
        return {restored,concurrentTab,firstRequests,alreadyActiveRequests,temporaryFailure,concurrentCookie,concurrentCookieRequests,rejectedPair,rejectedDisconnect,restoredAfterRejections,rejectionRequests,ambiguousPair,ambiguousRequests,afterDisconnect,afterDisconnectRequests:requests,signatureVerified};
    },enrolled);
    const recovery = ['session','pair/challenge','pair/recover','session'];
    assert.deepEqual(result, {
        restored:{authenticated:true},concurrentTab:{authenticated:true},firstRequests:[...recovery,'session'],alreadyActiveRequests:['session'],
        temporaryFailure:'Synthetic network unavailable',concurrentCookie:{authenticated:true},concurrentCookieRequests:['session','session'],
        rejectedPair:'INVALID_PAIRING',rejectedDisconnect:'PAIR_REQUIRED',
        restoredAfterRejections:{authenticated:true},rejectionRequests:recovery,
        ambiguousPair:'PAIR_REQUIRED',ambiguousRequests:['session','pair/challenge'],
        afterDisconnect:'PAIR_REQUIRED',afterDisconnectRequests:['session'],signatureVerified:true,
    });
});

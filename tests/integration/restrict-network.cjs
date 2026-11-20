'use strict';
const net = require('node:net');
const dns = require('node:dns');

function isLoopback(host) {
    return ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(host);
}

function restrictNodeNetwork() {
    const connect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (...args) {
        const first = Array.isArray(args[0]) ? args[0][0] : args[0];
        const host = typeof first === 'object' ? first.host : args[1];
        if (!isLoopback(host)) throw Error('Integration fixture requires a loopback TCP destination');
        return connect.apply(this, args);
    };

    const lookup = dns.lookup;
    dns.lookup = function (host, ...args) {
        if (!isLoopback(host)) throw Error('Integration fixture requires a loopback DNS destination');
        return lookup.call(this, host, ...args);
    };
}

module.exports = { isLoopback, restrictNodeNetwork };

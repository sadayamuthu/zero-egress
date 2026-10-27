/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import type * as httpType from 'http';
import type * as netType from 'net';
import type * as dgramType from 'dgram';
import type * as dnsType from 'dns';
import { createRequire } from 'node:module';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isAllowed } from '../../common/egressPolicy.js';
import { installEgressNodeHooks, installLoopbackOnlyEgressHooks } from '../egressNodeHooks.js';

const require = createRequire(import.meta.url);
const http: typeof httpType = require('http');
const https: typeof httpType = require('https');
const net: typeof netType = require('net');
const dgram: typeof dgramType = require('dgram');
const dns: typeof dnsType = require('dns');

const blockedMessage = (dest: string) => `ZeroEgress blocked connection to ${dest} (not a configured server)`;
const tick = (ms: number) => new Promise(r => setTimeout(r, ms));

suite('egressNodeHooks: UDP and DNS', () => {

	let hooks: IDisposable | undefined;
	let checked: { url: string; allowed: boolean }[];
	let udpServer: dgramType.Socket;
	let udpPort: number;
	let received: Buffer[];
	const sockets: dgramType.Socket[] = [];

	function install(allow: (url: string) => boolean): void {
		hooks = installEgressNodeHooks(url => { const allowed = allow(url); checked.push({ url, allowed }); return allowed; }, { global: globalThis, http, https, net, dgram, dns });
	}
	const blockAll = () => false;
	const loopbackOnly = (url: string) => isAllowed(url, []);
	const denials = () => checked.filter(c => !c.allowed).map(c => c.url);
	const client = () => { const s = dgram.createSocket('udp4'); sockets.push(s); return s; };

	setup(async () => {
		checked = [];
		received = [];
		udpServer = dgram.createSocket('udp4');
		udpServer.on('message', m => received.push(m));
		await new Promise<void>(r => udpServer.bind(0, '127.0.0.1', r));
		udpPort = udpServer.address().port;
	});

	teardown(async () => {
		hooks?.dispose();
		hooks = undefined;
		while (sockets.length) { try { sockets.pop()!.close(); } catch { /* already closed */ } }
		await new Promise<void>(r => udpServer.close(() => r()));
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('dgram send: a blocked datagram is never sent and fails through the callback', async () => {
		install(blockAll);
		const err = await new Promise<Error | null>(r => client().send('secret', udpPort, '127.0.0.1', e => r(e)));
		assert.strictEqual(err?.message, blockedMessage(`127.0.0.1:${udpPort}`));
		await tick(100);
		assert.deepStrictEqual(received, []);
		assert.deepStrictEqual(denials(), [`http://127.0.0.1:${udpPort}/`]);
	});

	test('dgram send: an allowed datagram arrives (both argument forms)', async () => {
		install(loopbackOnly);
		const s = client();
		await new Promise<void>((r, j) => s.send('one', udpPort, '127.0.0.1', e => e ? j(e) : r()));
		await new Promise<void>((r, j) => s.send(Buffer.from('xtwox'), 1, 3, udpPort, '127.0.0.1', e => e ? j(e) : r()));
		await new Promise<void>((r, j) => s.send('three', udpPort, e => e ? j(e) : r())); // address omitted: loopback
		await tick(50);
		assert.deepStrictEqual(received.map(String).sort(), ['one', 'three', 'two']);
		assert.deepStrictEqual(denials(), []);
	});

	test('dgram send: the offset/length form and a non-loopback address are checked; no callback emits error', async () => {
		install(loopbackOnly);
		const s = client();
		const viaCallback = await new Promise<Error | null>(r => s.send(Buffer.from('abcdef'), 0, 3, 1900, '239.255.255.250', e => r(e)));
		assert.strictEqual(viaCallback?.message, blockedMessage('239.255.255.250:1900'));
		const viaEvent = new Promise<Error>(r => s.once('error', r));
		s.send('ssdp', 1900, '239.255.255.250');
		assert.strictEqual((await viaEvent).message, blockedMessage('239.255.255.250:1900'));
		assert.deepStrictEqual(denials(), ['http://239.255.255.250:1900/', 'http://239.255.255.250:1900/']);
	});

	test('dgram connect: a blocked destination is not connected; an allowed one is, and its sends pass', async () => {
		install(url => url === `http://127.0.0.1:${udpPort}/`);
		const blocked = client();
		const viaCallback = await new Promise<Error | undefined>(r => blocked.connect(udpPort === 65535 ? 1 : udpPort + 1, '127.0.0.1', ((e?: Error) => r(e)) as () => void));
		assert.match(String(viaCallback?.message), /^ZeroEgress blocked connection to 127\.0\.0\.1:\d+ \(not a configured server\)$/);
		const viaEvent = new Promise<Error>(r => blocked.once('error', r));
		blocked.connect(udpPort === 65535 ? 1 : udpPort + 1, '127.0.0.1');
		assert.match((await viaEvent).message, /^ZeroEgress blocked connection/);
		assert.throws(() => blocked.remoteAddress());
		const allowed = client();
		await new Promise<void>(r => allowed.connect(udpPort, '127.0.0.1', r));
		await new Promise<void>((r, j) => allowed.send('connected', e => e ? j(e) : r()));
		await tick(50);
		assert.deepStrictEqual(received.map(String), ['connected']);
	});

	test('dns: a lookup or query for an unconfigured name fails without being sent', async () => {
		// A local DNS "server" that records any query it gets.
		const dnsServer = dgram.createSocket('udp4');
		sockets.push(dnsServer);
		const queries: Buffer[] = [];
		dnsServer.on('message', m => queries.push(m));
		await new Promise<void>(r => dnsServer.bind(0, '127.0.0.1', r));
		const resolver = new dns.Resolver({ timeout: 200, tries: 1 });
		resolver.setServers([`127.0.0.1:${dnsServer.address().port}`]);
		const promiseResolver = new dns.promises.Resolver({ timeout: 200, tries: 1 });
		promiseResolver.setServers([`127.0.0.1:${dnsServer.address().port}`]);

		install(loopbackOnly);
		const expected = (name: string) => (e: NodeJS.ErrnoException) => e.code === 'ENOTFOUND' && e.message === blockedMessage(`dns://${name}`);
		const lookupErr = await new Promise<NodeJS.ErrnoException | null>(r => dns.lookup('exfil-1.example.com', e => r(e)));
		assert.ok(lookupErr && expected('exfil-1.example.com')(lookupErr), String(lookupErr));
		const resolveErr = await new Promise<NodeJS.ErrnoException | null>(r => resolver.resolveTxt('exfil-2.example.com', e => r(e)));
		assert.ok(resolveErr && expected('exfil-2.example.com')(resolveErr), String(resolveErr));
		const rrtypeErr = await new Promise<NodeJS.ErrnoException | null>(r => dns.resolve('exfil-3.example.com', 'A', e => r(e)));
		assert.ok(rrtypeErr && expected('exfil-3.example.com')(rrtypeErr), String(rrtypeErr));
		await assert.rejects(dns.promises.resolve4('exfil-4.example.com'), expected('exfil-4.example.com'));
		await assert.rejects(promiseResolver.resolveAny('exfil-5.example.com'), expected('exfil-5.example.com'));
		await assert.rejects(dns.promises.lookup('exfil-6.example.com'), expected('exfil-6.example.com'));
		await assert.rejects(dns.promises.reverse('8.8.8.8'), expected('8.8.8.8'));
		await tick(100);
		assert.deepStrictEqual(queries, [], 'no query reached the resolver');
		assert.strictEqual(denials().length, 7);

		// Control: the same resolver does receive a query when it is allowed.
		hooks!.dispose();
		hooks = undefined;
		await new Promise(r => resolver.resolveTxt('allowed.example.com', () => r(undefined)));
		assert.ok(queries.length > 0, 'the control query reached the resolver');
	});

	test('dns: loopback names resolve, and a TCP connect to localhost still works with DNS hooked', async () => {
		install(loopbackOnly);
		const address = await dns.promises.lookup('localhost');
		assert.ok(['127.0.0.1', '::1'].includes(address.address), address.address);
		const server = net.createServer(s => s.end());
		await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
		try {
			const port = (server.address() as netType.AddressInfo).port;
			await new Promise<void>((r, j) => net.connect({ host: 'localhost', port, family: 4 }, r).once('error', j).unref());
		} finally {
			server.close();
		}
		assert.deepStrictEqual(denials(), []);
	});

	test('dns: lookup of an IP literal is not a query and is not checked (dgram binds and sends use it)', async () => {
		install(blockAll);
		assert.strictEqual((await dns.promises.lookup('203.0.113.7')).address, '203.0.113.7');
		assert.strictEqual((await dns.promises.lookup('::')).address, '::');
		assert.deepStrictEqual(checked, []);
	});

	test('dns: a configured host may be looked up, whatever its port', async () => {
		install(url => isAllowed(url, [{ host: 'model.internal', port: 8000 }]));
		const err = await new Promise<NodeJS.ErrnoException | null>(r => dns.lookup('model.internal', e => r(e)));
		// allowed through to the real resolver: whatever it answers, it is not our refusal
		assert.ok(!err || !err.message.startsWith('ZeroEgress'), String(err));
		assert.deepStrictEqual(denials(), []);
	});

	test('the loopback-only hooks (shared process) police UDP and DNS too', async () => {
		const blocked: string[] = [];
		hooks = installLoopbackOnlyEgressHooks(url => blocked.push(url));
		const err = await new Promise<Error | null>(r => client().send('x', 53, '8.8.8.8', e => r(e)));
		assert.strictEqual(err?.message, blockedMessage('8.8.8.8:53'));
		await assert.rejects(dns.promises.resolve4('exfil.example.com'), /ZeroEgress blocked/);
		assert.deepStrictEqual(blocked, ['http://8.8.8.8:53/', 'dns://exfil.example.com/']);
	});

	test('dispose restores every dgram and dns original', () => {
		const originals = () => [dgram.Socket.prototype.send, dgram.Socket.prototype.connect, dns.lookup, dns.resolve4, dns.Resolver.prototype.resolveTxt, dns.promises.lookup, dns.promises.Resolver.prototype.resolveAny];
		const before = originals();
		install(blockAll);
		assert.ok(originals().every((f, i) => f !== before[i]), 'every function is wrapped');
		hooks!.dispose();
		hooks = undefined;
		assert.deepStrictEqual(originals(), before);
	});
});

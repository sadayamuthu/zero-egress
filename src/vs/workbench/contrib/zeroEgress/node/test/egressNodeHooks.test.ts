/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import type * as httpType from 'http';
import type * as netType from 'net';
import type * as tlsType from 'tls';
import { createRequire } from 'node:module';
import * as proxyAgent from '@vscode/proxy-agent';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isAllowed } from '../../common/egressPolicy.js';
import { installEgressNodeHooks } from '../egressNodeHooks.js';

const require = createRequire(import.meta.url);
const http: typeof httpType = require('http');
const https: typeof httpType = require('https');
const net: typeof netType = require('net');
const tls: typeof tlsType = require('tls');

const blockedMessage = (hostPort: string) => `ZeroEgress blocked connection to ${hostPort} (not a configured server)`;

/** Resolves with the first 'error' (or 'response'/'connect', reported as REACHED) of a request or socket. */
function outcome(emitter: NodeJS.EventEmitter): Promise<string> {
	return new Promise(resolve => {
		emitter.once('error', (e: Error) => resolve(e.message));
		emitter.once('response', (r: httpType.IncomingMessage) => { r.resume(); resolve(`REACHED ${r.statusCode}`); });
		emitter.once('connect', () => { (emitter as netType.Socket).destroy?.(); resolve('REACHED'); });
	});
}

suite('egressNodeHooks', () => {

	let server: httpType.Server;
	let port: number;
	let connections: number;
	let hooks: IDisposable | undefined;
	let checked: { url: string; allowed: boolean }[];

	/** Installs the hooks; `allow` decides, every decision is recorded in `checked`. */
	function install(allow: (url: string) => boolean): void {
		hooks = installEgressNodeHooks(url => { const allowed = allow(url); checked.push({ url, allowed }); return allowed; }, { global: globalThis, http, https, net });
	}
	const blockAll = () => false;
	const loopbackOnly = (url: string) => isAllowed(url, []);
	const denials = () => checked.filter(c => !c.allowed).map(c => c.url);

	setup(async () => {
		connections = 0;
		checked = [];
		server = http.createServer((_q, r) => r.end('reached'));
		server.on('connection', () => connections++);
		await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
		port = (server.address() as netType.AddressInfo).port;
	});

	teardown(async () => {
		hooks?.dispose();
		hooks = undefined;
		server.closeAllConnections();
		await new Promise(r => server.close(r));
	});

	// after our teardown is registered, so the hooks are disposed before the leak check runs
	ensureNoDisposablesAreLeakedInTestSuite();

	test('blocked request never connects when proxy-agent has patched http and https first', async () => {
		const saved = [http.request, http.get, https.request, https.get];
		const params = {
			getProxySupport: () => 'override',
			addCertificatesV1: () => false,
			addCertificatesV2: () => false,
			loadAdditionalCertificates: async () => [],
			log: { trace() { }, debug() { }, info() { }, warn() { }, error() { } },
			lookupProxyAuthorization: async () => undefined,
		} as unknown as proxyAgent.ProxyAgentParams;
		const resolveProxy: proxyAgent.ResolveProxyWithRequest = (_flags, _req, _opts, _url, cb) => cb('DIRECT');
		Object.assign(http, proxyAgent.createHttpPatch(params, http, resolveProxy));
		Object.assign(https, proxyAgent.createHttpPatch(params, https, resolveProxy));
		try {
			install(blockAll);
			assert.strictEqual(await outcome(http.request({ host: '127.0.0.1', port }).end()), blockedMessage(`127.0.0.1:${port}`));
			assert.strictEqual(await outcome(https.request({ host: '127.0.0.1', port }).end()), blockedMessage(`127.0.0.1:${port}`));
			assert.strictEqual(connections, 0);
			assert.strictEqual(denials().length, 2, 'one attempt, one recorded block');
		} finally {
			hooks?.dispose();
			hooks = undefined;
			[http.request, http.get, https.request, https.get] = saved;
		}
	});

	test('the socket choke point catches request-hook bypasses', async () => {
		install(blockAll);
		const cases: [string, () => NodeJS.EventEmitter][] = [
			['empty hostname', () => http.request({ hostname: '', host: '127.0.0.1', port, agent: false }).end()],
			['ClientRequest', () => new http.ClientRequest({ host: '127.0.0.1', port, agent: false }).end()],
			['Socket#connect', () => new net.Socket().connect(port, '127.0.0.1')],
			['net.connect', () => net.connect({ host: '127.0.0.1', port })],
			['net.createConnection', () => net.createConnection(port, '127.0.0.1')],
			['tls.connect', () => tls.connect(port, '127.0.0.1')],
		];
		for (const [name, make] of cases) {
			assert.strictEqual(await outcome(make()), blockedMessage(`127.0.0.1:${port}`), name);
		}
		assert.strictEqual(connections, 0);
	});

	test('blocked fetch rejects with the message and never connects', async () => {
		install(blockAll);
		await assert.rejects(fetch(`http://127.0.0.1:${port}/`), (e: Error) => e.message === blockedMessage(`127.0.0.1:${port}`));
		assert.strictEqual(connections, 0);
		assert.strictEqual(denials().length, 1);
	});

	test('loopback passes through every layer', async () => {
		install(loopbackOnly);
		assert.strictEqual(await outcome(http.get(`http://127.0.0.1:${port}/`)), 'REACHED 200');
		assert.strictEqual(await (await fetch(`http://localhost:${port}/`)).text(), 'reached');
		assert.strictEqual(await outcome(net.connect(port, 'localhost')), 'REACHED');
		assert.deepStrictEqual(denials(), []);
	});

	test('a loopback name must resolve to an allowed address', async () => {
		install(loopbackOnly);
		const lookup = (_h: string, opts: { all?: boolean }, cb: Function) => opts?.all ? cb(null, [{ address: '10.255.255.1', family: 4 }]) : cb(null, '10.255.255.1', 4);
		const sock = net.connect({ host: 'localhost', port, lookup: lookup as unknown as netType.LookupFunction });
		assert.strictEqual(await outcome(sock), blockedMessage(`10.255.255.1:${port}`));
		assert.deepStrictEqual(denials(), [`http://10.255.255.1:${port}/`]);
	});

	test('numeric-string ports are ports, as in Node (not pipe paths)', async () => {
		install(blockAll);
		for (const p of [`0x${port.toString(16)}`, ` ${port}`, `${port}.0`, `${port}`]) {
			assert.strictEqual(await outcome(new net.Socket().connect(p as unknown as number, '127.0.0.1')), blockedMessage(`127.0.0.1:${port}`), `Socket#connect(${JSON.stringify(p)})`);
			assert.strictEqual(await outcome(net.connect({ port: p as unknown as number, host: '127.0.0.1' })), blockedMessage(`127.0.0.1:${port}`), `net.connect({port: ${JSON.stringify(p)}})`);
		}
		assert.strictEqual(connections, 0);
	});

	test('hosts that re-parse differently inside a URL are blocked (Socket#connect and http.request)', async () => {
		install(loopbackOnly);
		const toLoopback = ((_h: string, opts: { all?: boolean }, cb: Function) => opts?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)) as unknown as netType.LookupFunction;
		const cases: [unknown, string][] = [
			['x@localhost', 'invalid-host://x%40localhost'],
			['localhost#x', 'invalid-host://localhost%23x'],
			['localhost/x', 'invalid-host://localhost%2Fx'],
			['localhost?x', 'invalid-host://localhost%3Fx'],
			['local\\host', 'invalid-host://local%5Chost'],
			[' localhost', 'invalid-host://%20localhost'],
			['localhost\n', 'invalid-host://localhost%0A'],
			['[localhost]', 'invalid-host://%5Blocalhost%5D'],
			[{ toString: () => 'localhost' }, 'invalid-host://non-string'],
		];
		for (const [host, described] of cases) {
			const name = JSON.stringify(String(host));
			assert.strictEqual(await outcome(net.connect({ host: host as string, port, lookup: toLoopback })), blockedMessage(described), `Socket#connect ${name}`);
			if (typeof host === 'string') {
				let result: string;
				try {
					result = await outcome(http.request({ host, port, lookup: toLoopback }).end());
				} catch (e) {
					result = (e as NodeJS.ErrnoException).code === 'ERR_INVALID_CHAR' ? blockedMessage(described) : String(e); // Node's own Host-header refusal
				}
				assert.strictEqual(result, blockedMessage(described), `http.request ${name}`);
			}
		}
		assert.strictEqual(connections, 0);
	});

	test('a host spelled as a loopback IP must resolve to that IP', async () => {
		install(loopbackOnly);
		const to = (address: string) => ((_h: string, opts: { all?: boolean }, cb: Function) => opts?.all ? cb(null, [{ address, family: 4 }]) : cb(null, address, 4)) as unknown as netType.LookupFunction;
		// '2130706433' parses to 127.0.0.1 but Node resolves it, so a lookup can send it elsewhere
		assert.strictEqual(await outcome(net.connect({ host: '2130706433', port, lookup: to('10.255.255.1') })), blockedMessage(`10.255.255.1:${port}`));
		assert.strictEqual(await outcome(http.request({ host: '2130706433', port, lookup: to('10.255.255.1') }).end()), blockedMessage(`10.255.255.1:${port}`));
		assert.strictEqual(await outcome(net.connect({ host: '[::1]', port, lookup: to('10.255.255.1') })), blockedMessage(`10.255.255.1:${port}`));
		assert.strictEqual(connections, 0);
		// and the honest resolution still connects
		assert.strictEqual(await outcome(net.connect({ host: '2130706433', port, lookup: to('127.0.0.1') })), 'REACHED');
		assert.strictEqual(await outcome(net.connect({ host: '[::1]', port, lookup: to('127.0.0.1') })), 'REACHED');
	});

	test('tls over an existing socket is not checked again', async () => {
		install(loopbackOnly);
		const raw = net.connect(port, '127.0.0.1');
		await new Promise(r => raw.once('connect', r));
		const secure = tls.connect({ socket: raw, rejectUnauthorized: false });
		secure.on('error', () => { });
		assert.deepStrictEqual(checked.map(c => c.url), [`http://127.0.0.1:${port}/`], 'only the raw socket was checked');
		secure.destroy();
	});

	test('unix sockets pass without a check', () => {
		install(blockAll);
		const s = net.connect({ path: '/nonexistent/zero-egress.sock' });
		s.on('error', () => { });
		assert.deepStrictEqual(checked, []);
		s.destroy();
	});

	test('electron net is wrapped when given', async () => {
		const calls: unknown[] = [];
		const fakeNet = { request: (o: unknown) => { calls.push(o); return 'req'; }, fetch: async (u: unknown) => { calls.push(u); return 'res'; } };
		hooks = installEgressNodeHooks(url => isAllowed(url, []), { global: globalThis, http, https, net, electronNet: fakeNet });
		assert.throws(() => fakeNet.request({ url: 'https://update.example.com/x' }), (e: Error) => e.message === blockedMessage('update.example.com:443'));
		assert.throws(() => fakeNet.request({ protocol: 'https:', hostname: 'example.com', port: 8443 }), (e: Error) => e.message === blockedMessage('example.com:8443'));
		await assert.rejects(fakeNet.fetch('https://example.com/'), (e: Error) => e.message === blockedMessage('example.com:443'));
		assert.strictEqual(fakeNet.request({ url: 'http://127.0.0.1:1/' }), 'req');
		assert.strictEqual(await fakeNet.fetch('http://localhost:1/'), 'res');
		assert.strictEqual(calls.length, 2);
	});

	test('electron net.request: Electron\'s option precedence, and every named destination must pass', () => {
		const received: unknown[] = [];
		const fakeNet = { request: (o: unknown) => { received.push(o); return 'req'; } };
		hooks = installEgressNodeHooks(url => isAllowed(url, []), { global: globalThis, http, https, net, electronNet: fakeNet });
		const blocked: [unknown, string][] = [
			// Electron dials `host` over `hostname`, and a truthy non-string `url` over everything
			[{ hostname: 'localhost', host: 'example.com' }, 'example.com:80'],
			[{ url: new URL('https://example.com/'), hostname: 'localhost' }, 'example.com:443'],
			[{ host: 'example.com:8443', protocol: 'https:' }, 'example.com:8443'],
			[{ hostname: 'example.com', port: 8080 }, 'example.com:8080'],
			// defense in depth: Electron would dial localhost here, but another field names a remote host
			[{ url: 'http://127.0.0.1:1/', host: 'example.com' }, 'example.com:80'],
			[{ host: 'localhost', hostname: 'example.com' }, 'example.com:80'],
			// odd hosts
			[{ host: 'x@localhost' }, 'invalid-host://x%40localhost'],
			[{ host: { toString: () => 'localhost' } }, 'invalid-host://non-string'],
			// strings: WHATWG and Electron's legacy parse both looked at
			['http://example.com\\@localhost/', 'example.com:80'],
		];
		for (const [options, destination] of blocked) {
			assert.throws(() => fakeNet.request(options), (e: Error) => e.message === blockedMessage(destination), JSON.stringify(String((options as { url?: unknown }).url ?? JSON.stringify(options))));
		}
		assert.deepStrictEqual(received, []);
		const allowed: unknown[] = [
			{ url: 'http://127.0.0.1:1/' },
			{ host: 'localhost:8080' },
			{ hostname: 'localhost', port: 1 },
			{ hostname: '::1', port: 1 },
			{},
			'http://localhost:80\\@example.com/',
			'http://example.com%2f@localhost/',
		];
		for (const options of allowed) {
			assert.strictEqual(fakeNet.request(options), 'req', JSON.stringify(options));
		}
		assert.strictEqual(received.length, allowed.length);
	});

	test('electron net properties that cannot be replaced do not throw; sockets stay policed', async () => {
		const original = () => 'req';
		const getterOnly = {} as { request: Function; fetch?: Function };
		Object.defineProperty(getterOnly, 'request', { get: () => original, enumerable: true });
		Object.defineProperty(getterOnly, 'fetch', { value: async () => 'res', writable: false, enumerable: true });
		const logged: unknown[] = [];
		const realError = console.error;
		console.error = (...a: unknown[]) => { logged.push(a[0]); };
		try {
			hooks = installEgressNodeHooks(blockAll, { global: globalThis, http, https, net, electronNet: getterOnly });
		} finally {
			console.error = realError;
		}
		assert.deepStrictEqual(logged, [
			'ZeroEgress: could not wrap Electron net.request; its requests are not policed in this process',
			'ZeroEgress: could not wrap Electron net.fetch; its requests are not policed in this process',
		]);
		assert.strictEqual(await outcome(net.connect(port, '127.0.0.1')), blockedMessage(`127.0.0.1:${port}`));
		assert.strictEqual(connections, 0);
	});

	test('dispose restores every original', () => {
		const originals = [globalThis.fetch, http.request, http.get, https.request, https.get, net.Socket.prototype.connect];
		install(blockAll);
		assert.notStrictEqual(net.Socket.prototype.connect, originals[5]);
		hooks!.dispose();
		hooks = undefined;
		assert.deepStrictEqual([globalThis.fetch, http.request, http.get, https.request, https.get, net.Socket.prototype.connect], originals);
	});
});

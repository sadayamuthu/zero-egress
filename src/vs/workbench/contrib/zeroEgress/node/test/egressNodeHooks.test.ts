/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import type * as httpType from 'http';
import type * as netType from 'net';
import type * as tlsType from 'tls';
import { createRequire } from 'node:module';
import * as nodeUrl from 'url';
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

/** What Electron's net.request dials for `options`: its ClientRequest parseOptions, as in the bundled Electron. */
function electronDial(options: unknown): string {
	const t: any = typeof options === 'string' ? nodeUrl.parse(options) : { ...(options as object) };
	if (t.url) { return String(t.url); }
	const e: any = { protocol: t.protocol || 'http:' };
	if (t.host) { e.host = t.host; } else { e.hostname = t.hostname || 'localhost'; if (t.port) { e.port = t.port; } }
	const path = nodeUrl.parse(t.path || '/');
	e.pathname = path.pathname; e.search = path.search; e.hash = path.hash;
	return nodeUrl.format(e);
}

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

	// Time-of-check/time-of-use: a caller-supplied field read by the hook and again by the original must give both
	// the same value. Each test flips a getter/toString after the first read and asserts the original received the
	// value that was checked (and never an example-class destination).

	/** A value whose getter returns `first` for the first `reads` reads, then `then` (a flipping getter). */
	const flipping = <T>(first: T, then: T, reads = 1) => { let n = 0; return { get() { return ++n > reads ? then : first; } }; };
	const withFlippingProp = (base: object, prop: string, first: unknown, then: unknown, reads = 1): any => Object.defineProperty({ ...base }, prop, { ...flipping(first, then, reads), enumerable: true });
	const flippingToString = (first: string, then: string) => { let n = 0; return { toString() { return ++n > 1 ? then : first; } }; };
	/** `obj` with an own `prop` accessor shadowing the class getter (still instanceof its class). */
	const lying = <O extends object>(obj: O, prop: string, value: unknown) => Object.defineProperty(obj, prop, { get: () => value });
	const closedPort = async () => { const s = net.createServer(); await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); const p = (s.address() as netType.AddressInfo).port; await new Promise(r => s.close(r)); return p; };

	test('electron net.request: options are read once and the checked snapshot is passed on', () => {
		const received: unknown[] = [];
		const fakeNet = { request: (o: unknown) => { received.push(electronDial(o)); return 'req'; } };
		hooks = installEgressNodeHooks(url => isAllowed(url, [{ host: '10.0.0.5', port: 8000 }]), { global: globalThis, http, https, net, electronNet: fakeNet });
		const cases: [string, unknown][] = [
			...[1, 2, 3, 4, 5, 6].map((reads): [string, unknown] => [`url getter flipping after ${reads} reads`, withFlippingProp({}, 'url', 'http://localhost/', 'https://example.com/', reads)]),
			['url object with flipping toString', { url: flippingToString('http://localhost/', 'https://example.com/') }],
			['host getter', withFlippingProp({}, 'host', 'localhost', 'example.com')],
			['hostname getter', withFlippingProp({ port: 1 }, 'hostname', 'localhost', 'example.com')],
			['port with flipping toString on a configured host', { hostname: '10.0.0.5', port: flippingToString('8000', '22') }],
			['protocol getter', withFlippingProp({ host: 'localhost' }, 'protocol', 'http:', 'https:')],
		];
		for (const [name, options] of cases) {
			received.length = 0;
			let result: string;
			try { result = String(fakeNet.request(options)); } catch (e) { result = (e as Error).message; }
			if (received.length) {
				assert.strictEqual(result, 'req', name);
				const dialed = new URL(received[0] as string);
				assert.ok(dialed.hostname === 'localhost' || dialed.host === '10.0.0.5:8000', `${name}: Electron would dial ${dialed.href}`);
				assert.notStrictEqual(dialed.protocol, 'https:', `${name}: protocol flipped`);
			} else {
				assert.ok(result.startsWith('ZeroEgress blocked'), `${name}: ${result}`);
			}
		}
	});

	test('electron net.fetch and global fetch: the input is normalized once and the normalized value is passed on', async () => {
		const received: unknown[] = [];
		const fakeFetch = async (input: unknown) => { received.push(input); return 'res'; };
		const fakeGlobal = { fetch: fakeFetch as unknown as typeof fetch };
		const fakeNet = { request: () => 'req', fetch: fakeFetch };
		hooks = installEgressNodeHooks(loopbackOnly, { global: fakeGlobal, http, https, net, electronNet: fakeNet });
		for (const [name, doFetch] of [['global fetch', (i: unknown) => fakeGlobal.fetch(i as string)], ['electron net.fetch', (i: unknown) => fakeNet.fetch(i)]] as const) {
			received.length = 0;
			// an object whose stringification flips: the original gets the string we checked
			assert.strictEqual(await doFetch(flippingToString('http://localhost/', 'https://example.com/')), 'res', name);
			assert.strictEqual(received[0], 'http://localhost/', `${name}: flipping toString`);
			// a URL is passed on as its href
			assert.strictEqual(await doFetch(new URL('http://localhost:1/x')), 'res', name);
			assert.strictEqual(received[1], 'http://localhost:1/x', `${name}: URL`);
			// a plain object with a reassuring `url` but a different stringification is judged by what Request would use
			await assert.rejects(doFetch({ url: 'http://localhost/', toString: () => 'https://example.com/' }), (e: Error) => e.message === blockedMessage('example.com:443'), `${name}: {url, toString}`);
			// a Request subclass shadowing `url`: the real request state is what gets dialed
			await assert.rejects(doFetch(lying(new Request('https://example.com/'), 'url', 'http://localhost/')), (e: Error) => e.message === blockedMessage('example.com:443'), `${name}: Request with a shadowed url`);
			// a genuine Request passes through as the same instance, body intact
			const request = new Request('http://localhost:1/', { method: 'POST', body: 'payload' });
			assert.strictEqual(await doFetch(request), 'res', name);
			assert.strictEqual(received[2], request, `${name}: Request identity`);
			assert.strictEqual(request.bodyUsed, false, `${name}: Request body untouched`);
			assert.strictEqual(received.length, 3, name);
		}
	});

	test('http.request: host, hostname and port are read once and the checked values are dialed', async () => {
		install(loopbackOnly);
		const other = await closedPort();
		// the flipped values stay on loopback (so nothing leaves the machine either way), but would not reach the server
		const cases: [string, () => NodeJS.EventEmitter][] = [
			['hostname getter', () => http.request(withFlippingProp({ port, agent: false }, 'hostname', '127.0.0.1', '::1')).end()],
			['host getter', () => http.request(withFlippingProp({ port, agent: false }, 'host', '127.0.0.1', '::1')).end()],
			['port getter', () => http.request(withFlippingProp({ host: '127.0.0.1', agent: false }, 'port', port, other)).end()],
			['port getter via http.get', () => http.get(withFlippingProp({ host: '127.0.0.1', agent: false }, 'port', port, other))],
			['URL with a shadowed hostname', () => http.request(lying(new URL(`http://127.0.0.1:${port}/`), 'hostname', '::1'), { agent: false }).end()],
			['URL string with a flipping options port', () => http.request(`http://127.0.0.1:${port}/`, withFlippingProp({ agent: false }, 'port', port, other)).end()],
		];
		for (const [name, make] of cases) {
			connections = 0;
			assert.strictEqual(await outcome(make()), 'REACHED 200', name);
			assert.strictEqual(connections, 1, name);
		}
		assert.deepStrictEqual(denials(), []);
	});

	test('Socket#connect: host, port and path are read once and the checked values are dialed', async () => {
		install(loopbackOnly);
		const other = await closedPort();
		const cases: [string, () => NodeJS.EventEmitter][] = [
			['host getter', () => new net.Socket().connect(withFlippingProp({ port }, 'host', '127.0.0.1', '::1'))],
			['port getter', () => new net.Socket().connect(withFlippingProp({ host: '127.0.0.1' }, 'port', port, other))],
			['lookup is taken from the snapshot', () => new net.Socket().connect(withFlippingProp({ host: 'localhost', port }, 'lookup', undefined, () => { throw new Error('flipped lookup used'); }))],
			// net.createConnection copies the options once (Socket constructor) before connect reads them, so the
			// read the hook and the dial share is the second one
			['host getter via net.connect', () => net.connect(withFlippingProp({ port }, 'host', '127.0.0.1', '::1', 2))],
			['port getter via net.connect', () => net.connect(withFlippingProp({ host: '127.0.0.1' }, 'port', port, other, 2))],
		];
		for (const [name, make] of cases) {
			connections = 0;
			const seen = new Promise<void>(r => server.once('connection', () => r()));
			assert.strictEqual(await outcome(make()), 'REACHED', name);
			await seen;
			assert.strictEqual(connections, 1, name);
		}
		// a path that vanishes after the first read must not turn into a TCP dial
		const checksBefore = checked.length;
		const sock = new net.Socket().connect(withFlippingProp({ host: '127.0.0.1', port: other }, 'path', '/nonexistent/zero-egress.sock', undefined));
		const err = await new Promise<NodeJS.ErrnoException>(r => sock.once('error', r));
		assert.strictEqual(err.code, 'ENOENT', 'the unix socket we saw is the one Node tried');
		assert.strictEqual(checked.length, checksBefore, 'a pipe is not checked');
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

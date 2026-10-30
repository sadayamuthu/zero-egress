/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import type * as httpType from 'http';
import type * as netType from 'net';
import type * as tlsType from 'tls';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import { createRequire } from 'node:module';
import * as nodeUrl from 'url';
import * as proxyAgent from '@vscode/proxy-agent';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isAllowed } from '../../common/egressPolicy.js';
import { AllowedCountBatcher, EgressCheckKind, installEgressNodeHooks, installLoopbackOnlyEgressHooks } from '../egressNodeHooks.js';

const require = createRequire(import.meta.url);
const http: typeof httpType = require('http');
const https: typeof httpType = require('https');
const net: typeof netType = require('net');
const tls: typeof tlsType = require('tls');
const dns: typeof import('dns') = require('dns');

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
		const { fakeNet, requests, originalFetchCalls } = fakeElectronNet();
		hooks = installEgressNodeHooks(url => isAllowed(url, []), { global: globalThis, http, https, net, electronNet: fakeNet });
		assert.throws(() => fakeNet.request({ url: 'https://update.example.com/x' }), (e: Error) => e.message === blockedMessage('update.example.com:443'));
		assert.throws(() => fakeNet.request({ protocol: 'https:', hostname: 'example.com', port: 8443 }), (e: Error) => e.message === blockedMessage('example.com:8443'));
		await assert.rejects(fakeNet.fetch('https://example.com/'), (e: Error) => e.message === blockedMessage('example.com:443'));
		assert.strictEqual(requests.length, 0);
		assert.ok(fakeNet.request({ url: 'http://127.0.0.1:1/' }) instanceof FakeElectronRequest);
		const response = fakeNet.fetch('http://localhost:1/') as unknown as Promise<Response>;
		assert.strictEqual(requests[1].options.url, 'http://localhost:1/');
		requests[1].serverResponds(200, {}, 'ok');
		assert.strictEqual(await (await response).text(), 'ok');
		assert.deepStrictEqual(originalFetchCalls, [], 'Electron\'s own net.fetch is never used');
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

	test('global fetch: the input is normalized once and the normalized value is passed on', async () => {
		const received: unknown[] = [];
		const fakeGlobal = { fetch: (async (input: unknown) => { received.push(input); return 'res'; }) as unknown as typeof fetch };
		hooks = installEgressNodeHooks(loopbackOnly, { global: fakeGlobal, http, https, net });
		const doFetch = (i: unknown) => fakeGlobal.fetch(i as string);
		// an object whose stringification flips: the original gets the string we checked
		assert.strictEqual(await doFetch(flippingToString('http://localhost/', 'https://example.com/')), 'res');
		assert.strictEqual(received[0], 'http://localhost/', 'flipping toString');
		// a URL is passed on as its href
		assert.strictEqual(await doFetch(new URL('http://localhost:1/x')), 'res');
		assert.strictEqual(received[1], 'http://localhost:1/x', 'URL');
		// a plain object with a reassuring `url` but a different stringification is judged by what Request would use
		await assert.rejects(doFetch({ url: 'http://localhost/', toString: () => 'https://example.com/' }), (e: Error) => e.message === blockedMessage('example.com:443'));
		// a Request subclass shadowing `url`: the real request state is what gets dialed
		await assert.rejects(doFetch(lying(new Request('https://example.com/'), 'url', 'http://localhost/')), (e: Error) => e.message === blockedMessage('example.com:443'));
		// a genuine Request passes through as the same instance, body intact
		const request = new Request('http://localhost:1/', { method: 'POST', body: 'payload' });
		assert.strictEqual(await doFetch(request), 'res');
		assert.strictEqual(received[2], request, 'Request identity');
		assert.strictEqual(request.bodyUsed, false, 'Request body untouched');
		assert.strictEqual(received.length, 3);
	});

	test('electron net.fetch: the input is normalized once and the checked URL is what net.request gets', async () => {
		const { fakeNet, requests } = fakeElectronNet();
		hooks = installEgressNodeHooks(loopbackOnly, { global: globalThis, http, https, net, electronNet: fakeNet });
		const respond = async (p: unknown, i: number) => { await settle(); requests[i].serverResponds(200); return (await (p as Promise<Response>)).status; };
		assert.strictEqual(await respond(fakeNet.fetch(flippingToString('http://localhost/', 'https://example.com/')), 0), 200);
		assert.strictEqual(requests[0].options.url, 'http://localhost/', 'flipping toString');
		assert.strictEqual(await respond(fakeNet.fetch(new URL('http://localhost:1/x')), 1), 200);
		assert.strictEqual(requests[1].options.url, 'http://localhost:1/x', 'URL');
		await assert.rejects(fakeNet.fetch({ url: 'http://localhost/', toString: () => 'https://example.com/' }) as Promise<unknown>, (e: Error) => e.message === blockedMessage('example.com:443'));
		await assert.rejects(fakeNet.fetch(lying(new Request('https://example.com/'), 'url', 'http://localhost/')) as Promise<unknown>, (e: Error) => e.message === blockedMessage('example.com:443'));
		assert.strictEqual(requests.length, 2, 'nothing was created for the blocked inputs');
		// a genuine Request: its method, headers and body go to the request
		const p = fakeNet.fetch(new Request('http://localhost:1/', { method: 'POST', body: 'payload', headers: { 'x-a': '1' } }));
		while (!requests[2]?.started) { await settle(); }
		assert.strictEqual(requests[2].options.method, 'POST');
		assert.strictEqual(requests[2].headers['x-a'], '1');
		assert.strictEqual(Buffer.concat(requests[2].chunks).toString(), 'payload');
		assert.strictEqual(await respond(p, 2), 200);
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

	// Redirects. Electron's ClientRequest follows a redirect unless the request is cancelled while its 'redirect'
	// event is being emitted; with redirect 'manual' it cancels ("Redirect was cancelled") unless followRedirect() was
	// called during that emit. FakeElectronRequest reproduces that logic (net-client-request.ts in Electron 34).

	class FakeElectronRequest extends Writable {
		readonly policy: string;
		/** URLs the loader went on to after a redirect. */
		readonly followed: string[] = [];
		readonly headers: Record<string, string> = {};
		readonly chunks: Buffer[] = [];
		/** end() was called: Electron starts the url loader here. */
		started = false;
		setHeader(name: string, value: string): void { this.headers[name] = value; }
		override _write(chunk: Buffer, _enc: string, cb: () => void): void { this.chunks.push(Buffer.from(chunk)); cb(); }
		override _final(cb: () => void): void { this.started = true; cb(); }
		/** The server answered (Electron emits an IncomingMessage). */
		serverResponds(statusCode: number, headers: Record<string, string | string[]> = {}, body = ''): void {
			const resp = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { statusCode, statusMessage: `status ${statusCode}`, headers });
			this.emit('response', resp);
		}
		private cancelled = false;
		private aborted = false;
		private followRedirectCb: (() => void) | undefined;
		constructor(readonly options: any) {
			super();
			const policy = (typeof options === 'object' && options.redirect) || 'follow';
			if (!['follow', 'error', 'manual'].includes(policy)) { throw new Error('redirect mode should be one of follow, error or manual'); }
			this.policy = policy;
		}
		/** The server answered with a redirect to `newUrl`. */
		serverRedirects(newUrl: string): void {
			if (this.policy === 'error') {
				this.die(new Error('Attempted to redirect, but redirect policy was \'error\''));
			} else if (this.policy === 'manual') {
				let follow = false;
				this.followRedirectCb = () => { follow = true; };
				try {
					this.emit('redirect', 302, 'GET', newUrl, {});
				} finally {
					this.followRedirectCb = undefined;
					if (!follow && !this.aborted) { this.die(new Error('Redirect was cancelled')); }
				}
			} else {
				try {
					this.followRedirectCb = () => { };
					this.emit('redirect', 302, 'GET', newUrl, {});
				} finally {
					this.followRedirectCb = undefined;
				}
			}
			if (!this.cancelled) { this.followed.push(newUrl); }
		}
		followRedirect(): void {
			if (!this.followRedirectCb) { throw new Error('followRedirect() called, but was not waiting for a redirect'); }
			this.followRedirectCb();
		}
		abort(): void {
			this.aborted = true;
			this.die();
		}
		private die(e?: Error): void {
			this.cancelled = true;
			if (e) { process.nextTick(() => this.emit('error', e)); }
		}
	}

	function fakeElectronNet() {
		const requests: FakeElectronRequest[] = [];
		const originalFetchCalls: unknown[] = [];
		const fakeNet = {
			request: (o: unknown) => { const r = new FakeElectronRequest(o); requests.push(r); return r; },
			fetch: async (...a: unknown[]) => { originalFetchCalls.push(a); return 'original fetch'; },
		};
		return { fakeNet, requests, originalFetchCalls };
	}
	const nextError = (req: EventEmitter) => new Promise<string>(resolve => req.once('error', (e: Error) => resolve(e.message)));
	const settle = () => new Promise(r => setImmediate(r));

	test('electron net.request: a redirect is followed only to an allowed destination (default follow policy)', async () => {
		const { fakeNet, requests } = fakeElectronNet();
		hooks = installEgressNodeHooks(url => { const allowed = loopbackOnly(url); checked.push({ url, allowed }); return allowed; }, { global: globalThis, http, https, net, electronNet: fakeNet });

		// string and object options alike are handed to Electron with redirect 'manual'
		for (const options of ['http://127.0.0.1:1/start', { url: 'http://127.0.0.1:1/start' }, { url: 'http://127.0.0.1:1/start', redirect: 'follow' }]) {
			checked.length = 0;
			const req = fakeNet.request(options) as unknown as FakeElectronRequest;
			assert.strictEqual(req.policy, 'manual', JSON.stringify(options));
			const seenByCaller: string[] = [];
			req.on('redirect', (_s: number, _m: string, url: string) => seenByCaller.push(url));

			req.serverRedirects('http://localhost:2/next');
			assert.deepStrictEqual(req.followed, ['http://localhost:2/next'], 'allowed hop followed');

			const error = nextError(req);
			req.serverRedirects('http://192.168.68.60:18092/leaked');
			assert.deepStrictEqual(req.followed, ['http://localhost:2/next'], 'blocked hop not followed');
			assert.strictEqual(await error, blockedMessage('192.168.68.60:18092'));
			assert.deepStrictEqual(seenByCaller, ['http://localhost:2/next', 'http://192.168.68.60:18092/leaked'], 'the caller still sees redirect events');
			assert.deepStrictEqual(denials(), ['http://192.168.68.60:18092/leaked'], 'one log line per blocked hop');
		}
		assert.strictEqual(requests.length, 3);
	});

	test('electron net.request: a caller calling followRedirect() in follow mode cannot follow a blocked hop', async () => {
		const { fakeNet } = fakeElectronNet();
		hooks = installEgressNodeHooks(url => { const allowed = loopbackOnly(url); checked.push({ url, allowed }); return allowed; }, { global: globalThis, http, https, net, electronNet: fakeNet });
		const req = fakeNet.request({ url: 'http://127.0.0.1:1/' }) as unknown as FakeElectronRequest;
		req.on('redirect', () => { req.followRedirect(); req.followRedirect(); });
		const error = nextError(req);
		req.serverRedirects('https://example.com/');
		assert.deepStrictEqual(req.followed, []);
		assert.strictEqual(await error, blockedMessage('example.com:443'));
		assert.deepStrictEqual(denials(), ['https://example.com/'], 'decided once');
	});

	test('electron net.request: manual policy keeps emitting redirects, and followRedirect() to a blocked hop is refused', async () => {
		const { fakeNet } = fakeElectronNet();
		hooks = installEgressNodeHooks(url => { const allowed = loopbackOnly(url); checked.push({ url, allowed }); return allowed; }, { global: globalThis, http, https, net, electronNet: fakeNet });

		// the caller follows an allowed hop
		const ok = fakeNet.request({ url: 'http://127.0.0.1:1/', redirect: 'manual' }) as unknown as FakeElectronRequest;
		ok.on('redirect', () => ok.followRedirect());
		ok.serverRedirects('http://[::1]:2/');
		assert.deepStrictEqual(ok.followed, ['http://[::1]:2/']);

		// the caller does not follow: Electron's own cancellation, nothing checked or logged
		const declined = fakeNet.request({ url: 'http://127.0.0.1:1/', redirect: 'manual' }) as unknown as FakeElectronRequest;
		declined.on('redirect', () => { });
		checked.length = 0;
		const declinedError = nextError(declined);
		declined.serverRedirects('https://example.com/');
		assert.strictEqual(await declinedError, 'Redirect was cancelled');
		assert.deepStrictEqual(checked, []);

		// the caller tries to follow a blocked hop: refused, our error, one log line
		const refused = fakeNet.request({ url: 'http://127.0.0.1:1/', redirect: 'manual' }) as unknown as FakeElectronRequest;
		let threw: unknown;
		refused.on('redirect', () => { try { refused.followRedirect(); refused.followRedirect(); } catch (e) { threw = e; } });
		const refusedError = nextError(refused);
		refused.serverRedirects('http://192.168.68.60:18092/leaked');
		assert.strictEqual(threw, undefined, 'refusing does not throw into the caller\'s listener');
		assert.deepStrictEqual(refused.followed, []);
		assert.strictEqual(await refusedError, blockedMessage('192.168.68.60:18092'));
		assert.deepStrictEqual(denials(), ['http://192.168.68.60:18092/leaked']);

		// followRedirect() outside a redirect still fails the way Electron's does
		assert.throws(() => refused.followRedirect(), /not waiting for a redirect/);
	});

	test('electron net.request: redirect policy \'error\' is passed through; the policy is read once', async () => {
		const { fakeNet } = fakeElectronNet();
		hooks = installEgressNodeHooks(loopbackOnly, { global: globalThis, http, https, net, electronNet: fakeNet });
		const req = fakeNet.request({ url: 'http://127.0.0.1:1/', redirect: 'error' }) as unknown as FakeElectronRequest;
		assert.strictEqual(req.policy, 'error');
		const error = nextError(req);
		req.serverRedirects('http://localhost:2/');
		assert.strictEqual(await error, 'Attempted to redirect, but redirect policy was \'error\'');
		assert.deepStrictEqual(req.followed, []);

		// a getter answering 'error' to us and 'follow' to Electron cannot turn the gate off
		const flipped = fakeNet.request(withFlippingProp({ url: 'http://127.0.0.1:1/' }, 'redirect', 'error', 'follow')) as unknown as FakeElectronRequest;
		assert.strictEqual(flipped.policy, 'error');
		const flippedToManual = fakeNet.request(withFlippingProp({ url: 'http://127.0.0.1:1/' }, 'redirect', 'follow', 'error')) as unknown as FakeElectronRequest;
		assert.strictEqual(flippedToManual.policy, 'manual');
		flippedToManual.on('error', () => { });
		flippedToManual.serverRedirects('https://example.com/');
		assert.deepStrictEqual(flippedToManual.followed, []);
		await settle();
	});

	// net.fetch is built on the guarded net.request (Electron's own net.fetch is out of the wrapper's reach).

	/** Starts a net.fetch on the fake net and returns it with the request it created, once that request started. */
	async function startFetch(fakeNet: ReturnType<typeof fakeElectronNet>['fakeNet'], requests: FakeElectronRequest[], input: string, init?: RequestInit) {
		const n = requests.length;
		const response = fakeNet.fetch(input, init) as unknown as Promise<Response>;
		response.catch(() => { });
		while (!requests[n]?.started) { await settle(); }
		return { response, req: requests[n] };
	}

	test('electron net.fetch: an allowed hop is followed, a blocked hop is refused with one log line', async () => {
		const { fakeNet, requests, originalFetchCalls } = fakeElectronNet();
		hooks = installEgressNodeHooks(url => { const allowed = loopbackOnly(url); checked.push({ url, allowed }); return allowed; }, { global: globalThis, http, https, net, electronNet: fakeNet });

		const ok = await startFetch(fakeNet, requests, 'http://127.0.0.1:18091/start');
		assert.strictEqual(ok.req.policy, 'manual', 'redirect follow runs as manual');
		ok.req.serverRedirects('http://localhost:2/next');
		assert.deepStrictEqual(ok.req.followed, ['http://localhost:2/next']);
		ok.req.serverResponds(200, {}, 'landed');
		assert.strictEqual(await (await ok.response).text(), 'landed');

		checked.length = 0;
		const bad = await startFetch(fakeNet, requests, 'http://127.0.0.1:18091/start');
		bad.req.serverRedirects('http://192.168.68.60:18092/leaked');
		assert.deepStrictEqual(bad.req.followed, []);
		await assert.rejects(bad.response, (e: Error) => e.message === blockedMessage('192.168.68.60:18092'));
		assert.deepStrictEqual(denials(), ['http://192.168.68.60:18092/leaked']);
		assert.deepStrictEqual(originalFetchCalls, []);
	});

	test('electron net.fetch: redirect \'error\' and \'manual\' reject as Electron\'s own fetch does, following nothing', async () => {
		const { fakeNet, requests } = fakeElectronNet();
		hooks = installEgressNodeHooks(url => { const allowed = loopbackOnly(url); checked.push({ url, allowed }); return allowed; }, { global: globalThis, http, https, net, electronNet: fakeNet });
		const err = await startFetch(fakeNet, requests, 'http://127.0.0.1:1/', { redirect: 'error' });
		assert.strictEqual(err.req.policy, 'error');
		err.req.serverRedirects('http://localhost:2/');
		await assert.rejects(err.response, (e: Error) => e.message === 'Attempted to redirect, but redirect policy was \'error\'');
		checked.length = 0;
		const man = await startFetch(fakeNet, requests, 'http://127.0.0.1:1/', { redirect: 'manual' });
		assert.strictEqual(man.req.policy, 'manual');
		man.req.serverRedirects('https://example.com/');
		await assert.rejects(man.response, (e: Error) => e.message === 'Redirect was cancelled');
		assert.deepStrictEqual([err.req.followed, man.req.followed, checked.filter(c => !c.url.startsWith('http://127.0.0.1:1/') && c.url !== 'http://localhost:80/')], [[], [], []], 'the hop is never checked or logged');
		// init is read once: a getter answering 'error' first is what the request gets
		const flipped = await startFetch(fakeNet, requests, 'http://127.0.0.1:1/', withFlippingProp({}, 'redirect', 'error', 'follow'));
		assert.strictEqual(flipped.req.policy, 'error');
		flipped.req.serverResponds(204);
		assert.strictEqual((await flipped.response).body, null);
	});

	test('electron net.fetch: a request the guard could not wrap follows no redirect at all', async () => {
		const { fakeNet, requests } = fakeElectronNet();
		const request = fakeNet.request;
		// an unexpected Electron shape: no prependListener, so guardRedirects leaves the request unwrapped
		fakeNet.request = (o: unknown) => { const r = request(o); (r as any).prependListener = undefined; return r; };
		hooks = installEgressNodeHooks(loopbackOnly, { global: globalThis, http, https, net, electronNet: fakeNet });
		const f = await startFetch(fakeNet, requests, 'http://127.0.0.1:1/start');
		f.req.serverRedirects('http://localhost:2/allowed-but-unchecked');
		await assert.rejects(f.response, (e: Error) => e.message === 'ZeroEgress refused a redirect it could not check');
		assert.deepStrictEqual(f.req.followed, []);
	});

	test('electron net.fetch: at most 20 redirects are followed', async () => {
		const { fakeNet, requests } = fakeElectronNet();
		hooks = installEgressNodeHooks(loopbackOnly, { global: globalThis, http, https, net, electronNet: fakeNet });
		const { response, req } = await startFetch(fakeNet, requests, 'http://127.0.0.1:1/0');
		for (let i = 1; i <= 21; i++) { req.serverRedirects(`http://127.0.0.1:1/${i}`); }
		await assert.rejects(response, (e: Error) => e.message === 'net::ERR_TOO_MANY_REDIRECTS');
		assert.strictEqual(req.followed.length, 20);
		assert.strictEqual(req.followed[19], 'http://127.0.0.1:1/20');
	});

	test('electron net.fetch: the Response is built as Electron builds it; abort cancels the request', async () => {
		const { fakeNet, requests } = fakeElectronNet();
		hooks = installEgressNodeHooks(loopbackOnly, { global: globalThis, http, https, net, electronNet: fakeNet });
		const a = await startFetch(fakeNet, requests, 'http://localhost:1/', { headers: { origin: 'http://localhost:1' }, credentials: 'same-origin', mode: 'cors' });
		assert.deepStrictEqual([a.req.options.origin, a.req.options.credentials, a.req.headers['Sec-Fetch-Mode']], ['http://localhost:1', 'same-origin', 'cors']);
		a.req.serverResponds(201, { 'set-cookie': ['a=1', 'b=2'], 'x-y': 'z' }, 'body');
		const res = await a.response;
		assert.deepStrictEqual([res.status, res.statusText, res.headers.get('x-y'), res.headers.get('set-cookie'), await res.text()], [201, 'status 201', 'z', 'a=1, b=2', 'body']);
		const head = await startFetch(fakeNet, requests, 'http://localhost:1/', { method: 'HEAD' });
		assert.strictEqual(head.req.options.credentials, 'include', 'same-origin without origin becomes include');
		head.req.serverResponds(200, {}, 'ignored');
		assert.strictEqual((await head.response).body, null);
		const controller = new AbortController();
		const c = await startFetch(fakeNet, requests, 'http://localhost:1/', { signal: controller.signal });
		controller.abort();
		await assert.rejects(c.response, (e: Error) => e.name === 'AbortError');
		c.req.serverRedirects('http://localhost:2/');
		assert.deepStrictEqual(c.req.followed, [], 'aborted request cancelled');
	});

	test('kinds reach check', async () => {
		const calls: [string, EgressCheckKind][] = [];
		hooks = installEgressNodeHooks((url, kind) => { calls.push([url, kind]); return false; }, { global: globalThis, http, https, net, dns });
		assert.strictEqual(await outcome(net.connect({ host: '127.0.0.1', port })), blockedMessage(`127.0.0.1:${port}`));
		assert.deepStrictEqual(calls, [[`http://127.0.0.1:${port}/`, 'socket']]);
		calls.length = 0;
		await new Promise<void>(r => dns.lookup('exfil.example.com', () => r()));
		assert.deepStrictEqual(calls, [['dns://exfil.example.com/', 'lookup']]);
		calls.length = 0;
		await assert.rejects(fetch('https://exfil.example.com/x'));
		assert.deepStrictEqual(calls, [['https://exfil.example.com/x', 'wrapper']], 'a blocked fetch is one wrapper check and nothing else');
		assert.strictEqual(connections, 0);
	});

	test('loopback-only hooks report allowed socket checks only', async () => {
		const allowed: string[] = [];
		const blocked: string[] = [];
		hooks = installLoopbackOnlyEgressHooks(url => blocked.push(url), undefined, url => allowed.push(url));
		assert.strictEqual(await (await fetch(`http://127.0.0.1:${port}/a?q=1`)).text(), 'reached');
		assert.deepStrictEqual(allowed, [`http://127.0.0.1:${port}/`], 'the fetch wrapper check is not reported; its socket is');
		await assert.rejects(fetch('https://exfil.example.com/'));
		assert.deepStrictEqual(blocked, ['https://exfil.example.com/']);
		assert.strictEqual(allowed.length, 1);
	});

	suite('AllowedCountBatcher', () => {
		test('counts per URL and sends nothing when empty', () => {
			const sent: { url: string; count: number }[][] = [];
			const batcher = new AllowedCountBatcher(counts => sent.push(counts));
			batcher.flush();
			assert.deepStrictEqual(sent, []);
			batcher.add('http://10.0.0.5:8000/');
			batcher.add('http://10.0.0.5:8000/');
			batcher.add('http://127.0.0.1:1/');
			batcher.flush();
			batcher.flush();
			assert.deepStrictEqual(sent, [[{ url: 'http://10.0.0.5:8000/', count: 2 }, { url: 'http://127.0.0.1:1/', count: 1 }]]);
			batcher.add('http://127.0.0.1:1/');
			batcher.dispose();
			assert.deepStrictEqual(sent[1], [{ url: 'http://127.0.0.1:1/', count: 1 }], 'dispose flushes what is left');
		});

		test('flushes on its interval; a failing send does not throw', async () => {
			const sent: { url: string; count: number }[][] = [];
			let fail = true;
			const batcher = new AllowedCountBatcher(counts => { if (fail) { fail = false; throw new Error('gone'); } sent.push(counts); }, 5);
			try {
				batcher.add('http://127.0.0.1:1/');
				await new Promise(r => setTimeout(r, 30));
				batcher.add('http://127.0.0.1:2/');
				await new Promise(r => setTimeout(r, 30));
				assert.deepStrictEqual(sent, [[{ url: 'http://127.0.0.1:2/', count: 1 }]]);
			} finally {
				batcher.dispose();
			}
		});
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

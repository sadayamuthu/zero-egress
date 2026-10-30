/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';
import * as dgram from 'dgram';
import * as dns from 'dns';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BlockedAttempt } from '../../common/egressGuardService.js';
import { LedgerAggregator, LedgerBody } from '../../common/egressLedger.js';
import { EgressGuard, EgressGuardChannel } from '../egressGuard.js';

const blockedMessage = (hostPort: string) => `ZeroEgress blocked connection to ${hostPort} (not a configured server)`;

function nextError(emitter: { once(event: 'error', l: (e: Error) => void): unknown }): Promise<Error> {
	return new Promise(resolve => emitter.once('error', resolve));
}

suite('EgressGuard', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createGuard(): EgressGuard {
		return store.add(new EgressGuard());
	}

	test('target replacement', () => {
		const guard = createGuard();
		guard.setTargets('settings', ['http://10.0.0.5:8000']);
		assert.strictEqual(guard.check('http://10.0.0.5:8000/x'), true);
		guard.setTargets('settings', ['http://10.0.0.7:8000']);
		assert.strictEqual(guard.check('http://10.0.0.5:8000/x'), false);
		assert.strictEqual(guard.check('http://10.0.0.7:8000/x'), true);
	});

	test('sources are independent', () => {
		const guard = createGuard();
		guard.setTargets('settings', ['http://10.0.0.5:8000']);
		guard.setTargets('mcp', ['http://mcp.corp.internal:9000/sse']);
		guard.setTargets('audit', ['https://audit.corp.internal/ingest']);
		assert.strictEqual(guard.check('http://10.0.0.5:8000/v1'), true);
		assert.strictEqual(guard.check('http://mcp.corp.internal:9000/'), true);
		assert.strictEqual(guard.check('https://audit.corp.internal/x'), true);
		guard.setTargets('mcp', []);
		assert.strictEqual(guard.check('http://10.0.0.5:8000/v1'), true);
		assert.strictEqual(guard.check('http://mcp.corp.internal:9000/'), false);
	});

	test('loopback and non-network schemes always pass', () => {
		const guard = createGuard();
		assert.strictEqual(guard.check('http://127.0.0.1:11434/api/chat'), true);
		assert.strictEqual(guard.check('vscode-file://vscode-app/x.js'), true);
		assert.strictEqual(guard.check('https://example.com/'), false);
	});

	test('blocked attempt fires event', () => {
		const guard = createGuard();
		const seen: BlockedAttempt[] = [];
		store.add(guard.onDidBlock(e => seen.push(e)));
		assert.strictEqual(guard.check('http://127.0.0.1:1/'), true);
		assert.strictEqual(guard.check('https://example.com/a?b', 'renderer'), false);
		assert.strictEqual(guard.check('https://api.github.com/'), false);
		assert.deepStrictEqual(seen.map(e => [e.url, e.origin]), [['https://example.com/a?b', 'renderer'], ['https://api.github.com/', 'main']]);
		assert.ok(seen.every(e => typeof e.time === 'number' && e.time > 0));
	});

	test('target changes fire with the merged list', () => {
		const guard = createGuard();
		const seen: string[][] = [];
		store.add(guard.onDidChangeTargets(t => seen.push(t.map(x => `${x.host}:${x.port}`))));
		guard.setTargets('settings', ['http://10.0.0.5:8000', 'http://127.0.0.1:11434']);
		guard.setTargets('mcp', ['http://10.0.0.5:8000/mcp', 'http://gpubox:9000']);
		assert.deepStrictEqual(seen, [['10.0.0.5:8000', '127.0.0.1:11434'], ['10.0.0.5:8000', '127.0.0.1:11434', 'gpubox:9000']]);
		assert.deepStrictEqual(guard.targets.map(x => `${x.host}:${x.port}`), ['10.0.0.5:8000', '127.0.0.1:11434', 'gpubox:9000']);
	});

	test('a request lease keeps its endpoint allowed for the request\'s lifetime, whatever the window sets meanwhile', () => {
		const guard = createGuard();
		guard.setSettingsTargets('window:1', ['http://10.255.255.1:8000']);
		const lease = guard.leaseSettingsTarget('window:1', 'http://10.255.255.1:8000');
		// the user edits the field: each keystroke replaces the window's list
		guard.setSettingsTargets('window:1', ['http://10.255.255.1:80']);
		guard.setSettingsTargets('window:1', ['http://localhost:8000']);
		assert.strictEqual(guard.check('http://10.255.255.1:8000/v1/models'), true, 'in-flight request (and its retries) still allowed');
		lease.dispose();
		assert.strictEqual(guard.check('http://10.255.255.1:8000/v1/models'), false, 'released with the request');
		lease.dispose();
		assert.strictEqual(guard.check('http://10.255.255.1:8000/v1/models'), false, 'double release is harmless');
	});

	test('a lease taken before the window\'s settings arrive allows the request it was taken for', () => {
		const guard = createGuard();
		const lease = guard.leaseSettingsTarget('window:1', 'http://10.255.255.1:8000');
		assert.strictEqual(guard.check('http://10.255.255.1:8000/v1/models'), true);
		assert.deepStrictEqual(guard.targets.map(x => `${x.host}:${x.port}`), ['10.255.255.1:8000']);
		lease.dispose();
		assert.deepStrictEqual(guard.targets, []);
	});

	test('a lease of an endpoint already allowed changes nothing and fires nothing', () => {
		const guard = createGuard();
		guard.setSettingsTargets('window:1', ['http://10.0.0.5:8000']);
		let fired = 0;
		store.add(guard.onDidChangeTargets(() => fired++));
		guard.leaseSettingsTarget('window:1', 'http://10.0.0.5:8000/').dispose();
		assert.strictEqual(fired, 0);
		guard.leaseSettingsTarget('window:1', 'http://10.0.0.6:8000/').dispose();
		assert.strictEqual(fired, 2);
	});

	test('leases are counted, per window, and dropped with the window', () => {
		const guard = createGuard();
		const a = guard.leaseSettingsTarget('window:1', 'http://10.0.0.5:8000');
		const b = guard.leaseSettingsTarget('window:1', 'http://10.0.0.5:8000');
		const c = guard.leaseSettingsTarget('window:2', 'http://10.0.0.7:8000');
		a.dispose();
		assert.strictEqual(guard.check('http://10.0.0.5:8000/'), true, 'b still holds it');
		guard.removeSettingsClient('window:1');
		assert.strictEqual(guard.check('http://10.0.0.5:8000/'), false, 'window closed');
		b.dispose();
		const d = guard.leaseSettingsTarget('window:1', 'http://10.0.0.9:8000');
		guard.removeSettingsClient('window:1');
		assert.strictEqual(guard.check('http://10.0.0.9:8000/'), false, 'a window with only leases is dropped too');
		assert.strictEqual(guard.check('http://10.0.0.7:8000/'), true, 'other windows untouched');
		c.dispose();
		d.dispose();
		assert.deepStrictEqual(guard.targets, []);
	});

	test('node hooks', async () => {
		const guard = createGuard();
		const realFetch = globalThis.fetch;
		const originals = [http.request, http.get, https.request, https.get, net.Socket.prototype.connect];
		const stubCalls: string[] = [];
		const stub = (async (input: string | URL | Request) => { stubCalls.push(String(input)); return new Response('ok'); }) as typeof fetch;
		globalThis.fetch = stub;
		try {
			const hooks = guard.installNodeHooks();
			try {
				await assert.rejects(fetch('https://api.github.com/'), (e: Error) => e.message === blockedMessage('api.github.com:443'));
				assert.deepStrictEqual(stubCalls, []);

				await fetch('http://127.0.0.1:1/');
				assert.deepStrictEqual(stubCalls, ['http://127.0.0.1:1/']);

				const req = https.request({ host: 'example.com' });
				assert.strictEqual((await nextError(req)).message, blockedMessage('example.com:443'));

				const req2 = http.get('http://example.org:8080/path');
				assert.strictEqual((await nextError(req2)).message, blockedMessage('example.org:8080'));

				const sock = net.connect({ host: 'example.net', port: 25 });
				assert.strictEqual((await nextError(sock)).message, blockedMessage('example.net:25'));

				const tlsSock = tls.connect(443, 'example.com');
				assert.strictEqual((await nextError(tlsSock)).message, blockedMessage('example.com:443'));
			} finally {
				hooks.dispose();
			}
			assert.strictEqual(globalThis.fetch, stub);
			assert.deepStrictEqual([http.request, http.get, https.request, https.get, net.Socket.prototype.connect], originals);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	test('main-process node hooks police UDP and DNS', async () => {
		const guard = createGuard();
		const originals = [dgram.Socket.prototype.send, dgram.Socket.prototype.connect, dns.lookup, dns.promises.resolve4];
		const hooks = guard.installNodeHooks();
		const sock = dgram.createSocket('udp4');
		try {
			assert.ok([dgram.Socket.prototype.send, dgram.Socket.prototype.connect, dns.lookup, dns.promises.resolve4].every((f, i) => f !== originals[i]), 'every function is wrapped');
			const err = await new Promise<Error | null>(r => sock.send('x', 53, '8.8.8.8', e => r(e)));
			assert.strictEqual(err?.message, blockedMessage('8.8.8.8:53'));
			await assert.rejects(dns.promises.resolve4('exfil.example.com'), (e: Error) => e.message === blockedMessage('dns://exfil.example.com'));
			assert.deepStrictEqual(guard.recentBlocked.map(b => b.url), ['http://8.8.8.8:53/', 'dns://exfil.example.com/']);
		} finally {
			sock.close();
			hooks.dispose();
		}
		assert.deepStrictEqual([dgram.Socket.prototype.send, dgram.Socket.prototype.connect, dns.lookup, dns.promises.resolve4], originals);
	});

	test('node hooks let loopback sockets through', async () => {
		const guard = createGuard();
		const hooks = guard.installNodeHooks();
		const server = net.createServer(s => s.end());
		try {
			await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
			const port = (server.address() as net.AddressInfo).port;
			const sock = net.connect(port, '127.0.0.1');
			await new Promise<void>((resolve, reject) => { sock.once('connect', resolve); sock.once('error', reject); });
			sock.destroy();
		} finally {
			hooks.dispose();
			await new Promise(r => server.close(r));
		}
	});

	suite('ledger counting', () => {
		const strip = (rows: LedgerBody[]) => rows.map(r => {
			const { hour, minute, ...rest } = r as LedgerBody & { hour?: string; minute?: string };
			return rest;
		});

		test('counts allowed sockets and requests, not wrappers or lookups', () => {
			const ledger = new LedgerAggregator();
			const guard = store.add(new EgressGuard(ledger));
			guard.setTargets('settings', ['http://10.0.0.5:8000']);
			assert.strictEqual(guard.check('http://10.0.0.5:8000/', 'main', 'socket'), true);
			assert.strictEqual(guard.check('http://10.0.0.5:8000/v1/chat?x=1', 'renderer'), true);
			assert.strictEqual(guard.check('http://10.0.0.5:8000/v1', 'main', 'wrapper'), true);
			assert.strictEqual(guard.check('dns://10.0.0.5/', 'main', 'lookup'), true);
			assert.strictEqual(guard.check('vscode-file://vscode-app/x.js', 'renderer'), true);
			assert.deepStrictEqual(strip(ledger.drain()), [
				{ type: 'allowed', dest: '10.0.0.5:8000', kind: 'local network', reason: 'model server (set in Settings)', origin: 'main', count: 1 },
				{ type: 'allowed', dest: '10.0.0.5:8000', kind: 'local network', reason: 'model server (set in Settings)', origin: 'renderer', count: 1 },
			]);
		});

		test('a matched target without a reason is still allowed, under a fallback label', () => {
			const ledger = new LedgerAggregator();
			const guard = store.add(new EgressGuard(ledger));
			guard.setTargets('settings', ['http://10.0.0.5:8000']);
			// a reason-less target (as an extension host's older DTO could carry) must not change the decision
			(guard as unknown as { _targets: { host: string; port: number }[] })._targets = [{ host: '10.0.0.5', port: 8000 }];
			assert.strictEqual(guard.check('http://10.0.0.5:8000/', 'main', 'socket'), true);
			assert.deepStrictEqual(strip(ledger.drain()).map(r => (r as { reason?: string }).reason), ['listed target']);
		});

		test('reportAllowed uses current reason and falls back', async () => {
			const ledger = new LedgerAggregator();
			const guard = store.add(new EgressGuard(ledger));
			guard.setTargets('mcp', ['http://mcp.corp.internal:9000/sse']);
			guard.reportAllowed([{ url: 'http://mcp.corp.internal:9000/', count: 3 }, { url: 'http://127.0.0.1:1/', count: 2 }, { url: 'http://gone.corp.internal:80/', count: 1 }], 'extensionHost');
			const channel = new EgressGuardChannel(guard, { canSetSettings: false, reportOrigin: 'sharedProcess' });
			await channel.call('main', 'reportAllowed', [[{ url: 'http://127.0.0.1:2/', count: 4 }, { url: 'http://127.0.0.1:3/', count: -1 }, { url: 7, count: 1 }, 'junk']]);
			assert.deepStrictEqual(strip(ledger.drain()), [
				{ type: 'allowed', dest: '127.0.0.1:1', kind: 'this machine', reason: 'this machine', origin: 'extensionHost', count: 2 },
				{ type: 'allowed', dest: '127.0.0.1:2', kind: 'this machine', reason: 'this machine', origin: 'sharedProcess', count: 4 },
				{ type: 'allowed', dest: 'gone.corp.internal:80', kind: 'local network', reason: 'allowed by that process', origin: 'extensionHost', count: 1 },
				{ type: 'allowed', dest: 'mcp.corp.internal:9000', kind: 'local network', reason: 'MCP server', origin: 'extensionHost', count: 3 },
			]);
		});

		test('blocks are counted per kind', async () => {
			const ledger = new LedgerAggregator();
			const guard = store.add(new EgressGuard(ledger));
			assert.strictEqual(guard.check('https://example.com/a', 'main', 'wrapper'), false);
			assert.strictEqual(guard.check('http://example.com:443/', 'main', 'socket'), false);
			assert.strictEqual(guard.check('dns://exfil.example.com/', 'main', 'lookup'), false);
			assert.strictEqual(guard.check('https://example.com/b', 'renderer'), false);
			await new EgressGuardChannel(guard, { canSetSettings: true, reportOrigin: 'extensionHost' }).call('window:1', 'reportBlocked', ['https://example.com/']);
			const key = (r: object) => Object.entries(r).sort().join('|');
			const byKey = (x: object, y: object) => key(x).localeCompare(key(y));
			assert.deepStrictEqual(strip(ledger.drain()).sort(byKey), [
				{ type: 'blocked', dest: 'example.com:443', origin: 'extensionHost', count: 1 },
				{ type: 'blocked', dest: 'example.com:443', origin: 'main', count: 2 },
				{ type: 'blocked', dest: 'example.com:443', origin: 'renderer', count: 1 },
				{ type: 'blocked_lookup', host: 'exfil.example.com', origin: 'main', count: 1 },
			].sort(byKey));
			assert.strictEqual(guard.recentBlocked.length, 5, 'each block is recorded once');
		});

		test('main node hooks count the socket, not the fetch wrapper', async () => {
			const ledger = new LedgerAggregator();
			const guard = store.add(new EgressGuard(ledger));
			const hooks = guard.installNodeHooks();
			const server = http.createServer((_q, r) => r.end('ok'));
			try {
				await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
				const port = (server.address() as net.AddressInfo).port;
				assert.strictEqual(await (await fetch(`http://127.0.0.1:${port}/path?q=1`)).text(), 'ok');
				await assert.rejects(fetch('https://exfil.example.com/'));
				assert.deepStrictEqual(strip(ledger.drain()).map(r => [r.type, (r as { dest?: string }).dest, (r as { count?: number }).count]), [
					['allowed', `127.0.0.1:${port}`, 1],
					['blocked', 'exfil.example.com:443', 1],
				]);
			} finally {
				hooks.dispose();
				server.closeAllConnections();
				await new Promise(r => server.close(r));
			}
		});
	});

	suite('EgressGuardChannel', () => {
		const windows = { canSetSettings: true, reportOrigin: 'extensionHost' } as const;
		const fmt = (guard: EgressGuard) => guard.targets.map(x => `${x.host}:${x.port}`);

		test('settings are kept per window; the allow-list is their union', async () => {
			const guard = createGuard();
			const channel = new EgressGuardChannel(guard, windows);
			await channel.call('window:1', 'setTargets', ['settings', ['http://10.0.0.5:8000']]);
			await channel.call('window:2', 'setTargets', ['settings', ['http://10.0.0.7:8000']]);
			assert.deepStrictEqual(fmt(guard), ['10.0.0.5:8000', '10.0.0.7:8000']);
			// a stale window re-sending its own list does not drop the other window's endpoint
			await channel.call('window:2', 'setTargets', ['settings', ['http://10.0.0.7:8000']]);
			assert.strictEqual(guard.check('http://10.0.0.5:8000/'), true);
			// a window replacing its list removes its old endpoint
			await channel.call('window:1', 'setTargets', ['settings', []]);
			assert.deepStrictEqual(fmt(guard), ['10.0.0.7:8000']);
		});

		test('a closed window\'s settings are dropped', async () => {
			const guard = createGuard();
			const channel = new EgressGuardChannel(guard, windows);
			await channel.call('window:1', 'setTargets', ['settings', ['http://10.0.0.5:8000']]);
			await channel.call('window:2', 'setTargets', ['settings', ['http://10.0.0.5:8000', 'http://gpubox:8000']]);
			guard.removeSettingsClient('window:2');
			assert.deepStrictEqual(fmt(guard), ['10.0.0.5:8000']);
			guard.removeSettingsClient('window:1');
			assert.strictEqual(guard.check('http://10.0.0.5:8000/'), false);
		});

		test('only settings may be set, and only where allowed', async () => {
			const guard = createGuard();
			await assert.rejects(new EgressGuardChannel(guard, windows).call('window:1', 'setTargets', ['mcp', ['http://evil.example:80']]));
			await assert.rejects(new EgressGuardChannel(guard, { canSetSettings: false, reportOrigin: 'sharedProcess' }).call('main', 'setTargets', ['settings', ['http://evil.example:80']]));
			assert.strictEqual(guard.check('http://evil.example/'), false);
			await new EgressGuardChannel(guard, windows).call('window:1', 'setTargets', ['settings', ['http://10.0.0.5:8000', 42]]);
			assert.deepStrictEqual(fmt(guard), ['10.0.0.5:8000']);
		});

		test('reports are recorded with the channel origin, and buffered', async () => {
			const guard = createGuard();
			const seen: BlockedAttempt[] = [];
			store.add((new EgressGuardChannel(guard, windows).listen('window:1', 'onDidBlock') as Event<BlockedAttempt>)(e => seen.push(e)));
			await new EgressGuardChannel(guard, windows).call('window:1', 'reportBlocked', ['https://example.com/']);
			await new EgressGuardChannel(guard, { canSetSettings: false, reportOrigin: 'sharedProcess' }).call('main', 'reportBlocked', ['https://marketplace.example/']);
			assert.deepStrictEqual(seen.map(e => [e.url, e.origin]), [['https://example.com/', 'extensionHost'], ['https://marketplace.example/', 'sharedProcess']]);
			const recent = await new EgressGuardChannel(guard, windows).call('window:1', 'getRecentBlocked') as BlockedAttempt[];
			assert.deepStrictEqual(recent.map(e => e.url), ['https://example.com/', 'https://marketplace.example/']);
		});
	});
});

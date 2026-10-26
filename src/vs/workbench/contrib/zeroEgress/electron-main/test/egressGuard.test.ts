/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BlockedAttempt } from '../../common/egressGuardService.js';
import { EgressGuard, EgressGuardMainService } from '../egressGuard.js';

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

	test('node hooks', async () => {
		const guard = createGuard();
		const realFetch = globalThis.fetch;
		const originals = [http.request, http.get, https.request, https.get, net.connect, net.createConnection, tls.connect];
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
			assert.deepStrictEqual([http.request, http.get, https.request, https.get, net.connect, net.createConnection, tls.connect], originals);
		} finally {
			globalThis.fetch = realFetch;
		}
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

	suite('EgressGuardMainService', () => {
		test('renderer may only set settings targets', async () => {
			const guard = createGuard();
			const service = store.add(new EgressGuardMainService(guard));
			await service.setTargets('settings', ['http://10.0.0.5:8000']);
			assert.strictEqual(guard.check('http://10.0.0.5:8000/'), true);
			await assert.rejects(service.setTargets('mcp' as 'settings', ['http://evil.example:80']));
			assert.strictEqual(guard.check('http://evil.example/'), false);
		});

		test('extension host reports are recorded with their origin', async () => {
			const guard = createGuard();
			const service = store.add(new EgressGuardMainService(guard));
			const seen: BlockedAttempt[] = [];
			const listeners = new DisposableStore();
			listeners.add(service.onDidBlock(e => seen.push(e)));
			await service.reportBlocked('https://example.com/');
			assert.deepStrictEqual(seen.map(e => [e.url, e.origin]), [['https://example.com/', 'extensionHost']]);
			assert.deepStrictEqual((await service.getRecentBlocked()).map(e => e.url), ['https://example.com/']);
			listeners.dispose();
		});
	});
});

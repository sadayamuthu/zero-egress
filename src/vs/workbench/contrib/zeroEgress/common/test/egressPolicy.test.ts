/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { collectEgressTargets, describeDestination, isAllowed, isLoopbackHost, isNetworkUrl, isPrivateHost, targetFromUrl } from '../egressPolicy.js';

suite('egressPolicy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('targetFromUrl normalizes and rejects', () => {
		assert.deepStrictEqual(targetFromUrl('http://LOCALHOST:11434/'), { host: 'localhost', port: 11434 });
		assert.deepStrictEqual(targetFromUrl('http://gpubox:8000/v1'), { host: 'gpubox', port: 8000 });
		assert.deepStrictEqual(targetFromUrl('https://ai.corp.internal'), { host: 'ai.corp.internal', port: 443 });
		assert.deepStrictEqual(targetFromUrl('http://[::1]:1234'), { host: '::1', port: 1234 });
		assert.strictEqual(targetFromUrl(''), undefined);
		assert.strictEqual(targetFromUrl('localhost:11434'), undefined);
		assert.strictEqual(targetFromUrl('not a url'), undefined);
		assert.strictEqual(targetFromUrl('file:///etc/passwd'), undefined);
	});

	test('targetFromUrl spellings', () => {
		assert.deepStrictEqual(targetFromUrl('http://h.example:8000/'), { host: 'h.example', port: 8000 });
		assert.deepStrictEqual(targetFromUrl('http://h.example'), { host: 'h.example', port: 80 });
		assert.deepStrictEqual(targetFromUrl('ws://h.example'), { host: 'h.example', port: 80 });
		assert.deepStrictEqual(targetFromUrl('wss://h.example'), { host: 'h.example', port: 443 });
		assert.deepStrictEqual(targetFromUrl('http://0.0.0.0:80/'), { host: '0.0.0.0', port: 80 });
		assert.deepStrictEqual(targetFromUrl('http://2130706433/'), { host: '127.0.0.1', port: 80 });
		assert.deepStrictEqual(targetFromUrl('http://LOCALHOST.:11434'), { host: 'localhost', port: 11434 });
	});

	test('isLoopbackHost', () => {
		for (const h of ['localhost', '127.0.0.1', '127.5.5.5', '::1', '0.0.0.0', 'app.localhost', '::ffff:127.0.0.1', '::ffff:7f00:1']) { assert.ok(isLoopbackHost(h), h); }
		for (const h of ['example.com', '10.0.0.5', '128.0.0.1', 'localhost.evil.com']) { assert.ok(!isLoopbackHost(h), h); }
		assert.ok(isLoopbackHost(targetFromUrl('http://[::ffff:127.0.0.1]/')!.host));
		assert.ok(isLoopbackHost(targetFromUrl('http://2130706433/')!.host));
	});

	test('isPrivateHost', () => {
		for (const h of ['10.0.0.5', '172.20.1.1', '192.168.1.9', '169.254.1.1', '100.64.0.1', 'gpubox', 'gpu.local', 'a.lan', 'ai.corp.internal', 'x.home.arpa', 'fd00::1', 'fe80::1', '::ffff:10.0.0.5']) { assert.ok(isPrivateHost(h), h); }
		for (const h of ['api.openai.com', '8.8.8.8', '172.32.0.1', '100.128.0.1', 'example.com', '2001:db8::1']) { assert.ok(!isPrivateHost(h), h); }
		assert.ok(isPrivateHost(targetFromUrl('http://gpubox:11434')!.host));
		assert.ok(isPrivateHost(targetFromUrl('http://gpu.local:11434')!.host));
		assert.ok(isPrivateHost(targetFromUrl('http://10.0.0.5:8000')!.host));
		assert.ok(isPrivateHost(targetFromUrl('http://[::ffff:10.0.0.5]/')!.host));
	});

	test('isNetworkUrl', () => {
		for (const u of ['http://a', 'https://a', 'ws://a', 'wss://a']) { assert.ok(isNetworkUrl(u), u); }
		for (const u of ['file:///x', 'data:text/plain,hi', 'blob:abc', 'devtools://devtools/x', 'vscode-file://vscode-app/x.js', 'chrome-extension://x']) { assert.ok(!isNetworkUrl(u), u); }
	});

	test('collect and isAllowed', () => {
		const t = collectEgressTargets({ providerEndpoints: ['http://10.0.0.5:8000/v1', ''], mcpServerUrls: ['https://mcp.lan/sse'], auditCollectorUrl: undefined });
		assert.ok(isAllowed('http://10.0.0.5:8000/v1/chat/completions', t));
		assert.ok(isAllowed('https://mcp.lan/sse', t));
		assert.ok(!isAllowed('http://10.0.0.5:8001/', t));
		assert.ok(!isAllowed('http://10.0.0.6:8000/', t));
		assert.ok(!isAllowed('https://us.i.posthog.com/batch', t));
		assert.ok(isAllowed('http://127.0.0.1:11434/api/chat', []));
		assert.ok(isAllowed('vscode-file://vscode-app/x.js', []));
		assert.ok(!isAllowed('https://api.github.com/', []));
	});

	test('configured spellings are allowed, nothing else', () => {
		for (const ep of ['http://Gpu.Box:8000/', 'http://gpu.box:8000/v1', 'http://gpu.box:8000', 'http://gpu.box.:8000']) {
			const t = collectEgressTargets({ providerEndpoints: [ep], mcpServerUrls: [], auditCollectorUrl: undefined });
			assert.ok(isAllowed('http://gpu.box:8000/x', t), ep);
			assert.ok(isAllowed('ws://gpu.box:8000/x', t), ep);
			assert.ok(!isAllowed('http://gpu.box:8001/x', t), ep);
		}
		const t = collectEgressTargets({ providerEndpoints: ['https://h.example'], mcpServerUrls: [], auditCollectorUrl: undefined });
		assert.ok(isAllowed('https://h.example:443/', t));
		assert.ok(!isAllowed('http://h.example/', t));
	});

	test('malformed input does not crash and stays strict', () => {
		const t = collectEgressTargets({ providerEndpoints: ['', 'localhost:11434', 'not a url'], mcpServerUrls: [], auditCollectorUrl: '' });
		assert.deepStrictEqual(t, []);
		assert.ok(!isAllowed('http://', t));
		assert.ok(!isAllowed('http://exa mple.com/', t));
	});

	test('collect dedupes and includes audit collector', () => {
		const t = collectEgressTargets({ providerEndpoints: ['http://a.lan:1/x', 'HTTP://A.LAN:1/'], mcpServerUrls: ['http://a.lan:1'], auditCollectorUrl: 'https://audit.lan:9443/ingest' });
		assert.deepStrictEqual(t, [{ host: 'a.lan', port: 1 }, { host: 'audit.lan', port: 9443 }]);
	});

	test('control characters cannot hide a network scheme', () => {
		for (const u of ['\x01http://evil.com/', '\x00https://evil.com', 'ht\ttp://evil.com/', 'h\nttps://evil.com/', 'http\r://evil.com']) {
			assert.strictEqual(isNetworkUrl(u), true, JSON.stringify(u));
			assert.strictEqual(isAllowed(u, []), false, JSON.stringify(u));
		}
		assert.ok(isAllowed('\x01http://127.0.0.1:11434/', []));
		assert.ok(isAllowed('HTTP://LOCALHOST:11434', []));
	});

	test('unknown schemes and unparseable strings are denied', () => {
		for (const u of ['ftp://evil.com/', 'gopher://evil.com/', '//evil.com', 'evil.com', 'localhost:11434', '']) {
			assert.strictEqual(isAllowed(u, []), false, JSON.stringify(u));
		}
	});

	test('explicit non-network schemes are allowed', () => {
		for (const u of ['about:blank', 'javascript:void 0', 'chrome-extension://x/y', 'vscode-webview://abc/index.html', 'data:text/plain,hi', 'blob:vscode-file://x/uuid', 'file:///tmp/x']) {
			assert.strictEqual(isAllowed(u, []), true, u);
		}
	});

	test('describeDestination names host:port, or the scheme for non-network URLs', () => {
		assert.strictEqual(describeDestination('https://api.github.com/x?token=secret'), 'api.github.com:443');
		assert.strictEqual(describeDestination('http://[::1]:8000/'), '[::1]:8000');
		assert.strictEqual(describeDestination('ftp://user:pw@evil.com/f'), 'ftp://evil.com');
		assert.strictEqual(describeDestination('not a url'), 'unparseable URL');
	});
});

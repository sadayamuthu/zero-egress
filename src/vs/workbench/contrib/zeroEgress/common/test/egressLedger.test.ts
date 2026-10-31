/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { LedgerAggregator } from '../egressLedger.js';

suite('EgressLedger', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const T = Date.UTC(2026, 9, 30, 10, 15, 30);
	const HOUR = 3600_000;

	test('only host and port are kept', () => {
		const l = new LedgerAggregator();
		l.addAllowed('https://api.example.com:8443/v1?token=abc', 'model server (set in Settings)', 'main', T);
		const rows = l.drain();
		assert.strictEqual(rows.length, 1);
		assert.deepStrictEqual(rows[0], { type: 'allowed', hour: '2026-10-30T10:00:00.000Z', dest: 'api.example.com:8443', kind: 'internet', reason: 'model server (set in Settings)', origin: 'main', count: 1 });
		const s = JSON.stringify(rows);
		assert.ok(!s.includes('token') && !s.includes('/v1'));
	});

	test('allowed counts share an hour bucket', () => {
		const l = new LedgerAggregator();
		for (let i = 0; i < 3; i++) { l.addAllowed('https://a.example:443/x', 'r', 'main', T + i * 1000); }
		let rows = l.drain();
		assert.strictEqual(rows.length, 1);
		assert.strictEqual((rows[0] as { count: number }).count, 3);
		l.addAllowed('https://a.example/', 'r', 'main', T);
		l.addAllowed('https://a.example/', 'r', 'main', T + HOUR);
		rows = l.drain();
		assert.strictEqual(rows.length, 2);
	});

	test('blocked attempts collapse per minute', () => {
		const l = new LedgerAggregator();
		for (let i = 0; i < 10000; i++) { l.addBlocked('https://evil.example/p', 'renderer', T); }
		const rows = l.drain();
		assert.strictEqual(rows.length, 1);
		assert.deepStrictEqual(rows[0], { type: 'blocked', minute: '2026-10-30T10:15:00.000Z', dest: 'evil.example:443', origin: 'renderer', count: 10000 });
	});

	test('dns blocks become lookups', () => {
		const l = new LedgerAggregator();
		l.addBlocked('dns://evil.example/', 'main', T);
		assert.deepStrictEqual(l.drain(), [{ type: 'blocked_lookup', minute: '2026-10-30T10:15:00.000Z', host: 'evil.example', origin: 'main', count: 1 }]);
	});

	test('non-network schemes are not counted as allowed', () => {
		const l = new LedgerAggregator();
		l.addAllowed('vscode-file://vscode-app/a/b.js', 'r', 'renderer', T);
		l.addAllowed('data:text/plain,hi', 'r', 'renderer', T);
		assert.deepStrictEqual(l.drain(), []);
	});

	test('blocks that are not host:port-shaped are recorded as scheme://host, without path or query', () => {
		const l = new LedgerAggregator();
		l.addBlocked('ftp://user:pw@evil.example/secret/file.txt?token=abc', 'renderer', T);
		l.addBlocked('invalid-host://bad%20host', 'extensionHost', T);
		l.addBlocked('tcp://evil.example', 'main', T); // no port
		l.addBlocked('data:text/plain,secret', 'renderer', T);
		const rows = l.drain() as { dest: string }[];
		assert.deepStrictEqual(rows.map(r => r.dest).sort(), ['data:', 'ftp://evil.example', 'invalid-host://bad%20host', 'tcp://evil.example']);
		const s = JSON.stringify(rows);
		assert.ok(!s.includes('secret') && !s.includes('token') && !s.includes('pw') && !s.includes('file.txt'));
	});

	test('kinds', () => {
		const l = new LedgerAggregator();
		l.addAllowed('http://127.0.0.1:11434/api', 'r', 'main', T);
		l.addAllowed('tcp://192.168.1.20:8000', 'r', 'main', T);
		const rows = l.drain() as { dest: string; kind: string }[];
		assert.deepStrictEqual(rows.map(r => [r.dest, r.kind]), [['127.0.0.1:11434', 'this machine'], ['192.168.1.20:8000', 'local network']]);
	});

	test('drain empties', () => {
		const l = new LedgerAggregator();
		l.addAllowed('https://a.example/', 'r', 'main', T);
		assert.strictEqual(l.drain().length, 1);
		assert.deepStrictEqual(l.drain(), []);
	});
});

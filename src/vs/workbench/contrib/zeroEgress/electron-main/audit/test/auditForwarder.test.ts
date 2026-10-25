/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import { HttpAuditForwarder } from '../auditForwarder.js';
import { AuditRecord } from '../../../common/auditTypes.js';

function rec(id: string): AuditRecord {
	return {
		seq: 1, id, prevHash: '0'.repeat(64), timestamp: '2026-07-12T00:00:00.000Z',
		machineId: 'm', userId: 'u', appVersion: '1', zeroEgressVersion: 'b',
		workspace: { folderUri: null, repoName: null, gitRemote: null, gitBranch: null, gitCommit: null },
		provider: 'anthropic', modelName: 'claude-opus-4-8', chatMode: 'agent',
		request: { systemPrompt: 's', messages: [], tools: [] },
		response: { text: 't', toolCalls: [], finishReason: 'stop' },
		outcome: 'completed', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
		timing: { startedAt: '2026-07-12T00:00:00.000Z', durationMs: 5 }, error: null,
	};
}

function startServer(handler: http.RequestListener): Promise<{ url: string; received: string[]; headers: http.IncomingHttpHeaders[]; close: () => Promise<void> }> {
	const received: string[] = [];
	const headers: http.IncomingHttpHeaders[] = [];
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			let bodyStr = '';
			req.on('data', c => bodyStr += c);
			req.on('end', () => { received.push(bodyStr); headers.push(req.headers); handler(req, res); });
		});
		server.listen(0, '127.0.0.1', () => {
			const port = (server.address() as AddressInfo).port;
			resolve({
				url: `http://127.0.0.1:${port}/ingest`, received, headers,
				close: () => new Promise(r => server.close(() => r())),
			});
		});
	});
}

suite('HttpAuditForwarder', () => {
	test('POSTs NDJSON with auth header and returns ok on 2xx', async () => {
		const srv = await startServer((_req, res) => { res.statusCode = 200; res.end('ok'); });
		try {
			const fwd = new HttpAuditForwarder({ endpointUrl: srv.url, authHeader: 'Authorization: Bearer secret' });
			const result = await fwd.send([rec('a'), rec('b')]);
			assert.deepStrictEqual(result, { ok: true });
			const lines = srv.received[0].trim().split('\n');
			assert.strictEqual(lines.length, 2);
			assert.strictEqual((JSON.parse(lines[0]) as AuditRecord).id, 'a');
			assert.strictEqual(srv.headers[0]['authorization'], 'Bearer secret');
		} finally { await srv.close(); }
	});

	test('returns ok:false on 5xx (no throw)', async () => {
		const srv = await startServer((_req, res) => { res.statusCode = 503; res.end('down'); });
		try {
			const fwd = new HttpAuditForwarder({ endpointUrl: srv.url, authHeader: '' });
			assert.deepStrictEqual(await fwd.send([rec('a')]), { ok: false });
		} finally { await srv.close(); }
	});

	test('returns ok:false on connection failure (no throw)', async () => {
		const fwd = new HttpAuditForwarder({ endpointUrl: 'http://127.0.0.1:1/ingest', authHeader: '' });
		assert.deepStrictEqual(await fwd.send([rec('a')]), { ok: false });
	});

	test('preserves colons in the auth header value', async () => {
		const srv = await startServer((_req, res) => { res.statusCode = 200; res.end('ok'); });
		try {
			const fwd = new HttpAuditForwarder({ endpointUrl: srv.url, authHeader: 'Authorization: Bearer a:b:c' });
			assert.deepStrictEqual(await fwd.send([rec('a')]), { ok: true });
			assert.strictEqual(srv.headers[0]['authorization'], 'Bearer a:b:c');
		} finally { await srv.close(); }
	});

	test('returns ok:false when the server never responds (timeout)', async () => {
		// server that accepts but never responds
		const srv = await startServer(() => { /* intentionally never call res.end */ });
		try {
			const fwd = new HttpAuditForwarder({ endpointUrl: srv.url, authHeader: '', timeoutMs: 150 });
			assert.deepStrictEqual(await fwd.send([rec('a')]), { ok: false });
		} finally { await srv.close(); }
	});

	test('returns ok:false (never throws) when authHeader has an invalid header value', async () => {
		const srv = await startServer((_req, res) => { res.statusCode = 200; res.end('ok'); });
		try {
			// embedded newline makes Node's header validation throw synchronously
			const fwd = new HttpAuditForwarder({ endpointUrl: srv.url, authHeader: 'Authorization: bad\r\nvalue' });
			assert.deepStrictEqual(await fwd.send([rec('a')]), { ok: false });
		} finally { await srv.close(); }
	});
});

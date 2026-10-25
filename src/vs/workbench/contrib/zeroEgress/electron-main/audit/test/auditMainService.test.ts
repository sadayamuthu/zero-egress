/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { AuditMainService, BeginParams, FinalizeParams, createDisabledAuditService } from '../auditMainService.js';
import { LocalAuditStore } from '../localAuditStore.js';
import { IAuditForwarder } from '../auditForwarder.js';
import { AuditRecord, IAuditConfig } from '../../../common/auditTypes.js';

const CONFIG: IAuditConfig = { enabled: true, endpointUrl: 'x', authHeader: '', batchSize: 50, flushIntervalMs: 15000, maxLocalRetentionDays: 90 };

class FakeForwarder implements IAuditForwarder {
	public sent: AuditRecord[][] = [];
	public ok = true;
	async send(records: AuditRecord[]) { this.sent.push(records); return { ok: this.ok }; }
}

function begin(over: Partial<BeginParams> = {}): BeginParams {
	return {
		requestId: 'req-1', provider: 'anthropic', modelName: 'claude-opus-4-8', chatMode: 'agent',
		systemPrompt: 'sys', messages: [{ role: 'user' }], tools: [],
		workspace: { folderUri: null, repoName: null, gitRemote: null, gitBranch: null, gitCommit: null },
		identity: { machineId: 'm', userId: 'u', appVersion: '1', zeroEgressVersion: 'b' },
		startedAtMs: 1000, nowIso: '2026-07-12T00:00:00.000Z', ...over,
	};
}
function finalize(over: Partial<FinalizeParams> = {}): FinalizeParams {
	return {
		requestId: 'req-1', outcome: 'completed', text: 'answer', toolCalls: [], finishReason: 'stop',
		usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.01 }, error: null, endedAtMs: 1500, ...over,
	};
}

let tmpDir: string, store: LocalAuditStore, fwd: FakeForwarder, errors: string[];

async function makeService(cfg: IAuditConfig = CONFIG) {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-egress-audit-svc-'));
	store = await LocalAuditStore.create(path.join(tmpDir, 'a.vscdb'));
	fwd = new FakeForwarder();
	errors = [];
	return new AuditMainService(cfg, store, fwd, (m: string) => errors.push(m));
}

suite('AuditMainService', () => {
	teardown(async () => { await store.dispose(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

	test('completed exchange is stored with duration and usage', async () => {
		const svc = await makeService();
		svc.begin(begin());
		svc.appendText('req-1', 'answer');
		await svc.finalize(finalize());
		const stored = await store.getUnforwarded(10);
		assert.strictEqual(stored.length, 1);
		assert.strictEqual(stored[0].outcome, 'completed');
		assert.strictEqual(stored[0].response.text, 'answer');
		assert.strictEqual(stored[0].timing.durationMs, 500);
		assert.strictEqual(stored[0].usage.outputTokens, 20);
	});

	test('aborted exchange keeps partial streamed text', async () => {
		const svc = await makeService();
		svc.begin(begin());
		svc.appendText('req-1', 'partial so f');
		await svc.finalize(finalize({ outcome: 'aborted', text: 'partial so f', finishReason: null }));
		const stored = await store.getUnforwarded(10);
		assert.strictEqual(stored[0].outcome, 'aborted');
		assert.strictEqual(stored[0].response.text, 'partial so f');
	});

	test('aborted with empty finalize text falls back to streamed latestText', async () => {
		const svc = await makeService();
		svc.begin(begin());
		svc.appendText('req-1', 'streamed so far');
		await svc.finalize(finalize({ outcome: 'aborted', text: '', finishReason: null }));
		const stored = await store.getUnforwarded(10);
		assert.strictEqual(stored[0].outcome, 'aborted');
		assert.strictEqual(stored[0].response.text, 'streamed so far'); // proves p.text || entry.latestText fallback
	});

	test('error exchange records the error string', async () => {
		const svc = await makeService();
		svc.begin(begin());
		await svc.finalize(finalize({ outcome: 'error', text: '', error: 'boom' }));
		const stored = await store.getUnforwarded(10);
		assert.strictEqual(stored[0].outcome, 'error');
		assert.strictEqual(stored[0].error, 'boom');
	});

	test('disabled config makes begin/finalize no-ops', async () => {
		const svc = await makeService({ ...CONFIG, enabled: false });
		assert.strictEqual(svc.isEnabled, false);
		svc.begin(begin());
		await svc.finalize(finalize());
		assert.strictEqual((await store.getUnforwarded(10)).length, 0);
	});

	test('flushForwarder marks records forwarded on ok, keeps them on failure', async () => {
		const svc = await makeService();
		svc.begin(begin()); await svc.finalize(finalize());
		fwd.ok = false;
		await svc.flushForwarder();
		assert.strictEqual((await store.getUnforwarded(10)).length, 1); // still pending
		fwd.ok = true;
		await svc.flushForwarder();
		assert.strictEqual((await store.getUnforwarded(10)).length, 0); // now acked
	});

	test('finalize without begin is ignored and logs nothing fatal', async () => {
		const svc = await makeService();
		await svc.finalize(finalize({ requestId: 'never-began' }));
		assert.strictEqual((await store.getUnforwarded(10)).length, 0);
	});

	test('createDisabledAuditService is a safe no-op with isEnabled false', async () => {
		const svc = createDisabledAuditService();
		assert.strictEqual(svc.isEnabled, false);
		svc.begin({} as any);
		svc.appendText('x', 'y');
		await svc.finalize({} as any);
		await svc.flushForwarder();
		// nothing throws; nothing stored (no store involved)
	});

	test('concurrent flushForwarder calls coalesce into one send', async () => {
		const svc = await makeService();
		svc.begin(begin()); await svc.finalize(finalize());
		let concurrent = 0, maxConcurrent = 0;
		const slowFwd = fwd as any;
		const origSend = slowFwd.send.bind(slowFwd);
		slowFwd.send = async (recs: any) => { concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent); await Promise.resolve(); const r = await origSend(recs); concurrent--; return r; };
		await Promise.all([svc.flushForwarder(), svc.flushForwarder(), svc.flushForwarder()]);
		assert.strictEqual(maxConcurrent, 1); // never more than one send in flight
	});

	test('pruneRetention deletes forwarded records older than retention window', async () => {
		const svc = await makeService({ ...CONFIG, maxLocalRetentionDays: 1 });
		svc.begin(begin({ requestId: 'r-old' }));
		await svc.finalize(finalize({ requestId: 'r-old' }));
		// force it forwarded and old by acking then pruning against a now far in the future
		await svc.flushForwarder();
		const now = Date.parse('2026-07-12T00:00:00.000Z') + 5 * 24 * 3600 * 1000; // 5 days later
		const deleted = await svc.pruneRetention(now);
		assert.strictEqual(deleted, 1);
	});
});

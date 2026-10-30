/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { LocalAuditStore } from '../localAuditStore.js';
import { GENESIS_HASH, AuditRecord } from '../../../common/auditTypes.js';

function body(overrides: Partial<Omit<AuditRecord, 'seq' | 'prevHash'>> = {}): Omit<AuditRecord, 'seq' | 'prevHash'> {
	return {
		id: 'id-' + Math.round(Math.abs(Math.sin(overrides.timestamp ? overrides.timestamp.length : 1)) * 1e9),
		timestamp: '2026-07-12T00:00:00.000Z',
		machineId: 'm', userId: 'u', appVersion: '1', zeroEgressVersion: 'b',
		workspace: { folderUri: null, repoName: null, gitRemote: null, gitBranch: null, gitCommit: null },
		provider: 'anthropic', modelName: 'claude-opus-4-8', chatMode: 'agent',
		request: { systemPrompt: 's', messages: [], tools: [] },
		response: { text: 't', toolCalls: [], finishReason: 'stop' },
		outcome: 'completed', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
		timing: { startedAt: '2026-07-12T00:00:00.000Z', durationMs: 5 }, error: null,
		...overrides,
	};
}

let tmpDir: string;
let store: LocalAuditStore;

suite('LocalAuditStore', () => {
	setup(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-egress-audit-'));
		store = await LocalAuditStore.create(path.join(tmpDir, 'audit.vscdb'));
	});
	teardown(async () => {
		await store.dispose();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('append assigns monotonic seq starting at 1', async () => {
		const r1 = await store.append(body({ id: 'a' }));
		const r2 = await store.append(body({ id: 'b' }));
		assert.strictEqual(r1.seq, 1);
		assert.strictEqual(r2.seq, 2);
	});

	test('first record chains from GENESIS_HASH; second chains from first', async () => {
		const r1 = await store.append(body({ id: 'a' }));
		const r2 = await store.append(body({ id: 'b' }));
		assert.strictEqual(r1.prevHash, GENESIS_HASH);
		assert.notStrictEqual(r2.prevHash, GENESIS_HASH);
		const check = await store.verifyChain();
		assert.deepStrictEqual(check, { ok: true });
	});

	test('getUnforwarded returns appended records oldest-first, markForwarded removes them', async () => {
		await store.append(body({ id: 'a' }));
		await store.append(body({ id: 'b' }));
		const pending = await store.getUnforwarded(10);
		assert.deepStrictEqual(pending.map(r => r.id), ['a', 'b']);
		await store.markForwarded(['a', 'b']);
		assert.strictEqual((await store.getUnforwarded(10)).length, 0);
	});

	test('prune deletes only forwarded records older than cutoff', async () => {
		await store.append(body({ id: 'old', timestamp: '2020-01-01T00:00:00.000Z' }));
		await store.append(body({ id: 'new-unforwarded', timestamp: '2020-01-01T00:00:00.000Z' }));
		await store.markForwarded(['old']);
		const deleted = await store.pruneForwardedOlderThan('2021-01-01T00:00:00.000Z');
		assert.strictEqual(deleted, 1);
		const remaining = await store.getUnforwarded(10);
		assert.deepStrictEqual(remaining.map(r => r.id), ['new-unforwarded']);
	});

	test('concurrent appends get unique contiguous seqs and a valid chain', async () => {
		const N = 25;
		const results = await Promise.all(
			Array.from({ length: N }, (_v, i) => store.append(body({ id: 'c' + i })))
		);
		const seqs = results.map(r => r.seq).sort((a, b) => a - b);
		assert.deepStrictEqual(seqs, Array.from({ length: N }, (_v, i) => i + 1));
		assert.deepStrictEqual(await store.verifyChain(), { ok: true });
	});

	test('seq and hash chain continue after all rows are pruned', async () => {
		const r1 = await store.append(body({ id: 'a', timestamp: '2020-01-01T00:00:00.000Z' }));
		await store.markForwarded(['a']);
		const deleted = await store.pruneForwardedOlderThan('2021-01-01T00:00:00.000Z');
		assert.strictEqual(deleted, 1);
		assert.strictEqual((await store.getUnforwarded(10)).length, 0); // table empty
		const r2 = await store.append(body({ id: 'b' }));
		assert.strictEqual(r2.seq, r1.seq + 1);            // seq did NOT reset to 1
		assert.notStrictEqual(r2.prevHash, '0'.repeat(64)); // did NOT restart from GENESIS
	});

	test('records with nested undefined fields still verify (append/verify hash lockstep)', async () => {
		await store.append(body({ id: 'u1', response: { text: 't', toolCalls: [{ name: undefined, args: { x: undefined } }], finishReason: 'stop' } as any }));
		await store.append(body({ id: 'u2' }));
		assert.deepStrictEqual(await store.verifyChain(), { ok: true });
	});

	test('verifyChain detects tampering at the following record', async () => {
		await store.append(body({ id: 'a' }));
		await store.append(body({ id: 'b' }));
		// Tamper the body of seq=1. A hash chain only validates a record via the NEXT record's stored
		// prevHash, so tampering seq=1 (with seq=2 present) surfaces as a break at seq=2.
		await store.__tamperForTest(1, { text: 'HACKED' });
		const check = await store.verifyChain();
		assert.deepStrictEqual(check, { ok: false, brokenAtSeq: 2 });
	});

	test('countByModel counts per provider and model within the period', async () => {
		await store.append(body({ id: 'a', timestamp: '2026-07-12T01:00:00.000Z' }));
		await store.append(body({ id: 'b', timestamp: '2026-07-12T02:00:00.000Z' }));
		await store.append(body({ id: 'c', timestamp: '2026-07-12T02:30:00.000Z', provider: 'ollama', modelName: 'qwen3' }));
		await store.append(body({ id: 'd', timestamp: '2026-07-12T05:00:00.000Z', provider: 'ollama', modelName: 'qwen3' }));
		assert.deepStrictEqual(await store.countByModel('2026-07-12T01:00:00.000Z', '2026-07-12T05:00:00.000Z'), [
			{ provider: 'anthropic', model: 'claude-opus-4-8', requests: 2 },
			{ provider: 'ollama', model: 'qwen3', requests: 1 },
		]);
		assert.deepStrictEqual(await store.countByModel('2026-07-13T00:00:00.000Z', '2026-07-14T00:00:00.000Z'), []);
	});
});

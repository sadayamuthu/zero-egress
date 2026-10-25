/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { computeRecordHash, GENESIS_HASH, AuditRecord } from '../../../common/auditTypes.js';

function makeRecordBody(overrides: Partial<Omit<AuditRecord, 'prevHash'>> = {}): Omit<AuditRecord, 'prevHash'> {
	return {
		seq: 1, id: 'id-1', timestamp: '2026-07-12T00:00:00.000Z',
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

suite('computeRecordHash', () => {
	test('is a 64-char hex string', () => {
		const h = computeRecordHash(GENESIS_HASH, makeRecordBody());
		assert.match(h, /^[0-9a-f]{64}$/);
	});

	test('is deterministic regardless of key order in the body object', () => {
		const a = computeRecordHash(GENESIS_HASH, makeRecordBody({ seq: 7, id: 'x' }));
		const b = computeRecordHash(GENESIS_HASH, makeRecordBody({ id: 'x', seq: 7 }));
		assert.strictEqual(a, b);
	});

	test('changes when the record content changes', () => {
		const a = computeRecordHash(GENESIS_HASH, makeRecordBody({ seq: 1 }));
		const b = computeRecordHash(GENESIS_HASH, makeRecordBody({ seq: 2 }));
		assert.notStrictEqual(a, b);
	});

	test('changes when prevHash changes (chaining)', () => {
		const body = makeRecordBody();
		const a = computeRecordHash(GENESIS_HASH, body);
		const b = computeRecordHash('a'.repeat(64), body);
		assert.notStrictEqual(a, b);
	});
});

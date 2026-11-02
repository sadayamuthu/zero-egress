/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ChatMessage } from '../chatThreadServiceTypes.js';
import { contextUseOf, formatContextUse } from '../contextUse.js';

const user = (n: number): ChatMessage => ({ role: 'user', content: 'a'.repeat(n), displayContent: 'a'.repeat(n), selections: null, state: { stagingSelections: [], isBeingEdited: false } });
const assistant = (n: number, usage?: { promptTokens: number; completionTokens: number }): ChatMessage => ({ role: 'assistant', displayContent: 'a'.repeat(n), reasoning: '', anthropicReasoning: null, usage });

suite('contextUse', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses provider counts', () => {
		const u = contextUseOf([user(40), assistant(10, { promptTokens: 1000, completionTokens: 200 })], 4000, 0);
		assert.strictEqual(u.usedTokens, 1200);
		assert.strictEqual(u.fraction, 0.3);
		assert.strictEqual(u.estimated, false);
	});

	test('adds estimate after the last reply', () => {
		const u = contextUseOf([user(40), assistant(10, { promptTokens: 1000, completionTokens: 200 }), user(400)], 4000, 0);
		assert.strictEqual(u.usedTokens, 1300);
		assert.strictEqual(u.estimated, true);
	});

	test('estimates without counts', () => {
		const u = contextUseOf([user(4000), assistant(4000)], 32768, 0);
		assert.strictEqual(u.usedTokens, 2000);
		assert.strictEqual(u.estimated, true);
	});

	test('unknown window is never full', () => {
		const u = contextUseOf([user(40)], 0, 0);
		assert.strictEqual(u.fraction, 0);
		assert.strictEqual(u.estimated, true);
		assert.strictEqual(contextUseOf([user(40)], NaN, 0).fraction, 0);
	});

	test('counts a reply without usage after the last counted one', () => {
		const u = contextUseOf([assistant(10, { promptTokens: 1000, completionTokens: 200 }), assistant(400)], 4000, 0);
		assert.strictEqual(u.usedTokens, 1300);
		assert.strictEqual(u.estimated, true);
	});

	test('empty chat', () => {
		const u = contextUseOf([], 4000, 0);
		assert.strictEqual(u.usedTokens, 0);
		assert.strictEqual(u.estimated, true);
	});

	test('fraction is capped at 1', () => {
		assert.strictEqual(contextUseOf([assistant(10, { promptTokens: 5000, completionTokens: 0 })], 4000, 0).fraction, 1);
	});

	test('format', () => {
		assert.strictEqual(formatContextUse({ usedTokens: 20316, contextWindow: 32768, fraction: 0.62, estimated: false }), '62% of 32k');
		assert.strictEqual(formatContextUse({ usedTokens: 20316, contextWindow: 32768, fraction: 0.62, estimated: true }), '≈62% of 32k');
	});

	test('after Compact, the meter estimates from the summarized chat until the next counted reply', () => {
		// u0 a1 u2 a3 u4 a5: Compact cut at u2 (the last two turns stay); a5's counts still cover the whole chat
		const ms = [user(4000), assistant(4000, { promptTokens: 9000, completionTokens: 100 }), user(40), assistant(40, { promptTokens: 9100, completionTokens: 100 }), user(40), assistant(40, { promptTokens: 9200, completionTokens: 100 })];
		const compaction = { summary: 's'.repeat(100), uptoIdx: 2, at: 't' };
		const u = contextUseOf(ms, 32768, 0, compaction);
		assert.strictEqual(u.estimated, true);
		// 'Summary of the earlier conversation:\n' (37) + 100, then 4 × 40 chars
		assert.strictEqual(u.usedTokens, Math.ceil((37 + 100) / 4) + 40);
		// without the compaction the counts are used
		assert.strictEqual(contextUseOf(ms, 32768, 0).usedTokens, 9300);
	});

	test('a counted reply sent after Compact is used as is', () => {
		const ms = [user(4000), assistant(4000), user(40), assistant(40), user(40), assistant(40), user(40), assistant(40, { promptTokens: 500, completionTokens: 50 })];
		const u = contextUseOf(ms, 32768, 0, { summary: 's', uptoIdx: 2, at: 't' });
		assert.deepStrictEqual([u.usedTokens, u.estimated], [550, false]);
	});
});

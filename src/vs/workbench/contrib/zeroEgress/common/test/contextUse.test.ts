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

	test('format', () => {
		assert.strictEqual(formatContextUse({ usedTokens: 20316, contextWindow: 32768, fraction: 0.62, estimated: false }), '62% of 32k');
		assert.strictEqual(formatContextUse({ usedTokens: 20316, contextWindow: 32768, fraction: 0.62, estimated: true }), '≈62% of 32k');
	});
});

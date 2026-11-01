/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { usageOfChunk } from '../tokenUsage.js';

suite('tokenUsage', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('usage chunk with empty choices', () => {
		assert.deepStrictEqual(usageOfChunk({ choices: [], usage: { prompt_tokens: 31, completion_tokens: 5, total_tokens: 36 } }), { promptTokens: 31, completionTokens: 5 });
	});

	test('no usage', () => {
		assert.strictEqual(usageOfChunk({ choices: [{ delta: { content: 'x' } }] }), null);
	});

	test('bad numbers', () => {
		assert.strictEqual(usageOfChunk({ usage: { prompt_tokens: '31' } }), null);
	});
});

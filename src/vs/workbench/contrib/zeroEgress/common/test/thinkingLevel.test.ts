/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getModelCapabilities } from '../modelCapabilities.js';
import { optionsForThinkingLevel, reasoningBodyOf, thinkingLevelOf, thinkingLevelsOf } from '../thinkingLevel.js';

suite('thinkingLevel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const defaultCaps = getModelCapabilities('ollama', 'llama3.1', undefined);
	const qwen3 = getModelCapabilities('ollama', 'qwen3:0.6b', undefined);
	const gptOss = getModelCapabilities('ollama', 'gpt-oss:20b', undefined);

	test('no reasoning, no levels', () => {
		assert.deepStrictEqual(thinkingLevelsOf(getModelCapabilities('ollama', 'unknown-model-xyz', undefined)), []);
		assert.deepStrictEqual(thinkingLevelsOf(defaultCaps), []);
	});

	test('on/off model', () => {
		assert.deepStrictEqual(thinkingLevelsOf(qwen3), ['off', 'high']);
	});

	test('effort model', () => {
		assert.deepStrictEqual(thinkingLevelsOf(gptOss), ['low', 'med', 'high']);
	});

	test('options round-trip', () => {
		assert.strictEqual(thinkingLevelOf(gptOss, optionsForThinkingLevel(gptOss, 'low')), 'low');
		assert.strictEqual(thinkingLevelOf(qwen3, optionsForThinkingLevel(qwen3, 'off')), 'off');
		assert.strictEqual(thinkingLevelOf(qwen3, optionsForThinkingLevel(qwen3, 'high')), 'high');
		assert.strictEqual(thinkingLevelOf(defaultCaps, undefined), null);
	});

	test('body', () => {
		assert.deepStrictEqual(reasoningBodyOf(qwen3, { reasoningEnabled: false }), { reasoning_effort: 'none' });
		assert.deepStrictEqual(reasoningBodyOf(gptOss, { reasoningEnabled: true, reasoningEffort: 'high' }), { reasoning_effort: 'high' });
		assert.deepStrictEqual(reasoningBodyOf(defaultCaps, { reasoningEnabled: false }), {});
	});
});

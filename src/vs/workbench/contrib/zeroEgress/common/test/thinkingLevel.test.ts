/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getModelCapabilities } from '../modelCapabilities.js';
import { optionsForThinkingLevel, reasoningBodyOf, thinkingButtonLabel, thinkingLevelOf, thinkingLevelsOf } from '../thinkingLevel.js';

suite('thinkingLevel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const defaultCaps = getModelCapabilities('ollama', 'llama3.1', undefined);
	const qwen3 = getModelCapabilities('ollama', 'qwen3:0.6b', undefined);
	const gptOss = getModelCapabilities('ollama', 'gpt-oss:20b', undefined);

	test('no reasoning, no levels', () => {
		assert.deepStrictEqual(thinkingLevelsOf('ollama', getModelCapabilities('ollama', 'unknown-model-xyz', undefined)), []);
		assert.deepStrictEqual(thinkingLevelsOf('ollama', defaultCaps), []);
	});

	test('on/off model', () => {
		assert.deepStrictEqual(thinkingLevelsOf('ollama', qwen3), ['off', 'high']);
	});

	test('effort model', () => {
		assert.deepStrictEqual(thinkingLevelsOf('ollama', gptOss), ['low', 'med', 'high']);
	});

	test('options round-trip', () => {
		assert.strictEqual(thinkingLevelOf('ollama', gptOss, optionsForThinkingLevel(gptOss, 'low')), 'low');
		assert.strictEqual(thinkingLevelOf('ollama', qwen3, optionsForThinkingLevel(qwen3, 'off')), 'off');
		assert.strictEqual(thinkingLevelOf('ollama', qwen3, optionsForThinkingLevel(qwen3, 'high')), 'high');
		assert.strictEqual(thinkingLevelOf('ollama', defaultCaps, undefined), null);
	});

	test('body', () => {
		assert.deepStrictEqual(reasoningBodyOf('ollama', qwen3, { reasoningEnabled: false }), { reasoning_effort: 'none' });
		assert.deepStrictEqual(reasoningBodyOf('ollama', gptOss, { reasoningEnabled: true, reasoningEffort: 'high' }), { reasoning_effort: 'high' });
		assert.deepStrictEqual(reasoningBodyOf('ollama', defaultCaps, { reasoningEnabled: false }), {});
	});

	test('body defaults and providers', () => {
		assert.deepStrictEqual(reasoningBodyOf('ollama', gptOss, undefined), { reasoning_effort: 'medium' });
		assert.deepStrictEqual(reasoningBodyOf('ollama', qwen3, { reasoningEnabled: true }), {});
		assert.deepStrictEqual(reasoningBodyOf('vLLM', qwen3, { reasoningEnabled: false }), {});
		assert.deepStrictEqual(reasoningBodyOf('lmStudio', qwen3, { reasoningEnabled: false }), {});
		assert.deepStrictEqual(reasoningBodyOf('vLLM', gptOss, { reasoningEnabled: true, reasoningEffort: 'low' }), { reasoning_effort: 'low' });
	});

	test('default level', () => {
		assert.strictEqual(thinkingLevelOf('ollama', gptOss, undefined), 'med');
	});

	test('button label', () => {
		const alwaysThinks = getModelCapabilities('ollama', 'deepseek-r1', undefined);
		assert.strictEqual(thinkingButtonLabel('ollama', gptOss, undefined), 'Med');
		assert.strictEqual(thinkingButtonLabel('ollama', gptOss, optionsForThinkingLevel(gptOss, 'high')), 'High');
		assert.strictEqual(thinkingButtonLabel('ollama', gptOss, optionsForThinkingLevel(gptOss, 'low')), 'Low');
		assert.strictEqual(thinkingButtonLabel('ollama', qwen3, undefined), 'On');
		assert.strictEqual(thinkingButtonLabel('ollama', qwen3, { reasoningEnabled: false }), 'Off');
		assert.strictEqual(thinkingButtonLabel('ollama', alwaysThinks, undefined), null);
		assert.strictEqual(thinkingButtonLabel('ollama', defaultCaps, undefined), null);
	});

	test('other providers: no off (none is unverified there), and no control for an on/off model', () => {
		assert.deepStrictEqual(thinkingLevelsOf('vLLM', qwen3), []);
		assert.strictEqual(thinkingButtonLabel('vLLM', qwen3, { reasoningEnabled: false }), null);
		const effortAndOff = { ...gptOss, reasoningCapabilities: { ...(gptOss.reasoningCapabilities as object), canTurnOffReasoning: true } } as typeof gptOss;
		assert.deepStrictEqual(thinkingLevelsOf('ollama', effortAndOff), ['off', 'low', 'med', 'high']);
		assert.deepStrictEqual(thinkingLevelsOf('lmStudio', effortAndOff), ['low', 'med', 'high']);
		// an off stored earlier isn't shown where it isn't sent
		assert.strictEqual(thinkingLevelOf('lmStudio', effortAndOff, { reasoningEnabled: false, reasoningEffort: 'high' }), 'high');
		assert.strictEqual(thinkingButtonLabel('lmStudio', effortAndOff, { reasoningEnabled: false }), 'Med');
	});
});

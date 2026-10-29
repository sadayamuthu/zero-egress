/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { classifyPort8000, FoundModel, isLoopbackUrl, paramsBillionsOf, PROBE_TARGETS, recommendModel } from '../localDetection.js';

const M = (modelName: string): FoundModel => ({ providerName: 'ollama', modelName, paramsB: paramsBillionsOf(modelName) });

suite('localDetection', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('probe targets are loopback defaults', () => {
		assert.strictEqual(PROBE_TARGETS.length, 3);
		for (const t of PROBE_TARGETS) { assert.ok(isLoopbackUrl(t.url), t.url); }
		assert.deepStrictEqual(PROBE_TARGETS.map(t => t.id), ['ollama', 'lmStudio', 'port8000']);
		assert.deepStrictEqual(PROBE_TARGETS[2].providers, ['vLLM', 'oMLX']);
		assert.strictEqual(PROBE_TARGETS[2].url, 'http://localhost:8000');
	});

	test('isLoopbackUrl', () => {
		for (const u of ['http://localhost:1234', 'http://127.0.0.1:11434', 'http://127.4.5.6', 'http://[::1]:8000']) { assert.strictEqual(isLoopbackUrl(u), true, u); }
		for (const u of ['http://192.168.1.5:11434', 'https://example.com', 'not a url']) { assert.strictEqual(isLoopbackUrl(u), false, u); }
	});

	test('classifyPort8000', () => {
		assert.strictEqual(classifyPort8000(['vllm']), 'vLLM');
		assert.strictEqual(classifyPort8000(['omlx']), 'oMLX');
		assert.strictEqual(classifyPort8000(['openai']), 'unknown');
		assert.strictEqual(classifyPort8000([]), 'unknown');
	});

	test('paramsBillionsOf', () => {
		assert.strictEqual(paramsBillionsOf('qwen2.5-coder:7b'), 7);
		assert.strictEqual(paramsBillionsOf('qwen3-coder:30b-a3b'), 30);
		assert.strictEqual(paramsBillionsOf('llama3', '8.0B'), 8);
		assert.strictEqual(paramsBillionsOf('phi'), null);
		assert.strictEqual(paramsBillionsOf('x:1.5b'), 1.5);
		assert.strictEqual(paramsBillionsOf('qwen2.5-coder:32b-instruct'), 32);
	});

	test('recommend prefers coder family', () => {
		assert.strictEqual(recommendModel([M('llama3:70b'), M('qwen2.5-coder:7b')])?.modelName, 'qwen2.5-coder:7b');
	});

	test('recommend picks largest under 34B', () => {
		assert.strictEqual(recommendModel([M('qwen2.5-coder:1.5b'), M('qwen2.5-coder:32b'), M('qwen2.5-coder:7b')])?.modelName, 'qwen2.5-coder:32b');
	});

	test('recommend skips too-large', () => {
		assert.strictEqual(recommendModel([M('qwen2.5-coder:72b'), M('qwen2.5-coder:14b')])?.modelName, 'qwen2.5-coder:14b');
	});

	test('recommend returns null for no models', () => {
		assert.strictEqual(recommendModel([]), null);
	});
});

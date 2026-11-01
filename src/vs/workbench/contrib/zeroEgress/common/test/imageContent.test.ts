/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { toOpenAIUserContent, imageNote, redactImagesForAudit } from '../imageContent.js';
import { getModelCapabilities } from '../modelCapabilities.js';
import { LLMChatMessage } from '../sendLLMMessageTypes.js';

suite('imageContent', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const png = { mime: 'image/png', base64: 'AAAA' };

	test('plain text stays a string', () => {
		assert.strictEqual(toOpenAIUserContent('hi', []), 'hi');
	});

	test('images become parts', () => {
		const out = toOpenAIUserContent('hi', [png]);
		assert.ok(Array.isArray(out));
		assert.strictEqual(out.length, 2);
		const second = out[1] as { type: 'image_url'; image_url: { url: string } };
		assert.ok(second.image_url.url.startsWith('data:image/png;base64,'));
	});

	test('at most four images', () => {
		const out = toOpenAIUserContent('hi', [png, png, png, png, png, png]);
		assert.ok(Array.isArray(out));
		assert.strictEqual(out.length, 5);
	});

	test('note text', () => {
		assert.strictEqual(imageNote('a.png'), `[Image a.png not sent: this model can't read images.]`);
	});

	test('audit copy has no image data', () => {
		const msgs: LLMChatMessage[] = [{ role: 'user', content: toOpenAIUserContent('hi', [png]) }];
		const before = JSON.stringify(msgs);
		const out = redactImagesForAudit(msgs);
		assert.ok(!JSON.stringify(out).includes('base64,'));
		assert.ok(JSON.stringify(out).includes('[image omitted]'));
		assert.strictEqual(JSON.stringify(msgs), before);
	});

	test('vision families are recognised by name', () => {
		const v = (n: string) => !!getModelCapabilities('ollama', n, undefined).supportsVision;
		for (const n of ['llava:7b', 'llama3.2-vision:11b', 'qwen2.5vl:7b', 'minicpm-v:8b', 'mistral-small3.1:24b', 'gemma3:4b']) assert.strictEqual(v(n), true, n);
		for (const n of ['gemma3:1b', 'qwen2.5-coder:7b', 'llama3.1']) assert.strictEqual(v(n), false, n);
	});
});

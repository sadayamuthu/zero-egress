/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applyCompaction, compactionAfterCut, compactionCut } from '../compaction.js';
import type { ChatMessage } from '../chatThreadServiceTypes.js';

const seq = (roles: string): ChatMessage[] => [...roles].map((r, i) => r === 'u'
	? { role: 'user', content: `u${i}`, displayContent: `u${i}`, selections: null, state: { stagingSelections: [], isBeingEdited: false } }
	: { role: 'assistant', displayContent: `a${i}`, reasoning: '', anthropicReasoning: null } as ChatMessage);

suite('compaction', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('cut keeps the last two turns', () => {
		assert.strictEqual(compactionCut(seq('uauaua')), 2);
	});

	test('cut needs three turns', () => {
		assert.strictEqual(compactionCut(seq('uaua')), null);
	});

	test('apply replaces the head', () => {
		const messages = seq('uauaua');
		const out = applyCompaction(messages, { summary: 'S', uptoIdx: 2, at: '' });
		assert.strictEqual(out.length, messages.length - 1);
		assert.ok((out[0] as { content: string }).content.startsWith('Summary of the earlier conversation:\n'));
		assert.strictEqual(out[1], messages[2]);
		assert.strictEqual(applyCompaction(messages, undefined), messages);
	});

	test('compaction is cleared when messages are cut before it', () => {
		assert.strictEqual(compactionAfterCut({ summary: 's', uptoIdx: 4, at: '' }, 4), undefined);
		const c = { summary: 's', uptoIdx: 4, at: '' };
		assert.strictEqual(compactionAfterCut(c, 6), c);
	});
});

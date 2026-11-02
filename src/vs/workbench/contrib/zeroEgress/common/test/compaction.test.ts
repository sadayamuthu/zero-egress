/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applyCompaction, compactionAfterCut, compactionCut, compactionInput, compactionStillValid, compactionTranscript } from '../compaction.js';
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

	test('transcript prefixes each role', () => {
		const tool = { role: 'tool', name: 'read_file', content: 'file text' } as unknown as ChatMessage;
		const t = compactionTranscript([...seq('ua'), tool]);
		assert.strictEqual(t, 'USER: u0\n\nASSISTANT: a1\n\nTOOL read_file: file text');
	});

	test('transcript trims each message to 2000 chars', () => {
		const long = 'x'.repeat(5000);
		const m = { ...seq('u')[0], content: long } as ChatMessage;
		const t = compactionTranscript([m]);
		assert.strictEqual(t, 'USER: ' + 'x'.repeat(2000) + '…');
	});

	test('transcript falls back to displayContent when content is empty', () => {
		const m = { ...seq('u')[0], content: '', displayContent: 'shown' } as ChatMessage;
		assert.strictEqual(compactionTranscript([m]), 'USER: shown');
	});

	test('a result lands only while the chat still holds the cut message', () => {
		const messages = seq('uauaua');
		const at = messages[2];
		assert.strictEqual(compactionStillValid(messages, 2, at), true);
		assert.strictEqual(compactionStillValid([...messages, ...seq('ua')], 2, at), true);
		assert.strictEqual(compactionStillValid(messages.slice(0, 2), 2, at), false);
		assert.strictEqual(compactionStillValid([...messages.slice(0, 2), ...seq('uaua')], 2, at), false);
	});

	test('input starts from the previous summary, not the start of the chat', () => {
		const ms = seq('uauauaua');
		assert.strictEqual(compactionInput(ms, 6, { summary: 'S', uptoIdx: 4, at: 't' }, 10000), 'Previous summary:\nS\n\nUSER: u4\n\nASSISTANT: a5');
		assert.strictEqual(compactionInput(ms, 4, undefined, 10000), 'USER: u0\n\nASSISTANT: a1\n\nUSER: u2\n\nASSISTANT: a3');
	});

	test('over budget, input keeps the newest messages and the whole previous summary', () => {
		const ms = seq('uauauaua');
		// "USER: u4" is 8 chars, "ASSISTANT: a5" 13, joined by two newlines
		const prev = { summary: 'S'.repeat(50), uptoIdx: 2, at: 't' };
		const out = compactionInput(ms, 6, prev, 'Previous summary:\n'.length + 50 + 2 + 8 + 2 + 13);
		assert.strictEqual(out, 'Previous summary:\n' + 'S'.repeat(50) + '\n\nUSER: u4\n\nASSISTANT: a5');
		assert.strictEqual(compactionInput(ms, 4, undefined, 12), 'ASSISTANT: a3');
		// the newest message is kept even when it alone is over budget
		assert.strictEqual(compactionInput(ms, 4, undefined, 1), 'ASSISTANT: a3');
	});
});

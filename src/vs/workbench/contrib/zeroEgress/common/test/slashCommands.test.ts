/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { expandBuiltin, parseSlash, resolveSlashSend, withNewSelections } from '../slashCommands.js';

suite('slashCommands', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses', () => {
		assert.deepStrictEqual(parseSlash('/review  auth only'), { name: 'review', args: 'auth only' });
		assert.strictEqual(parseSlash('hello /x'), null);
	});

	test('review is read only with the diff', () => {
		const e = expandBuiltin('review', '', { hasSelection: false });
		assert.strictEqual(e?.modeOverride, 'gather');
		assert.deepStrictEqual(e?.addContext, ['workingDiff']);
	});

	test('explain falls back to the file', () => {
		assert.deepStrictEqual(expandBuiltin('explain', '', { hasSelection: false })?.addContext, ['currentFile']);
	});

	test('plan switches mode', () => {
		assert.deepStrictEqual(expandBuiltin('plan', 'add retry', { hasSelection: false }), { setMode: 'plan', prompt: 'add retry' });
	});

	test('unknown is null', () => {
		assert.strictEqual(expandBuiltin('nope', '', { hasSelection: false }), null);
	});

	test('an edited /review is expanded, read only, and still shows /review', () => {
		const r = resolveSlashSend('/review auth', { hasSelection: false });
		assert.strictEqual(r.modeOverride, 'gather');
		assert.strictEqual(r.displayMessage, '/review auth');
		assert.ok(r.prompt.startsWith('Review the pending changes'));
		assert.ok(r.prompt.endsWith('Focus: auth'));
		assert.deepStrictEqual(r.addContext, ['workingDiff']);
	});

	test('plain text and unknown commands are sent as typed', () => {
		for (const t of ['fix the bug', '/nope now']) {
			const r = resolveSlashSend(t, { hasSelection: false });
			assert.strictEqual(r.prompt, t);
			assert.strictEqual(r.modeOverride, undefined);
			assert.strictEqual(r.displayMessage, undefined);
			assert.strictEqual(r.isCommand, false);
		}
	});

	test('staged context is not added twice', () => {
		const diff = { type: 'GitDiff' as const, against: null, text: 'x', truncated: false };
		const out = withNewSelections([diff as never], [diff as never]);
		assert.strictEqual(out.length, 1);
	});
});

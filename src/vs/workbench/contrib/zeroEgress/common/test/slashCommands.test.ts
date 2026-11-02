/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { expandBuiltin, parseSlash } from '../slashCommands.js';

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
});

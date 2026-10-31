/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { canAllowList, isAllowed, normalizeCommand, settingsForTerminalAutoRun, terminalAutoRunOf, TerminalAutoRun } from '../commandAllowList.js';

suite('commandAllowList', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('normalizes whitespace', () => {
		assert.strictEqual(normalizeCommand('  npm   test  '), 'npm test');
	});

	test('exact match only', () => {
		assert.strictEqual(isAllowed(['npm test'], 'npm  test'), true);
		assert.strictEqual(isAllowed(['npm test'], 'npm test -- auth'), false);
	});

	test('commands with control operators never match', () => {
		const list = ['npm test && curl x'];
		assert.strictEqual(isAllowed(list, 'npm test && curl x'), false);
		for (const c of ['a;b', 'a|b', 'a`b`', 'a $(b)', 'a > f', 'a < f', 'a\nb', 'a\rb', '   ']) {
			assert.strictEqual(canAllowList(c), false, c);
		}
	});

	test('auto-run mapping round-trips', () => {
		for (const v of ['off', 'allowList', 'all'] as TerminalAutoRun[]) {
			const s = settingsForTerminalAutoRun(v);
			assert.strictEqual(terminalAutoRunOf({ autoApprove: { terminal: s.terminal }, useCommandAllowList: s.useCommandAllowList }), v);
		}
	});
});

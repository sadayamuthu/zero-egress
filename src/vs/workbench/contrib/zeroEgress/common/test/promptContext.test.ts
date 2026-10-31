/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { promptWithContext } from '../promptContext.js';

suite('promptContext', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('no chips leaves the prompt unchanged', () => {
		assert.strictEqual(promptWithContext('Fix the bug', []), 'Fix the bug');
	});

	test('a file is listed by its workspace-relative path', () => {
		assert.strictEqual(
			promptWithContext('Fix the bug', [{ kind: 'file', path: '/src/a.ts' }]),
			'Fix the bug\n\nContext:\n- src/a.ts',
		);
	});

	test('a folder ends with a slash', () => {
		assert.strictEqual(
			promptWithContext('Look', [{ kind: 'folder', path: 'src/lib' }, { kind: 'folder', path: '\\pkg\\' }]),
			'Look\n\nContext:\n- src/lib/\n- pkg/',
		);
	});

	test('a selection has its line range', () => {
		assert.strictEqual(
			promptWithContext('Explain', [{ kind: 'file', path: 'b.ts' }, { kind: 'selection', path: '/src/a.ts', range: [40, 62] }]),
			'Explain\n\nContext:\n- b.ts\n- src/a.ts:L40-L62',
		);
	});
});

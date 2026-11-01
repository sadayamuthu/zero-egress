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

	test('an absolute path outside the workspace keeps its leading separator', () => {
		assert.strictEqual(
			promptWithContext('Look', [
				{ kind: 'file', path: '/Users/x/other.ts', absolute: true },
				{ kind: 'folder', path: '/Users/x/lib/', absolute: true },
				{ kind: 'selection', path: '/Users/x/other.ts', range: [1, 3], absolute: true },
			]),
			'Look\n\nContext:\n- /Users/x/other.ts\n- /Users/x/lib/\n- /Users/x/other.ts:L1-L3',
		);
	});

	test('a Windows absolute path is left as is', () => {
		assert.strictEqual(
			promptWithContext('Look', [{ kind: 'file', path: 'C:\\work\\other.ts', absolute: true }, { kind: 'folder', path: 'C:\\work\\lib', absolute: true }]),
			'Look\n\nContext:\n- C:\\work\\other.ts\n- C:\\work\\lib\\',
		);
	});

	test('a selection has its line range', () => {
		assert.strictEqual(
			promptWithContext('Explain', [{ kind: 'file', path: 'b.ts' }, { kind: 'selection', path: '/src/a.ts', range: [40, 62] }]),
			'Explain\n\nContext:\n- b.ts\n- src/a.ts:L40-L62',
		);
	});
});

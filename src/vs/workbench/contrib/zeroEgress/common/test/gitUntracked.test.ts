/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { hasDiffText, isInsideRoot, noIndexDiffOk, parseNulList } from '../gitUntracked.js';

suite('gitUntracked', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses -z output; a cut-off last name is dropped', () => {
		assert.deepStrictEqual(parseNulList('a.ts\0dir/b c.ts\0', true), ['a.ts', 'dir/b c.ts']);
		assert.deepStrictEqual(parseNulList('a.ts\0dir/b', false), ['a.ts']);
		assert.deepStrictEqual(parseNulList('', true), []);
	});

	test('only paths inside the repo', () => {
		assert.strictEqual(isInsideRoot('/repo', 'src/a.ts'), true);
		assert.strictEqual(isInsideRoot('/repo', '/repo/src/a.ts'), true);
		assert.strictEqual(isInsideRoot('/repo', '../etc/passwd'), false);
		assert.strictEqual(isInsideRoot('/repo', 'src/../../x'), false);
		assert.strictEqual(isInsideRoot('/repo', '/etc/passwd'), false);
		assert.strictEqual(isInsideRoot('/repo', '/repo2/a'), false);
		assert.strictEqual(isInsideRoot('/repo', '/repo'), false);
		assert.strictEqual(isInsideRoot('/repo', '..foo'), true);
	});

	test('an empty or blank diff is no diff', () => {
		assert.strictEqual(hasDiffText(''), false);
		assert.strictEqual(hasDiffText(' \n\t\n'), false);
		assert.strictEqual(hasDiffText('diff --git a/x b/x'), true);
	});

	test('git diff --no-index exits 1 when the files differ', () => {
		assert.strictEqual(noIndexDiffOk(0), true);
		assert.strictEqual(noIndexDiffOk(1), true);
		assert.strictEqual(noIndexDiffOk(128), false);
		assert.strictEqual(noIndexDiffOk(null), false);
	});
});

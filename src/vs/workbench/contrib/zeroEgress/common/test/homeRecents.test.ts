/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { countsByFolderKey, folderKey, reviewLabel } from '../homeRecents.js';

suite('homeRecents', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('folderKey drops trailing separators but keeps a root', () => {
		assert.strictEqual(folderKey('/tmp/zep-ws/', false), '/tmp/zep-ws');
		assert.strictEqual(folderKey('/tmp/zep-ws//', false), '/tmp/zep-ws');
		assert.strictEqual(folderKey('/', false), '/');
		assert.strictEqual(folderKey('C:\\repo\\', false), 'C:\\repo');
		assert.strictEqual(folderKey('C:\\', false), 'C:\\');
	});

	test('folderKey lower-cases only when case-insensitive', () => {
		assert.strictEqual(folderKey('/Users/Me/Repo', true), '/users/me/repo');
		assert.strictEqual(folderKey('/Users/Me/Repo', false), '/Users/Me/Repo');
	});

	test('countsByFolderKey adds colliding keys', () => {
		const m = countsByFolderKey(new Map([['/a/B', 1], ['/a/b/', 2], ['/c', 0]]), true);
		assert.deepStrictEqual([...m], [['/a/b', 3], ['/c', 0]]);
	});

	test('reviewLabel', () => {
		assert.strictEqual(reviewLabel(0), '');
		assert.strictEqual(reviewLabel(1), '1 agent needs review');
		assert.strictEqual(reviewLabel(3), '3 agents need review');
	});
});

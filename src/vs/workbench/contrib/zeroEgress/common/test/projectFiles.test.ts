/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isReadableProjectRulesFile, PROJECT_RULES_MAX_BYTES } from '../projectFiles.js';

suite('projectFiles', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a small plain file is read', () => {
		assert.strictEqual(isReadableProjectRulesFile({ isFile: true, isSymbolicLink: false, size: 120 }), true);
		assert.strictEqual(isReadableProjectRulesFile({ isFile: true, isSymbolicLink: false, size: 0 }), true);
	});

	test('a symlink is never read', () => {
		assert.strictEqual(isReadableProjectRulesFile({ isFile: true, isSymbolicLink: true, size: 10 }), false);
	});

	test('a directory is not read', () => {
		assert.strictEqual(isReadableProjectRulesFile({ isFile: false, isSymbolicLink: false, size: 10 }), false);
	});

	test('size must be known and at most 64 KB', () => {
		assert.strictEqual(PROJECT_RULES_MAX_BYTES, 64 * 1024);
		assert.strictEqual(isReadableProjectRulesFile({ isFile: true, isSymbolicLink: false, size: 64 * 1024 }), true);
		assert.strictEqual(isReadableProjectRulesFile({ isFile: true, isSymbolicLink: false, size: 64 * 1024 + 1 }), false);
		assert.strictEqual(isReadableProjectRulesFile({ isFile: true, isSymbolicLink: false, size: undefined }), false);
	});
});

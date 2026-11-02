/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isReadableProjectRulesFile, LatestOnly, PROJECT_RULES_MAX_BYTES, projectRulesRefusal, projectRulesStateOf } from '../projectFiles.js';

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

	test('state: a link is told apart from other unreadable files', () => {
		assert.strictEqual(projectRulesStateOf({ isFile: true, isSymbolicLink: false, size: 10 }), 'ok');
		assert.strictEqual(projectRulesStateOf({ isFile: true, isSymbolicLink: true, size: 10 }), 'link');
		assert.strictEqual(projectRulesStateOf({ isFile: false, isSymbolicLink: false, size: 0 }), 'unsafe');
		assert.strictEqual(projectRulesStateOf({ isFile: true, isSymbolicLink: false, size: PROJECT_RULES_MAX_BYTES + 1 }), 'unsafe');
	});

	test('refusal copy', () => {
		assert.strictEqual(projectRulesRefusal('link'), ".zeroegressrules is a link, so ZeroEgress won't read it.");
		assert.strictEqual(projectRulesRefusal('unsafe'), ".zeroegressrules isn't a plain file under 64 KB, so ZeroEgress won't read it.");
	});

	test('only the latest check of a folder applies', () => {
		const g = new LatestOnly();
		const a1 = g.start('/a');
		const a2 = g.start('/a');
		const b1 = g.start('/b');
		assert.strictEqual(g.isLatest('/a', a1), false); // an older check finishing late is ignored
		assert.strictEqual(g.isLatest('/a', a2), true);
		assert.strictEqual(g.isLatest('/b', b1), true);
	});
});

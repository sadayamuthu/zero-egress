/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { restoreTargets, reviewScope } from '../reviewScope.js';

suite('reviewScope', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('counts only my files', () => {
		const r = reviewScope([
			{ path: '/a', owner: 't1', changes: 2 },
			{ path: '/b', owner: 't2', changes: 1 },
			{ path: '/c', owner: 't1', changes: 1 },
		], 't1');
		assert.deepStrictEqual(r.mine.map(f => f.path), ['/a', '/c']);
		assert.strictEqual(r.changes, 3);
		assert.strictEqual(r.otherFiles, 1);
	});

	test('unowned changes count as other', () => {
		const r = reviewScope([{ path: '/a', owner: undefined, changes: 1 }], 't1');
		assert.deepStrictEqual(r.mine, []);
		assert.strictEqual(r.otherFiles, 1);
	});

	test('restore skips files another chat has pending', () => {
		const owners: Record<string, string> = { '/b': 't2' };
		const r = restoreTargets(['/a', '/b'], p => owners[p], p => p === '/b', 't1');
		assert.deepStrictEqual(r, { restore: ['/a'], skipped: ['/b'] });
	});

	test('restore keeps files another chat no longer has pending', () => {
		const owners: Record<string, string> = { '/b': 't2' };
		const r = restoreTargets(['/a', '/b'], p => owners[p], () => false, 't1');
		assert.ok(r.restore.includes('/b'));
		assert.deepStrictEqual(r.skipped, []);
	});

	test('restore skips unowned files that have pending changes', () => {
		const r = restoreTargets(['/a', '/b'], () => undefined, p => p === '/b', 't1');
		assert.deepStrictEqual(r, { restore: ['/a'], skipped: ['/b'] });
	});

	test('restore keeps my own pending files', () => {
		const r = restoreTargets(['/a'], () => 't1', () => true, 't1');
		assert.deepStrictEqual(r, { restore: ['/a'], skipped: [] });
	});
});

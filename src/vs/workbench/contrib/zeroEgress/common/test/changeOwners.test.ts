/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChangeOwners } from '../changeOwners.js';

suite('ChangeOwners', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('first claim wins', () => {
		const o = new ChangeOwners();
		assert.deepStrictEqual(o.claim('/a', 't1'), { ok: true });
		assert.deepStrictEqual(o.claim('/a', 't2'), { ok: false, owner: 't1' });
		assert.deepStrictEqual(o.claim('/a', 't1'), { ok: true });
	});

	test('transfer overrides', () => {
		const o = new ChangeOwners();
		o.claim('/a', 't1');
		o.transfer('/a', 't2');
		assert.strictEqual(o.ownerOf('/a'), 't2');
	});

	test('releasing a thread frees its files', () => {
		const o = new ChangeOwners();
		o.claim('/a', 't1');
		o.claim('/b', 't1');
		o.claim('/c', 't2');
		assert.deepStrictEqual(o.releaseThread('t1'), ['/a', '/b']);
		assert.strictEqual(o.ownerOf('/a'), undefined);
		assert.strictEqual(o.ownerOf('/c'), 't2');
	});

	test('pathsOf is sorted', () => {
		const o = new ChangeOwners();
		o.claim('/b', 't1');
		o.claim('/a', 't1');
		assert.deepStrictEqual(o.pathsOf('t1'), ['/a', '/b']);
	});
});

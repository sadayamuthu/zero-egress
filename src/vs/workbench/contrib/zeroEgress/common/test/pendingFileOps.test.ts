/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PendingFileOps } from '../pendingFileOps.js';

suite('PendingFileOps', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepting a create keeps the file', () => {
		const m = new PendingFileOps();
		assert.deepStrictEqual(m.recordCreate('/w/a.ts', false), []);
		assert.strictEqual(m.ops.length, 1);
		assert.deepStrictEqual(m.resolve(m.ops[0].id, 'accept'), []);
		assert.strictEqual(m.ops.length, 0);
	});

	test('rejecting a create removes the file', () => {
		const m = new PendingFileOps();
		m.recordCreate('/w/dir/', true);
		assert.deepStrictEqual(m.resolve(m.ops[0].id, 'reject'), [{ type: 'delete', path: '/w/dir', recursive: true }]);
	});

	test('accepting a delete deletes; rejecting keeps', () => {
		const m = new PendingFileOps();
		assert.deepStrictEqual(m.recordDelete('/w/a.ts', false), []);
		assert.deepStrictEqual(m.resolve(m.ops[0].id, 'accept'), [{ type: 'delete', path: '/w/a.ts', recursive: false }]);
		m.recordDelete('/w/b.ts', false);
		assert.deepStrictEqual(m.resolve(m.ops[0].id, 'reject'), []);
		assert.strictEqual(m.ops.length, 0);
	});

	test('delete of a pending create cancels both', () => {
		const m = new PendingFileOps();
		m.recordCreate('/w/a.ts', false);
		assert.deepStrictEqual(m.recordDelete('/w/a.ts', false), [{ type: 'delete', path: '/w/a.ts', recursive: false }]);
		assert.strictEqual(m.ops.length, 0);
	});

	test('create over a pending delete cancels the delete', () => {
		const m = new PendingFileOps();
		m.recordDelete('/w/a.ts', false);
		assert.deepStrictEqual(m.recordCreate('/w/a.ts', false), []);
		assert.strictEqual(m.ops.length, 0);
	});

	test('deleting the same path twice records one op', () => {
		const m = new PendingFileOps();
		m.recordDelete('/w/a.ts', false);
		m.recordDelete('/w/a.ts', false);
		assert.strictEqual(m.ops.length, 1);
	});

	test('folder delete absorbs pending creates inside it', () => {
		const m = new PendingFileOps();
		m.recordCreate('/w/d/new.ts', false);
		m.recordDelete('/w/d/', true);
		assert.deepStrictEqual(m.ops.map(o => [o.kind, o.path]), [['create', '/w/d/new.ts'], ['delete', '/w/d']]);
		assert.deepStrictEqual(m.resolveAll('accept'), [{ type: 'delete', path: '/w/d', recursive: true }]);
		assert.strictEqual(m.ops.length, 0);
		m.recordCreate('/w/e/new.ts', false);
		m.recordDelete('/w/e', true);
		assert.deepStrictEqual(m.resolveAll('reject'), [{ type: 'delete', path: '/w/e/new.ts', recursive: false }]);
	});

	test('resolveAll can be limited to one path', () => {
		const m = new PendingFileOps();
		m.recordDelete('/w/a.ts', false);
		m.recordDelete('/w/b.ts', false);
		assert.deepStrictEqual(m.resolveAll('accept', '/w/a.ts'), [{ type: 'delete', path: '/w/a.ts', recursive: false }]);
		assert.deepStrictEqual(m.ops.map(o => o.path), ['/w/b.ts']);
	});

	test('unknown id is a no-op', () => {
		assert.deepStrictEqual(new PendingFileOps().resolve(42, 'accept'), []);
	});
});

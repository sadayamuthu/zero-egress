/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { closeTab, MAX_OPEN_TABS, openTab, threadTitleOf } from '../chatTabs.js';

suite('chatTabs', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('title falls back', () => {
		assert.strictEqual(threadTitleOf({ messages: [] }), 'New chat');
		assert.strictEqual(threadTitleOf({ messages: [{ role: 'user', displayContent: 'a'.repeat(50) }] }), 'a'.repeat(40) + '…');
		assert.strictEqual(threadTitleOf({ title: 'X', messages: [{ role: 'user', displayContent: 'hello' }] }), 'X');
	});

	test('open is idempotent', () => {
		assert.deepStrictEqual(openTab(['a'], 'a'), ['a']);
	});

	test('closing current picks right then left', () => {
		assert.strictEqual(closeTab(['a', 'b', 'c'], 'b', 'b').next, 'c');
		assert.strictEqual(closeTab(['a', 'b'], 'b', 'b').next, 'a');
		assert.strictEqual(closeTab(['a'], 'a', 'a').next, undefined);
	});

	test('cap drops the oldest idle tab', () => {
		const ids = ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];
		const result = openTab(ids.slice(0, 8), ids[8], id => id === 't0');
		assert.strictEqual(result.length, MAX_OPEN_TABS);
		assert.ok(result.includes('t0'));
		assert.ok(!result.includes('t1'));
		assert.ok(result.includes('t8'));
	});
});

/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { closeTab, MAX_OPEN_TABS, openTab, restoreTabs, threadTitleOf } from '../chatTabs.js';

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

	const known = new Set(['a', 'b', 'c', 'agent']);
	const exists = (id: string) => known.has(id);
	const isAgent = (id: string) => id === 'agent';

	test('restore keeps the stored tabs and current chat', () => {
		assert.deepStrictEqual(restoreTabs({ tabs: ['a', 'b', 'c'], current: 'b' }, exists, isAgent), { tabs: ['a', 'b', 'c'], current: 'b' });
	});

	test('restore drops missing and agent ids, and never applies the cap', () => {
		const many = Array.from({ length: MAX_OPEN_TABS + 2 }, (_, i) => `t${i}`);
		const all = (id: string) => id.startsWith('t') || exists(id);
		assert.deepStrictEqual(restoreTabs({ tabs: ['gone', 'a', 'agent', 'a', 'c'], current: 'c' }, exists, isAgent), { tabs: ['a', 'c'], current: 'c' });
		assert.strictEqual(restoreTabs({ tabs: many, current: 't0' }, all, isAgent).tabs.length, MAX_OPEN_TABS + 2);
	});

	test('restore falls back to the last tab, then to nothing', () => {
		assert.deepStrictEqual(restoreTabs({ tabs: ['a', 'b'], current: 'gone' }, exists, isAgent), { tabs: ['a', 'b'], current: 'b' });
		assert.deepStrictEqual(restoreTabs({ tabs: ['a', 'b'], current: 'agent' }, exists, isAgent), { tabs: ['a', 'b'], current: 'b' });
		assert.deepStrictEqual(restoreTabs({ tabs: ['gone'], current: 'gone' }, exists, isAgent), { tabs: [], current: undefined });
		assert.deepStrictEqual(restoreTabs(undefined, exists, isAgent), { tabs: [], current: undefined });
		assert.deepStrictEqual(restoreTabs('junk', exists, isAgent), { tabs: [], current: undefined });
	});

	test('restore reads the old plain-array format', () => {
		assert.deepStrictEqual(restoreTabs(['a', 'b', 7], exists, isAgent), { tabs: ['a', 'b'], current: 'b' });
	});
});

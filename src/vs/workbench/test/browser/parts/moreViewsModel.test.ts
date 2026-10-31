/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ZeroEgress: the side bar's ⌄ More Views list and its default pins. Runs under test-node by path (no DOM).

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ViewContainerLocation } from '../../../common/views.js';
import { isPinnedByDefault, moreViewsItems } from '../../../browser/parts/moreViewsModel.js';

suite('MoreViewsModel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const item = (id: string, pinned: boolean, visible = true) => ({ id, name: id.toUpperCase(), pinned, visible });

	test('lists every visible view that is not shown in the bar, in bar order', () => {
		const items = [item('explorer', true), item('search', true), item('scm', true), item('debug', false), item('extensions', false)];
		assert.deepStrictEqual(moreViewsItems(items, ['explorer', 'search', 'scm']), [
			{ id: 'debug', name: 'DEBUG', pinned: false },
			{ id: 'extensions', name: 'EXTENSIONS', pinned: false },
		]);
	});

	test('a pinned view that overflowed the bar is listed as pinned, so it can be unpinned', () => {
		const items = [item('explorer', true), item('search', true), item('testing', true)];
		assert.deepStrictEqual(moreViewsItems(items, ['explorer', 'search']), [{ id: 'testing', name: 'TESTING', pinned: true }]);
	});

	test('an open view shown in the bar without a pin is not listed', () => {
		const items = [item('explorer', true), item('debug', false)];
		assert.deepStrictEqual(moreViewsItems(items, ['explorer', 'debug']), []);
	});

	test('views with nothing to show (not visible) are not listed', () => {
		const items = [item('explorer', true), item('remote', false, false)];
		assert.deepStrictEqual(moreViewsItems(items, ['explorer']), []);
	});

	test('a missing name falls back to the id', () => {
		assert.deepStrictEqual(moreViewsItems([{ id: 'x', pinned: false, visible: true }], []), [{ id: 'x', name: 'x', pinned: false }]);
	});

	test('Run and Debug and Extensions start unpinned in the side bar only', () => {
		assert.strictEqual(isPinnedByDefault('workbench.view.debug', ViewContainerLocation.Sidebar), false);
		assert.strictEqual(isPinnedByDefault('workbench.view.extensions', ViewContainerLocation.Sidebar), false);
		assert.strictEqual(isPinnedByDefault('workbench.view.explorer', ViewContainerLocation.Sidebar), true);
		assert.strictEqual(isPinnedByDefault('workbench.view.scm', ViewContainerLocation.Sidebar), true);
		assert.strictEqual(isPinnedByDefault('workbench.view.debug', ViewContainerLocation.Panel), true);
	});
});

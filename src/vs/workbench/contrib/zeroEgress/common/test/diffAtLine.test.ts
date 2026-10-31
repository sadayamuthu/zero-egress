/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { diffAtLine } from '../diffAtLine.js';
import { Diff } from '../editCodeServiceTypes.js';

const d = (diffid: number, c: { type: Diff['type']; startLine: number; endLine: number }) =>
	({ diffid, diffareaid: 1, originalStartLine: c.startLine, originalEndLine: c.startLine, code: '', originalCode: '', ...c }) as Diff;

suite('diffAtLine', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const diffs = [
		d(1, { type: 'edit', startLine: 2, endLine: 3 }),
		d(2, { type: 'insertion', startLine: 6, endLine: 8 }),
		d(3, { type: 'deletion', startLine: 10, endLine: 10 }),
	];

	test('finds the change covering the line', () => {
		assert.strictEqual(diffAtLine(diffs, 3, 20)?.diffid, 1);
		assert.strictEqual(diffAtLine(diffs, 6, 20)?.diffid, 2);
		assert.strictEqual(diffAtLine(diffs, 8, 20)?.diffid, 2);
		assert.strictEqual(diffAtLine(diffs, 10, 20)?.diffid, 3);
	});

	test('a deletion past the last line belongs to the last line', () => {
		// the editor draws removed lines between startLine - 1 and startLine; at the end of a file startLine is
		// one past the last line, so only there does the line above count
		assert.strictEqual(diffAtLine([d(4, { type: 'deletion', startLine: 3, endLine: 2 })], 2, 2)?.diffid, 4);
		assert.strictEqual(diffAtLine([d(5, { type: 'deletion', startLine: 1, endLine: 0 })], 1, 5)?.diffid, 5);
	});

	test('the unchanged line above a deletion in the middle is not a change', () => {
		assert.strictEqual(diffAtLine(diffs, 9, 20), undefined);
	});

	test('lines outside every change return undefined', () => {
		for (const line of [1, 4, 5, 9, 11]) {
			assert.strictEqual(diffAtLine(diffs, line, 20), undefined, String(line));
		}
		assert.strictEqual(diffAtLine([], 1, 1), undefined);
	});
});

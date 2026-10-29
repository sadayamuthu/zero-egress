/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { acceptHunk, classifyHunk, computeHunks, rejectHunk, reviewFile } from '../agentReview.js';

suite('agentReview', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('computeHunks finds two separate hunks', () => {
		const hunks = computeHunks('a\nb\nc\nd\ne\n', 'a\nB\nc\nd\nE\n');
		assert.strictEqual(hunks.length, 2);
		assert.deepStrictEqual(hunks.map(h => h.baseStart), [1, 4]);
	});

	test('clean hunk shifts past user insertions above it', () => {
		const base = 'a\nb\nc\n', agent = 'a\nB\nc\n';
		const [hunk] = computeHunks(base, agent);
		const s = classifyHunk(hunk, base, 'n1\nn2\na\nb\nc\n');
		assert.strictEqual(s.status, 'clean');
		assert.strictEqual(s.currentStart, hunk.baseStart + 2);
	});

	test('user edit overlapping a hunk is a conflict', () => {
		const base = 'x\ny\nz\n';
		const [hunk] = computeHunks(base, 'x\nY\nz\n');
		const s = classifyHunk(hunk, base, 'x\nyy\nz\n');
		assert.strictEqual(s.status, 'conflict');
		if (s.status === 'conflict') {
			assert.deepStrictEqual(s.currentLines, ['yy']);
			assert.deepStrictEqual(s.agentVersion, ['Y']);
		}
	});

	test('user edit on the adjacent line is a conflict', () => {
		const base = 'a\nb\nc\nd\n';
		const [hunk] = computeHunks(base, 'a\nB\nc\nd\n');
		assert.strictEqual(classifyHunk(hunk, base, 'a\nb\nCC\nd\n').status, 'conflict');
		assert.strictEqual(classifyHunk(hunk, base, 'a\nb\nc\nDD\n').status, 'clean');
	});

	test('hunk becomes a conflict after another accept changed current', () => {
		const base = 'a\nb\nc\nd\ne\n';
		const agent1 = 'a\nB\nc\nd\ne\n';
		const agent2 = 'a\nb\nc\nd\nE\n';
		const [h1] = computeHunks(base, agent1);
		const [h2] = computeHunks(base, agent2);
		const current = base;
		assert.strictEqual(classifyHunk(h1, base, current).status, 'clean');
		const accepted = acceptHunk(classifyHunk(h2, base, current), base, current);
		assert.strictEqual(classifyHunk(h1, base, accepted.current).status, 'clean');
		// another agent's hunk over the same lines
		const [other] = computeHunks(base, 'a\nbb\nc\nd\ne\n');
		const acc2 = acceptHunk(classifyHunk(other, base, current), base, current);
		assert.strictEqual(classifyHunk(h1, base, acc2.current).status, 'conflict');
	});

	test('accept then recompute drops the hunk', () => {
		const base = 'a\nb\nc\nd\ne\n', agent = 'a\nB\nc\nd\nE\n';
		const hunks = computeHunks(base, agent);
		const r = acceptHunk(classifyHunk(hunks[0], base, base), base, base);
		assert.strictEqual(computeHunks(r.base, agent).length, 1);
		assert.ok(r.current.includes('B'));
	});

	test('reject then recompute drops the hunk', () => {
		const base = 'a\nb\nc\nd\ne\n', agent = 'a\nB\nc\nd\nE\n';
		const hunks = computeHunks(base, agent);
		const newAgent = rejectHunk(hunks[0], agent);
		assert.strictEqual(newAgent, 'a\nb\nc\nd\nE\n');
		assert.strictEqual(computeHunks(base, newAgent).length, 1);
	});

	test('CRLF current keeps CRLF', () => {
		const base = 'a\nb\nc\n', agent = 'a\nB\nc\n';
		const current = 'a\r\nb\r\nc\r\n';
		const [hunk] = computeHunks(base, agent);
		const r = acceptHunk(classifyHunk(hunk, base, current), base, current);
		assert.strictEqual(r.current, 'a\r\nB\r\nc\r\n');
		assert.ok(!/(?<!\r)\n/.test(r.current));
	});

	test('added file', () => {
		const r = reviewFile('f', null, 'x\ny\n', null, false);
		assert.strictEqual(r.kind, 'added');
		assert.strictEqual(r.hunks.length, 1);
		assert.strictEqual(r.hunks[0].status, 'clean');
		assert.strictEqual(r.added, 2);
		assert.strictEqual(reviewFile('f', null, 'x\n', 'x\n', false).hunks.length, 0);
		assert.strictEqual(reviewFile('f', null, 'x\n', 'other\n', false).fileConflict, true);
	});

	test('deleted file', () => {
		const ok = reviewFile('f', 'a\nb\n', null, 'a\nb\n', false);
		assert.strictEqual(ok.kind, 'deleted');
		assert.strictEqual(ok.fileConflict, false);
		assert.strictEqual(ok.removed, 2);
		assert.strictEqual(reviewFile('f', 'a\nb\n', null, 'a\nc\n', false).fileConflict, true);
	});

	test('user deleted a modified file', () => {
		assert.strictEqual(reviewFile('f', 'a\n', 'b\n', null, false).fileConflict, true);
	});

	test('binary', () => {
		const r = reviewFile('f', 'a', 'b', 'a', true);
		assert.strictEqual(r.kind, 'binary');
		assert.deepStrictEqual(r.hunks, []);
	});
});

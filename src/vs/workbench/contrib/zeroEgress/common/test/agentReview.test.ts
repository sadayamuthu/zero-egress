/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { acceptHunk, classifyHunk, computeHunks, decodeReviewText, linesMatch, minimalEdit, rejectHunk, reviewFile } from '../agentReview.js';

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

	test('linesMatch ignores a trailing newline and line endings only', () => {
		assert.strictEqual(linesMatch('a\nb\n', 'a\nb'), true);
		assert.strictEqual(linesMatch('a\r\nb\r\n', 'a\nb\n'), true);
		assert.strictEqual(linesMatch(null, null), true);
		assert.strictEqual(linesMatch(null, ''), false);
		assert.strictEqual(linesMatch('', null), false);
		assert.strictEqual(linesMatch('a\n', 'b\n'), false);
	});

	test('accepting a hunk that only differs in the trailing newline leaves nothing pending', () => {
		const base = 'a\nb\n', agent = 'a\nB';
		const [hunk] = computeHunks(base, agent);
		const r = acceptHunk(classifyHunk(hunk, base, base), base, base);
		assert.strictEqual(r.base, 'a\nB\n');
		assert.strictEqual(linesMatch(r.base, agent), true);
		assert.deepStrictEqual(computeHunks(r.base, agent), []);
	});

	test('CRLF agent against an LF base has no hunks and matches', () => {
		assert.deepStrictEqual(computeHunks('a\nb\n', 'a\r\nb\r\n'), []);
		assert.strictEqual(linesMatch('a\nb\n', 'a\r\nb\r\n'), true);
	});

	test('decodeReviewText strips a BOM and refuses bytes that are not UTF-8', () => {
		assert.deepStrictEqual(decodeReviewText(new Uint8Array([0x61, 0x0a])), { text: 'a\n', bom: false });
		assert.deepStrictEqual(decodeReviewText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0a])), { text: 'a\n', bom: true });
		assert.deepStrictEqual(decodeReviewText(new Uint8Array([0xc3, 0xa9])), { text: '\u00e9', bom: false });
		assert.strictEqual(decodeReviewText(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a])), undefined); // latin1 "café"
		assert.deepStrictEqual(decodeReviewText(new Uint8Array([0xef, 0xbf, 0xbd])), { text: '\ufffd', bom: false }); // a real U+FFFD is fine
	});

	test('minimalEdit replaces only the changed lines', () => {
		const apply = (old: string, e: { start: number; end: number; text: string }) => old.slice(0, e.start) + e.text + old.slice(e.end);
		const cases: [string, string][] = [
			['a\nb\nc\n', 'a\nB\nc\n'],
			['a\nb\nc\n', 'a\nb\nc\n'],
			['a\nb', 'a\nb\nc'],
			['x\n', ''],
			['', 'new\n'],
			['a\nb\nb\nc\n', 'a\nb\nc\n'],
			['a\r\nb\r\nc\r\n', 'a\r\nX\r\nY\r\nc\r\n'],
		];
		for (const [old, next] of cases) {
			assert.strictEqual(apply(old, minimalEdit(old, next)), next, JSON.stringify([old, next]));
		}
		assert.deepStrictEqual(minimalEdit('a\nb\nc\n', 'a\nB\nc\n'), { start: 2, end: 4, text: 'B\n' });
		assert.deepStrictEqual(minimalEdit('a\nb\nc\n', 'a\nb\nc\n'), { start: 6, end: 6, text: '' });
		assert.deepStrictEqual(minimalEdit('a\nb\nc\nd\n', 'a\nb\nc\nd\ne\n'), { start: 8, end: 8, text: 'e\n' });
	});
});

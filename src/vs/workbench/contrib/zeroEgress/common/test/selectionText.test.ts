/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { messageOfSelection } from '../prompt/prompts.js';
import { DIFF_MAX_CHARS, TERMINAL_MAX_CHARS, textOfSnapshotSelection, isValidBranchName, imageExtOf } from '../selectionText.js';

suite('selectionText', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('terminal keeps the tail', () => {
		const text = 'a'.repeat(25_000) + 'END';
		const out = textOfSnapshotSelection({ type: 'Terminal', title: 't', text, capturedAt: '2026-01-01T00:00:00.000Z' });
		assert.ok(out.includes('END'));
		const body = out.slice(out.indexOf('```\n') + 4, out.lastIndexOf('\n```'));
		assert.ok(body.length <= TERMINAL_MAX_CHARS);
	});

	test('diff marks truncation', () => {
		const out = textOfSnapshotSelection({ type: 'GitDiff', against: null, text: 'x'.repeat(70_000), truncated: false });
		assert.ok(out.includes('(truncated)'));
		assert.ok(out.length < DIFF_MAX_CHARS + 200);
	});

	test('problems lines', () => {
		const out = textOfSnapshotSelection({ type: 'Problems', items: [{ path: 'src/a.ts', line: 3, severity: 'error', message: 'x' }] });
		assert.strictEqual(out, 'Problems:\nsrc/a.ts:3 error: x');
	});

	test('unknown selection type gives empty text', async () => {
		const opts = {
			directoryStrService: {} as any,
			fileService: {} as any,
			folderOpts: { maxChildren: 1, maxCharsPerFile: 1 },
		};
		assert.strictEqual(await messageOfSelection({ type: 'Nope' } as any, opts), '');
	});

	test('branch names', () => {
		for (const ok of ['main', 'feature/x-1', 'release/1.2']) { assert.strictEqual(isValidBranchName(ok), true, ok); }
		for (const bad of ['-o', 'main;rm -rf ~', 'a..b', '$(x)', '']) { assert.strictEqual(isValidBranchName(bad), false, bad); }
	});

	test('image types', () => {
		assert.strictEqual(imageExtOf('image/jpeg'), 'jpg');
		assert.strictEqual(imageExtOf('image/png'), 'png');
		assert.strictEqual(imageExtOf('image/svg+xml'), null);
	});
});

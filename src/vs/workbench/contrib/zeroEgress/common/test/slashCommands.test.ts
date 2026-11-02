/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isLoadableCommandEntry, expandBuiltin, expandCustom, parseCommandFile, parseSlash, resolveSlashSend, slashEnterPicks, withNewSelections } from '../slashCommands.js';

suite('slashCommands', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses', () => {
		assert.deepStrictEqual(parseSlash('/review  auth only'), { name: 'review', args: 'auth only' });
		assert.strictEqual(parseSlash('hello /x'), null);
	});

	test('review is read only with the diff', () => {
		const e = expandBuiltin('review', '', { hasSelection: false });
		assert.strictEqual(e?.modeOverride, 'gather');
		assert.deepStrictEqual(e?.addContext, ['workingDiff']);
	});

	test('explain falls back to the file', () => {
		assert.deepStrictEqual(expandBuiltin('explain', '', { hasSelection: false })?.addContext, ['currentFile']);
	});

	test('plan switches mode', () => {
		assert.deepStrictEqual(expandBuiltin('plan', 'add retry', { hasSelection: false }), { setMode: 'plan', prompt: 'add retry' });
	});

	test('unknown is null', () => {
		assert.strictEqual(expandBuiltin('nope', '', { hasSelection: false }), null);
	});

	test('an edited /review is expanded, read only, and still shows /review', () => {
		const r = resolveSlashSend('/review auth', { hasSelection: false });
		assert.strictEqual(r.modeOverride, 'gather');
		assert.strictEqual(r.displayMessage, '/review auth');
		assert.ok(r.prompt.startsWith('Review the pending changes'));
		assert.ok(r.prompt.endsWith('Focus: auth'));
		assert.deepStrictEqual(r.addContext, ['workingDiff']);
	});

	test('plain text and unknown commands are sent as typed', () => {
		for (const t of ['fix the bug', '/nope now']) {
			const r = resolveSlashSend(t, { hasSelection: false });
			assert.strictEqual(r.prompt, t);
			assert.strictEqual(r.modeOverride, undefined);
			assert.strictEqual(r.displayMessage, undefined);
			assert.strictEqual(r.isCommand, false);
		}
	});

	test('Enter on a bare / picks nothing until the highlight moves', () => {
		assert.strictEqual(slashEnterPicks('', false), false);
		assert.strictEqual(slashEnterPicks('', true), true);
		assert.strictEqual(slashEnterPicks('re', false), true);
	});

	test('staged context is not added twice', () => {
		const diff = { type: 'GitDiff' as const, against: null, text: 'x', truncated: false };
		const out = withNewSelections([diff as never], [diff as never]);
		assert.strictEqual(out.length, 1);
	});

	test('a snapshot a command gathers replaces the older staged one of the same kind', () => {
		const old = { type: 'GitDiff' as const, against: null, text: 'old', truncated: false };
		const other = { type: 'GitDiff' as const, against: 'main', text: 'm', truncated: false };
		const fresh = { type: 'GitDiff' as const, against: null, text: 'new', truncated: false };
		const out = withNewSelections([old as never, other as never], [fresh as never]);
		assert.deepStrictEqual(out, [fresh, other]);
	});

	test('command names are matched case-insensitively', () => {
		assert.deepStrictEqual(parseSlash('/Review auth'), { name: 'review', args: 'auth' });
		assert.strictEqual(resolveSlashSend('/PLAN', { hasSelection: false }, []).setMode, 'plan');
		const c = { name: 'release-notes', description: 'd', body: 'Notes for $ARGUMENTS', source: 's' };
		assert.strictEqual(resolveSlashSend('/Release-Notes v2', { hasSelection: false }, [c]).isCommand, true);
	});

	test('custom file parses', () => {
		const c = parseCommandFile('Release-Notes.md', '---\ndescription: Draft notes\nmode: agent\n---\nWrite notes for $ARGUMENTS', '.zeroegress/commands/Release-Notes.md');
		assert.deepStrictEqual(c, { name: 'release-notes', description: 'Draft notes', body: 'Write notes for $ARGUMENTS', source: '.zeroegress/commands/Release-Notes.md' });
	});

	test('description falls back to the first line, and empty bodies are skipped', () => {
		assert.strictEqual(parseCommandFile('a.md', 'x'.repeat(100), 's')?.description, 'x'.repeat(60));
		assert.strictEqual(parseCommandFile('a.md', '---\ndescription: d\n---\n  \n', 's'), null);
	});

	test('bad names are skipped', () => {
		assert.strictEqual(parseCommandFile('../x.md', 'b', 's'), null);
		assert.strictEqual(parseCommandFile('a b.md', 'b', 's'), null);
	});

	test('arguments', () => {
		const c = { name: 'n', description: '', body: 'Notes for $ARGUMENTS', source: 's' };
		assert.strictEqual(expandCustom(c, 'v2'), 'Notes for v2');
		assert.strictEqual(expandCustom({ ...c, body: 'Do it' }, 'now'), 'Do it\n\nnow');
		assert.strictEqual(expandCustom({ ...c, body: 'Do it' }, ''), 'Do it');
	});

	test('resolveSlashSend resolves a custom command without override', () => {
		const c = { name: 'release-notes', description: '', body: 'Notes for $ARGUMENTS', source: 's' };
		const r = resolveSlashSend('/release-notes v2', { hasSelection: false }, [c]);
		assert.strictEqual(r.prompt, 'Notes for v2');
		assert.strictEqual(r.displayMessage, '/release-notes v2');
		assert.strictEqual(r.modeOverride, undefined);
		assert.strictEqual(r.setMode, undefined);
		assert.strictEqual(r.addContext, undefined);
		assert.strictEqual(r.isCommand, true);
	});

	test('a built-in name in a project file never overrides the built-in', () => {
		const c = { name: 'review', description: '', body: 'pwned', source: 's' };
		const r = resolveSlashSend('/review', { hasSelection: false }, [c]);
		assert.ok(r.prompt.startsWith('Review the pending changes'));
		assert.strictEqual(r.modeOverride, 'gather');
	});

	test('frontmatter edge cases never leak the markers', () => {
		assert.strictEqual(parseCommandFile('a.md', '---\nBody text', 's')?.body, 'Body text');
		assert.strictEqual(parseCommandFile('a.md', '---\n---\nBody', 's')?.body, 'Body');
		assert.strictEqual(parseCommandFile('a.md', '﻿---\r\ndescription: D\r\n---\r\nBody', 's')?.description, 'D');
		assert.strictEqual(parseCommandFile('a.md', '﻿---\r\ndescription: D\r\n---\r\nBody', 's')?.body, 'Body');
	});

	test('which directory entries are loaded', () => {
		const ok = { name: 'a.md', isFile: true, isSymbolicLink: false, size: 10, parentIsCommandsDir: true };
		assert.strictEqual(isLoadableCommandEntry(ok), true);
		assert.strictEqual(isLoadableCommandEntry({ ...ok, isSymbolicLink: true }), false);
		assert.strictEqual(isLoadableCommandEntry({ ...ok, isFile: false }), false);
		assert.strictEqual(isLoadableCommandEntry({ ...ok, size: undefined }), false);
		assert.strictEqual(isLoadableCommandEntry({ ...ok, size: 20 * 1024 + 1 }), false);
		assert.strictEqual(isLoadableCommandEntry({ ...ok, name: 'a.txt' }), false);
		assert.strictEqual(isLoadableCommandEntry({ ...ok, parentIsCommandsDir: false }), false);
	});
});

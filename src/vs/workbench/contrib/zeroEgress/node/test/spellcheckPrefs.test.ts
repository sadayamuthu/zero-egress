/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PrefsFileIO, seedSpellcheckOff, withSpellcheckOff } from '../spellcheckPrefs.js';

function fakeIO(files: Record<string, string>): PrefsFileIO & { files: Record<string, string>; dirs: string[] } {
	const dirs: string[] = [];
	return {
		files, dirs,
		readFileSync: path => { if (!(path in files)) { throw new Error('ENOENT'); } return files[path]; },
		writeFileSync: (path, data) => { files[path] = data; },
		mkdirSync: path => { dirs.push(path); },
	};
}

suite('ZeroEgress spellcheck prefs', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a first launch (no Preferences yet) writes spell checking off with no dictionaries', () => {
		const io = fakeIO({});
		assert.strictEqual(seedSpellcheckOff('/u/Preferences', io), true);
		assert.deepStrictEqual(io.dirs, ['/u']);
		assert.deepStrictEqual(JSON.parse(io.files['/u/Preferences']), {
			spellcheck: { dictionaries: [], dictionary: '' },
			browser: { enable_spellchecking: false },
		});
	});

	test('the dictionaries Electron wrote are cleared and every other preference is kept', () => {
		const io = fakeIO({ '/u/Preferences': JSON.stringify({ spellcheck: { dictionaries: ['en-US'], other: 1 }, browser: { x: true }, devtools: { y: 2 } }) });
		assert.strictEqual(seedSpellcheckOff('/u/Preferences', io), true);
		assert.deepStrictEqual(JSON.parse(io.files['/u/Preferences']), {
			spellcheck: { dictionaries: [], dictionary: '', other: 1 },
			browser: { x: true, enable_spellchecking: false },
			devtools: { y: 2 },
		});
	});

	test('an already seeded file is left alone', () => {
		const seeded = JSON.stringify(withSpellcheckOff({ a: 1 }).prefs);
		const io = fakeIO({ '/u/Preferences': seeded });
		assert.strictEqual(seedSpellcheckOff('/u/Preferences', io), false);
		assert.strictEqual(io.files['/u/Preferences'], seeded);
		assert.deepStrictEqual(io.dirs, []);
	});

	test('a file that is not valid JSON, or not an object, is replaced', () => {
		for (const text of ['{not json', '[1,2]', 'null']) {
			const io = fakeIO({ '/u/Preferences': text });
			assert.strictEqual(seedSpellcheckOff('/u/Preferences', io), true, text);
			assert.deepStrictEqual(JSON.parse(io.files['/u/Preferences']).spellcheck.dictionaries, [], text);
		}
	});

	test('a legacy single dictionary or spell checking left on still counts as not seeded', () => {
		assert.strictEqual(withSpellcheckOff({ spellcheck: { dictionaries: [], dictionary: 'en-US' }, browser: { enable_spellchecking: false } }).changed, true);
		assert.strictEqual(withSpellcheckOff({ spellcheck: { dictionaries: [] }, browser: { enable_spellchecking: true } }).changed, true);
		assert.strictEqual(withSpellcheckOff({ spellcheck: { dictionaries: [] }, browser: { enable_spellchecking: false } }).changed, false);
	});
});

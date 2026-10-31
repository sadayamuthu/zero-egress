/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Electron's built-in spell checker (Linux; Windows when not using the OS one) downloads a Hunspell
// dictionary for the UI language from redirector.gvt1.com as soon as the default session is created:
// before any app code can turn it off, and outside the session's webRequest filter, so the egress
// guard never sees it. Chromium reads the session's `Preferences` file when it creates the session,
// so seeding it beforehand with no dictionaries (and spell checking off) leaves nothing to download.

import { dirname } from 'path';

/** Only what seeding needs from `fs`, so tests can pass a fake. */
export interface PrefsFileIO {
	readFileSync(path: string, encoding: 'utf8'): string;
	writeFileSync(path: string, data: string): void;
	mkdirSync(path: string, options: { recursive: true }): unknown;
}

type Prefs = Record<string, unknown>;

const isObject = (v: unknown): v is Prefs => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `prefs` with no spell-check dictionaries and spell checking off; `changed` is false when it already was. */
export function withSpellcheckOff(prefs: unknown): { prefs: Prefs; changed: boolean } {
	const base = isObject(prefs) ? prefs : {};
	const spellcheck = isObject(base.spellcheck) ? base.spellcheck : {};
	const browser = isObject(base.browser) ? base.browser : {};
	const dictionaries = spellcheck.dictionaries;
	const changed = !(Array.isArray(dictionaries) && dictionaries.length === 0)
		|| (spellcheck.dictionary !== undefined && spellcheck.dictionary !== '')
		|| browser.enable_spellchecking !== false;
	return {
		prefs: {
			...base,
			spellcheck: { ...spellcheck, dictionaries: [], dictionary: '' },
			browser: { ...browser, enable_spellchecking: false },
		},
		changed,
	};
}

/**
 * Writes spell checking off into the Chromium `Preferences` file at `file` (the default session's, in the
 * user data folder), creating it if needed and keeping every other preference. A file that isn't valid
 * JSON is replaced, as Chromium itself would. Returns true when it wrote the file.
 */
export function seedSpellcheckOff(file: string, io: PrefsFileIO): boolean {
	let current: unknown;
	try {
		current = JSON.parse(io.readFileSync(file, 'utf8'));
	} catch {
		current = undefined; // missing or unreadable
	}
	const { prefs, changed } = withSpellcheckOff(current);
	if (!changed) {
		return false;
	}
	io.mkdirSync(dirname(file), { recursive: true });
	io.writeFileSync(file, JSON.stringify(prefs));
	return true;
}

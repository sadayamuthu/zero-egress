/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Which project files the agent may read into its prompt. A repo can ship `.zeroegressrules` as a link to a secret file.

export const PROJECT_RULES_MAX_BYTES = 64 * 1024;

/** a project rules file is read only if it is a plain file (not a symlink) of known size, at most 64 KB */
export function isReadableProjectRulesFile(e: { isFile: boolean; isSymbolicLink: boolean; size: number | undefined }): boolean {
	return e.isFile && !e.isSymbolicLink && e.size !== undefined && e.size <= PROJECT_RULES_MAX_BYTES;
}

export type ProjectRulesState = 'ok' | 'missing' | 'link' | 'unsafe';

/** the state of an existing rules file: a link is told apart so the notice can say so */
export function projectRulesStateOf(e: { isFile: boolean; isSymbolicLink: boolean; size: number | undefined }): Exclude<ProjectRulesState, 'missing'> {
	if (e.isSymbolicLink) { return 'link'; }
	return isReadableProjectRulesFile(e) ? 'ok' : 'unsafe';
}

/** why the panel won't open the rules file */
export function projectRulesRefusal(state: 'link' | 'unsafe'): string {
	return state === 'link' ? ".zeroegressrules is a link, so ZeroEgress won't read it." : ".zeroegressrules isn't a plain file under 64 KB, so ZeroEgress won't read it.";
}

/** numbers async checks per key, so a check that finishes after a newer one for the same key is ignored */
export class LatestOnly {
	private readonly _gen = new Map<string, number>();
	start(key: string): number {
		const g = (this._gen.get(key) ?? 0) + 1;
		this._gen.set(key, g);
		return g;
	}
	isLatest(key: string, gen: number): boolean {
		return this._gen.get(key) === gen;
	}
}

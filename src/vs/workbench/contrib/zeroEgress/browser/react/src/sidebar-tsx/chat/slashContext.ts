/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Fetches the context a / command stages before it is sent (the pending diff, the selection, the open file), for
// both the composer and the edit-resend path. Type imports only: the bundle flattens this folder.

import type { StagingSelectionItem } from '../../../../../common/chatThreadServiceTypes.js';

type FileSelection = Extract<StagingSelectionItem, { type: 'File' }>;

export type SlashContextDeps = {
	contextService: {
		gitDiff(against: null): Promise<StagingSelectionItem | null>;
		currentSelection(): StagingSelectionItem | null;
	};
	activeUri: FileSelection['uri'] | undefined | null;
	languageOf(uri: FileSelection['uri']): string;
	notify(message: string): void;
};

/** the selections the command needs, or null (after telling the user why) when one can't be had: the text then stays put */
export async function gatherSlashContext(kinds: readonly ('workingDiff' | 'selection' | 'currentFile')[], deps: SlashContextDeps): Promise<StagingSelectionItem[] | null> {
	const out: StagingSelectionItem[] = [];
	for (const kind of kinds) {
		let sel: StagingSelectionItem | null = null;
		try {
			sel = kind === 'workingDiff' ? await deps.contextService.gitDiff(null)
				: kind === 'selection' ? deps.contextService.currentSelection()
					: deps.activeUri ? { type: 'File', uri: deps.activeUri, language: deps.languageOf(deps.activeUri), state: { wasAddedAsCurrentFile: false } } : null;
		} catch (e) {
			deps.notify(`Couldn't read the context for this command: ${e instanceof Error ? e.message : String(e)}`);
			return null;
		}
		if (!sel) {
			deps.notify(kind === 'workingDiff' ? 'There are no pending changes to send.' : 'Open a file first.');
			return null;
		}
		out.push(sel);
	}
	return out;
}

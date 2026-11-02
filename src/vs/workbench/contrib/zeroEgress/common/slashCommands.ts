/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The built-in / commands of the chat box: what the menu lists, how typed text is read as a command, and what each
// command turns into (a prompt, a mode for that one message, context to stage first). No vs/ runtime imports: the
// React bundle takes this file as it is.

import type { ChatMode } from './zeroEgressSettingsTypes.js';

export type SlashExpansion = {
	/** the message sent to the model (empty: nothing to send) */
	prompt: string;
	/** switch the chat's mode for good (the user's chosen mode changes) */
	setMode?: ChatMode;
	/** run this one message in another mode; the chosen mode is unchanged afterwards */
	modeOverride?: ChatMode;
	/** context staged before the message is sent */
	addContext?: ('workingDiff' | 'selection' | 'currentFile')[];
	/** shrink the chat instead of sending */
	compact?: true;
};

export const builtinCommands: readonly { name: string; detail: string }[] = [
	{ name: 'plan', detail: 'switch to Plan' },
	{ name: 'test', detail: 'write or run tests' },
	{ name: 'review', detail: 'review pending diff' },
	{ name: 'explain', detail: 'explain selection' },
	{ name: 'commit', detail: 'message from diff' },
	{ name: 'compact', detail: 'shrink this chat' },
];

/** the text the menu is open for: a slash and the start of a command name, nothing else */
export const slashMenuQuery = (text: string): string | null => {
	const m = /^\/([\w-]*)$/.exec(text);
	return m ? m[1].toLowerCase() : null;
};

export function parseSlash(text: string): { name: string; args: string } | null {
	const m = /^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(text);
	return m ? { name: m[1], args: (m[2] ?? '').trim() } : null;
}

export function expandBuiltin(name: string, args: string, ctx: { hasSelection: boolean }): SlashExpansion | null {
	switch (name) {
		case 'plan':
			return { setMode: 'plan', prompt: args };
		case 'test':
			return { prompt: 'Write or update tests for ' + (args || 'the code I\'m working on') + ', then run them and fix any failures.' };
		case 'review':
			return {
				modeOverride: 'gather',
				addContext: ['workingDiff'],
				prompt: 'Review the pending changes in the diff for bugs, missing tests and unclear code. List problems by file with line numbers, most serious first.' + (args ? ' Focus: ' + args : ''),
			};
		case 'explain':
			return {
				modeOverride: 'normal',
				addContext: [ctx.hasSelection ? 'selection' : 'currentFile'],
				prompt: 'Explain what this code does and why, step by step.' + (args ? ' ' + args : ''),
			};
		case 'commit':
			return {
				modeOverride: 'normal',
				addContext: ['workingDiff'],
				prompt: 'Write a commit message for these changes: one summary line under 72 characters, a blank line, then short bullet points. Reply with only the message.',
			};
		case 'compact':
			return { compact: true, prompt: '' };
		default:
			return null;
	}
}

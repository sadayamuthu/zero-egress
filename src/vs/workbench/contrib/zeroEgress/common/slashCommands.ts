/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The built-in / commands of the chat box: what the menu lists, how typed text is read as a command, and what each
// command turns into (a prompt, a mode for that one message, context to stage first). No vs/ runtime imports: the
// React bundle takes this file as it is.

import type { StagingSelectionItem } from './chatThreadServiceTypes.js';
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

/** Enter picks a row only once the user has typed a letter of a command or moved the highlight: a bare "/" plus Enter does nothing */
export const slashEnterPicks = (query: string, userMovedHighlight: boolean): boolean => query.length > 0 || userMovedHighlight;

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

/**
 * What typed text turns into when it is sent: the one decision both the composer and the edit-resend path use.
 * Plain text (and an unknown /word) is sent as it is. A built-in command sends its expanded prompt, and the bubble
 * keeps showing the command as typed.
 */
export type SlashSend = SlashExpansion & {
	/** what the user's bubble shows, when it is not the prompt */
	displayMessage?: string;
	/** true when the text was a built-in command */
	isCommand: boolean;
};

export function resolveSlashSend(text: string, ctx: { hasSelection: boolean }, custom: readonly CustomCommand[] = []): SlashSend {
	const slash = parseSlash(text.trim());
	const expansion = slash ? expandBuiltin(slash.name, slash.args, ctx) : null;
	if (expansion) { return { ...expansion, displayMessage: text.trim(), isCommand: true }; }
	// a project command is prompt text only: no mode, no tools, no context of its own. Built-in names were tried first.
	const c = slash && custom.find(x => x.name === slash.name);
	if (slash && c) { return { prompt: expandCustom(c, slash.args), displayMessage: text.trim(), isCommand: true }; }
	return { prompt: text, isCommand: false };
}

/** a command from a project's .zeroegress/commands/<name>.md; `source` is the folder-relative path */
export type CustomCommand = { name: string; description: string; body: string; source: string };

/**
 * Reads a command file. Only `description:` of the optional frontmatter is used: every other key is ignored, so a
 * project file can never pick a mode, tools or auto-run settings.
 */
export function parseCommandFile(fileName: string, text: string, source: string): CustomCommand | null {
	if (!/\.md$/i.test(fileName)) { return null; }
	const name = fileName.slice(0, -3).toLowerCase();
	if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) { return null; }
	let body = text.replace(/^\uFEFF/, '');
	let description = '';
	const fm = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(body);
	if (fm) {
		body = body.slice(fm[0].length);
		const d = /^description:[ \t]*(.*)$/m.exec(fm[1]);
		if (d) { description = d[1].trim().replace(/^(["'])(.*)\1$/, '$2'); }
	}
	body = body.trim();
	if (!body) { return null; }
	if (!description) { description = body.split(/\r?\n/)[0].trim().slice(0, 60); }
	return { name, description, body, source };
}

export function expandCustom(c: CustomCommand, args: string): string {
	if (c.body.includes('$ARGUMENTS')) { return c.body.split('$ARGUMENTS').join(args); }
	return args ? c.body + '\n\n' + args : c.body;
}

/** the selections plus those of `added` that are not already there (a diff, a file or a code selection is staged once) */
export function withNewSelections(selections: StagingSelectionItem[], added: StagingSelectionItem[]): StagingSelectionItem[] {
	const same = (a: StagingSelectionItem, b: StagingSelectionItem) => {
		if (a.type !== b.type) { return false; }
		if (a.type === 'GitDiff' && b.type === 'GitDiff') { return a.against === b.against; }
		if (a.type === 'File' && b.type === 'File') { return a.uri.fsPath === b.uri.fsPath; }
		if (a.type === 'CodeSelection' && b.type === 'CodeSelection') { return a.uri.fsPath === b.uri.fsPath && a.range[0] === b.range[0] && a.range[1] === b.range[1]; }
		return false;
	};
	return [...selections, ...added.filter(n => !selections.some(s => same(s, n)))];
}

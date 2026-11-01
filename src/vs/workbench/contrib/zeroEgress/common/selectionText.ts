/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { StagingSelectionItem } from './chatThreadServiceTypes.js';
import type { PromptContextItem } from './promptContext.js';

export const TERMINAL_MAX_CHARS = 20_000;
export const DIFF_MAX_CHARS = 60_000;
export const PROBLEMS_MAX = 100;
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export type SavedDoc = { name: string; path: string; isFolder: boolean };

const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;

/** a branch name safe to pass to git as an argument */
export function isValidBranchName(name: string): boolean {
	return BRANCH_RE.test(name) && !name.startsWith('-') && !name.includes('..');
}

export function imageExtOf(mime: string): 'png' | 'jpg' | 'webp' | 'gif' | null {
	switch (mime) {
		case 'image/png': return 'png';
		case 'image/jpeg': return 'jpg';
		case 'image/webp': return 'webp';
		case 'image/gif': return 'gif';
		default: return null;
	}
}

const FENCE = '```';

/** keeps the last `max` chars */
export function capTail(text: string, max: number): string {
	return text.length > max ? text.slice(text.length - max) : text;
}

/** keeps the first `max` chars */
export function capHead(text: string, max: number): string {
	return text.length > max ? text.slice(0, max) : text;
}

/** the prompt text of a snapshot selection; '' for any other type */
export function textOfSnapshotSelection(s: StagingSelectionItem): string {
	if (s.type === 'Terminal') {
		return `Terminal output (${s.title}):\n${FENCE}\n${capTail(s.text, TERMINAL_MAX_CHARS)}\n${FENCE}`;
	}
	if (s.type === 'Problems') {
		return 'Problems:\n' + s.items.slice(0, PROBLEMS_MAX)
			.map(p => `${p.path}:${p.line} ${p.severity}: ${p.message}`).join('\n');
	}
	if (s.type === 'GitDiff') {
		const what = s.against === null ? 'working changes' : 'against ' + s.against;
		const truncated = s.truncated || s.text.length > DIFF_MAX_CHARS;
		return `Git diff (${what})${truncated ? ' (truncated)' : ''}:\n${FENCE}diff\n${capHead(s.text, DIFF_MAX_CHARS)}\n${FENCE}`;
	}
	if (s.type === 'Symbol') {
		return `Symbol ${s.name} (${s.kind}) in ${s.uri.fsPath} (lines ${s.range[0]}:${s.range[1]}):`;
	}
	return '';
}

/**
 * The chip a selection becomes in a background agent's plain-text first message. Terminal, Problems and GitDiff carry
 * their text as a snapshot (never a file line, even a Problems selection that has a uri); Image has none (undefined).
 * `pathOf` turns a uri into the path as shown and whether it is outside the workspace.
 */
export function promptContextOfSelection(
	s: StagingSelectionItem,
	pathOf: (uri: { fsPath: string }) => { path: string; absolute: boolean },
): PromptContextItem | undefined {
	if (s.type === 'Terminal' || s.type === 'Problems' || s.type === 'GitDiff') {
		return { kind: 'snapshot', text: textOfSnapshotSelection(s) };
	}
	if (s.type === 'Image') {
		return undefined;
	}
	const uri = (s as { uri?: { fsPath: string } }).uri;
	if (!uri) {
		return undefined;
	}
	const { path, absolute } = pathOf(uri);
	return s.type === 'Folder' || (s.type === 'Doc' && s.isFolder) ? { kind: 'folder', path, absolute }
		: s.type === 'CodeSelection' || s.type === 'Symbol' ? { kind: 'selection', path, range: s.range, absolute }
			: { kind: 'file', path, absolute };
}

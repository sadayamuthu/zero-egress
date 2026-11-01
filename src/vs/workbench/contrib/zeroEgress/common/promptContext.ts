/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The context chips of a prompt that is sent as plain text (a background agent's first message takes no selections).
// Pure, with no runtime imports, so the React bundle can use it through sidebar-tsx/.

/** `absolute`: the path is outside the workspace (an absolute fsPath), so it is kept as is */
export type PromptContextItem =
	| { readonly kind: 'file'; readonly path: string; readonly absolute?: boolean }
	| { readonly kind: 'folder'; readonly path: string; readonly absolute?: boolean }
	| { readonly kind: 'selection'; readonly path: string; readonly range: readonly [number, number]; readonly absolute?: boolean };

/** a workspace-relative path without a leading or trailing separator, with forward slashes */
const cleanRelative = (path: string) => path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');

/** the path as shown: absolute paths keep their form; a folder ends with one separator of the path's own kind */
const shown = (item: PromptContextItem) => {
	if (!item.absolute) {
		return item.kind === 'folder' ? `${cleanRelative(item.path)}/` : cleanRelative(item.path);
	}
	if (item.kind !== 'folder') {
		return item.path;
	}
	const sep = item.path.includes('\\') ? '\\' : '/';
	const trimmed = item.path.replace(/[\\/]+$/, '');
	return `${trimmed}${sep}`;
};

/**
 * `prompt`, then a blank line, `Context:` and one line per chip: `- <path>` for a file, `- <path>/` for a folder,
 * `- <path>:L<start>-L<end>` for a code selection. Workspace paths are relative; others stay absolute. No chips: the
 * prompt unchanged.
 */
export function promptWithContext(prompt: string, items: readonly PromptContextItem[]): string {
	if (items.length === 0) {
		return prompt;
	}
	const lines = items.map(item => item.kind === 'selection'
		? `- ${shown(item)}:L${item.range[0]}-L${item.range[1]}`
		: `- ${shown(item)}`);
	return `${prompt}\n\nContext:\n${lines.join('\n')}`;
}

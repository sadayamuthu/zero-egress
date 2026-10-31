/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The context chips of a prompt that is sent as plain text (a background agent's first message takes no selections).
// Pure, with no runtime imports, so the React bundle can use it through sidebar-tsx/.

export type PromptContextItem =
	| { readonly kind: 'file'; readonly path: string }
	| { readonly kind: 'folder'; readonly path: string }
	| { readonly kind: 'selection'; readonly path: string; readonly range: readonly [number, number] };

/** a workspace-relative path without a leading or trailing separator, with forward slashes */
const clean = (path: string) => path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');

/**
 * `prompt`, then a blank line, `Context:` and one line per chip: `- <path>` for a file, `- <path>/` for a folder,
 * `- <path>:L<start>-L<end>` for a code selection. No chips: the prompt unchanged.
 */
export function promptWithContext(prompt: string, items: readonly PromptContextItem[]): string {
	if (items.length === 0) {
		return prompt;
	}
	const lines = items.map(item =>
		item.kind === 'file' ? `- ${clean(item.path)}`
			: item.kind === 'folder' ? `- ${clean(item.path)}/`
				: `- ${clean(item.path)}:L${item.range[0]}-L${item.range[1]}`);
	return `${prompt}\n\nContext:\n${lines.join('\n')}`;
}

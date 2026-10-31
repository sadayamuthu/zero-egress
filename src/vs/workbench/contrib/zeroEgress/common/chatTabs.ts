/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Chat titles and the docked panel's open tabs. Pure functions with no runtime imports, so the React bundle can use
// them (through sidebar-tsx/chatTitle.ts) as well as the chat thread service.

const TITLE_MAX = 40;

/** the title the user set, else the first user message trimmed to 40 characters with `…`, else `New chat` */
export function threadTitleOf(t: { title?: string; messages: readonly { role: string; displayContent?: string }[] }): string {
	const title = t.title?.trim();
	if (title) {
		return title;
	}
	const first = t.messages.find(m => m.role === 'user')?.displayContent?.trim();
	if (!first) {
		return 'New chat';
	}
	return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX)}…` : first;
}

export const MAX_OPEN_TABS = 8;

/** appends `id` if missing; over MAX_OPEN_TABS, drops the oldest tab that isn't running (never `id` itself) */
export function openTab(tabs: readonly string[], id: string, isRunning: (id: string) => boolean = () => false): string[] {
	const next = tabs.includes(id) ? [...tabs] : [...tabs, id];
	while (next.length > MAX_OPEN_TABS) {
		const idx = next.findIndex(t => t !== id && !isRunning(t));
		if (idx === -1) {
			break; // every other tab is running: keep them all
		}
		next.splice(idx, 1);
	}
	return next;
}

/**
 * `next` is `current` when a different tab was closed; otherwise the right neighbour, else the left one, else
 * undefined (the caller opens a new thread)
 */
export function closeTab(tabs: readonly string[], id: string, current: string): { tabs: string[]; next: string | undefined } {
	const idx = tabs.indexOf(id);
	const rest = tabs.filter(t => t !== id);
	if (id !== current) {
		return { tabs: rest, next: current };
	}
	if (idx === -1) {
		return { tabs: rest, next: rest[rest.length - 1] };
	}
	return { tabs: rest, next: tabs[idx + 1] ?? tabs[idx - 1] };
}

/**
 * The tabs and current chat to reopen at startup, from what was stored under the open-tabs key: `{ tabs, current }`,
 * or the older plain `string[]`. Drops ids that no longer exist, background agents and duplicates; never applies the
 * cap. `current` is the stored one if it is still a tab, else the last tab, else undefined (the caller opens a new chat).
 */
export function restoreTabs(stored: unknown, exists: (id: string) => boolean, isAgent: (id: string) => boolean): { tabs: string[]; current: string | undefined } {
	const raw: unknown = Array.isArray(stored) ? stored : (stored && typeof stored === 'object' ? (stored as { tabs?: unknown }).tabs : undefined);
	const storedCurrent: unknown = !Array.isArray(stored) && stored && typeof stored === 'object' ? (stored as { current?: unknown }).current : undefined;
	const tabs: string[] = [];
	if (Array.isArray(raw)) {
		for (const id of raw) {
			if (typeof id === 'string' && !tabs.includes(id) && exists(id) && !isAgent(id)) {
				tabs.push(id);
			}
		}
	}
	const current = typeof storedCurrent === 'string' && tabs.includes(storedCurrent) ? storedCurrent : tabs[tabs.length - 1];
	return { tabs, current };
}

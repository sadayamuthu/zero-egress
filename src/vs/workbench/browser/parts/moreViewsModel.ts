/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ZeroEgress: what the side bar's ⌄ More Views menu lists, and which views start out of the bar. No DOM, so it is
// unit tested on its own; the menu itself is in moreViews.ts.

import { ViewContainerLocation } from '../../common/views.js';

/** Side bar views that start in ⌄ instead of the bar. Still one click away, and pinnable. */
const NOT_PINNED_BY_DEFAULT: ReadonlySet<string> = new Set([
	'workbench.view.debug', // Run and Debug
	'workbench.view.extensions',
]);

export function isPinnedByDefault(viewContainerId: string, location: ViewContainerLocation): boolean {
	return location !== ViewContainerLocation.Sidebar || !NOT_PINNED_BY_DEFAULT.has(viewContainerId);
}

export interface IMoreViewsItem {
	readonly id: string;
	readonly name: string;
	/** pinned but it didn't fit in the bar */
	readonly pinned: boolean;
}

/** Every view that has something to show but isn't in the bar right now, in bar order. */
export function moreViewsItems(items: readonly { id: string; name?: string; pinned: boolean; visible: boolean }[], shownIds: readonly string[]): IMoreViewsItem[] {
	return items
		.filter(item => item.visible && !shownIds.includes(item.id))
		.map(item => ({ id: item.id, name: item.name || item.id, pinned: item.pinned }));
}

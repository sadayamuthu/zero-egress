/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ZeroEgress: the ⌄ at the end of the side bar's icon row. It lists the views that aren't in the row: click one to
// open it, click its pin to keep it in the row (or take it out again).

import './media/moreViews.css';
import { $, addDisposableListener, append, EventType, getWindow, isAncestor } from '../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../base/browser/keyboardEvent.js';
import { KeyCode } from '../../../base/common/keyCodes.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { Codicon } from '../../../base/common/codicons.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { localize } from '../../../nls.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../platform/hover/browser/hover.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { IColorTheme, IThemeService } from '../../../platform/theme/common/themeService.js';
import { CompositeBarAction, CompositeBarActionViewItem, IActivityHoverOptions, ICompositeBarActionItem, ICompositeBarColors } from './compositeBarActions.js';
import { IMoreViewsItem } from './moreViewsModel.js';

export const MORE_VIEWS_ACTION_ID = 'zeroEgress.moreViews.action';

export class MoreViewsAction extends CompositeBarAction {
	constructor(private readonly toggleMenu: () => void) {
		super({ id: MORE_VIEWS_ACTION_ID, name: localize('moreViews', "More Views"), classNames: ThemeIcon.asClassNameArray(Codicon.chevronDown) });
	}

	override async run(): Promise<void> {
		this.toggleMenu();
	}
}

export interface IMoreViewsDelegate {
	getItems(): IMoreViewsItem[];
	getActionItem(id: string): ICompositeBarActionItem | undefined;
	open(id: string): void;
	setPinned(id: string, pinned: boolean): void;
}

export class MoreViewsActionViewItem extends CompositeBarActionViewItem {

	private menuOpen = false;
	private readonly hovers: IHoverService;

	constructor(
		action: CompositeBarAction,
		private readonly delegate: IMoreViewsDelegate,
		colors: (theme: IColorTheme) => ICompositeBarColors,
		hoverOptions: IActivityHoverOptions,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super(action, { icon: true, colors, hasPopup: true, hoverOptions }, () => true, themeService, hoverService, configurationService, keybindingService);
		this.hovers = hoverService;
	}

	toggleMenu(): void {
		if (this.menuOpen) {
			this.contextViewService.hideContextView();
		} else {
			this.showMenu();
		}
	}

	private showMenu(): void {
		this.hovers.hideHover(true); // the ⌄ tooltip would sit on top of the menu
		let root: HTMLElement | undefined;
		this.contextViewService.showContextView({
			getAnchor: () => this.container,
			layer: 2, // over hovers (layer 1): the ⌄ tooltip can still come up after its delay while the pointer rests on ⌄
			render: container => {
				const store = new DisposableStore();
				root = append(container, $('.ze-more-views', { role: 'menu', 'aria-label': localize('moreViews', "More Views") }));
				this.renderItems(root, store);
				this.menuOpen = true;
				return store;
			},
			onDOMEvent: (e: Event) => {
				// a click outside closes it (the ⌄ itself toggles through run(); Escape is handled on the rows)
				if (e.type === EventType.MOUSE_DOWN && root && !isAncestor(e.target as HTMLElement, root) && !isAncestor(e.target as HTMLElement, this.container)) {
					this.contextViewService.hideContextView();
				}
			},
			onHide: () => {
				this.menuOpen = false;
				this.focus(); // back to ⌄
			},
		});
		// rendered synchronously above: move focus in, like a menu, so the arrow keys work right away
		(root?.querySelector('.ze-more-views-row') as HTMLElement | null)?.focus();
	}

	private renderItems(root: HTMLElement, store: DisposableStore): void {
		const items = this.delegate.getItems();
		if (items.length === 0) {
			append(root, $('.ze-more-views-empty', undefined, localize('moreViews.empty', "All views are in the bar.")));
			return;
		}
		const rows: HTMLElement[] = [];
		for (const item of items) {
			const actionItem = this.delegate.getActionItem(item.id);
			const row = append(root, $('.ze-more-views-row', { role: 'menuitem', tabindex: '-1' }));
			const icon = append(row, $('.ze-more-views-icon'));
			if (actionItem?.classNames?.length) {
				icon.classList.add(...actionItem.classNames);
			} else if (actionItem?.iconUrl) {
				icon.classList.add('uri-icon');
				icon.style.maskImage = icon.style.webkitMaskImage = `url('${actionItem.iconUrl.toString(true)}')`;
			}
			append(row, $('span.ze-more-views-label', undefined, item.name));
			const keybinding = actionItem?.keybindingId ? this.keybindingService.lookupKeybinding(actionItem.keybindingId)?.getLabel() : undefined;
			if (keybinding) {
				append(row, $('span.ze-more-views-key', undefined, keybinding));
			}
			const pinLabel = item.pinned
				? localize('moreViews.unpin', "Remove {0} from the bar", item.name)
				: localize('moreViews.pin', "Pin {0} to the bar", item.name);
			const pin = append(row, $(`button.ze-more-views-pin${item.pinned ? '.pinned' : ''}`, { 'aria-label': pinLabel, title: pinLabel, tabindex: '-1' }));
			pin.classList.add(...ThemeIcon.asClassNameArray(item.pinned ? Codicon.pinned : Codicon.pin));

			const open = () => { this.contextViewService.hideContextView(); this.delegate.open(item.id); };
			const togglePin = () => { this.contextViewService.hideContextView(); this.delegate.setPinned(item.id, !item.pinned); };
			store.add(addDisposableListener(row, EventType.CLICK, e => {
				e.stopPropagation();
				if (isAncestor(e.target as HTMLElement, pin)) { togglePin(); } else { open(); }
			}));
			store.add(addDisposableListener(row, EventType.KEY_DOWN, e => {
				const event = new StandardKeyboardEvent(e);
				const index = rows.indexOf(row);
				if (event.equals(KeyCode.DownArrow)) {
					rows[(index + 1) % rows.length].focus();
				} else if (event.equals(KeyCode.UpArrow)) {
					rows[(index - 1 + rows.length) % rows.length].focus();
				} else if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
					open();
				} else if (event.equals(KeyCode.KeyP)) {
					togglePin(); // P pins from the keyboard, like the pin button
				} else if (event.equals(KeyCode.Escape) || event.equals(KeyCode.Tab)) {
					this.contextViewService.hideContextView();
				} else {
					return;
				}
				event.preventDefault();
				event.stopPropagation();
			}));
			rows.push(row);
		}
		store.add(addDisposableListener(getWindow(root), EventType.BLUR, () => this.contextViewService.hideContextView()));
	}

	override dispose(): void {
		if (this.menuOpen) {
			this.contextViewService.hideContextView();
		}
		super.dispose();
	}
}

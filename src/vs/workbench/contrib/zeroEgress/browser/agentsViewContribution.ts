/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The Agents view: a full-window overlay between the title bar and the status bar (agent list, the selected agent's
// conversation, and a review column). The editor underneath is never hidden or resized, so its tabs, cursors and
// scroll positions are exactly as they were when the overlay goes away. Also the "N agents need your OK" status bar entry.

import { $, isHTMLElement } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { InputFocusedContext } from '../../../../platform/contextkey/common/contextkeys.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { ZERO_EGRESS_AGENTS_ACCEPT_ALL_ACTION_ID, ZERO_EGRESS_AGENTS_VIEW_VISIBLE_KEY, ZERO_EGRESS_SHOW_AGENTS_ACTION_ID, ZERO_EGRESS_SHOW_EDITOR_ACTION_ID } from './actionIDs.js';
import { IBackgroundAgentsService } from './backgroundAgentsServiceInterface.js';
import { mountAgentsView } from './react/out/agents-tsx/index.js';

export const AGENTS_VIEW_VISIBLE = new RawContextKey<boolean>(ZERO_EGRESS_AGENTS_VIEW_VISIBLE_KEY, false);

/** status bar copy for agents waiting on a tool approval; undefined hides the entry */
export const agentsNeedOkText = (n: number): string | undefined =>
	n <= 0 ? undefined : n === 1 ? '$(bell) 1 agent needs your OK' : `$(bell) ${n} agents need your OK`;

/** shared with the React view (react/src/agents-tsx/AgentsView.tsx, AgentsViewBridge) */
interface AgentsViewBridge {
	onShow?: () => void;
	acceptAllSelected?: () => void;
}

let instance: AgentsViewContribution | undefined;

class AgentsViewContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.zeroEgress.agentsView';

	private readonly _root: HTMLElement;
	private readonly _visible: IContextKey<boolean>;
	private readonly _bridge: AgentsViewBridge = {};
	private _mounted = false;
	private _restoreFocus: HTMLElement | undefined;
	private _statusEntry: IStatusbarEntryAccessor | undefined;

	constructor(
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IBackgroundAgentsService private readonly _agentsService: IBackgroundAgentsService,
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
	) {
		super();
		this._visible = AGENTS_VIEW_VISIBLE.bindTo(contextKeyService);

		this._root = $('.ze-agents-view');
		this._root.setAttribute('role', 'region');
		this._root.setAttribute('aria-label', 'Agents');
		this._root.tabIndex = -1;
		this._layoutService.mainContainer.appendChild(this._root);
		this._register(toDisposable(() => this._root.remove()));

		this._register(this._layoutService.onDidLayoutMainContainer(() => this._position()));
		this._register(this._layoutService.onDidChangePartVisibility(() => this._position()));
		this._position();

		this._register(this._agentsService.onDidChange(() => this._renderStatus()));
		this._renderStatus();

		instance = this;
		this._register(toDisposable(() => { if (instance === this) { instance = undefined; } }));
	}

	get isVisible(): boolean {
		return !!this._visible.get();
	}

	/** top = title bar height, bottom = status bar height (0 when hidden) */
	private _position(): void {
		const height = (part: Parts) => this._layoutService.isVisible(part, mainWindow)
			? this._layoutService.getContainer(mainWindow, part)?.offsetHeight ?? 0
			: 0;
		this._root.style.top = `${height(Parts.TITLEBAR_PART)}px`;
		this._root.style.bottom = `${height(Parts.STATUSBAR_PART)}px`;
	}

	show(): void {
		if (!this.isVisible) {
			const active = mainWindow.document.activeElement;
			this._restoreFocus = isHTMLElement(active) && !this._root.contains(active) ? active : undefined;
			this._position();
			this._root.classList.add('visible');
			this._visible.set(true);
		}
		if (!this._mounted) {
			this._mounted = true;
			this._instantiationService.invokeFunction(accessor => {
				const mounted = mountAgentsView(this._root, accessor, { bridge: this._bridge });
				this._register(toDisposable(() => mounted?.dispose()));
			});
			// React calls onShow itself once it has mounted
		} else {
			this._bridge.onShow?.();
		}
		if (!this._root.contains(mainWindow.document.activeElement)) {
			this._root.focus(); // until React focuses the prompt, keys must not reach the editor underneath
		}
	}

	hide(): void {
		if (!this.isVisible) { return; }
		this._root.classList.remove('visible');
		this._visible.set(false);
		const target = this._restoreFocus;
		this._restoreFocus = undefined;
		if (target?.isConnected) {
			target.focus();
		} else {
			this._layoutService.focus();
		}
	}

	acceptAll(): void {
		this._bridge.acceptAllSelected?.();
	}

	private _renderStatus(): void {
		const n = this._agentsService.agents.filter(a => a.status.kind === 'needs_ok').length;
		const text = agentsNeedOkText(n);
		if (!text) {
			this._statusEntry?.dispose();
			this._statusEntry = undefined;
			return;
		}
		const props: IStatusbarEntry = {
			name: 'ZeroEgress Agents',
			text,
			ariaLabel: text.replace(/\$\([^)]*\)\s*/g, ''),
			tooltip: 'Show the Agents view',
			command: ZERO_EGRESS_SHOW_AGENTS_ACTION_ID,
			kind: 'warning', // statusBarItem.warningBackground
		};
		if (this._statusEntry) {
			this._statusEntry.update(props);
		} else {
			this._statusEntry = this._statusbarService.addEntry(props, 'zeroEgress.agentsNeedOk', StatusbarAlignment.LEFT, 9999);
		}
	}

	override dispose(): void {
		this._statusEntry?.dispose();
		this._statusEntry = undefined;
		super.dispose();
	}
}

registerWorkbenchContribution2(AgentsViewContribution.ID, AgentsViewContribution, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: ZERO_EGRESS_SHOW_AGENTS_ACTION_ID,
			title: localize2('zeroEgress.showAgents', 'Show Agents'),
			category: localize2('zeroEgress.category', 'ZeroEgress'),
			f1: true,
			keybinding: {
				// shadows notification.acceptPrimaryAction (⇧⌘A while a notification toast shows) and, on Linux, editor.action.blockComment
				weight: KeybindingWeight.WorkbenchContrib + 1,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyA,
			},
		});
	}
	run(_accessor: ServicesAccessor): void {
		instance?.show();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: ZERO_EGRESS_SHOW_EDITOR_ACTION_ID,
			title: localize2('zeroEgress.showEditor', 'Show Editor'),
			category: localize2('zeroEgress.category', 'ZeroEgress'),
			f1: true,
			precondition: AGENTS_VIEW_VISIBLE,
			keybinding: {
				// only while the Agents view shows; otherwise ⇧⌘E stays Show Explorer
				weight: KeybindingWeight.WorkbenchContrib + 1,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyE,
				when: AGENTS_VIEW_VISIBLE,
			},
		});
	}
	run(_accessor: ServicesAccessor): void {
		instance?.hide();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: ZERO_EGRESS_AGENTS_ACCEPT_ALL_ACTION_ID,
			title: localize2('zeroEgress.agentsView.acceptAll', 'Agents: Accept All Changes of the Selected Agent'),
			category: localize2('zeroEgress.category', 'ZeroEgress'),
			f1: true,
			precondition: AGENTS_VIEW_VISIBLE,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 1,
				primary: KeyMod.CtrlCmd | KeyCode.Enter,
				when: ContextKeyExpr.and(AGENTS_VIEW_VISIBLE, InputFocusedContext.negate()),
			},
		});
	}
	run(_accessor: ServicesAccessor): void {
		instance?.acceptAll();
	}
});

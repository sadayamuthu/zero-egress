/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Shows where the app may connect (Local / LAN / Internet) in the status bar and the title bar, and adds the
// ZeroEgress mark and the Editor | Agents switch to the title bar. The status itself comes from ILocalStatusService.

import { $, append } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IOutputService } from '../../../services/output/common/output.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { ZERO_EGRESS_AGENTS_VIEW_VISIBLE_KEY, ZERO_EGRESS_SHOW_AGENTS_ACTION_ID, ZERO_EGRESS_SHOW_EDITOR_ACTION_ID } from './actionIDs.js';
import { NETWORK_OUTPUT_CHANNEL_ID } from './egressTargetsContribution.js';
import { ILocalStatusService } from './localStatusService.js';

const SHOW_NETWORK_LOG_COMMAND_ID = 'zeroEgress.showNetworkLog';

CommandsRegistry.registerCommand(SHOW_NETWORK_LOG_COMMAND_ID, accessor => accessor.get(IOutputService).showChannel(NETWORK_OUTPUT_CHANNEL_ID));

// The #mark group of resources/zero-egress/logo.svg, unchanged (no tile).
const MARK: readonly [string, Record<string, string>][] = [
	['path', { d: 'M16 40 a44 44 0 0 1 64 0', fill: 'none', stroke: '#34d399', 'stroke-width': '7', 'stroke-linecap': 'round', opacity: '.3' }],
	['path', { d: 'M28 51 a28 28 0 0 1 40 0', fill: 'none', stroke: '#34d399', 'stroke-width': '7', 'stroke-linecap': 'round', opacity: '.3' }],
	['ellipse', { cx: '48', cy: '70', rx: '9', ry: '12', fill: 'none', stroke: '#34d399', 'stroke-width': '5.5' }],
	['line', { x1: '43', y1: '78', x2: '53', y2: '62', stroke: '#34d399', 'stroke-width': '5', 'stroke-linecap': 'round' }],
];

function createMark(): SVGElement {
	const ns = 'http://www.w3.org/2000/svg';
	const svg = mainWindow.document.createElementNS(ns, 'svg');
	for (const [k, v] of Object.entries({ viewBox: '8 22 80 66', width: '16', height: '16', 'aria-hidden': 'true' })) { svg.setAttribute(k, v); }
	for (const [tag, attrs] of MARK) {
		const el = mainWindow.document.createElementNS(ns, tag);
		for (const [k, v] of Object.entries(attrs)) { el.setAttribute(k, v); }
		svg.appendChild(el);
	}
	return svg;
}

class LocalStatusContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.zeroEgress.localStatus';

	private entry: IStatusbarEntryAccessor | undefined;
	private pill: HTMLElement | undefined;

	constructor(
		@ILocalStatusService private readonly localStatusService: ILocalStatusService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
	) {
		super();
		this.addTitlebarElements();

		this._register(this.localStatusService.onDidChange(() => this.render()));
		// the service may have read the guard's state already; otherwise its first change renders
		if (this.localStatusService.status || this.localStatusService.blocked) {
			this.render();
		}
	}

	private render(): void {
		const status = this.localStatusService.status;
		const { text, tooltip } = this.localStatusService.formatted();
		const props = {
			name: 'ZeroEgress Local Status',
			text,
			tooltip,
			ariaLabel: text.replace(/\$\([^)]*\)\s*/g, ''),
			command: SHOW_NETWORK_LOG_COMMAND_ID,
			kind: status?.kind === 'internet' ? 'warning' as const : 'standard' as const, // warning kind sets both foreground and background
		};
		if (this.entry) {
			this.entry.update(props);
		} else {
			this.entry = this._register(this.statusbarService.addEntry(props, 'zeroEgress.localStatus', StatusbarAlignment.LEFT, 10000));
		}
		if (this.pill) {
			const glyph = status?.kind === 'internet' ? '▲' : status ? '●' : '?';
			this.pill.textContent = `${glyph} ${props.ariaLabel}`;
			this.pill.title = tooltip;
			this.pill.dataset.kind = status?.kind ?? 'unknown';
		}
	}

	private addTitlebarElements(): void {
		const titlebar = this.layoutService.getContainer(mainWindow, Parts.TITLEBAR_PART);
		const left = titlebar?.querySelector<HTMLElement>('.titlebar-left');
		const right = titlebar?.querySelector<HTMLElement>('.titlebar-right');
		if (!left || !right) {
			return; // native title bar
		}

		const brand = $('.ze-titlebar-brand');
		brand.appendChild(createMark());
		append(brand, $('span', undefined, 'ZeroEgress'));
		// On macOS the window buttons live in a container at the start of .titlebar-left; sit after it.
		const controls = left.querySelector(':scope > .window-controls-container');
		left.insertBefore(brand, controls ? controls.nextSibling : left.firstChild);
		const viewSwitch = this.createViewSwitch();
		left.insertBefore(viewSwitch, brand.nextSibling);

		const pill = $('.ze-titlebar-status');
		pill.setAttribute('role', 'button');
		pill.tabIndex = 0;
		const open = () => this.commandService.executeCommand(SHOW_NETWORK_LOG_COMMAND_ID);
		pill.addEventListener('click', open);
		pill.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
		right.insertBefore(pill, right.firstChild);
		this.pill = pill;

		this._register(toDisposable(() => { brand.remove(); viewSwitch.remove(); pill.remove(); }));
	}

	/** Editor | Agents: the active segment follows the zeroEgress.agentsViewVisible context key; clicks run the commands */
	private createViewSwitch(): HTMLElement {
		const container = $('.ze-view-switch');
		container.setAttribute('role', 'radiogroup');
		container.setAttribute('aria-label', 'View');
		const segment = (label: string, commandId: string) => {
			const el = append(container, $('.ze-view-switch-segment', undefined, label));
			el.setAttribute('role', 'radio');
			el.tabIndex = 0;
			const run = () => this.commandService.executeCommand(commandId);
			el.addEventListener('click', run);
			el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run(); } });
			return el;
		};
		const editor = segment('Editor', ZERO_EGRESS_SHOW_EDITOR_ACTION_ID);
		const agents = segment('Agents', ZERO_EGRESS_SHOW_AGENTS_ACTION_ID);
		const update = () => {
			const agentsVisible = !!this.contextKeyService.getContextKeyValue<boolean>(ZERO_EGRESS_AGENTS_VIEW_VISIBLE_KEY);
			editor.classList.toggle('active', !agentsVisible);
			agents.classList.toggle('active', agentsVisible);
			editor.setAttribute('aria-checked', String(!agentsVisible));
			agents.setAttribute('aria-checked', String(agentsVisible));
		};
		const keys = new Set([ZERO_EGRESS_AGENTS_VIEW_VISIBLE_KEY]);
		this._register(this.contextKeyService.onDidChangeContext(e => { if (e.affectsSome(keys)) { update(); } }));
		update();
		return container;
	}
}

registerWorkbenchContribution2(LocalStatusContribution.ID, LocalStatusContribution, WorkbenchPhase.AfterRestored);

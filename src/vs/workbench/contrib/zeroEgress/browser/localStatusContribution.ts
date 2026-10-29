/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Shows where the app may connect (Local / LAN / Internet) in the status bar and the title bar, and adds the
// ZeroEgress mark to the title bar. Every destination the egress guard allows counts (see common/localStatus.ts).

import { $, append } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IOutputService } from '../../../services/output/common/output.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IEgressGuardService } from '../common/egressGuardService.js';
import { formatLocalStatus, LocalStatus, localStatusOf } from '../common/localStatus.js';
import { IZeroEgressSettingsService } from '../common/zeroEgressSettingsService.js';
import { NETWORK_OUTPUT_CHANNEL_ID } from './egressTargetsContribution.js';

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

	private status: LocalStatus | undefined;
	private blocked = 0;
	private entry: IStatusbarEntryAccessor | undefined;
	private pill: HTMLElement | undefined;
	private refreshSeq = 0;

	constructor(
		@IEgressGuardService private readonly egressGuardService: IEgressGuardService,
		@IZeroEgressSettingsService private readonly settingsService: IZeroEgressSettingsService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this.addTitlebarElements();

		this._register(this.egressGuardService.onDidBlock(() => { this.blocked++; this.render(); }));
		this.egressGuardService.getRecentBlocked().then(recent => { this.blocked += recent.length; this.render(); }, () => { });

		this._register(this.settingsService.onDidChangeState(() => this.refresh()));
		this._register(this.egressGuardService.onDidChangeTargets(() => this.refresh()));
		this.refresh();
	}

	private async refresh(): Promise<void> {
		const seq = ++this.refreshSeq;
		let status: LocalStatus | undefined;
		try {
			status = localStatusOf(await this.egressGuardService.getTargets());
		} catch {
			status = undefined;
		}
		if (seq === this.refreshSeq) {
			this.status = status;
			this.render();
		}
	}

	private render(): void {
		const { text, tooltip } = formatLocalStatus(this.status, this.blocked);
		const props = {
			name: 'ZeroEgress Local Status',
			text,
			tooltip,
			ariaLabel: text.replace(/\$\([^)]*\)\s*/g, ''),
			command: SHOW_NETWORK_LOG_COMMAND_ID,
			kind: this.status?.kind === 'internet' ? 'warning' as const : 'standard' as const, // warning kind sets both foreground and background
		};
		if (this.entry) {
			this.entry.update(props);
		} else {
			this.entry = this._register(this.statusbarService.addEntry(props, 'zeroEgress.localStatus', StatusbarAlignment.LEFT, 10000));
		}
		if (this.pill) {
			const glyph = this.status?.kind === 'internet' ? '▲' : this.status ? '●' : '?';
			this.pill.textContent = `${glyph} ${props.ariaLabel}`;
			this.pill.title = tooltip;
			this.pill.dataset.kind = this.status?.kind ?? 'unknown';
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

		const pill = $('.ze-titlebar-status');
		pill.setAttribute('role', 'button');
		pill.tabIndex = 0;
		const open = () => this.commandService.executeCommand(SHOW_NETWORK_LOG_COMMAND_ID);
		pill.addEventListener('click', open);
		pill.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
		right.insertBefore(pill, right.firstChild);
		this.pill = pill;

		this._register(toDisposable(() => { brand.remove(); pill.remove(); }));
	}
}

registerWorkbenchContribution2(LocalStatusContribution.ID, LocalStatusContribution, WorkbenchPhase.AfterRestored);

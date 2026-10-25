/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { mountZeroEgressOnboarding } from './react/out/zero-egress-onboarding/index.js'
import { h, getActiveWindow } from '../../../../base/browser/dom.js';
import { CodeWindow } from '../../../../base/browser/window.js';
import { IZeroEgressSettingsService } from '../common/zeroEgressSettingsService.js';

// Onboarding contribution that mounts the component at startup
export class OnboardingContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.zeroEgressOnboarding';

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.initialize();
	}

	private initialize(): void {
		const targetWindow = getActiveWindow();

		// Cover the window immediately (BlockRestore runs before editors restore)
		// so the home page never flashes under onboarding.
		const cover = h('div.ze-onboarding-cover').root;
		cover.style.cssText = 'position:fixed;inset:0;z-index:99999;background-color:var(--vscode-editor-background,#1e1e1e)';
		targetWindow.document.body.appendChild(cover);
		this._register(toDisposable(() => {
			if (cover.parentElement) {
				cover.parentElement.removeChild(cover);
			}
		}));

		const settingsService = this.instantiationService.invokeFunction((accessor: ServicesAccessor) => {
			return accessor.get(IZeroEgressSettingsService);
		});

		void this.mountWhenReady(settingsService, targetWindow, cover);
	}

	private async mountWhenReady(
		settingsService: IZeroEgressSettingsService,
		targetWindow: CodeWindow,
		cover: HTMLElement,
	): Promise<void> {
		await settingsService.waitForInitState;

		if (settingsService.state.globalSettings.isOnboardingComplete) {
			cover.remove();
			return;
		}

		// Prefer workbench if it exists by now; body is fine for a fixed overlay.
		const parent = targetWindow.document.querySelector('.monaco-workbench') ?? targetWindow.document.body;
		const onboardingContainer = h('div.ze-onboarding-container').root;
		parent.appendChild(onboardingContainer);

		this.instantiationService.invokeFunction((accessor: ServicesAccessor) => {
			const result = mountZeroEgressOnboarding(onboardingContainer, accessor);
			if (result && typeof result.dispose === 'function') {
				this._register(toDisposable(result.dispose));
			}
		});

		this._register(toDisposable(() => {
			if (onboardingContainer.parentElement) {
				onboardingContainer.parentElement.removeChild(onboardingContainer);
			}
		}));

		// The splash is inline SVG/HTML (no image to decode): drop the cover on
		// the next frame, once React has painted.
		targetWindow.requestAnimationFrame(() => {
			cover.remove();
		});
	}
}

// Mount before editors restore so home never flashes under the splash.
registerWorkbenchContribution2(OnboardingContribution.ID, OnboardingContribution, WorkbenchPhase.BlockRestore);

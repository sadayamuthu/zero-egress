/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { RefreshModelService } from '../refreshModelService.js';
import { ILLMMessageService } from '../sendLLMMessageService.js';
import { IZeroEgressSettingsService } from '../zeroEgressSettingsService.js';
import { defaultGlobalSettings, defaultSettingsOfProvider, SettingsOfProvider } from '../zeroEgressSettingsTypes.js';

// The endpoint field saves on every keystroke. A model-list probe of each partial value ("https://gp") would
// send DNS queries and connection attempts for hosts the user never meant, so probes wait for the value to settle.
suite('RefreshModelService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let clock: sinon.SinonFakeTimers;
	setup(() => { clock = sinon.useFakeTimers(); });
	teardown(() => clock.restore());
	const timeout = (ms: number) => clock.tickAsync(ms);

	function createService() {
		const disposables = store.add(new DisposableStore());
		const onDidChangeState = disposables.add(new Emitter<void>());
		let settingsOfProvider: SettingsOfProvider = defaultSettingsOfProvider;
		const settings = {
			get state() { return { settingsOfProvider, globalSettings: defaultGlobalSettings }; },
			onDidChangeState: onDidChangeState.event,
			waitForInitState: Promise.resolve(),
			setAutodetectedModels() { },
			setSettingOfProvider() { },
		} as unknown as IZeroEgressSettingsService;
		const probes: string[] = [];
		const list = ({ providerName, onError }: { providerName: keyof SettingsOfProvider; onError: (e: { error: string }) => void }) => {
			probes.push(`${providerName} ${settingsOfProvider[providerName].endpoint}`);
			// vLLM fails at once, so it polls again in 5 s; the others never answer (and so never poll)
			if (providerName === 'vLLM') { onError({ error: 'unreachable' }); }
		};
		const llm = { ollamaList: list, openAICompatibleList: list } as unknown as ILLMMessageService;
		disposables.add(new RefreshModelService(settings, llm));
		const type = async (text: string, msPerKey: number) => {
			for (let i = 1; i <= text.length; i++) {
				settingsOfProvider = { ...settingsOfProvider, vLLM: { ...settingsOfProvider.vLLM, endpoint: text.slice(0, i) } };
				onDidChangeState.fire();
				await timeout(msPerKey);
			}
		};
		return { probes, type, dispose: () => disposables.dispose() };
	}

	test('typing an endpoint probes only the value it settles on, and polling waits meanwhile', async () => {
		const { probes, type, dispose } = createService();
		try {
		await timeout(0);
		assert.deepStrictEqual(probes, ['ollama http://127.0.0.1:11434', 'vLLM http://localhost:8000', 'lmStudio http://localhost:1234', 'oMLX http://127.0.0.1:8000'], 'initial probe');
		probes.length = 0;

		// 60 keys at 100 ms: longer than the 5 s poll interval
		await type('https://gpu.example-cloud.com:8000/' + 'x'.repeat(25), 100);
		assert.deepStrictEqual(probes.filter(p => p.startsWith('vLLM')), [], 'no partial value probed, not even by the poll');

		await timeout(1000);
		assert.deepStrictEqual(probes.filter(p => p.startsWith('vLLM')), [`vLLM https://gpu.example-cloud.com:8000/${'x'.repeat(25)}`], 'the settled value is probed once');

		// polling resumes for the settled value
		await timeout(5100);
		assert.strictEqual(probes.filter(p => p.startsWith('vLLM')).length, 2);
		} finally {
			dispose();
		}
	});
});

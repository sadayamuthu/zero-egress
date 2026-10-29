/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Runs under test-node by path (it uses no DOM): node test/unit/node/index.js --run <this file>

import assert from 'assert';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILLMMessageService } from '../../common/sendLLMMessageService.js';
import { ServiceModelListParams } from '../../common/sendLLMMessageTypes.js';
import { IZeroEgressSettingsService } from '../../common/zeroEgressSettingsService.js';
import { defaultSettingsOfProvider, FeatureName, ModelSelection, ModelSelectionOfFeature, ProviderName, SettingsOfProvider } from '../../common/zeroEgressSettingsTypes.js';
import { LocalModelDetectionService, oneResultPerProvider, ProbeResult } from '../localModelDetectionService.js';

type Answer = { models: unknown[] } | { error: string } | 'never';

suite('LocalModelDetectionService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let answers: Record<string, Answer>;
	let listCalls: { kind: 'ollama' | 'openAICompatible'; providerName: string; endpointOverride: string | undefined }[];
	let calls: string[];
	let settingsOfProvider: SettingsOfProvider;
	let selections: ModelSelectionOfFeature;

	const answer = (endpointOverride: string | undefined, p: ServiceModelListParams<any>) => {
		const a = answers[endpointOverride ?? ''] ?? { error: 'connect ECONNREFUSED' };
		if (a === 'never') { return; }
		setTimeout(() => 'models' in a ? p.onSuccess({ models: a.models }) : p.onError({ error: a.error }), 5);
	};

	const llm = {
		ollamaList: (p: ServiceModelListParams<any>) => { listCalls.push({ kind: 'ollama', providerName: p.providerName, endpointOverride: p.endpointOverride }); answer(p.endpointOverride, p); },
		openAICompatibleList: (p: ServiceModelListParams<any>) => { listCalls.push({ kind: 'openAICompatible', providerName: p.providerName, endpointOverride: p.endpointOverride }); answer(p.endpointOverride, p); },
	} as unknown as ILLMMessageService;

	const settings = {
		get state() { return { settingsOfProvider, modelSelectionOfFeature: selections }; },
		setSettingOfProvider: async (providerName: ProviderName, settingName: string, value: unknown) => { calls.push(`endpoint ${providerName} ${value}`); settingsOfProvider = { ...settingsOfProvider, [providerName]: { ...settingsOfProvider[providerName], [settingName]: value } }; },
		setAutodetectedModels: (providerName: ProviderName, names: string[]) => { calls.push(`models ${providerName} ${names.join(',')}`); },
		setModelSelectionOfFeature: async (feature: FeatureName, sel: ModelSelection | null) => { calls.push(`select ${feature} ${sel?.providerName}/${sel?.modelName}`); selections = { ...selections, [feature]: sel }; },
	} as unknown as IZeroEgressSettingsService;

	setup(() => {
		answers = {};
		listCalls = [];
		calls = [];
		settingsOfProvider = defaultSettingsOfProvider;
		selections = { 'Chat': null, 'Ctrl+K': null, 'Autocomplete': null, 'Apply': null, 'SCM': null };
	});

	const ollamaModel = (name: string, parameter_size: string) => ({ name, details: { parameter_size } });
	const oaiModel = (id: string, owned_by: string) => ({ id, object: 'model', created: 0, owned_by });
	const byId = (results: ProbeResult[], id: string) => results.find(r => r.target.id === id)!;

	test('detects ollama and lm studio', () => runWithFakedTimers({}, async () => {
		answers['http://127.0.0.1:11434'] = { models: [ollamaModel('qwen2.5-coder:7b', '7.6B'), ollamaModel('llama3', '8.0B')] };
		answers['http://localhost:1234'] = { models: [oaiModel('qwen3-coder-30b', 'organization_owner')] };
		const results = await new LocalModelDetectionService(llm, settings).detect();

		assert.deepStrictEqual(results.map(r => [r.target.id, r.status, r.providerName, r.models.length]), [
			['ollama', 'found', 'ollama', 2],
			['lmStudio', 'found', 'lmStudio', 1],
			['port8000', 'not_running', null, 0],
		]);
		assert.deepStrictEqual(byId(results, 'ollama').models[0], { providerName: 'ollama', modelName: 'qwen2.5-coder:7b', paramsB: 7.6 });
		assert.deepStrictEqual(byId(results, 'lmStudio').models[0], { providerName: 'lmStudio', modelName: 'qwen3-coder-30b', paramsB: 30 });
		assert.deepStrictEqual(listCalls.map(c => c.endpointOverride).sort(), ['http://127.0.0.1:11434', 'http://localhost:1234', 'http://localhost:8000']);
		assert.deepStrictEqual(calls, [], 'detect does not touch settings');
	}));

	test('ollama with no models is found with an empty list', () => runWithFakedTimers({}, async () => {
		answers['http://127.0.0.1:11434'] = { models: [] };
		const results = await new LocalModelDetectionService(llm, settings).detect();
		assert.deepStrictEqual([byId(results, 'ollama').status, byId(results, 'ollama').models], ['found', []]);
	}));

	test('port 8000 classified as vLLM', () => runWithFakedTimers({}, async () => {
		answers['http://localhost:8000'] = { models: [oaiModel('Qwen/Qwen2.5-Coder-14B-Instruct', 'vllm')] };
		const r = byId(await new LocalModelDetectionService(llm, settings).detect(), 'port8000');
		assert.deepStrictEqual([r.status, r.providerName, r.models.map(m => m.providerName)], ['found', 'vLLM', ['vLLM']]);
	}));

	test('port 8000 unknown asks', () => runWithFakedTimers({}, async () => {
		answers['http://localhost:8000'] = { models: [oaiModel('some-model', 'openai')] };
		const r = byId(await new LocalModelDetectionService(llm, settings).detect(), 'port8000');
		assert.deepStrictEqual([r.status, r.providerName, r.models.length], ['found', null, 1]);
	}));

	test('non-model response is not running', () => runWithFakedTimers({}, async () => {
		answers['http://127.0.0.1:11434'] = { error: '404 <html>Not Found</html>' };
		answers['http://localhost:1234'] = { models: [{ html: '<!doctype html>' }] }; // answered, but not with models
		const results = await new LocalModelDetectionService(llm, settings).detect();
		assert.deepStrictEqual(results.map(r => r.status), ['not_running', 'not_running', 'not_running']);
	}));

	test('timeout is not running', () => runWithFakedTimers({}, async () => {
		answers['http://127.0.0.1:11434'] = 'never';
		const late: { p?: ServiceModelListParams<any> } = {};
		const lateLlm = { ...llm, openAICompatibleList: (p: ServiceModelListParams<any>) => { late.p = p; } } as unknown as ILLMMessageService;
		const start = Date.now();
		const results = await new LocalModelDetectionService(lateLlm, settings).detect();
		assert.strictEqual(Date.now() - start, 2000, 'gives up after 2000 ms');
		assert.deepStrictEqual(results.map(r => r.status), ['not_running', 'not_running', 'not_running']);
		late.p!.onSuccess({ models: [oaiModel('m', 'vllm')] }); // a late success must not flip the result
		assert.strictEqual(byId(results, 'port8000').status, 'not_running');
	}));

	test('probeUrl probes exactly the typed URL as the chosen provider', () => runWithFakedTimers({}, async () => {
		answers['http://192.168.1.20:8000'] = { models: [oaiModel('m-7b', 'openai')] };
		const r = await new LocalModelDetectionService(llm, settings).probeUrl(' http://192.168.1.20:8000/ ', 'oMLX');
		assert.deepStrictEqual(listCalls, [{ kind: 'openAICompatible', providerName: 'oMLX', endpointOverride: 'http://192.168.1.20:8000' }]);
		assert.deepStrictEqual([r.target, r.status, r.providerName, r.models], [{ id: 'custom', url: 'http://192.168.1.20:8000', providers: ['oMLX'] }, 'found', 'oMLX', [{ providerName: 'oMLX', modelName: 'm-7b', paramsB: 7 }]]);
		const bad = await new LocalModelDetectionService(llm, settings).probeUrl('not a url', 'ollama');
		assert.strictEqual(bad.status, 'not_running');
	}));

	test('apply keeps existing selections', () => runWithFakedTimers({}, async () => {
		settingsOfProvider = { ...settingsOfProvider, ollama: { ...settingsOfProvider.ollama, endpoint: 'http://10.0.0.5:11434' } };
		selections = { ...selections, 'Chat': { providerName: 'ollama', modelName: 'mine' } };
		answers['http://127.0.0.1:11434'] = { models: [ollamaModel('qwen2.5-coder:7b', '7.6B')] };
		answers['http://localhost:1234'] = { models: [oaiModel('qwen3-coder-30b', 'x')] };
		const service = new LocalModelDetectionService(llm, settings);
		const results = await service.detect();
		const chosen = byId(results, 'lmStudio').models[0];
		service.apply(results, chosen);

		assert.strictEqual(settingsOfProvider.ollama.endpoint, 'http://10.0.0.5:11434', 'custom endpoint untouched');
		assert.ok(!calls.some(c => c.includes('ollama')), 'nothing written for ollama');
		assert.ok(calls.includes('models lmStudio qwen3-coder-30b'));
		assert.deepStrictEqual(selections['Chat'], { providerName: 'ollama', modelName: 'mine' }, 'Chat kept');
		assert.deepStrictEqual(selections['Ctrl+K'], { providerName: 'lmStudio', modelName: 'qwen3-coder-30b' });
		assert.deepStrictEqual(selections['Apply'], { providerName: 'lmStudio', modelName: 'qwen3-coder-30b' });
		assert.deepStrictEqual(selections['SCM'], { providerName: 'lmStudio', modelName: 'qwen3-coder-30b' });
		assert.strictEqual(selections['Autocomplete'], null, 'Autocomplete is not assigned');
	}));

	test('apply sets a default endpoint to the probed URL', () => runWithFakedTimers({}, async () => {
		settingsOfProvider = { ...settingsOfProvider, oMLX: { ...settingsOfProvider.oMLX, endpoint: '' } };
		answers['http://localhost:8000'] = { models: [oaiModel('mlx-community/Qwen3-8B', 'mlx-community')] };
		const service = new LocalModelDetectionService(llm, settings);
		service.apply(await service.detect(), null);
		assert.deepStrictEqual(calls, ['endpoint oMLX http://localhost:8000', 'models oMLX mlx-community/Qwen3-8B']);
	}));

	test('apply uses only the first found result of a provider', () => runWithFakedTimers({}, async () => {
		answers['http://127.0.0.1:11434'] = { models: [ollamaModel('model-a:7b', '7B')] };
		answers['http://192.168.1.50:11434'] = { models: [ollamaModel('model-b:7b', '7B')] };
		const service = new LocalModelDetectionService(llm, settings);
		const loopback = byId(await service.detect(), 'ollama');
		const lan = await service.probeUrl('http://192.168.1.50:11434', 'ollama');
		calls = [];
		service.apply([loopback, lan], loopback.models[0]);
		assert.strictEqual(settingsOfProvider.ollama.endpoint, 'http://127.0.0.1:11434', 'the second result does not move the endpoint');
		assert.deepStrictEqual(calls.filter(c => !c.startsWith('select')), ['models ollama model-a:7b']);
		assert.deepStrictEqual(selections['Chat'], { providerName: 'ollama', modelName: 'model-a:7b' });
	}));

	test('oneResultPerProvider keeps the chosen model\'s server, else an added URL, else the default', () => {
		const found = (id: 'ollama' | 'lmStudio' | 'custom', url: string, providerName: ProviderName, models: string[]): ProbeResult => ({
			target: { id, url, providers: [providerName] }, status: 'found', providerName,
			models: models.map(modelName => ({ providerName, modelName, paramsB: null })),
		});
		const ollamaDefault = found('ollama', 'http://127.0.0.1:11434', 'ollama', ['a']);
		const ollamaLan = found('custom', 'http://192.168.1.50:11434', 'ollama', ['b']);
		const lmDefault = found('lmStudio', 'http://localhost:1234', 'lmStudio', ['c']);
		const lmLan = found('custom', 'http://192.168.1.60:1234', 'lmStudio', ['d']);
		const notRunning: ProbeResult = { target: { id: 'custom', url: 'http://192.168.1.70:11434', providers: ['ollama'] }, status: 'not_running', providerName: null, models: [] };
		const unresolved: ProbeResult = { target: { id: 'port8000', url: 'http://localhost:8000', providers: ['vLLM', 'oMLX'] }, status: 'found', providerName: null, models: [] };
		const all = [ollamaDefault, ollamaLan, lmDefault, lmLan, notRunning, unresolved];

		assert.deepStrictEqual(oneResultPerProvider(all, ollamaLan.models[0]), [ollamaLan, lmLan], 'chosen B: its server; lmStudio: the added URL');
		assert.deepStrictEqual(oneResultPerProvider(all, ollamaDefault.models[0]), [ollamaDefault, lmLan], 'chosen A: the default server');
		assert.deepStrictEqual(oneResultPerProvider(all, null), [ollamaLan, lmLan], 'no choice: added URLs win');
		assert.deepStrictEqual(oneResultPerProvider([ollamaDefault, lmDefault, notRunning], null), [ollamaDefault, lmDefault], 'one each: kept');
	});
});

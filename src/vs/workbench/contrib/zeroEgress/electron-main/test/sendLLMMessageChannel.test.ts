/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as http from 'http';
import type * as net from 'net';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMetricsService } from '../../common/metricsService.js';
import { defaultSettingsOfProvider, SettingsOfProvider } from '../../common/zeroEgressSettingsTypes.js';
import { createDisabledAuditService } from '../audit/auditMainService.js';
import { EndpointLeases, LLMMessageChannel } from '../sendLLMMessageChannel.js';

const metrics: IMetricsService = { _serviceBrand: undefined, capture() { }, setOptOut() { }, getDebuggingProperties: async () => ({}) } as unknown as IMetricsService;
const identity = { machineId: 'm', userId: 'u', appVersion: '0', zeroEgressVersion: '0' };

// The egress guard allows a window's model endpoints from the settings it pushes. A model request carries the
// settings it was made with, and its endpoint must stay allowed until the request is over (SDK retries
// included): otherwise a request racing ahead of setTargets, or retrying after the field was edited, is blocked.
suite('LLMMessageChannel endpoint leases', () => {

	ensureNoDisposablesAreLeakedInTestSuite();
	let events: string[];
	let leases: EndpointLeases;
	let server: http.Server;
	let port: number;
	let onRequest: (req: http.IncomingMessage, res: http.ServerResponse) => void;

	setup(async () => {
		events = [];
		leases = {
			leaseSettingsTarget: (client, url) => {
				events.push(`lease ${client} ${url}`);
				return toDisposable(() => events.push(`release ${client} ${url}`));
			},
		};
		server = http.createServer((req, res) => { events.push(`server ${req.method} ${req.url}`); onRequest(req, res); });
		await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
		port = (server.address() as net.AddressInfo).port;
	});

	teardown(async () => {
		server.closeAllConnections();
		await new Promise(r => server.close(r));
	});

	const settingsWith = (provider: 'vLLM' | 'ollama', endpoint: string): SettingsOfProvider => ({ ...defaultSettingsOfProvider, [provider]: { ...defaultSettingsOfProvider[provider], endpoint } });
	const next = <T>(event: Event<T>) => new Promise<T>(resolve => { const d = new DisposableStore(); d.add(event(e => { d.dispose(); resolve(e); })); });

	test('a model list request holds its endpoint from receipt until it succeeds', async () => {
		onRequest = (_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ object: 'list', data: [{ id: 'm1', object: 'model', created: 0, owned_by: 'x' }] })); };
		const channel = new LLMMessageChannel(metrics, createDisabledAuditService(), identity, leases);
		const endpoint = `http://127.0.0.1:${port}`;
		const done = next(channel.listen(undefined, 'onSuccess_list_openAICompatible'));
		await channel.call('window:7', 'openAICompatibleList', { providerName: 'vLLM', settingsOfProvider: settingsWith('vLLM', endpoint), requestId: 'r1' });
		assert.deepStrictEqual(events, [`lease window:7 ${endpoint}`], 'leased before anything is dialed');
		await done;
		assert.deepStrictEqual(events, [`lease window:7 ${endpoint}`, 'server GET /v1/models', `release window:7 ${endpoint}`]);
	});

	test('a model list request releases its endpoint when it fails', async () => {
		const endpoint = `http://127.0.0.1:${port}`;
		server.closeAllConnections();
		await new Promise(r => server.close(r));
		server = http.createServer();
		await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); // for teardown; the endpoint's port is now closed
		const channel = new LLMMessageChannel(metrics, createDisabledAuditService(), identity, leases);
		const done = next(channel.listen(undefined, 'onError_list_ollama'));
		await channel.call('window:3', 'ollamaList', { providerName: 'ollama', settingsOfProvider: settingsWith('ollama', endpoint), requestId: 'r2' });
		await done;
		assert.deepStrictEqual(events, [`lease window:3 ${endpoint}`, `release window:3 ${endpoint}`]);
	});

	test('a chat request holds the selected provider\'s endpoint until it finishes, or is aborted', async () => {
		let pending: http.ServerResponse | undefined;
		onRequest = (_req, res) => { pending = res; };
		const channel = new LLMMessageChannel(metrics, createDisabledAuditService(), identity, leases);
		const endpoint = `http://127.0.0.1:${port}`;
		const params = {
			requestId: 'r3',
			messagesType: 'chatMessages',
			messages: [{ role: 'user', content: 'hi' }],
			modelSelection: { providerName: 'vLLM', modelName: 'm1' },
			modelSelectionOptions: undefined,
			overridesOfModel: undefined,
			settingsOfProvider: settingsWith('vLLM', endpoint),
			logging: { loggingName: 'test' },
			chatMode: 'normal',
			separateSystemMessage: undefined,
			mcpTools: undefined,
		};
		await channel.call('window:9', 'sendLLMMessage', params);
		assert.deepStrictEqual(events, [`lease window:9 ${endpoint}`]);
		while (!pending) { await new Promise(r => setTimeout(r, 10)); }
		assert.deepStrictEqual(events, [`lease window:9 ${endpoint}`, 'server POST /v1/chat/completions'], 'still held while the request runs');
		const aborted = channel.call('window:9', 'abort', { requestId: 'r3' });
		assert.deepStrictEqual(events.slice(2), [`release window:9 ${endpoint}`], 'released on abort');
		pending.destroy();
		await aborted;
		assert.strictEqual(events.filter(e => e.startsWith('release')).length, 1, 'released once');
	});

	test('a request whose provider has no endpoint leases nothing', async () => {
		const channel = new LLMMessageChannel(metrics, createDisabledAuditService(), identity, leases);
		const done = next(channel.listen(undefined, 'onError_list_openAICompatible'));
		await channel.call('window:1', 'openAICompatibleList', { providerName: 'vLLM', settingsOfProvider: settingsWith('vLLM', ''), requestId: 'r4' });
		await done;
		assert.deepStrictEqual(events, []);
	});
});

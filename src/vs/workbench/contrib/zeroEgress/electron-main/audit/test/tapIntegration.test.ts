/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { sendLLMMessage } from '../../llmMessage/sendLLMMessage.js';
import { sendLLMMessageToProviderImplementation } from '../../llmMessage/sendLLMMessage.impl.js';
import { IAuditMainService, BeginParams, FinalizeParams } from '../auditMainService.js';
import { IMetricsService } from '../../../common/metricsService.js';

class RecordingAudit implements IAuditMainService {
	declare readonly _serviceBrand: undefined;
	isEnabled = true;
	begins: BeginParams[] = [];
	finals: FinalizeParams[] = [];
	texts: string[] = [];
	begin(p: BeginParams) { this.begins.push(p); }
	appendText(_id: string, t: string) { this.texts.push(t); }
	async finalize(p: FinalizeParams) { this.finals.push(p); }
	async flushForwarder() { }
	async pruneRetention() { return 0; }
}

const noopMetrics: IMetricsService = { _serviceBrand: undefined, capture() { }, setOptOut() { }, async getDebuggingProperties() { return {}; } };

const IDENTITY = { machineId: 'm', userId: 'u', appVersion: '1', zeroEgressVersion: 'b' };
const WS = { folderUri: null, repoName: null, gitRemote: null, gitBranch: null, gitCommit: null };

function baseParams(over: Partial<any> = {}) {
	return {
		messagesType: 'chatMessages' as const,
		messages: [{ role: 'user', content: 'hi' }] as any,
		separateSystemMessage: 'sys',
		chatMode: 'agent' as any,
		onText: () => { }, onFinalMessage: () => { }, onError: () => { },
		abortRef: { current: null } as any,
		logging: { loggingName: 'Test' },
		settingsOfProvider: {} as any,
		modelSelection: { providerName: 'ollama', modelName: 'claude-opus-4-8' } as any,
		modelSelectionOptions: undefined, overridesOfModel: undefined, mcpTools: undefined,
		requestId: 'req-1', auditWorkspace: WS,
		...over,
	};
}

function fimParams(over: Partial<any> = {}) {
	return {
		messagesType: 'FIMMessage' as const,
		messages: { prefix: 'a', suffix: 'b', stopTokens: [] } as any,
		separateSystemMessage: undefined,
		chatMode: undefined,
		onText: () => { }, onFinalMessage: () => { }, onError: () => { },
		abortRef: { current: null } as any,
		logging: { loggingName: 'TestFIM' },
		settingsOfProvider: {} as any,
		modelSelection: { providerName: 'ollama', modelName: 'claude-opus-4-8' } as any,
		modelSelectionOptions: undefined, overridesOfModel: undefined, mcpTools: undefined,
		requestId: 'req-fim', auditWorkspace: WS,
		...over,
	};
}

suite('sendLLMMessage audit tap', () => {
	let originalChat: any;
	setup(() => { originalChat = sendLLMMessageToProviderImplementation.ollama.sendChat; });
	teardown(() => { sendLLMMessageToProviderImplementation.ollama.sendChat = originalChat; });

	test('completed chat fires begin then finalize(completed)', async () => {
		sendLLMMessageToProviderImplementation.ollama.sendChat = async ({ onText, onFinalMessage }: any) => {
			onText({ fullText: 'partial', fullReasoning: '' });
			onFinalMessage({ fullText: 'partial done', fullReasoning: '', anthropicReasoning: null });
		};
		const audit = new RecordingAudit();
		await sendLLMMessage(baseParams() as any, noopMetrics, audit, IDENTITY);
		assert.strictEqual(audit.begins.length, 1);
		assert.strictEqual(audit.begins[0].provider, 'ollama');
		assert.strictEqual(audit.finals.length, 1);
		assert.strictEqual(audit.finals[0].outcome, 'completed');
		assert.strictEqual(audit.finals[0].text, 'partial done');
	});

	test('error fires finalize(error) with the message', async () => {
		sendLLMMessageToProviderImplementation.ollama.sendChat = async ({ onError }: any) => {
			onError({ message: 'kaboom', fullError: null });
		};
		const audit = new RecordingAudit();
		await sendLLMMessage(baseParams() as any, noopMetrics, audit, IDENTITY);
		assert.strictEqual(audit.finals.length, 1);
		assert.strictEqual(audit.finals[0].outcome, 'error');
		assert.strictEqual(audit.finals[0].error, 'kaboom');
	});

	test('FIM request fires begin then finalize(completed)', async () => {
		const orig = sendLLMMessageToProviderImplementation.ollama.sendFIM;
		sendLLMMessageToProviderImplementation.ollama.sendFIM = async ({ onFinalMessage }: any) => {
			onFinalMessage({ fullText: 'completion', fullReasoning: '', anthropicReasoning: null });
		};
		try {
			const audit = new RecordingAudit();
			await sendLLMMessage(fimParams() as any, noopMetrics, audit, IDENTITY);
			assert.strictEqual(audit.begins.length, 1);
			assert.strictEqual(audit.finals.length, 1);
			assert.strictEqual(audit.finals[0].outcome, 'completed');
		} finally {
			sendLLMMessageToProviderImplementation.ollama.sendFIM = orig;
		}
	});
});

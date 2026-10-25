/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// registered in app.ts
// code convention is to make a service responsible for this stuff, and not a channel, but having fewer files is simpler...

import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { EventLLMMessageOnTextParams, EventLLMMessageOnErrorParams, EventLLMMessageOnFinalMessageParams, MainSendLLMMessageParams, AbortRef, SendLLMMessageParams, MainLLMMessageAbortParams, ModelListParams, EventModelListOnSuccessParams, EventModelListOnErrorParams, OllamaModelResponse, OpenaiCompatibleModelResponse, MainModelListParams, } from '../common/sendLLMMessageTypes.js';
import { sendLLMMessage } from './llmMessage/sendLLMMessage.js'
import { IMetricsService } from '../common/metricsService.js';
import { sendLLMMessageToProviderImplementation } from './llmMessage/sendLLMMessage.impl.js';
import { IAuditMainService } from './audit/auditMainService.js';

// NODE IMPLEMENTATION - calls actual sendLLMMessage() and returns listeners to it

export class LLMMessageChannel implements IServerChannel {

	// sendLLMMessage
	private readonly llmMessageEmitters = {
		onText: new Emitter<EventLLMMessageOnTextParams>(),
		onFinalMessage: new Emitter<EventLLMMessageOnFinalMessageParams>(),
		onError: new Emitter<EventLLMMessageOnErrorParams>(),
	}

	// aborters for above
	private readonly _infoOfRunningRequest: Record<string, { waitForSend: Promise<void> | undefined, abortRef: AbortRef }> = {}


	// list
	private readonly listEmitters = {
		ollama: {
			success: new Emitter<EventModelListOnSuccessParams<OllamaModelResponse>>(),
			error: new Emitter<EventModelListOnErrorParams<OllamaModelResponse>>(),
		},
		openaiCompat: {
			success: new Emitter<EventModelListOnSuccessParams<OpenaiCompatibleModelResponse>>(),
			error: new Emitter<EventModelListOnErrorParams<OpenaiCompatibleModelResponse>>(),
		},
	} satisfies {
		[providerName in 'ollama' | 'openaiCompat']: {
			success: Emitter<EventModelListOnSuccessParams<any>>,
			error: Emitter<EventModelListOnErrorParams<any>>,
		}
	}

	// Audit service + identity are mutable so app.ts can register this channel SYNCHRONOUSLY with a
	// disabled service, then hot-swap the real audit pipeline in once its async init resolves. A slow or
	// hung audit init can therefore never delay/block chat channel registration.
	private auditService: IAuditMainService;
	private auditIdentity: { machineId: string; userId: string; appVersion: string; zeroEgressVersion: string };

	// stupidly, channels can't take in @IService
	constructor(
		private readonly metricsService: IMetricsService,
		auditService: IAuditMainService,
		auditIdentity: { machineId: string; userId: string; appVersion: string; zeroEgressVersion: string },
	) {
		this.auditService = auditService;
		this.auditIdentity = auditIdentity;
	}

	setAudit(service: IAuditMainService, identity: { machineId: string; userId: string; appVersion: string; zeroEgressVersion: string }) {
		this.auditService = service;
		this.auditIdentity = identity;
	}

	// browser uses this to listen for changes
	listen(_: unknown, event: string): Event<any> {
		// text
		if (event === 'onText_sendLLMMessage') return this.llmMessageEmitters.onText.event;
		else if (event === 'onFinalMessage_sendLLMMessage') return this.llmMessageEmitters.onFinalMessage.event;
		else if (event === 'onError_sendLLMMessage') return this.llmMessageEmitters.onError.event;
		// list
		else if (event === 'onSuccess_list_ollama') return this.listEmitters.ollama.success.event;
		else if (event === 'onError_list_ollama') return this.listEmitters.ollama.error.event;
		else if (event === 'onSuccess_list_openAICompatible') return this.listEmitters.openaiCompat.success.event;
		else if (event === 'onError_list_openAICompatible') return this.listEmitters.openaiCompat.error.event;

		else throw new Error(`Event not found: ${event}`);
	}

	// browser uses this to call (see this.channel.call() in llmMessageService.ts for all usages)
	async call(_: unknown, command: string, params: any): Promise<any> {
		try {
			if (command === 'sendLLMMessage') {
				this._callSendLLMMessage(params)
			}
			else if (command === 'abort') {
				await this._callAbort(params)
			}
			else if (command === 'ollamaList') {
				this._callOllamaList(params)
			}
			else if (command === 'openAICompatibleList') {
				this._callOpenAICompatibleList(params)
			}
			else {
				throw new Error(`ZeroEgress sendLLM: command "${command}" not recognized.`)
			}
		}
		catch (e) {
			console.log('llmMessageChannel: Call Error:', e)
		}
	}

	// the only place sendLLMMessage is actually called
	private _callSendLLMMessage(params: MainSendLLMMessageParams) {
		const { requestId } = params;

		if (!(requestId in this._infoOfRunningRequest))
			this._infoOfRunningRequest[requestId] = { waitForSend: undefined, abortRef: { current: null } }

		const mainThreadParams: SendLLMMessageParams = {
			...params,
			onText: (p) => {
				this.llmMessageEmitters.onText.fire({ requestId, ...p });
			},
			onFinalMessage: (p) => {
				this.llmMessageEmitters.onFinalMessage.fire({ requestId, ...p });
			},
			onError: (p) => {
				console.log('sendLLM: firing err');
				this.llmMessageEmitters.onError.fire({ requestId, ...p });
			},
			abortRef: this._infoOfRunningRequest[requestId].abortRef,
		}
		// mainThreadParams carries requestId + auditWorkspace at runtime (via ...params); the audit
		// service + identity let sendLLMMessage record this request. Audit never throws into chat.
		const p = sendLLMMessage(mainThreadParams, this.metricsService, this.auditService, this.auditIdentity);
		this._infoOfRunningRequest[requestId].waitForSend = p
	}

	private async _callAbort(params: MainLLMMessageAbortParams) {
		const { requestId } = params;
		if (!(requestId in this._infoOfRunningRequest)) return
		const { waitForSend, abortRef } = this._infoOfRunningRequest[requestId]
		await waitForSend // wait for the send to finish so we know abortRef was set
		abortRef?.current?.()
		delete this._infoOfRunningRequest[requestId]
	}





	_callOllamaList = (params: MainModelListParams<OllamaModelResponse>) => {
		const { requestId } = params
		const emitters = this.listEmitters.ollama
		const mainThreadParams: ModelListParams<OllamaModelResponse> = {
			...params,
			onSuccess: (p) => { emitters.success.fire({ requestId, ...p }); },
			onError: (p) => { emitters.error.fire({ requestId, ...p }); },
		}
		sendLLMMessageToProviderImplementation.ollama.list(mainThreadParams)
	}

	_callOpenAICompatibleList = (params: MainModelListParams<OpenaiCompatibleModelResponse>) => {
		const { requestId, providerName } = params
		const emitters = this.listEmitters.openaiCompat
		const mainThreadParams: ModelListParams<OpenaiCompatibleModelResponse> = {
			...params,
			onSuccess: (p) => { emitters.success.fire({ requestId, ...p }); },
			onError: (p) => { emitters.error.fire({ requestId, ...p }); },
		}
		sendLLMMessageToProviderImplementation[providerName].list(mainThreadParams)
	}





}

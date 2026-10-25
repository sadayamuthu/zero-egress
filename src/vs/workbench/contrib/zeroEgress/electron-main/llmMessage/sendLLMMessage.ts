/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { SendLLMMessageParams, OnText, OnFinalMessage, OnError } from '../../common/sendLLMMessageTypes.js';
import { IMetricsService } from '../../common/metricsService.js';
import { displayInfoOfProviderName } from '../../common/zeroEgressSettingsTypes.js';
import { sendLLMMessageToProviderImplementation } from './sendLLMMessage.impl.js';
import { IAuditMainService } from '../audit/auditMainService.js';
import { AuditWorkspace } from '../../common/auditTypes.js';


export const sendLLMMessage = async ({
	messagesType,
	messages: messages_,
	onText: onText_,
	onFinalMessage: onFinalMessage_,
	onError: onError_,
	abortRef: abortRef_,
	logging: { loggingName, loggingExtras },
	settingsOfProvider,
	modelSelection,
	modelSelectionOptions,
	overridesOfModel,
	chatMode,
	separateSystemMessage,
	mcpTools,
	requestId,
	auditWorkspace,
}: SendLLMMessageParams & { requestId?: string; auditWorkspace?: AuditWorkspace },

	metricsService: IMetricsService,
	auditService?: IAuditMainService,
	identity?: { machineId: string; userId: string; appVersion: string; zeroEgressVersion: string },
) => {


	const { providerName, modelName } = modelSelection

	// only captures number of messages and message "shape", no actual code, instructions, prompts, etc
	const captureLLMEvent = (eventId: string, extras?: object) => {


		metricsService.capture(eventId, {
			providerName,
			modelName,
			customEndpointURL: settingsOfProvider[providerName]?.endpoint,
			numModelsAtEndpoint: settingsOfProvider[providerName]?.models?.length,
			...messagesType === 'chatMessages' ? {
				numMessages: messages_?.length,
			} : messagesType === 'FIMMessage' ? {
				prefixLength: messages_.prefix.length,
				suffixLength: messages_.suffix.length,
			} : {},
			...loggingExtras,
			...extras,
		})
	}
	const submit_time = new Date()

	// --- Chat audit tap: never throws into the chat path. begin()/appendText() are guarded
	// by auditService?.isEnabled; finalize() is fire-and-forget (void), never awaited here. ---
	const _auditReqId = requestId ?? ''
	const _auditNowIso = submit_time.toISOString()
	if (auditService?.isEnabled && identity && _auditReqId) {
		try {
			auditService.begin({
				requestId: _auditReqId,
				provider: providerName,
				modelName,
				chatMode: chatMode ?? null,
				systemPrompt: separateSystemMessage ?? '',
				messages: messagesType === 'chatMessages' ? (messages_ as unknown[]) : [messages_],
				tools: mcpTools ?? [],
				workspace: auditWorkspace ?? { folderUri: null, repoName: null, gitRemote: null, gitBranch: null, gitCommit: null },
				identity,
				startedAtMs: submit_time.getTime(),
				nowIso: _auditNowIso,
			})
		} catch (e) { /* audit must never break chat */ }
	}
	const _finalizeAudit = (outcome: 'completed' | 'aborted' | 'error', p: { text: string; toolCalls: unknown[]; finishReason: string | null; error: string | null }) => {
		if (auditService?.isEnabled && identity && _auditReqId) {
			try {
				void auditService.finalize({
					requestId: _auditReqId, outcome,
					text: p.text, toolCalls: p.toolCalls, finishReason: p.finishReason,
					usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
					error: p.error, endedAtMs: Date.now(),
				})
			} catch (e) { /* audit must never break chat */ }
		}
	}

	let _fullTextSoFar = ''
	let _aborter: (() => void) | null = null
	let _setAborter = (fn: () => void) => { _aborter = fn }
	let _didAbort = false

	const onText: OnText = (params) => {
		const { fullText } = params
		if (_didAbort) return
		onText_(params)
		_fullTextSoFar = fullText
		if (auditService?.isEnabled && _auditReqId) { try { auditService.appendText(_auditReqId, fullText) } catch (e) { /* audit must never break chat */ } }
	}

	const onFinalMessage: OnFinalMessage = (params) => {
		const { fullText, fullReasoning, toolCall } = params
		if (_didAbort) return
		captureLLMEvent(`${loggingName} - Received Full Message`, { messageLength: fullText.length, reasoningLength: fullReasoning?.length, duration: new Date().getMilliseconds() - submit_time.getMilliseconds(), toolCallName: toolCall?.name })
		_finalizeAudit('completed', { text: fullText, toolCalls: toolCall ? [toolCall] : [], finishReason: 'stop', error: null })
		onFinalMessage_(params)
	}

	const onError: OnError = ({ message: errorMessage, fullError }) => {
		if (_didAbort) return
		console.error('sendLLMMessage onError:', errorMessage)

		// handle failed to fetch errors, which give 0 information by design
		if (errorMessage === 'TypeError: fetch failed')
			errorMessage = `Failed to fetch from ${displayInfoOfProviderName(providerName).title}. This likely means you specified the wrong endpoint in ZeroEgress Settings, or your local model provider like Ollama is powered off.`

		captureLLMEvent(`${loggingName} - Error`, { error: errorMessage })
		_finalizeAudit('error', { text: _fullTextSoFar, toolCalls: [], finishReason: null, error: errorMessage })
		onError_({ message: errorMessage, fullError })
	}

	// we should NEVER call onAbort internally, only from the outside
	const onAbort = () => {
		captureLLMEvent(`${loggingName} - Abort`, { messageLengthSoFar: _fullTextSoFar.length })
		_finalizeAudit('aborted', { text: _fullTextSoFar, toolCalls: [], finishReason: null, error: null })
		try { _aborter?.() } // aborter sometimes automatically throws an error
		catch (e) { }
		_didAbort = true
	}
	abortRef_.current = onAbort


	if (messagesType === 'chatMessages')
		captureLLMEvent(`${loggingName} - Sending Message`, {})
	else if (messagesType === 'FIMMessage')
		captureLLMEvent(`${loggingName} - Sending FIM`, { prefixLen: messages_?.prefix?.length, suffixLen: messages_?.suffix?.length })


	try {
		const implementation = sendLLMMessageToProviderImplementation[providerName]
		if (!implementation) {
			onError({ message: `Error: Provider "${providerName}" not recognized.`, fullError: null })
			return
		}
		const { sendFIM, sendChat } = implementation
		if (messagesType === 'chatMessages') {
			await sendChat({ messages: messages_, onText, onFinalMessage, onError, settingsOfProvider, modelSelectionOptions, overridesOfModel, modelName, _setAborter, providerName, separateSystemMessage, chatMode, mcpTools })
			return
		}
		if (messagesType === 'FIMMessage') {
			if (sendFIM) {
				await sendFIM({ messages: messages_, onText, onFinalMessage, onError, settingsOfProvider, modelSelectionOptions, overridesOfModel, modelName, _setAborter, providerName, separateSystemMessage })
				return
			}
			onError({ message: `Error running Autocomplete with ${providerName} - ${modelName}.`, fullError: null })
			return
		}
		onError({ message: `Error: Message type "${messagesType}" not recognized.`, fullError: null })
		return
	}

	catch (error) {
		if (error instanceof Error) { onError({ message: error + '', fullError: error }) }
		else { onError({ message: `Unexpected Error in sendLLMMessage: ${error}`, fullError: error }); }
		// ; (_aborter as any)?.()
		// _didAbort = true
	}



}


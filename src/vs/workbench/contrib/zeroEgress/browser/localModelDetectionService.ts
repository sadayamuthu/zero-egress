/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// First-run detection: asks the main process to list models at the loopback default ports (and at URLs the user
// types), through the same list requests and egress-guard leases as a normal model refresh, with the URL passed as
// a one-request endpoint override. Probing never touches settings; `apply` fills them in when asked.

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { classifyPort8000, FoundModel, paramsBillionsOf, PROBE_TARGETS, ProbeTarget } from '../common/localDetection.js';
import { defaultProviderSettings } from '../common/modelCapabilities.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { OllamaModelResponse, OpenaiCompatibleModelResponse } from '../common/sendLLMMessageTypes.js';
import { IZeroEgressSettingsService } from '../common/zeroEgressSettingsService.js';
import { FeatureName, ProviderName, RefreshableProviderName } from '../common/zeroEgressSettingsTypes.js';

export interface ProbeResult {
	target: ProbeTarget | { id: 'custom'; url: string; providers: ProviderName[] };
	status: 'found' | 'not_running';
	/** null when port 8000 answered but could not be told apart as vLLM or oMLX; the UI then asks which. */
	providerName: ProviderName | null;
	models: FoundModel[];
}

export const ILocalModelDetectionService = createDecorator<ILocalModelDetectionService>('zeroEgressLocalModelDetectionService');

export interface ILocalModelDetectionService {
	readonly _serviceBrand: undefined;
	/** Probes every PROBE_TARGET in parallel, each with a 2000 ms timeout. Never throws. */
	detect(): Promise<ProbeResult[]>;
	/** Probes exactly `url` as `providerName` (no port 8000 classification). Never throws. */
	probeUrl(url: string, providerName: ProviderName): Promise<ProbeResult>;
	/** Fills in default/empty endpoints and autodetected models of found providers, and gives `chosen` to the
	 *  Chat, Ctrl+K, Apply and SCM features that have no selection. Never changes anything the user set. */
	apply(results: readonly ProbeResult[], chosen: FoundModel | null): void;
}

export const PROBE_TIMEOUT_MS = 2000;

/** Features `apply` gives the chosen model to. Autocomplete wants a different kind of model, so it is left alone. */
const CHOSEN_FEATURES: readonly FeatureName[] = ['Chat', 'Ctrl+K', 'Apply', 'SCM'];

/** Returns `result` with an unknown port 8000 server resolved to the provider the user picked. */
export function withProvider(result: ProbeResult, providerName: ProviderName): ProbeResult {
	return { ...result, providerName, models: result.models.map(m => ({ ...m, providerName })) };
}

/** Trimmed, without trailing slashes (the list request appends `/v1` or `/api/tags`), or null unless http(s). */
function normalizedUrl(url: string): string | null {
	const trimmed = url.trim().replace(/\/+$/, '');
	try {
		const { protocol } = new URL(trimmed);
		return protocol === 'http:' || protocol === 'https:' ? trimmed : null;
	} catch {
		return null;
	}
}

type ListOutcome<T> = { ok: true; models: T[] } | { ok: false };

export class LocalModelDetectionService implements ILocalModelDetectionService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,
		@IZeroEgressSettingsService private readonly settingsService: IZeroEgressSettingsService,
	) { }

	detect(): Promise<ProbeResult[]> {
		return Promise.all(PROBE_TARGETS.map(target => this._probe(target, target.url, target.id === 'port8000' ? 'classify' : target.providers[0])));
	}

	probeUrl(url: string, providerName: ProviderName): Promise<ProbeResult> {
		const normalized = normalizedUrl(url);
		const target = { id: 'custom' as const, url: normalized ?? url, providers: [providerName] };
		if (normalized === null) {
			return Promise.resolve({ target, status: 'not_running', providerName: null, models: [] });
		}
		return this._probe(target, normalized, providerName);
	}

	private async _probe(target: ProbeResult['target'], url: string, as: ProviderName | 'classify'): Promise<ProbeResult> {
		const notRunning: ProbeResult = { target, status: 'not_running', providerName: null, models: [] };
		try {
			if (as === 'ollama') {
				const r = await this._list<OllamaModelResponse>('ollama', url);
				if (!r.ok || !r.models.every(m => typeof m?.name === 'string')) { return notRunning; }
				return {
					target, status: 'found', providerName: 'ollama',
					models: r.models.map(m => ({ providerName: 'ollama', modelName: m.name, paramsB: paramsBillionsOf(m.name, typeof m.details?.parameter_size === 'string' ? m.details.parameter_size : undefined) })),
				};
			}
			// Port 8000 is listed as vLLM; vLLM and oMLX share the OpenAI-compatible list request.
			const r = await this._list<OpenaiCompatibleModelResponse>(as === 'classify' ? 'vLLM' : as, url);
			if (!r.ok || !r.models.every(m => typeof m?.id === 'string')) { return notRunning; }
			let providerName: ProviderName | null;
			if (as === 'classify') {
				const kind = classifyPort8000(r.models.map(m => typeof m.owned_by === 'string' ? m.owned_by.toLowerCase() : ''));
				providerName = kind === 'unknown' ? null : kind;
			} else {
				providerName = as;
			}
			// An unknown port 8000 server's models carry vLLM until the user picks; see withProvider.
			const modelsProvider: ProviderName = providerName ?? 'vLLM';
			return {
				target, status: 'found', providerName,
				models: r.models.map(m => ({ providerName: modelsProvider, modelName: m.id, paramsB: paramsBillionsOf(m.id) })),
			};
		} catch {
			return notRunning;
		}
	}

	/** One list request with `url` as its endpoint override. Resolves `{ ok: false }` on error, on a reply that is
	 *  not a model list, or after PROBE_TIMEOUT_MS; whatever arrives after that is ignored. */
	private _list<T>(providerName: RefreshableProviderName, url: string): Promise<ListOutcome<T>> {
		return new Promise<ListOutcome<T>>(resolve => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined = undefined;
			const settle = (outcome: ListOutcome<T>) => {
				if (settled) { return; }
				settled = true;
				if (timer !== undefined) { clearTimeout(timer); } // not once it has fired
				resolve(outcome);
			};
			timer = setTimeout(() => { timer = undefined; settle({ ok: false }); }, PROBE_TIMEOUT_MS);
			const params = {
				providerName,
				endpointOverride: url,
				onSuccess: ({ models }: { models: T[] }) => settle(Array.isArray(models) ? { ok: true, models } : { ok: false }),
				onError: () => settle({ ok: false }),
			};
			try {
				if (providerName === 'ollama') {
					this.llmMessageService.ollamaList(params as unknown as Parameters<ILLMMessageService['ollamaList']>[0]);
				} else {
					this.llmMessageService.openAICompatibleList(params as unknown as Parameters<ILLMMessageService['openAICompatibleList']>[0]);
				}
			} catch {
				settle({ ok: false });
			}
		});
	}

	apply(results: readonly ProbeResult[], chosen: FoundModel | null): void {
		// Which features are unset is decided before any write: writing models lets settings validation fill an
		// empty selection with the first model, and the chosen model should win over that.
		const unsetFeatures = CHOSEN_FEATURES.filter(f => this.settingsService.state.modelSelectionOfFeature[f] === null);

		for (const result of results) {
			const providerName = result.providerName;
			if (result.status !== 'found' || !providerName) { continue; }
			const url = result.target.url;
			const current = this.settingsService.state.settingsOfProvider[providerName].endpoint;
			const isDefault = !current || current === defaultProviderSettings[providerName].endpoint;
			if (!isDefault && current !== url) { continue; } // the user's own endpoint: leave it and its models alone
			if (current !== url) {
				void this.settingsService.setSettingOfProvider(providerName, 'endpoint', url);
			}
			this.settingsService.setAutodetectedModels(providerName, result.models.map(m => m.modelName), { source: 'firstRun' });
		}

		if (chosen) {
			for (const feature of unsetFeatures) {
				void this.settingsService.setModelSelectionOfFeature(feature, { providerName: chosen.providerName, modelName: chosen.modelName });
			}
		}
	}
}

registerSingleton(ILocalModelDetectionService, LocalModelDetectionService, InstantiationType.Delayed);

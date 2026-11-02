/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The chat panel's "Thinking" control as one level per model, and the request-body field that carries it.

import type { ZeroEgressStaticModelInfo } from './modelCapabilities.js';
import type { ModelSelectionOptions, ProviderName } from './zeroEgressSettingsTypes.js';

export type ThinkingLevel = 'off' | 'low' | 'med' | 'high';

export const thinkingLabel: Record<ThinkingLevel, string> = { off: 'Off', low: 'Low', med: 'Med', high: 'High' };

const effortOfLevel = { low: 'low', med: 'medium', high: 'high' } as const;
const levelOfEffort: Record<string, ThinkingLevel> = { low: 'low', medium: 'med', high: 'high' };

const reasoningOf = (caps: ZeroEgressStaticModelInfo) => caps.reasoningCapabilities || undefined;
const effortSliderOf = (caps: ZeroEgressStaticModelInfo) => {
	const slider = reasoningOf(caps)?.reasoningSlider;
	return slider?.type === 'effort_slider' ? slider : undefined;
};

// Off is sent as reasoning_effort 'none', verified only on Ollama (see reasoningBodyOf), so only Ollama offers it
const canTurnOff = (providerName: ProviderName, caps: ZeroEgressStaticModelInfo) => providerName === 'ollama' && !!reasoningOf(caps)?.canTurnOffReasoning;

export function thinkingLevelsOf(providerName: ProviderName, caps: ZeroEgressStaticModelInfo): ThinkingLevel[] {
	const reasoning = reasoningOf(caps);
	if (!reasoning) {
		return [];
	}
	if (effortSliderOf(caps)) {
		return canTurnOff(providerName, caps) ? ['off', 'low', 'med', 'high'] : ['low', 'med', 'high'];
	}
	if (reasoning.canTurnOffReasoning) {
		// an on/off model elsewhere: off can't be sent, so there is nothing to choose
		return canTurnOff(providerName, caps) ? ['off', 'high'] : [];
	}
	return ['high']; // always thinks
}

// Chat reasons by default (as getIsReasoningEnabledState does for the Chat feature)
export function thinkingLevelOf(providerName: ProviderName, caps: ZeroEgressStaticModelInfo, opts: ModelSelectionOptions | undefined): ThinkingLevel | null {
	const reasoning = reasoningOf(caps);
	if (!reasoning) {
		return null;
	}
	if (canTurnOff(providerName, caps) && opts?.reasoningEnabled === false) {
		return 'off';
	}
	const slider = effortSliderOf(caps);
	if (!slider) {
		return 'high';
	}
	return levelOfEffort[opts?.reasoningEffort ?? slider.default] ?? levelOfEffort[slider.default] ?? 'med';
}

export function optionsForThinkingLevel(caps: ZeroEgressStaticModelInfo, level: ThinkingLevel): Partial<ModelSelectionOptions> {
	if (level === 'off') {
		return { reasoningEnabled: false };
	}
	if (effortSliderOf(caps)) {
		return { reasoningEnabled: true, reasoningEffort: effortOfLevel[level] };
	}
	return { reasoningEnabled: true };
}

// "· <Level>" on the model button: the same words the Thinking row shows. Nothing for a model that can't reason or always does.
export function thinkingButtonLabel(providerName: ProviderName, caps: ZeroEgressStaticModelInfo, opts: ModelSelectionOptions | undefined): string | null {
	const levels = thinkingLevelsOf(providerName, caps);
	const level = thinkingLevelOf(providerName, caps, opts);
	if (!level || levels.length < 2) {
		return null;
	}
	if (!effortSliderOf(caps)) {
		return level === 'off' ? 'Off' : 'On';
	}
	return thinkingLabel[level];
}

// Probed against Ollama 0.40.11 (/v1/chat/completions, qwen3:0.6b, "What is 17*23?"):
//   {reasoning_effort:'none'} -> message.content only, no `reasoning` text
//   {reasoning_effort:'high'} -> message.reasoning present
//   {think:false}             -> ignored on /v1 (reasoning still came back)
// so for `ollama` off is 'none'. 'none' is unverified on vLLM / LM Studio / oMLX (it could be a 400), so they send
// reasoning_effort only for low / medium / high and nothing for off.
export function reasoningBodyOf(providerName: ProviderName, caps: ZeroEgressStaticModelInfo, opts: ModelSelectionOptions | undefined): Record<string, string> {
	const reasoning = reasoningOf(caps);
	if (!reasoning) {
		return {};
	}
	if (reasoning.canTurnOffReasoning && opts?.reasoningEnabled === false) {
		return providerName === 'ollama' ? { reasoning_effort: 'none' } : {};
	}
	const slider = effortSliderOf(caps);
	const effort = opts?.reasoningEffort ?? slider?.default; // the default is what the row shows, so it is what is sent
	return slider && effort ? { reasoning_effort: effort } : {};
}

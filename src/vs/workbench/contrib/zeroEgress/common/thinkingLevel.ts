/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The chat panel's "Thinking" control as one level per model, and the request-body field that carries it.

import type { ZeroEgressStaticModelInfo } from './modelCapabilities.js';
import type { ModelSelectionOptions } from './zeroEgressSettingsTypes.js';

export type ThinkingLevel = 'off' | 'low' | 'med' | 'high';

export const thinkingLabel: Record<ThinkingLevel, string> = { off: 'Off', low: 'Low', med: 'Med', high: 'High' };

const effortOfLevel = { low: 'low', med: 'medium', high: 'high' } as const;
const levelOfEffort: Record<string, ThinkingLevel> = { low: 'low', medium: 'med', high: 'high' };

const reasoningOf = (caps: ZeroEgressStaticModelInfo) => caps.reasoningCapabilities || undefined;
const effortSliderOf = (caps: ZeroEgressStaticModelInfo) => {
	const slider = reasoningOf(caps)?.reasoningSlider;
	return slider?.type === 'effort_slider' ? slider : undefined;
};

export function thinkingLevelsOf(caps: ZeroEgressStaticModelInfo): ThinkingLevel[] {
	const reasoning = reasoningOf(caps);
	if (!reasoning) {
		return [];
	}
	const levels: ThinkingLevel[] = reasoning.canTurnOffReasoning ? ['off'] : [];
	if (effortSliderOf(caps)) {
		levels.push('low', 'med', 'high');
	} else {
		levels.push('high'); // no effort to choose: shown as "On"
	}
	return levels;
}

// Chat reasons by default (as getIsReasoningEnabledState does for the Chat feature)
export function thinkingLevelOf(caps: ZeroEgressStaticModelInfo, opts: ModelSelectionOptions | undefined): ThinkingLevel | null {
	const reasoning = reasoningOf(caps);
	if (!reasoning) {
		return null;
	}
	if (reasoning.canTurnOffReasoning && opts?.reasoningEnabled === false) {
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

// Probed against Ollama 0.40.11 (/v1/chat/completions, qwen3:0.6b, "What is 17*23?"):
//   {reasoning_effort:'none'} -> message.content only, no `reasoning` text
//   {reasoning_effort:'high'} -> message.reasoning present
//   {think:false}             -> ignored on /v1 (reasoning still came back)
// so `reasoning_effort` is honored by Ollama's OpenAI-compatible endpoint and no provider-specific branch is needed.
export function reasoningBodyOf(caps: ZeroEgressStaticModelInfo, opts: ModelSelectionOptions | undefined): Record<string, string> {
	const reasoning = reasoningOf(caps);
	if (!reasoning) {
		return {};
	}
	if (reasoning.canTurnOffReasoning && opts?.reasoningEnabled === false) {
		return { reasoning_effort: 'none' };
	}
	const slider = effortSliderOf(caps);
	const effort = opts?.reasoningEffort ?? slider?.default;
	return slider && effort ? { reasoning_effort: effort } : {};
}

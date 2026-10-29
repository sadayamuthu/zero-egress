/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Pure logic for first-run detection: which loopback default ports to probe, how to tell vLLM from oMLX on
// their shared port, and which found model to recommend for agent work. No I/O and no DNS here.

import { defaultProviderSettings } from './modelCapabilities.js';
import { ProviderName } from './zeroEgressSettingsTypes.js';

export interface ProbeTarget {
	id: 'ollama' | 'lmStudio' | 'port8000';
	url: string;
	providers: ProviderName[];
}

/** Loopback default ports only. vLLM and oMLX share port 8000, so it is probed once. */
export const PROBE_TARGETS: readonly ProbeTarget[] = [
	{ id: 'ollama', url: defaultProviderSettings.ollama.endpoint, providers: ['ollama'] },
	{ id: 'lmStudio', url: defaultProviderSettings.lmStudio.endpoint, providers: ['lmStudio'] },
	{ id: 'port8000', url: 'http://localhost:8000', providers: ['vLLM', 'oMLX'] },
];

/** True for `localhost`, 127.0.0.0/8 and [::1]. False for anything else, including unparsable input. */
export function isLoopbackUrl(url: string): boolean {
	let hostname: string;
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (hostname.startsWith('[') && hostname.endsWith(']')) {
		hostname = hostname.slice(1, -1);
	}
	if (hostname === 'localhost' || hostname === '::1') {
		return true;
	}
	return /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(hostname)
		&& hostname.split('.').every(p => Number(p) <= 255);
}

export function classifyPort8000(ownedBy: readonly string[]): 'vLLM' | 'oMLX' | 'unknown' {
	if (ownedBy.some(o => o === 'vllm')) { return 'vLLM'; }
	if (ownedBy.some(o => o.includes('mlx'))) { return 'oMLX'; }
	return 'unknown';
}

export interface FoundModel {
	providerName: ProviderName;
	modelName: string;
	paramsB: number | null;
}

/** A size token is a number followed by `b`, not preceded by a digit/dot/letter and not followed by a letter,
 *  so `qwen2.5-coder:7b` gives 7 and `qwen2.5` gives nothing. */
const SIZE_TOKEN = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z0-9])/i;

export function paramsBillionsOf(modelName: string, detailsParameterSize?: string): number | null {
	for (const s of [detailsParameterSize, modelName]) {
		if (!s) { continue; }
		const m = SIZE_TOKEN.exec(s);
		if (m) { return parseFloat(m[1]); }
	}
	return null;
}

const FAMILIES = ['qwen3-coder', 'qwen2.5-coder', 'devstral', 'deepseek-coder', 'codestral', 'qwen3', 'codellama'];
const MAX_RECOMMENDED_B = 34;

/** Largest paramsB <= 34, ties and unknown sizes keep input order. */
const largestFitting = (models: readonly FoundModel[]): FoundModel | undefined => {
	let best: FoundModel | undefined;
	for (const m of models) {
		if (m.paramsB === null || m.paramsB > MAX_RECOMMENDED_B) { continue; }
		if (!best || m.paramsB > best.paramsB!) { best = m; }
	}
	return best;
};

export function recommendModel(found: readonly FoundModel[]): FoundModel | null {
	if (!found.length) { return null; }
	for (const family of FAMILIES) {
		const inFamily = found.filter(m => m.modelName.toLowerCase().includes(family));
		if (inFamily.length) {
			return largestFitting(inFamily) ?? inFamily[0];
		}
	}
	return largestFitting(found) ?? found[0];
}

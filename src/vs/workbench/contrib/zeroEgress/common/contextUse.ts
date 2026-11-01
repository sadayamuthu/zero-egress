/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// How full a chat's context window is: the provider's own counts from the last reply when there are any (plus an
// estimate for what was added since), else an estimate from the text.

import type { ChatMessage } from './chatThreadServiceTypes.js';

export const CHARS_PER_TOKEN = 4 // assume abysmal chars per token

export type ContextUse = { usedTokens: number; contextWindow: number; fraction: number; estimated: boolean };

const charsOf = (m: ChatMessage): number => {
	if (m.role === 'user' || m.role === 'tool') { return m.content.length; }
	if (m.role === 'assistant') { return m.displayContent.length; }
	return 0;
};

export function contextUseOf(messages: ChatMessage[], contextWindow: number, systemChars: number): ContextUse {
	let lastIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === 'assistant' && m.usage) { lastIdx = i; break; }
	}
	let used: number;
	let estimated: boolean;
	if (lastIdx >= 0) {
		const m = messages[lastIdx];
		used = m.role === 'assistant' && m.usage ? m.usage.promptTokens + m.usage.completionTokens : 0;
		estimated = false;
		for (const after of messages.slice(lastIdx + 1)) {
			if (after.role === 'user' || after.role === 'tool') {
				used += Math.ceil(charsOf(after) / CHARS_PER_TOKEN);
				estimated = true;
			}
		}
	} else {
		used = Math.ceil((systemChars + messages.reduce((n, m) => n + charsOf(m), 0)) / CHARS_PER_TOKEN);
		estimated = true;
	}
	const fraction = contextWindow > 0 ? Math.min(1, used / contextWindow) : 1;
	return { usedTokens: used, contextWindow, fraction, estimated };
}

export const contextPercent = (u: ContextUse): number => Math.round(u.fraction * 100);
export const contextWindowK = (u: ContextUse): number => Math.round(u.contextWindow / 1024);

/** "62% of 32k", or "≈62% of 32k" when estimated */
export function formatContextUse(u: ContextUse): string {
	return `${u.estimated ? '≈' : ''}${contextPercent(u)}% of ${contextWindowK(u)}k`;
}

/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export type TokenUsage = { promptTokens: number; completionTokens: number }

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0

// reads the token counts off a streamed chunk (the final chunk has `choices: []` plus `usage`)
export function usageOfChunk(chunk: unknown): TokenUsage | null {
	const usage = (chunk as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null | undefined)?.usage
	if (!usage || typeof usage !== 'object') return null
	const { prompt_tokens, completion_tokens } = usage
	if (!isCount(prompt_tokens) || !isCount(completion_tokens)) return null
	return { promptTokens: prompt_tokens, completionTokens: completion_tokens }
}

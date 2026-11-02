/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Custom modes live only in app settings (never read from the project). They decide which tools a model may call.
// No runtime vs/ imports: the chat React bundle re-exports this file.

import type { ToolPolicy } from './toolPolicy.js';
import type { ChatMode, GlobalSettings } from './zeroEgressSettingsTypes.js';

export type CustomModeIcon = 'sparkles' | 'shield' | 'eye' | 'wrench' | 'book' | 'bug' | 'rocket' | 'pen'

export type CustomMode = { id: string; name: string; icon: CustomModeIcon; tools: { edit: boolean; terminal: boolean; mcp: boolean }; instructions: string }

export type RunMode = { chatMode: ChatMode; toolPolicy: ToolPolicy | null; label: string; extraInstructions?: string; customModeId?: string }

export const MAX_CUSTOM_MODE_NAME = 24
export const MAX_CUSTOM_MODE_INSTRUCTIONS = 4000

const builtInLabelOfMode: Record<ChatMode, string> = { agent: 'Agent', plan: 'Plan', gather: 'Gather', normal: 'Chat' }
const builtInLabels = Object.values(builtInLabelOfMode)

// kept in step with toolPolicyOfMode (toolPolicy.ts), which this file can't import at runtime
const builtInPolicyOfMode = (mode: ChatMode): ToolPolicy | null => {
	switch (mode) {
		case 'agent': return { edit: true, terminal: true, mcp: true, plan: true }
		case 'gather': return { edit: false, terminal: false, mcp: false, plan: false }
		case 'plan': return { edit: false, terminal: false, mcp: false, plan: true }
		default: return null
	}
}

export function resolveRunMode(gs: Pick<GlobalSettings, 'chatMode' | 'customModes' | 'activeCustomModeId'>): RunMode {
	const custom = gs.activeCustomModeId ? gs.customModes?.find(m => m.id === gs.activeCustomModeId) : undefined
	if (!custom) {
		return { chatMode: gs.chatMode, toolPolicy: builtInPolicyOfMode(gs.chatMode), label: builtInLabelOfMode[gs.chatMode] }
	}
	const { edit, terminal, mcp } = custom.tools
	const instructions = custom.instructions.trim()
	return {
		chatMode: (edit || terminal) ? 'agent' : 'gather',
		toolPolicy: { edit, terminal, mcp, plan: edit || terminal },
		label: custom.name,
		extraInstructions: instructions ? `MODE INSTRUCTIONS (custom mode “${custom.name}”):\n${instructions}` : undefined,
		customModeId: custom.id,
	}
}

export function validateCustomMode(m: CustomMode, others: CustomMode[]): string | null {
	const name = m.name.trim()
	if (!name) return 'Give the mode a name.'
	if (name.length > MAX_CUSTOM_MODE_NAME) return 'Names can be up to 24 characters.'
	const lower = name.toLowerCase()
	if (builtInLabels.some(l => l.toLowerCase() === lower) || others.some(o => o.id !== m.id && o.name.trim().toLowerCase() === lower)) return 'Another mode already has this name.'
	if (m.instructions.length > MAX_CUSTOM_MODE_INSTRUCTIONS) return 'Instructions can be up to 4,000 characters.'
	return null
}

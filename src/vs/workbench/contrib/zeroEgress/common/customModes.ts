/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Custom modes live only in app settings (never read from the project). They decide which tools a model may call.
// No runtime vs/ imports: the chat React bundle re-exports this file.

import type { ChatMode, GlobalSettings } from './zeroEgressSettingsTypes.js';

export type CustomModeIcon = 'sparkles' | 'shield' | 'eye' | 'wrench' | 'book' | 'bug' | 'rocket' | 'pen'

export type CustomMode = { id: string; name: string; icon: CustomModeIcon; tools: { edit: boolean; terminal: boolean; mcp: boolean }; instructions: string }

export type RunMode = { chatMode: ChatMode; toolPolicy: ToolPolicy | null; label: string; extraInstructions?: string; customModeId?: string }

export const MAX_CUSTOM_MODE_NAME = 24
export const MAX_CUSTOM_MODE_INSTRUCTIONS = 4000

const builtInLabelOfMode: Record<ChatMode, string> = { agent: 'Agent', plan: 'Plan', gather: 'Gather', normal: 'Chat' }
const builtInLabels = Object.values(builtInLabelOfMode)

/** Which groups of tools a run may use. Read tools are always allowed when a policy exists; `null` means no tools at all. */
export type ToolPolicy = { edit: boolean; terminal: boolean; mcp: boolean; plan: boolean }

/** the one built-in mode -> policy table (toolPolicy.ts re-exports it) */
export function toolPolicyOfMode(mode: ChatMode): ToolPolicy | null {
	switch (mode) {
		case 'agent': return { edit: true, terminal: true, mcp: true, plan: true }
		case 'gather': return { edit: false, terminal: false, mcp: false, plan: false }
		case 'plan': return { edit: false, terminal: false, mcp: false, plan: true }
		default: return null
	}
}

const builtInRunMode = (chatMode: ChatMode): RunMode => ({ chatMode, toolPolicy: toolPolicyOfMode(chatMode), label: builtInLabelOfMode[chatMode] })

export function resolveRunMode(gs: Pick<GlobalSettings, 'chatMode' | 'customModes' | 'activeCustomModeId'>): RunMode {
	const custom = gs.activeCustomModeId && Array.isArray(gs.customModes) ? gs.customModes.find(m => m?.id === gs.activeCustomModeId) : undefined
	if (!custom) return builtInRunMode(gs.chatMode)
	// stored data may be malformed: only a real `true` grants a tool
	const edit = custom.tools?.edit === true, terminal = custom.tools?.terminal === true, mcp = custom.tools?.mcp === true
	const name = String(custom.name ?? '').replace(/[\r\n”]/g, ' ').trim().slice(0, MAX_CUSTOM_MODE_NAME).trim()
	const instructions = String(custom.instructions ?? '').slice(0, MAX_CUSTOM_MODE_INSTRUCTIONS).trim()
	return {
		chatMode: (edit || terminal) ? 'agent' : 'gather',
		toolPolicy: { edit, terminal, mcp, plan: edit || terminal },
		label: name,
		extraInstructions: instructions ? `MODE INSTRUCTIONS (custom mode “${name}”):\n${instructions}` : undefined,
		customModeId: custom.id,
	}
}

/** What a run uses: a / command's mode, else Agent for background agents, else the chosen mode. Only the last may carry custom tools or instructions. */
export function runModeFor({ modeOverride, isBackground, gs }: { modeOverride?: ChatMode; isBackground: boolean; gs: Pick<GlobalSettings, 'chatMode' | 'customModes' | 'activeCustomModeId'> }): RunMode {
	if (modeOverride) return builtInRunMode(modeOverride)
	if (isBackground) return builtInRunMode('agent')
	return resolveRunMode(gs)
}

/** Background agents run as Agent: starting one is refused while Plan or a custom mode is chosen, so the choice isn't silently dropped. */
export function backgroundAllowed(gs: Pick<GlobalSettings, 'chatMode' | 'customModes' | 'activeCustomModeId'>): boolean {
	const r = resolveRunMode(gs)
	return !r.customModeId && r.chatMode !== 'plan'
}

/** Choosing a built-in mode (the mode menu, `/plan`, approving a plan) also leaves any custom mode, so the pick takes effect. */
export function selectBuiltInMode(settings: { setGlobalSetting(name: 'chatMode', v: ChatMode): unknown; setGlobalSetting(name: 'activeCustomModeId', v: string | null): unknown }, mode: ChatMode): Promise<void> {
	return Promise.all([settings.setGlobalSetting('activeCustomModeId', null), settings.setGlobalSetting('chatMode', mode)]).then(() => undefined)
}

export function validateCustomMode(m: CustomMode, others: CustomMode[]): string | null {
	const name = m.name.trim()
	if (!name) return 'Give the mode a name.'
	if (name.length > MAX_CUSTOM_MODE_NAME) return 'Names can be up to 24 characters.'
	const lower = name.toLowerCase()
	if (builtInLabels.some(l => l.toLowerCase() === lower) || others.some(o => o?.id !== m.id && (typeof o?.name === 'string' ? o.name : '').trim().toLowerCase() === lower)) return 'Another mode already has this name.'
	if (m.instructions.length > MAX_CUSTOM_MODE_INSTRUCTIONS) return 'Instructions can be up to 4,000 characters.'
	return null
}

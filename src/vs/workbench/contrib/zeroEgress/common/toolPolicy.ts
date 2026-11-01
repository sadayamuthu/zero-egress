/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { approvalTypeOfBuiltinToolName, BuiltinToolName } from './toolsServiceTypes.js';
import { ChatMode } from './zeroEgressSettingsTypes.js';

/** Which groups of tools a run may use. Read tools are always allowed when a policy exists; `null` means no tools at all. */
export type ToolPolicy = { edit: boolean; terminal: boolean; mcp: boolean; plan: boolean }

export type ToolGroup = 'read' | 'edit' | 'terminal' | 'mcp' | 'plan'

export function toolPolicyOfMode(mode: ChatMode): ToolPolicy | null {
	switch (mode) {
		case 'agent': return { edit: true, terminal: true, mcp: true, plan: true }
		case 'gather': return { edit: false, terminal: false, mcp: false, plan: false }
		default: return null
	}
}

export function toolGroupOf(toolName: string, isMCP: boolean): ToolGroup {
	if (isMCP) return 'mcp'
	if (toolName === 'update_plan') return 'plan'
	const approvalType = approvalTypeOfBuiltinToolName[toolName as BuiltinToolName]
	if (approvalType === 'edits') return 'edit'
	if (approvalType === 'terminal') return 'terminal'
	return 'read'
}

export function policyAllows(p: ToolPolicy | null, group: ToolGroup): boolean {
	if (!p) return false
	return group === 'read' ? true : p[group]
}

export const TOOL_REFUSAL_MESSAGE = "This tool isn't available in this mode."

/** the refusal copy when the policy does not allow this tool, else null */
export function refusalOf(policy: ToolPolicy | null, toolName: string, isMCP: boolean): string | null {
	return policyAllows(policy, toolGroupOf(toolName, isMCP)) ? null : TOOL_REFUSAL_MESSAGE
}

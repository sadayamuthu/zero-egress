/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { approvalTypeOfBuiltinToolName, BuiltinToolName } from './toolsServiceTypes.js';
import type { ToolPolicy } from './customModes.js';

export { toolPolicyOfMode } from './customModes.js'
export type { ToolPolicy } from './customModes.js'

export type ToolGroup = 'read' | 'edit' | 'terminal' | 'mcp' | 'plan'

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

/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The vs/ helpers the chat/ components (the input box and its menus, the approval card) use. This file sits
// directly in sidebar-tsx/ (not chat/) on purpose: the bundle flattens chat/ into this folder, so these relative paths
// only resolve from here.

export { ZERO_EGRESS_CTRL_L_ACTION_ID, ZERO_EGRESS_SHOW_AGENTS_ACTION_ID } from '../../../actionIDs.js';
export { displayInfoOfProviderName, isFeatureNameDisabled, modelSelectionsEqual } from '../../../../common/zeroEgressSettingsTypes.js';
export type { ChatMode, FeatureName, ModelSelection, ProviderName } from '../../../../common/zeroEgressSettingsTypes.js';
export { modelFilterOfFeatureName } from '../../../../common/zeroEgressSettingsService.js';
export type { ModelOption } from '../../../../common/zeroEgressSettingsService.js';
export { getIsReasoningEnabledState, getModelCapabilities } from '../../../../common/modelCapabilities.js';
export { optionsForThinkingLevel, thinkingButtonLabel, thinkingLabel, thinkingLevelOf, thinkingLevelsOf } from '../../../../common/thinkingLevel.js';
export { contextPercent, contextUseOf, contextWindowK, formatContextUse } from '../../../../common/contextUse.js';
export type { ContextUse } from '../../../../common/contextUse.js';
export { promptWithContext } from '../../../../common/promptContext.js';
export type { PromptContextItem } from '../../../../common/promptContext.js';
export { canAllowList, normalizeCommand, terminalAutoRunOf, settingsForTerminalAutoRun } from '../../../../common/commandAllowList.js';
export type { TerminalAutoRun } from '../../../../common/commandAllowList.js';
// the id of zeroEgressSettingsPane's open-settings action (that module registers actions, so only the id is copied)
export const ZERO_EGRESS_OPEN_SETTINGS_ACTION_ID = 'workbench.action.openZeroEgressSettings';
export { planProgress } from '../../../../common/plan.js';
export type { PlanStep } from '../../../../common/plan.js';
export { promptContextOfSelection, textOfSnapshotSelection } from '../../../../common/selectionText.js';
export { builtinCommands, expandBuiltin, parseSlash, slashMenuQuery } from '../../../../common/slashCommands.js';
export type { SlashExpansion } from '../../../../common/slashCommands.js';

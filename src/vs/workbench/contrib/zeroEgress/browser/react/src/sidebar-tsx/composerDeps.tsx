/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The vs/ helpers the input box and its menus (chat/Composer, chat/ModeMenu, chat/ModelMenu) use. This file sits
// directly in sidebar-tsx/ (not chat/) on purpose: the bundle flattens chat/ into this folder, so these relative paths
// only resolve from here.

export { ZERO_EGRESS_CTRL_L_ACTION_ID, ZERO_EGRESS_SHOW_AGENTS_ACTION_ID } from '../../../actionIDs.js';
export { displayInfoOfProviderName, isFeatureNameDisabled, modelSelectionsEqual } from '../../../../common/zeroEgressSettingsTypes.js';
export type { ChatMode, FeatureName, ModelSelection, ProviderName } from '../../../../common/zeroEgressSettingsTypes.js';
export { modelFilterOfFeatureName } from '../../../../common/zeroEgressSettingsService.js';
export type { ModelOption } from '../../../../common/zeroEgressSettingsService.js';
export { getIsReasoningEnabledState, getModelCapabilities } from '../../../../common/modelCapabilities.js';
export { promptWithContext } from '../../../../common/promptContext.js';
export type { PromptContextItem } from '../../../../common/promptContext.js';

/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The one chat-title rule, for components in chat/. This file sits directly in sidebar-tsx/ (not chat/) on purpose:
// the bundle flattens chat/ into this folder, so the relative path to common/ only resolves from here.

export { threadTitleOf } from '../../../../common/chatTabs.js';

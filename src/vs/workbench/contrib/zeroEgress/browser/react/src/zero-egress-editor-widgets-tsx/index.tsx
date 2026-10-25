/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { mountFnGenerator } from '../util/mountFnGenerator.js'
import { ZeroEgressCommandBarMain } from './ZeroEgressCommandBar.js'
import { ZeroEgressSelectionHelperMain } from './ZeroEgressSelectionHelper.js'

export const mountZeroEgressCommandBar = mountFnGenerator(ZeroEgressCommandBarMain)

export const mountZeroEgressSelectionHelper = mountFnGenerator(ZeroEgressSelectionHelperMain)


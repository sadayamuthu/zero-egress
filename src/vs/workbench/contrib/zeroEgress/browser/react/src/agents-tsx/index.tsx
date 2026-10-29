/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { mountFnGenerator } from '../util/mountFnGenerator.js'
import { AgentsView } from './AgentsView.js'

/** `mountAgentsView(root, accessor, { bridge })`; returns `{ dispose() }` (and `rerender`) */
export const mountAgentsView = mountFnGenerator(AgentsView)

/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IMetricsService } from '../common/metricsService.js';


// Zero-egress: analytics are removed. Every method is a no-op; nothing is collected or sent.
export class MetricsMainService extends Disposable implements IMetricsService {
	_serviceBrand: undefined;

	capture: IMetricsService['capture'] = () => { }

	setOptOut: IMetricsService['setOptOut'] = () => { }

	async getDebuggingProperties() {
		return {}
	}
}

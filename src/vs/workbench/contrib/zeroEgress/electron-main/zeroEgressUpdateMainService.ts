/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IZeroEgressUpdateService } from '../common/zeroEgressUpdateService.js';
import { ZeroEgressCheckUpdateRespose } from '../common/zeroEgressUpdateServiceTypes.js';


// Zero-egress: this service never touches the network. Updates are manual.
export class ZeroEgressMainUpdateService extends Disposable implements IZeroEgressUpdateService {
	_serviceBrand: undefined;

	constructor(
		@IProductService private readonly _productService: IProductService,
	) {
		super()
	}

	async check(explicit: boolean): Promise<ZeroEgressCheckUpdateRespose> {
		if (!explicit) {
			return { message: null } as const
		}
		return {
			message: `ZeroEgress ${this._productService.zeroEgressVersion}. Updates are manual: download new versions from github.com/sadayamuthu/zero-egress/releases.`,
		} as const
	}
}

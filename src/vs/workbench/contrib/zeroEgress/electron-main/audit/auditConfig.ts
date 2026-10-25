/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { IAuditConfig } from '../../common/auditTypes.js';

export const AUDIT_DEFAULTS: IAuditConfig = {
	enabled: false,
	endpointUrl: '',
	authHeader: '',
	batchSize: 50,
	flushIntervalMs: 15000,
	maxLocalRetentionDays: 90,
};

function mergeTyped(base: IAuditConfig, src: Partial<IAuditConfig> | undefined): IAuditConfig {
	if (!src) return base;
	const out: IAuditConfig = { ...base };
	for (const key of Object.keys(AUDIT_DEFAULTS) as (keyof IAuditConfig)[]) {
		const v = src[key];
		if (typeof v === typeof AUDIT_DEFAULTS[key]) {
			(out as unknown as Record<string, unknown>)[key] = v;
		}
	}
	return out;
}

export function resolveAuditConfig(sources: { product?: Partial<IAuditConfig>; policy?: Partial<IAuditConfig> }): IAuditConfig {
	return mergeTyped(mergeTyped(AUDIT_DEFAULTS, sources.product), sources.policy);
}

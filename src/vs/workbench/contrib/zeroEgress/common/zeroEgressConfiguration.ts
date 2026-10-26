/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

export const AUDIT_ENABLED_SETTING = 'zeroEgress.audit.enabled';
export const AUDIT_COLLECTOR_URL_SETTING = 'zeroEgress.audit.collectorUrl';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'zeroEgress.audit',
	title: localize('zeroEgress.audit.title', "ZeroEgress Audit"),
	type: 'object',
	properties: {
		[AUDIT_ENABLED_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			restricted: true,
			description: localize('zeroEgress.audit.enabled', "Keep a local, tamper-evident record of every chat exchange. Restart to apply."),
		},
		[AUDIT_COLLECTOR_URL_SETTING]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			restricted: true,
			description: localize('zeroEgress.audit.collectorUrl', "Optional: also send records to this server on your network. Restart to apply."),
		},
	},
});

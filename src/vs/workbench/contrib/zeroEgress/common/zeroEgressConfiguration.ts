/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

export const AUDIT_ENABLED_SETTING = 'zeroEgress.audit.enabled';
export const AUDIT_COLLECTOR_URL_SETTING = 'zeroEgress.audit.collectorUrl';
export const AGENTS_MAX_CONCURRENT_SETTING = 'zeroEgress.agents.maxConcurrent';
export const AGENTS_SETUP_COMMAND_SETTING = 'zeroEgress.agents.setupCommand';
export const AGENTS_MAX_CONCURRENT_DEFAULT = 4;

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

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'zeroEgress.agents',
	title: localize('zeroEgress.agents.title', "ZeroEgress Agents"),
	type: 'object',
	properties: {
		[AGENTS_MAX_CONCURRENT_SETTING]: {
			type: 'integer',
			default: AGENTS_MAX_CONCURRENT_DEFAULT,
			minimum: 1,
			maximum: 16,
			scope: ConfigurationScope.RESOURCE,
			description: localize('zeroEgress.agents.maxConcurrent', "How many background agents may run at once. Others wait their turn."),
		},
		[AGENTS_SETUP_COMMAND_SETTING]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.RESOURCE,
			description: localize('zeroEgress.agents.setupCommand', "Shell command run in a background agent's new worktree before it starts, e.g. to install dependencies."),
		},
	},
});

/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';

export const ZERO_EGRESS_CLONE_REPO_ACTION_ID = 'zeroEgress.cloneRepo';

/** shown in the clone input: git runs outside the network guard */
export const CLONE_NOTE = `Cloning runs git on your machine and connects to the URL you enter. Like git in the terminal, it is outside ZeroEgress's network guard.`;
export const GIT_UNAVAILABLE = 'Git is not available.';

registerAction2(class extends Action2 {
	constructor() {
		super({ id: ZERO_EGRESS_CLONE_REPO_ACTION_ID, title: localize2('zeroEgressCloneRepo', 'ZeroEgress: Clone Repository'), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const commandService = accessor.get(ICommandService);
		const notificationService = accessor.get(INotificationService);

		const value = await quickInputService.input({ prompt: CLONE_NOTE, placeHolder: 'Repository URL' });
		const url = value?.trim();
		if (!url) { return; }

		try {
			await commandService.executeCommand('git.clone', url);
		} catch (e) {
			// executeCommand activates the git extension first; the command is still missing only when there is no git extension
			if (!CommandsRegistry.getCommand('git.clone')) {
				notificationService.error(GIT_UNAVAILABLE);
			} else {
				notificationService.error(e instanceof Error ? e.message : String(e));
			}
		}
	}
});

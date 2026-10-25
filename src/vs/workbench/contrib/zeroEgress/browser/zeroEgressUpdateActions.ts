/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import Severity from '../../../../base/common/severity.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { INotificationActions, INotificationHandle, INotificationService } from '../../../../platform/notification/common/notification.js';
import { IMetricsService } from '../common/metricsService.js';
import { IZeroEgressUpdateService } from '../common/zeroEgressUpdateService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IUpdateService } from '../../../../platform/update/common/update.js';
import { ZeroEgressCheckUpdateRespose } from '../common/zeroEgressUpdateServiceTypes.js';
import { IAction } from '../../../../base/common/actions.js';




const notifyUpdate = (res: ZeroEgressCheckUpdateRespose & { message: string }, notifService: INotificationService, updateService: IUpdateService): INotificationHandle => {
	const message = res?.message || 'Updates are manual: download new versions from github.com/sadayamuthu/zero-egress/releases.'

	let actions: INotificationActions | undefined

	if (res?.action) {
		const primary: IAction[] = []

		if (res.action === 'download') {
			primary.push({
				label: `Download`,
				id: 'zeroEgress.updater.download',
				enabled: true,
				tooltip: '',
				class: undefined,
				run: () => {
					updateService.downloadUpdate()
				}
			})
		}


		if (res.action === 'apply') {
			primary.push({
				label: `Apply`,
				id: 'zeroEgress.updater.apply',
				enabled: true,
				tooltip: '',
				class: undefined,
				run: () => {
					updateService.applyUpdate()
				}
			})
		}

		if (res.action === 'restart') {
			primary.push({
				label: `Restart`,
				id: 'zeroEgress.updater.restart',
				enabled: true,
				tooltip: '',
				class: undefined,
				run: () => {
					updateService.quitAndInstall()
				}
			})
		}

		actions = {
			primary: primary,
			secondary: [{
				id: 'zeroEgress.updater.close',
				enabled: true,
				label: `Keep current version`,
				tooltip: '',
				class: undefined,
				run: () => {
					notifController.close()
				}
			}]
		}
	}
	else {
		actions = undefined
	}

	const notifController = notifService.notify({
		severity: Severity.Info,
		message: message,
		sticky: true,
		progress: actions ? { worked: 0, total: 100 } : undefined,
		actions: actions,
	})

	return notifController
	// const d = notifController.onDidClose(() => {
	// 	notifyYesUpdate(notifService, res)
	// 	d.dispose()
	// })
}
const notifyErrChecking = (notifService: INotificationService): INotificationHandle => {
	const message = `ZeroEgress Error: There was an error checking the installed version. If this persists, please [report it](https://github.com/sadayamuthu/zero-egress/issues).`
	const notifController = notifService.notify({
		severity: Severity.Info,
		message: message,
		sticky: true,
	})
	return notifController
}


const performZeroEgressCheck = async (
	explicit: boolean,
	notifService: INotificationService,
	zeroEgressUpdateService: IZeroEgressUpdateService,
	metricsService: IMetricsService,
	updateService: IUpdateService,
): Promise<INotificationHandle | null> => {

	const metricsTag = explicit ? 'Manual' : 'Auto'

	metricsService.capture(`ZeroEgress Update ${metricsTag}: Checking...`, {})
	const res = await zeroEgressUpdateService.check(explicit)
	if (!res) {
		const notifController = notifyErrChecking(notifService);
		metricsService.capture(`ZeroEgress Update ${metricsTag}: Error`, { res })
		return notifController
	}
	else {
		if (res.message) {
			const notifController = notifyUpdate(res, notifService, updateService)
			metricsService.capture(`ZeroEgress Update ${metricsTag}: Yes`, { res })
			return notifController
		}
		else {
			metricsService.capture(`ZeroEgress Update ${metricsTag}: No`, { res })
			return null
		}
	}
}


// Action
let lastNotifController: INotificationHandle | null = null


registerAction2(class extends Action2 {
	constructor() {
		super({
			f1: true,
			id: 'zeroEgress.zeroEgressCheckUpdate',
			title: localize2('zeroEgressCheckUpdate', 'ZeroEgress: Check for Updates'),
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const zeroEgressUpdateService = accessor.get(IZeroEgressUpdateService)
		const notifService = accessor.get(INotificationService)
		const metricsService = accessor.get(IMetricsService)
		const updateService = accessor.get(IUpdateService)

		const currNotifController = lastNotifController

		const newController = await performZeroEgressCheck(true, notifService, zeroEgressUpdateService, metricsService, updateService)

		if (newController) {
			currNotifController?.close()
			lastNotifController = newController
		}
	}
})

// on mount
class ZeroEgressUpdateWorkbenchContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.zeroEgress.zeroEgressUpdate'
	// zero-egress: no automatic update checks (no startup check, no interval); updates are manual
}
registerWorkbenchContribution2(ZeroEgressUpdateWorkbenchContribution.ID, ZeroEgressUpdateWorkbenchContribution, WorkbenchPhase.BlockRestore);

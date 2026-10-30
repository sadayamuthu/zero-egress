/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Appearance: color theme, icon theme and editor font size.

import React, { useCallback, useEffect, useState } from 'react'
import ErrorBoundary from '../../sidebar-tsx/ErrorBoundary.js'
import { ZeroEgressButtonBgDarken, ZeroEgressSimpleInputBox } from '../../util/inputs.js'
import { useAccessor, useConfigurationValue } from '../../util/services.js'

const FONT_SIZE_SETTING = 'editor.fontSize'

export const AppearanceSection = () => {
	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const themeService = accessor.get('IThemeService')
	const configurationService = accessor.get('IConfigurationService')

	const [themeName, setThemeName] = useState(() => themeService.getColorTheme().label)
	useEffect(() => {
		setThemeName(themeService.getColorTheme().label)
		const d = themeService.onDidColorThemeChange(theme => setThemeName(theme.label))
		return () => { d.dispose() }
	}, [themeService])

	const fontSize = useConfigurationValue<number>(FONT_SIZE_SETTING)
	const onChangeFontSize = useCallback((newVal: string) => {
		const trimmed = newVal.trim()
		if (!/^\d+$/.test(trimmed)) return // wait for a whole number
		const n = parseInt(trimmed, 10)
		if (n < 6 || n > 100) return // the editor's own bounds
		configurationService.updateValue(FONT_SIZE_SETTING, n)
	}, [configurationService])

	return <ErrorBoundary>
		<div className='flex flex-col gap-6'>
			<div>
				<h3 className='text-xl mb-1'>Color theme</h3>
				<div className='text-sm text-ze-fg-3 mb-2'>{themeName}</div>
				<ZeroEgressButtonBgDarken className='px-4 py-1 w-fit' onClick={() => { commandService.executeCommand('workbench.action.selectTheme') }}>
					Change theme
				</ZeroEgressButtonBgDarken>
			</div>
			<div>
				<h3 className='text-xl mb-2'>Icon theme</h3>
				<ZeroEgressButtonBgDarken className='px-4 py-1 w-fit' onClick={() => { commandService.executeCommand('workbench.action.selectIconTheme') }}>
					Change icon theme
				</ZeroEgressButtonBgDarken>
			</div>
			<div className='flex items-center gap-2'>
				<span className='text-sm whitespace-nowrap'>Editor font size</span>
				<ZeroEgressSimpleInputBox
					value={fontSize === undefined ? '' : String(fontSize)}
					onChangeValue={onChangeFontSize}
					placeholder='14'
					compact={true}
					className='max-w-16'
					inputMode='numeric'
					aria-label='Editor font size'
				/>
			</div>
		</div>
	</ErrorBoundary>
}

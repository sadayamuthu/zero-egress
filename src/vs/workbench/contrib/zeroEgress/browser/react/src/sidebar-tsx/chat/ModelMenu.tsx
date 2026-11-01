/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The input box's model button and menu: the models the settings offer for a feature (the same list and filter as
// ModelDropdown), grouped by provider, with the thinking control for the selected model below them. All app-wide.

import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useAccessor, useSettingsState } from '../../util/services.js';
import { ModelDropdown } from '../../zero-egress-settings-tsx/ModelDropdown.js';
// no runtime imports from vs/ here: the bundle flattens this folder, so a relative path one level deeper breaks
import { displayInfoOfProviderName, getModelCapabilities, isFeatureNameDisabled, modelFilterOfFeatureName, modelSelectionsEqual, optionsForThinkingLevel, thinkingLabel, thinkingLevelOf, thinkingLevelsOf } from '../composerDeps.js';
import type { FeatureName, ModelOption, ProviderName } from '../composerDeps.js';
import { MenuButton } from './ModeMenu.js';
import { MenuHeading, MenuRow, Popover } from './Popover.js';
import { Segmented } from './Segmented.js';


// The Thinking row for the selected model: Off / On for an on-off model, Low / Med / High for an effort model, a note for
// a model that always thinks, nothing for a model that can't. Writes the options the request body is built from.
const useThinking = (featureName: FeatureName) => {
	const settingsState = useSettingsState()
	const modelSelection = settingsState.modelSelectionOfFeature[featureName]
	if (!modelSelection) return null
	const { providerName, modelName } = modelSelection
	const caps = getModelCapabilities(providerName, modelName, settingsState.overridesOfModel)
	const levels = thinkingLevelsOf(caps)
	if (levels.length === 0) return null
	const options = settingsState.optionsOfModelSelection[featureName][providerName]?.[modelName]
	const level = thinkingLevelOf(caps, options)
	if (!level) return null
	return { modelSelection, caps, levels, level }
}

const ThinkingRow = ({ featureName }: { featureName: FeatureName }) => {
	const settingsService = useAccessor().get('IZeroEgressSettingsService')
	const thinking = useThinking(featureName)
	if (!thinking) return null
	const { modelSelection, caps, levels, level } = thinking
	const hasEffortLevels = levels.includes('low')

	return <div className='flex items-center justify-between gap-2'>
		<span className='text-ze-fg-3 text-xs select-none'>Thinking</span>
		{levels.length === 1 && !hasEffortLevels
			? <span className='text-ze-fg-3 text-xs select-none'>Always thinks</span>
			: <Segmented
				label='Thinking'
				value={level}
				options={levels.map(l => ({ value: l, label: !hasEffortLevels && l === 'high' ? 'On' : thinkingLabel[l] }))}
				onChange={l => settingsService.setOptionsOfModelSelection(featureName, modelSelection.providerName, modelSelection.modelName, optionsForThinkingLevel(caps, l))}
			/>}
	</div>
}


const providerTitle = (providerName: ProviderName) => {
	try {
		return displayInfoOfProviderName(providerName).title;
	} catch {
		return providerName;
	}
};

export const ModelMenu = ({ featureName }: { featureName: FeatureName }) => {
	const accessor = useAccessor();
	const settingsService = accessor.get('IZeroEgressSettingsService');
	const settingsState = useSettingsState();
	const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
	const [open, setOpen] = useState(false);
	const thinking = useThinking(featureName);

	const { filter, emptyMessage } = modelFilterOfFeatureName[featureName];
	const chatMode = settingsState.globalSettings.chatMode;
	const options: ModelOption[] = useMemo(
		() => settingsState._modelOptions.filter(o => filter(o.selection, { chatMode, overridesOfModel: settingsState.overridesOfModel })),
		[settingsState._modelOptions, settingsState.overridesOfModel, filter, chatMode],
	);
	const selection = settingsState.modelSelectionOfFeature[featureName];
	const selected = selection ? options.find(o => modelSelectionsEqual(o.selection, selection)) : undefined;

	// as ModelDropdown does: with no (or an unlisted) selection, the first listed model becomes the selection
	const isDisabled = isFeatureNameDisabled(featureName, settingsState);
	useEffect(() => {
		if (isDisabled || selected || options.length === 0) {
			return;
		}
		settingsService.setModelSelectionOfFeature(featureName, options[0].selection);
	}, [isDisabled, selected, options, featureName, settingsService]);

	const groups = useMemo(() => {
		const byProvider = new Map<ProviderName, ModelOption[]>();
		for (const o of options) {
			const list = byProvider.get(o.selection.providerName) ?? [];
			list.push(o);
			byProvider.set(o.selection.providerName, list);
		}
		return [...byProvider.entries()];
	}, [options]);

	// no usable model: the same warning (and link to settings) ModelDropdown shows
	if (isDisabled) {
		return <ModelDropdown featureName={featureName} className='text-xs text-ze-fg-3 bg-ze-bg-1 rounded' />;
	}
	if (options.length === 0) {
		return <span className='text-xs text-ze-warning select-none'>{emptyMessage?.message || 'No models available'}</span>;
	}

	const close = () => { setOpen(false); anchor?.focus({ preventScroll: true }); };
	const label = (selected ?? options[0]).selection.modelName;
	const level = thinking ? thinkingLabel[thinking.level] : null;

	return <>
		<MenuButton buttonRef={setAnchor} open={open} label={`Model: ${label}${level ? ` · ${level}` : ''}`} onToggle={() => setOpen(o => !o)} shrinks>
			<span className='min-w-0 truncate max-w-40'>{label}{level ? ` · ${level}` : ''}</span>
			<ChevronDown size={12} className='shrink-0 opacity-70' />
		</MenuButton>
		<Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement='top-start' className='w-64' label='Model'>
			<MenuHeading>Model</MenuHeading>
			{groups.map(([providerName, list]) => <div key={providerName} className='flex flex-col'>
				{groups.length > 1 ? <div className='px-2 pt-1 text-xs text-ze-fg-3 select-none'>{providerTitle(providerName)}</div> : null}
				{list.map(o => <MenuRow
					key={o.selection.providerName + '/' + o.selection.modelName}
					checked={!!selected && modelSelectionsEqual(o.selection, selected.selection)}
					onSelect={() => { settingsService.setModelSelectionOfFeature(featureName, o.selection); close(); }}
				>
					<span className='truncate font-medium'>{o.selection.modelName}</span>
					{groups.length > 1 ? null : <span className='ml-auto shrink-0 text-xs text-ze-fg-3'>{providerTitle(providerName)}</span>}
				</MenuRow>)}
			</div>)}
			<div className='mt-1 px-2 pt-1.5 pb-1 border-t border-ze-border-3 empty:hidden'><ThinkingRow featureName={featureName} /></div>
		</Popover>
	</>;
};

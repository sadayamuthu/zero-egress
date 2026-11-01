/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The input box's model button and menu: the models the settings offer for a feature (the same list and filter as
// ModelDropdown), grouped by provider, with the thinking control for the selected model below them. All app-wide.

import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useAccessor, useSettingsState } from '../../util/services.js';
import { ZeroEgressSlider, ZeroEgressSwitch } from '../../util/inputs.js';
import { ModelDropdown } from '../../zero-egress-settings-tsx/ModelDropdown.js';
// no runtime imports from vs/ here: the bundle flattens this folder, so a relative path one level deeper breaks
import { displayInfoOfProviderName, getIsReasoningEnabledState, getModelCapabilities, isFeatureNameDisabled, modelFilterOfFeatureName, modelSelectionsEqual } from '../composerDeps.js';
import type { FeatureName, ModelOption, ProviderName } from '../composerDeps.js';
import { MenuButton } from './ModeMenu.js';
import { MenuHeading, MenuRow, Popover } from './Popover.js';


// SLIDER ONLY (moved here unchanged from SidebarChat.tsx):
const ReasoningOptionSlider = ({ featureName }: { featureName: FeatureName }) => {
	const accessor = useAccessor()

	const zeroEgressSettingsService = accessor.get('IZeroEgressSettingsService')
	const zeroEgressSettingsState = useSettingsState()

	const modelSelection = zeroEgressSettingsState.modelSelectionOfFeature[featureName]
	const overridesOfModel = zeroEgressSettingsState.overridesOfModel

	if (!modelSelection) return null

	const { modelName, providerName } = modelSelection
	const { reasoningCapabilities } = getModelCapabilities(providerName, modelName, overridesOfModel)
	const { canTurnOffReasoning, reasoningSlider: reasoningBudgetSlider } = reasoningCapabilities || {}

	const modelSelectionOptions = zeroEgressSettingsState.optionsOfModelSelection[featureName][providerName]?.[modelName]
	const isReasoningEnabled = getIsReasoningEnabledState(featureName, providerName, modelName, modelSelectionOptions, overridesOfModel)

	if (canTurnOffReasoning && !reasoningBudgetSlider) { // if it's just a on/off toggle without a power slider
		return <div className='flex items-center gap-x-2'>
			<span className='text-ze-fg-3 text-xs pointer-events-none inline-block w-10 pr-1'>Thinking</span>
			<ZeroEgressSwitch
				size='xxs'
				value={isReasoningEnabled}
				onChange={(newVal) => {
					const isOff = canTurnOffReasoning && !newVal
					zeroEgressSettingsService.setOptionsOfModelSelection(featureName, modelSelection.providerName, modelSelection.modelName, { reasoningEnabled: !isOff })
				}}
			/>
		</div>
	}

	if (reasoningBudgetSlider?.type === 'budget_slider') { // if it's a slider
		const { min: min_, max, default: defaultVal } = reasoningBudgetSlider

		const nSteps = 8 // only used in calculating stepSize, stepSize is what actually matters
		const stepSize = Math.round((max - min_) / nSteps)

		const valueIfOff = min_ - stepSize
		const min = canTurnOffReasoning ? valueIfOff : min_
		const value = isReasoningEnabled ? zeroEgressSettingsState.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName]?.reasoningBudget ?? defaultVal
			: valueIfOff

		return <div className='flex items-center gap-x-2'>
			<span className='text-ze-fg-3 text-xs pointer-events-none inline-block w-10 pr-1'>Thinking</span>
			<ZeroEgressSlider
				width={50}
				size='xs'
				min={min}
				max={max}
				step={stepSize}
				value={value}
				onChange={(newVal) => {
					const isOff = canTurnOffReasoning && newVal === valueIfOff
					zeroEgressSettingsService.setOptionsOfModelSelection(featureName, modelSelection.providerName, modelSelection.modelName, { reasoningEnabled: !isOff, reasoningBudget: newVal })
				}}
			/>
			<span className='text-ze-fg-3 text-xs pointer-events-none'>{isReasoningEnabled ? `${value} tokens` : 'Thinking disabled'}</span>
		</div>
	}

	if (reasoningBudgetSlider?.type === 'effort_slider') {

		const { values, default: defaultVal } = reasoningBudgetSlider

		const min = canTurnOffReasoning ? -1 : 0
		const max = values.length - 1

		const currentEffort = zeroEgressSettingsState.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName]?.reasoningEffort ?? defaultVal
		const valueIfOff = -1
		const value = isReasoningEnabled && currentEffort ? values.indexOf(currentEffort) : valueIfOff

		const currentEffortCapitalized = currentEffort.charAt(0).toUpperCase() + currentEffort.slice(1, Infinity)

		return <div className='flex items-center gap-x-2'>
			<span className='text-ze-fg-3 text-xs pointer-events-none inline-block w-10 pr-1'>Thinking</span>
			<ZeroEgressSlider
				width={30}
				size='xs'
				min={min}
				max={max}
				step={1}
				value={value}
				onChange={(newVal) => {
					const isOff = canTurnOffReasoning && newVal === valueIfOff
					zeroEgressSettingsService.setOptionsOfModelSelection(featureName, modelSelection.providerName, modelSelection.modelName, { reasoningEnabled: !isOff, reasoningEffort: values[newVal] ?? undefined })
				}}
			/>
			<span className='text-ze-fg-3 text-xs pointer-events-none'>{isReasoningEnabled ? `${currentEffortCapitalized}` : 'Thinking disabled'}</span>
		</div>
	}

	return null
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

	return <>
		<MenuButton buttonRef={setAnchor} open={open} label={`Model: ${label}`} onToggle={() => setOpen(o => !o)} shrinks>
			<span className='min-w-0 truncate max-w-40'>{label}</span>
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
			<div className='mt-1 px-2 pt-1.5 pb-1 border-t border-ze-border-3 empty:hidden'><ReasoningOptionSlider featureName={featureName} /></div>
		</Popover>
	</>;
};

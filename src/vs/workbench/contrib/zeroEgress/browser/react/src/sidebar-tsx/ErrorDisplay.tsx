/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useEffect, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronUp, X } from 'lucide-react';
import { useSettingsState } from '../util/services.js';
import { errorDetails } from '../../../../common/sendLLMMessageTypes.js';


export const ErrorDisplay = ({
	message: message_,
	fullError,
	onDismiss,
	showDismiss,
}: {
	message: string,
	fullError: Error | null,
	onDismiss: (() => void) | null,
	showDismiss?: boolean,
}) => {
	const [isExpanded, setIsExpanded] = useState(false);

	const details = errorDetails(fullError)
	const isExpandable = !!details

	const message = message_ + ''

	return (
		// theme colors only: the error foreground, mixed into the panel background (no fixed reds, which glare in dark themes)
		<div className='rounded-[10px] border border-[color-mix(in_srgb,var(--vscode-errorForeground)_45%,transparent)] bg-[color-mix(in_srgb,var(--vscode-errorForeground)_10%,var(--ze-bg-2))] text-ze-fg-1 p-3 overflow-auto'>
			{/* Header */}
			<div className='flex items-start justify-between'>
				<div className='flex gap-3'>
					<AlertCircle className='h-5 w-5 text-[var(--vscode-errorForeground)] mt-0.5 shrink-0' />
					<div className='flex-1'>
						<h3 className='font-semibold text-[var(--vscode-errorForeground)]'>
							{/* eg Error */}
							Error
						</h3>
						<p className='text-ze-fg-1 mt-1'>
							{/* eg Something went wrong */}
							{message}
						</p>
					</div>
				</div>

				<div className='flex gap-2'>
					{isExpandable && (
						<button className='text-ze-fg-3 hover:text-ze-fg-1 hover:bg-ze-bg-2-hover p-1 rounded'
							onClick={() => setIsExpanded(!isExpanded)}
						>
							{isExpanded ? (
								<ChevronUp className='h-5 w-5' />
							) : (
								<ChevronDown className='h-5 w-5' />
							)}
						</button>
					)}
					{showDismiss && onDismiss && (
						<button className='text-ze-fg-3 hover:text-ze-fg-1 hover:bg-ze-bg-2-hover p-1 rounded'
							onClick={onDismiss}
						>
							<X className='h-5 w-5' />
						</button>
					)}
				</div>
			</div>

			{/* Expandable Details */}
			{isExpanded && details && (
				<div className='mt-4 space-y-3 border-t border-[color-mix(in_srgb,var(--vscode-errorForeground)_30%,transparent)] pt-3 overflow-auto'>
					<div>
						<span className='font-semibold text-[var(--vscode-errorForeground)]'>Full Error: </span>
						<pre className='text-ze-fg-2 whitespace-pre-wrap'>{details}</pre>
					</div>
				</div>
			)}
		</div>
	);
};

// Normally you'd want to put these exports in the files that register them, but if you do that you'll get an import order error if you import them in certain cases.
// (importing them runs the whole file to get the ID, causing an import error). I guess it's best practice to separate out IDs, pretty annoying...

export const ZERO_EGRESS_CTRL_L_ACTION_ID = 'zeroEgress.ctrlLAction'

export const ZERO_EGRESS_CTRL_K_ACTION_ID = 'zeroEgress.ctrlKAction'

export const ZERO_EGRESS_ACCEPT_DIFF_ACTION_ID = 'zeroEgress.acceptDiff'

export const ZERO_EGRESS_REJECT_DIFF_ACTION_ID = 'zeroEgress.rejectDiff'

export const ZERO_EGRESS_GOTO_NEXT_DIFF_ACTION_ID = 'zeroEgress.goToNextDiff'

export const ZERO_EGRESS_GOTO_PREV_DIFF_ACTION_ID = 'zeroEgress.goToPrevDiff'

export const ZERO_EGRESS_GOTO_NEXT_URI_ACTION_ID = 'zeroEgress.goToNextUri'

export const ZERO_EGRESS_GOTO_PREV_URI_ACTION_ID = 'zeroEgress.goToPrevUri'

export const ZERO_EGRESS_ACCEPT_FILE_ACTION_ID = 'zeroEgress.acceptFile'

export const ZERO_EGRESS_REJECT_FILE_ACTION_ID = 'zeroEgress.rejectFile'

export const ZERO_EGRESS_ACCEPT_ALL_DIFFS_ACTION_ID = 'zeroEgress.acceptAllDiffs'

export const ZERO_EGRESS_REJECT_ALL_DIFFS_ACTION_ID = 'zeroEgress.rejectAllDiffs'

// Agents view (agentsViewContribution.ts)

export const ZERO_EGRESS_SHOW_AGENTS_ACTION_ID = 'zeroEgress.showAgents'

export const ZERO_EGRESS_SHOW_EDITOR_ACTION_ID = 'zeroEgress.showEditor'

export const ZERO_EGRESS_AGENTS_ACCEPT_ALL_ACTION_ID = 'zeroEgress.agentsView.acceptAll'

/** context key `zeroEgress.agentsViewVisible` (the RawContextKey lives in agentsViewContribution.ts) */
export const ZERO_EGRESS_AGENTS_VIEW_VISIBLE_KEY = 'zeroEgress.agentsViewVisible'

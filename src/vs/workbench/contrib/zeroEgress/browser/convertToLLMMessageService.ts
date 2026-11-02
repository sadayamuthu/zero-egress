import { Disposable } from '../../../../base/common/lifecycle.js';
import { ToolPolicy } from '../common/toolPolicy.js';
import { CHARS_PER_TOKEN } from '../common/contextUse.js';
import { deepClone } from '../../../../base/common/objects.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ChatMessage } from '../common/chatThreadServiceTypes.js';
import { applyCompaction, Compaction } from '../common/compaction.js';
import { formatPlan, PlanStep } from '../common/plan.js';
import { getIsReasoningEnabledState, getReservedOutputTokenSpace, getModelCapabilities } from '../common/modelCapabilities.js';
import { reParsedToolXMLString, chat_systemMessage } from '../common/prompt/prompts.js';
import { AnthropicLLMChatMessage, AnthropicReasoning, GeminiLLMChatMessage, LLMChatMessage, LLMFIMMessage, OpenAILLMChatMessage, OpenAIUserPart, RawToolParamsObj } from '../common/sendLLMMessageTypes.js';
import { IZeroEgressSettingsService } from '../common/zeroEgressSettingsService.js';
import { ChatMode, FeatureName, ModelSelection, ProviderName } from '../common/zeroEgressSettingsTypes.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { ITerminalToolService } from './terminalToolService.js';
import { terminalIdsVisibleTo } from '../common/terminalOwnership.js';
import { IZeroEgressModelService } from '../common/zeroEgressModelService.js';
import { URI } from '../../../../base/common/uri.js';
import { EndOfLinePreference } from '../../../../editor/common/model.js';
import { ToolName } from '../common/toolsServiceTypes.js';
import { IMCPService } from '../common/mcpService.js';
import { encodeBase64 } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { checkProjectRulesFile, PROJECT_RULES_FILE } from './projectRules.js';
import { IMAGE_MAX_BYTES } from '../common/selectionText.js';
import { MAX_IMAGES_PER_MESSAGE, imageMessageIndex, mergeUserImages, noteForImage, prefixUserContent, toOpenAIUserContent } from '../common/imageContent.js';

export const EMPTY_MESSAGE = '(empty message)'



type SimpleLLMMessage = {
	role: 'tool';
	content: string;
	id: string;
	name: ToolName;
	rawParams: RawToolParamsObj;
} | {
	role: 'user';
	content: string;
	images?: { mime: string; base64: string; name: string }[]; // read at prepare time; turned into image_url parts (or notes) in prepareOpenAIOrAnthropicMessages
} | {
	role: 'assistant';
	content: string;
	anthropicReasoning: AnthropicReasoning[] | null;
}



const TRIM_TO_LEN = 120




// convert messages as if about to send to openai
/*
reference - https://platform.openai.com/docs/guides/function-calling#function-calling-steps
openai MESSAGE (role=assistant):
"tool_calls":[{
	"type": "function",
	"id": "call_12345xyz",
	"function": {
	"name": "get_weather",
	"arguments": "{\"latitude\":48.8566,\"longitude\":2.3522}"
}]

openai RESPONSE (role=user):
{   "role": "tool",
	"tool_call_id": tool_call.id,
	"content": str(result)    }

also see
openai on prompting - https://platform.openai.com/docs/guides/reasoning#advice-on-prompting
openai on developer system message - https://cdn.openai.com/spec/model-spec-2024-05-08.html#follow-the-chain-of-command
*/


const prepareMessages_openai_tools = (messages: SimpleLLMMessage[]): AnthropicOrOpenAILLMMessage[] => {

	const newMessages: OpenAILLMChatMessage[] = [];

	for (let i = 0; i < messages.length; i += 1) {
		const currMsg = messages[i]

		if (currMsg.role !== 'tool') {
			newMessages.push(currMsg)
			continue
		}

		// edit previous assistant message to have called the tool
		const prevMsg = 0 <= i - 1 && i - 1 <= newMessages.length ? newMessages[i - 1] : undefined
		if (prevMsg?.role === 'assistant') {
			prevMsg.tool_calls = [{
				type: 'function',
				id: currMsg.id,
				function: {
					name: currMsg.name,
					arguments: JSON.stringify(currMsg.rawParams)
				}
			}]
		}

		// add the tool
		newMessages.push({
			role: 'tool',
			tool_call_id: currMsg.id,
			content: currMsg.content,
		})
	}
	return newMessages

}



// convert messages as if about to send to anthropic
/*
https://docs.anthropic.com/en/docs/build-with-claude/tool-use#tool-use-examples
anthropic MESSAGE (role=assistant):
"content": [{
	"type": "text",
	"text": "<thinking>I need to call the get_weather function, and the user wants SF, which is likely San Francisco, CA.</thinking>"
}, {
	"type": "tool_use",
	"id": "toolu_01A09q90qw90lq917835lq9",
	"name": "get_weather",
	"input": { "location": "San Francisco, CA", "unit": "celsius" }
}]
anthropic RESPONSE (role=user):
"content": [{
	"type": "tool_result",
	"tool_use_id": "toolu_01A09q90qw90lq917835lq9",
	"content": "15 degrees"
}]


Converts:
assistant: ...content
tool: (id, name, params)
->
assistant: ...content, call(name, id, params)
user: ...content, result(id, content)
*/

type AnthropicOrOpenAILLMMessage = AnthropicLLMChatMessage | OpenAILLMChatMessage

const prepareMessages_anthropic_tools = (messages: SimpleLLMMessage[], supportsAnthropicReasoning: boolean): AnthropicOrOpenAILLMMessage[] => {
	const newMessages: (AnthropicLLMChatMessage | (SimpleLLMMessage & { role: 'tool' }))[] = messages;

	for (let i = 0; i < messages.length; i += 1) {
		const currMsg = messages[i]

		// add anthropic reasoning
		if (currMsg.role === 'assistant') {
			if (currMsg.anthropicReasoning && supportsAnthropicReasoning) {
				const content = currMsg.content
				newMessages[i] = {
					role: 'assistant',
					content: content ? [...currMsg.anthropicReasoning, { type: 'text' as const, text: content }] : currMsg.anthropicReasoning
				}
			}
			else {
				newMessages[i] = {
					role: 'assistant',
					content: currMsg.content,
					// strip away anthropicReasoning
				}
			}
			continue
		}

		if (currMsg.role === 'user') {
			newMessages[i] = {
				role: 'user',
				content: currMsg.content,
			}
			continue
		}

		if (currMsg.role === 'tool') {
			// add anthropic tools
			const prevMsg = 0 <= i - 1 && i - 1 <= newMessages.length ? newMessages[i - 1] : undefined

			// make it so the assistant called the tool
			if (prevMsg?.role === 'assistant') {
				if (typeof prevMsg.content === 'string') prevMsg.content = [{ type: 'text', text: prevMsg.content }]
				prevMsg.content.push({ type: 'tool_use', id: currMsg.id, name: currMsg.name, input: currMsg.rawParams })
			}

			// turn each tool into a user message with tool results at the end
			newMessages[i] = {
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: currMsg.id, content: currMsg.content }]
			}
			continue
		}

	}

	// we just removed the tools
	return newMessages as AnthropicLLMChatMessage[]
}


const prepareMessages_XML_tools = (messages: SimpleLLMMessage[], supportsAnthropicReasoning: boolean): AnthropicOrOpenAILLMMessage[] => {

	const llmChatMessages: AnthropicOrOpenAILLMMessage[] = [];
	for (let i = 0; i < messages.length; i += 1) {

		const c = messages[i]
		const next = 0 <= i + 1 && i + 1 <= messages.length - 1 ? messages[i + 1] : null

		if (c.role === 'assistant') {
			// if called a tool (message after it), re-add its XML to the message
			// alternatively, could just hold onto the original output, but this way requires less piping raw strings everywhere
			let content: AnthropicOrOpenAILLMMessage['content'] = c.content
			if (next?.role === 'tool') {
				content = `${content}\n\n${reParsedToolXMLString(next.name, next.rawParams)}`
			}

			// anthropic reasoning
			if (c.anthropicReasoning && supportsAnthropicReasoning) {
				content = content ? [...c.anthropicReasoning, { type: 'text' as const, text: content }] : c.anthropicReasoning
			}
			llmChatMessages.push({
				role: 'assistant',
				content
			})
		}
		// add user or tool to the previous user message
		else if (c.role === 'user' || c.role === 'tool') {
			if (c.role === 'tool')
				c.content = `<${c.name}_result>\n${c.content}\n</${c.name}_result>`

			const images = c.role === 'user' ? c.images : undefined
			if (llmChatMessages.length === 0 || llmChatMessages[llmChatMessages.length - 1].role !== 'user')
				llmChatMessages.push({
					role: 'user',
					content: c.content,
					...(images ? { images } : {}),
				} as OpenAILLMChatMessage)
			else {
				const prev = llmChatMessages[llmChatMessages.length - 1] as { content: string, images?: unknown[] }
				prev.content += '\n\n' + c.content
				if (images) {
					const merged = mergeUserImages((prev.images ?? []) as { name: string }[], images)
					prev.images = merged.images
					if (merged.notes.length) prev.content += '\n' + merged.notes.join('\n')
				}
			}
		}
	}
	return llmChatMessages
}


// --- CHAT ---

const prepareOpenAIOrAnthropicMessages = ({
	messages: messages_,
	systemMessage,
	aiInstructions,
	supportsSystemMessage,
	specialToolFormat,
	supportsAnthropicReasoning,
	contextWindow,
	reservedOutputTokenSpace,
	supportsVision,
}: {
	messages: SimpleLLMMessage[],
	systemMessage: string,
	aiInstructions: string,
	supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated',
	specialToolFormat: 'openai-style' | 'anthropic-style' | undefined,
	supportsAnthropicReasoning: boolean,
	contextWindow: number,
	reservedOutputTokenSpace: number | null | undefined,
	supportsVision?: boolean,
}): { messages: AnthropicOrOpenAILLMMessage[], separateSystemMessage: string | undefined } => {

	reservedOutputTokenSpace = Math.max(
		contextWindow * 1 / 2, // reserve at least 1/4 of the token window length
		reservedOutputTokenSpace ?? 4_096 // defaults to 4096
	)
	let messages: (SimpleLLMMessage | { role: 'system', content: string })[] = deepClone(messages_)

	// ================ system message ================
	// A COMPLETE HACK: last message is system message for context purposes

	const sysMsgParts: string[] = []
	if (aiInstructions) sysMsgParts.push(`GUIDELINES (from the user's .zeroegressrules file):\n${aiInstructions}`)
	if (systemMessage) sysMsgParts.push(systemMessage)
	const combinedSystemMessage = sysMsgParts.join('\n\n')

	messages.unshift({ role: 'system', content: combinedSystemMessage })

	// ================ trim ================
	messages = messages.map(m => ({ ...m, content: m.role !== 'tool' ? m.content.trim() : m.content }))

	// images become image_url parts only for vision models on OpenAI-format messages; elsewhere they are described in text
	const sendsImageParts = !!supportsVision && specialToolFormat !== 'anthropic-style'
	if (!sendsImageParts) {
		for (const m of messages) {
			if (m.role === 'user' && m.images?.length) {
				const reason = supportsVision ? 'format' : 'no-vision'
				m.content = [m.content, ...m.images.map(i => noteForImage(i.name, reason))].filter(Boolean).join('\n')
				delete m.images
			}
		}
	}

	type MesType = (typeof messages)[0]

	// ================ fit into context ================

	// the higher the weight, the higher the desire to truncate - TRIM HIGHEST WEIGHT MESSAGES
	const alreadyTrimmedIdxes = new Set<number>()
	const weight = (message: MesType, messages: MesType[], idx: number) => {
		const base = message.content.length

		let multiplier: number
		multiplier = 1 + (messages.length - 1 - idx) / messages.length // slow rampdown from 2 to 1 as index increases
		if (message.role === 'user') {
			multiplier *= 1
		}
		else if (message.role === 'system') {
			multiplier *= .01 // very low weight
		}
		else {
			multiplier *= 10 // llm tokens are far less valuable than user tokens
		}

		// any already modified message should not be trimmed again
		if (alreadyTrimmedIdxes.has(idx)) {
			multiplier = 0
		}
		// 1st and last messages should be very low weight
		if (idx <= 1 || idx >= messages.length - 1 - 3) {
			multiplier *= .05
		}
		return base * multiplier
	}

	const _findLargestByWeight = (messages_: MesType[]) => {
		let largestIndex = -1
		let largestWeight = -Infinity
		for (let i = 0; i < messages.length; i += 1) {
			const m = messages[i]
			const w = weight(m, messages_, i)
			if (w > largestWeight) {
				largestWeight = w
				largestIndex = i
			}
		}
		return largestIndex
	}

	let totalLen = 0
	for (const m of messages) { totalLen += m.content.length }
	const charsNeedToTrim = totalLen - Math.max(
		(contextWindow - reservedOutputTokenSpace) * CHARS_PER_TOKEN, // can be 0, in which case charsNeedToTrim=everything, bad
		5_000 // ensure we don't trim at least 5k chars (just a random small value)
	)


	// <----------------------------------------->
	// 0                      |    |             |
	//                        |    contextWindow |
	//                     contextWindow - maxOut|putTokens
	//                                          totalLen
	let remainingCharsToTrim = charsNeedToTrim
	let i = 0

	while (remainingCharsToTrim > 0) {
		i += 1
		if (i > 100) break

		const trimIdx = _findLargestByWeight(messages)
		const m = messages[trimIdx]

		// if can finish here, do
		const numCharsWillTrim = m.content.length - TRIM_TO_LEN
		if (numCharsWillTrim > remainingCharsToTrim) {
			// trim remainingCharsToTrim + '...'.length chars
			m.content = m.content.slice(0, m.content.length - remainingCharsToTrim - '...'.length).trim() + '...'
			break
		}

		remainingCharsToTrim -= numCharsWillTrim
		m.content = m.content.substring(0, TRIM_TO_LEN - '...'.length) + '...'
		alreadyTrimmedIdxes.add(trimIdx)
	}

	// ================ system message hack ================
	const newSysMsg = messages.shift()!.content


	// ================ tools and anthropicReasoning ================
	// SYSTEM MESSAGE HACK: we shifted (removed) the system message role, so now SimpleLLMMessage[] is valid

	let llmChatMessages: AnthropicOrOpenAILLMMessage[] = []
	if (!specialToolFormat) { // XML tool behavior
		llmChatMessages = prepareMessages_XML_tools(messages as SimpleLLMMessage[], supportsAnthropicReasoning)
	}
	else if (specialToolFormat === 'anthropic-style') {
		llmChatMessages = prepareMessages_anthropic_tools(messages as SimpleLLMMessage[], supportsAnthropicReasoning)
	}
	else if (specialToolFormat === 'openai-style') {
		llmChatMessages = prepareMessages_openai_tools(messages as SimpleLLMMessage[])
	}
	// user messages that still carry images become OpenAI content parts (text is already trimmed; image parts are never cut)
	for (const m of llmChatMessages) {
		const withImages = m as { role: string, content: unknown, images?: { mime: string; base64: string }[] }
		if (withImages.role !== 'user' || !withImages.images) continue
		const images = withImages.images
		delete withImages.images
		if (typeof withImages.content === 'string') withImages.content = toOpenAIUserContent(withImages.content, images)
	}
	const llmMessages = llmChatMessages


	// ================ system message add as first llmMessage ================

	let separateSystemMessageStr: string | undefined = undefined

	// if supports system message
	if (supportsSystemMessage) {
		if (supportsSystemMessage === 'separated')
			separateSystemMessageStr = newSysMsg
		else if (supportsSystemMessage === 'system-role')
			llmMessages.unshift({ role: 'system', content: newSysMsg }) // add new first message
		else if (supportsSystemMessage === 'developer-role')
			llmMessages.unshift({ role: 'developer', content: newSysMsg }) // add new first message
	}
	// if does not support system message
	else {
		const first = llmMessages[0].content
		const sysPrefix = `<SYSTEM_MESSAGE>\n${newSysMsg}\n</SYSTEM_MESSAGE>\n`
		const newFirstMessage = {
			role: 'user',
			content: typeof first === 'string' || (Array.isArray(first) && llmMessages[0].role === 'user')
				? prefixUserContent(first as string | OpenAIUserPart[], sysPrefix) as any
				: `${sysPrefix}${first}`
		} as const
		llmMessages.splice(0, 1) // delete first message
		llmMessages.unshift(newFirstMessage) // add new first message
	}


	// ================ no empty message ================
	for (let i = 0; i < llmMessages.length; i += 1) {
		const currMsg: AnthropicOrOpenAILLMMessage = llmMessages[i]
		const nextMsg: AnthropicOrOpenAILLMMessage | undefined = llmMessages[i + 1]

		if (currMsg.role === 'tool') continue

		// if content is a string, replace string with empty msg
		if (typeof currMsg.content === 'string') {
			currMsg.content = currMsg.content || EMPTY_MESSAGE
		}
		else {
			// allowed to be empty if has a tool in it or following it
			if ((currMsg.content as { type: string }[]).find(c => c.type === 'tool_result' || c.type === 'tool_use')) {
				currMsg.content = (currMsg.content as { type: string, text?: string }[]).filter(c => !(c.type === 'text' && !c.text)) as any
				continue
			}
			if (nextMsg?.role === 'tool') continue

			// replace any empty text entries with empty msg, and make sure there's at least 1 entry
			for (const c of currMsg.content) {
				if (c.type === 'text') c.text = c.text || EMPTY_MESSAGE
			}
			if (currMsg.content.length === 0) currMsg.content = [{ type: 'text', text: EMPTY_MESSAGE }] as any
		}
	}

	return {
		messages: llmMessages,
		separateSystemMessage: separateSystemMessageStr,
	} as const
}




type GeminiUserPart = (GeminiLLMChatMessage & { role: 'user' })['parts'][0]
type GeminiModelPart = (GeminiLLMChatMessage & { role: 'model' })['parts'][0]
const prepareGeminiMessages = (messages: AnthropicLLMChatMessage[]) => {
	let latestToolName: ToolName | undefined = undefined
	const messages2: GeminiLLMChatMessage[] = messages.map((m): GeminiLLMChatMessage | null => {
		if (m.role === 'assistant') {
			if (typeof m.content === 'string') {
				return { role: 'model', parts: [{ text: m.content }] }
			}
			else {
				const parts: GeminiModelPart[] = m.content.map((c): GeminiModelPart | null => {
					if (c.type === 'text') {
						return { text: c.text }
					}
					else if (c.type === 'tool_use') {
						latestToolName = c.name
						return { functionCall: { id: c.id, name: c.name, args: c.input } }
					}
					else return null
				}).filter(m => !!m)
				return { role: 'model', parts, }
			}
		}
		else if (m.role === 'user') {
			if (typeof m.content === 'string') {
				return { role: 'user', parts: [{ text: m.content }] } satisfies GeminiLLMChatMessage
			}
			else {
				const parts: GeminiUserPart[] = m.content.map((c): GeminiUserPart | null => {
					if (c.type === 'text') {
						return { text: c.text }
					}
					else if (c.type === 'tool_result') {
						if (!latestToolName) return null
						return { functionResponse: { id: c.tool_use_id, name: latestToolName, response: { output: c.content } } }
					}
					else return null
				}).filter(m => !!m)
				return { role: 'user', parts, }
			}

		}
		else return null
	}).filter(m => !!m)

	return messages2
}


const prepareMessages = (params: {
	messages: SimpleLLMMessage[],
	systemMessage: string,
	aiInstructions: string,
	supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated',
	specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined,
	supportsAnthropicReasoning: boolean,
	contextWindow: number,
	reservedOutputTokenSpace: number | null | undefined,
	providerName: ProviderName,
	supportsVision?: boolean,
}): { messages: LLMChatMessage[], separateSystemMessage: string | undefined } => {

	const specialFormat = params.specialToolFormat // this is just for ts stupidness

	// if need to convert to gemini style of messaes, do that (treat as anthropic style, then convert to gemini style)
	if (specialFormat === 'gemini-style') {
		const res = prepareOpenAIOrAnthropicMessages({ ...params, specialToolFormat: specialFormat === 'gemini-style' ? 'anthropic-style' : undefined })
		const messages = res.messages as AnthropicLLMChatMessage[]
		const messages2 = prepareGeminiMessages(messages)
		return { messages: messages2, separateSystemMessage: res.separateSystemMessage }
	}

	return prepareOpenAIOrAnthropicMessages({ ...params, specialToolFormat: specialFormat })
}




export interface IConvertToLLMMessageService {
	readonly _serviceBrand: undefined;
	prepareLLMSimpleMessages: (opts: { simpleMessages: SimpleLLMMessage[], systemMessage: string, modelSelection: ModelSelection | null, featureName: FeatureName }) => { messages: LLMChatMessage[], separateSystemMessage: string | undefined }
	/** `agentRoot`: set for background agents; the system message then describes only that folder. */
	prepareLLMChatMessages: (opts: { chatMessages: ChatMessage[], chatMode: ChatMode, toolPolicy: ToolPolicy | null, modelSelection: ModelSelection | null, agentRoot?: { folder: string, depsMayBeMissing: boolean, agentId: string }, compaction?: Compaction, plan?: PlanStep[], modeInstructions?: string }) => Promise<{ messages: LLMChatMessage[], separateSystemMessage: string | undefined }>
	prepareFIMMessage(opts: { messages: LLMFIMMessage, }): { prefix: string, suffix: string, stopTokens: string[] }
}

export const IConvertToLLMMessageService = createDecorator<IConvertToLLMMessageService>('ConvertToLLMMessageService');


class ConvertToLLMMessageService extends Disposable implements IConvertToLLMMessageService {
	_serviceBrand: undefined;

	constructor(
		@IModelService private readonly modelService: IModelService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
		@IDirectoryStrService private readonly directoryStrService: IDirectoryStrService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@IZeroEgressSettingsService private readonly zeroEgressSettingsService: IZeroEgressSettingsService,
		@IZeroEgressModelService private readonly zeroEgressModelService: IZeroEgressModelService,
		@IMCPService private readonly mcpService: IMCPService,
		@IFileService private readonly fileService: IFileService,
	) {
		super()
		this._refreshAllRulesAllowed()
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this._refreshAllRulesAllowed()))
		this._register(this.fileService.onDidFilesChange(e => {
			for (const f of this.workspaceContextService.getWorkspace().folders) {
				if (e.contains(URI.joinPath(f.uri, PROJECT_RULES_FILE))) void this._refreshRulesAllowed(f.uri)
			}
		}))
	}

	// folders (fsPath) whose .zeroegressrules is a plain, small file. Unknown = not allowed, so a symlinked file is never read.
	private readonly _rulesAllowed = new Set<string>()

	private async _refreshRulesAllowed(folderUri: URI) {
		const ok = (await checkProjectRulesFile(this.fileService, URI.joinPath(folderUri, PROJECT_RULES_FILE))) === 'ok'
		if (ok) this._rulesAllowed.add(folderUri.fsPath)
		else this._rulesAllowed.delete(folderUri.fsPath)
	}

	private _refreshAllRulesAllowed() {
		const folders = this.workspaceContextService.getWorkspace().folders
		const keep = new Set(folders.map(f => f.uri.fsPath))
		for (const k of [...this._rulesAllowed]) if (!keep.has(k)) this._rulesAllowed.delete(k)
		for (const f of folders) void this._refreshRulesAllowed(f.uri)
	}

	// Read .zeroegressrules files from workspace folders
	private _getZeroEgressRulesFileContents(): string {
		try {
			const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
			let zeroEgressRules = '';
			for (const folder of workspaceFolders) {
				if (!this._rulesAllowed.has(folder.uri.fsPath)) continue
				const uri = URI.joinPath(folder.uri, PROJECT_RULES_FILE)
				const { model } = this.zeroEgressModelService.getModel(uri)
				if (!model) continue
				zeroEgressRules += model.getValue(EndOfLinePreference.LF) + '\n\n';
			}
			return zeroEgressRules.trim();
		}
		catch (e) {
			return ''
		}
	}

	// Get combined AI instructions from settings and .zeroegressrules files
	private _getCombinedAIInstructions(): string {
		const globalAIInstructions = this.zeroEgressSettingsService.state.globalSettings.aiInstructions;
		const zeroEgressRulesFileContent = this._getZeroEgressRulesFileContents();

		const ans: string[] = []
		if (globalAIInstructions) ans.push(globalAIInstructions)
		if (zeroEgressRulesFileContent) ans.push(zeroEgressRulesFileContent)
		return ans.join('\n\n')
	}


	// system message
	private _generateChatMessagesSystemMessage = async (chatMode: ChatMode, toolPolicy: ToolPolicy | null, specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined, agentRoot: { folder: string, depsMayBeMissing: boolean, agentId: string } | undefined) => {
		// a background agent works only in its worktree: describe that folder, not the user's workspace or editors
		const workspaceFolders = agentRoot ? [agentRoot.folder] : this.workspaceContextService.getWorkspace().folders.map(f => f.uri.fsPath)

		const openedURIs = agentRoot ? [] : this.modelService.getModels().filter(m => m.isAttachedToEditor()).map(m => m.uri.fsPath) || [];
		const activeURI = agentRoot ? undefined : this.editorService.activeEditor?.resource?.fsPath;

		const directoryStr = agentRoot ?
			`Directory of ${agentRoot.folder}:\n` + await this.directoryStrService.getDirectoryStrTool(URI.file(agentRoot.folder)).catch(() => '(could not read the folder)')
			: await this.directoryStrService.getAllDirectoriesStr({
				cutOffMessage: chatMode === 'agent' || chatMode === 'gather' || chatMode === 'plan' ?
					`...Directories string cut off, use tools to read more...`
					: `...Directories string cut off, ask user for more if necessary...`
			})

		const includeXMLToolDefinitions = !specialToolFormat

		const mcpTools = this.mcpService.getMCPTools()

		// each thread sees only its own persistent terminals (docked: the ones no background agent owns)
		const persistentTerminalIDs = terminalIdsVisibleTo(this.terminalToolService.listPersistentTerminalIds(), id => this.terminalToolService.ownerOfPersistentTerminal(id), agentRoot?.agentId)
		const systemMessage = chat_systemMessage({ workspaceFolders, openedURIs, directoryStr, activeURI, persistentTerminalIDs, chatMode, toolPolicy, mcpTools, includeXMLToolDefinitions, depsMayBeMissing: agentRoot?.depsMayBeMissing ?? false })
		return systemMessage
	}




	// --- LLM Chat messages ---

	/** Reads an image selection's bytes now (it may have changed since it was picked). Returns the image, or a note saying why it was not sent. */
	private async _readImage(sel: { uri: URI, name: string, mime: string }): Promise<{ image: { mime: string; base64: string; name: string } } | { note: string }> {
		try {
			const stat = await this.fileService.stat(sel.uri)
			if (stat.size > IMAGE_MAX_BYTES) return { note: noteForImage(sel.name, 'too-large') }
			const file = await this.fileService.readFile(sel.uri)
			if (file.value.byteLength > IMAGE_MAX_BYTES) return { note: noteForImage(sel.name, 'too-large') }
			return { image: { mime: sel.mime, base64: encodeBase64(file.value), name: sel.name } }
		}
		catch {
			return { note: noteForImage(sel.name, 'missing') }
		}
	}

	private async _chatMessagesToSimpleMessages(chatMessages: ChatMessage[], supportsVision: boolean): Promise<SimpleLLMMessage[]> {
		const simpleLLMMessages: SimpleLLMMessage[] = []

		// only the latest user message carries image bytes; earlier ones leave a text note per image
		const userIdxs = chatMessages.flatMap((m, i) => m.role === 'user' ? [i] : [])
		const imageIdx = imageMessageIndex(userIdxs)

		for (let idx = 0; idx < chatMessages.length; idx += 1) {
			const m = chatMessages[idx]
			if (m.role === 'checkpoint') continue
			if (m.role === 'interrupted_streaming_tool') continue
			if (m.role === 'assistant') {
				simpleLLMMessages.push({
					role: m.role,
					content: m.displayContent,
					anthropicReasoning: m.anthropicReasoning,
				})
			}
			else if (m.role === 'tool') {
				simpleLLMMessages.push({
					role: m.role,
					content: m.content,
					name: m.name,
					id: m.id,
					rawParams: m.rawParams,
				})
			}
			else if (m.role === 'user') {
				const imageSels = (m.selections ?? []).filter((s): s is Extract<typeof s, { type: 'Image' }> => s.type === 'Image')
				const images: { mime: string; base64: string; name: string }[] = []
				const notes: string[] = []
				if (imageSels.length && !supportsVision) { // prepareOpenAIOrAnthropicMessages writes the notes; no file is read
					for (const sel of imageSels) images.push({ mime: sel.mime, base64: '', name: sel.name })
				}
				else if (imageSels.length && idx !== imageIdx) {
					for (const sel of imageSels) notes.push(noteForImage(sel.name, 'sent-earlier'))
				}
				else if (imageSels.length) {
					const results = await Promise.all(imageSels.slice(0, MAX_IMAGES_PER_MESSAGE).map(sel => this._readImage(sel)))
					for (const res of results) {
						if ('image' in res) images.push(res.image)
						else notes.push(res.note)
					}
					for (const sel of imageSels.slice(MAX_IMAGES_PER_MESSAGE)) notes.push(noteForImage(sel.name, 'cap'))
				}
				simpleLLMMessages.push({
					role: m.role,
					content: notes.length ? [m.content, ...notes].filter(Boolean).join('\n') : m.content,
					...(images.length ? { images } : {}),
				})
			}
		}
		return simpleLLMMessages
	}

	prepareLLMSimpleMessages: IConvertToLLMMessageService['prepareLLMSimpleMessages'] = ({ simpleMessages, systemMessage, modelSelection, featureName }) => {
		if (modelSelection === null) return { messages: [], separateSystemMessage: undefined }

		const { overridesOfModel } = this.zeroEgressSettingsService.state

		const { providerName, modelName } = modelSelection
		const {
			specialToolFormat,
			contextWindow,
			supportsSystemMessage,
		} = getModelCapabilities(providerName, modelName, overridesOfModel)

		const modelSelectionOptions = this.zeroEgressSettingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName]

		// Get combined AI instructions
		const aiInstructions = this._getCombinedAIInstructions();

		const isReasoningEnabled = getIsReasoningEnabledState(featureName, providerName, modelName, modelSelectionOptions, overridesOfModel)
		const reservedOutputTokenSpace = getReservedOutputTokenSpace(providerName, modelName, { isReasoningEnabled, overridesOfModel })

		const { messages, separateSystemMessage } = prepareMessages({
			messages: simpleMessages,
			systemMessage,
			aiInstructions,
			supportsSystemMessage,
			specialToolFormat,
			supportsAnthropicReasoning: false, // no kept provider natively supports anthropic-style reasoning blocks
			contextWindow,
			reservedOutputTokenSpace,
			providerName,
		})
		return { messages, separateSystemMessage };
	}
	prepareLLMChatMessages: IConvertToLLMMessageService['prepareLLMChatMessages'] = async ({ chatMessages, chatMode, toolPolicy, modelSelection, agentRoot, compaction, plan, modeInstructions }) => {
		if (modelSelection === null) return { messages: [], separateSystemMessage: undefined }

		const { overridesOfModel } = this.zeroEgressSettingsService.state

		const { providerName, modelName } = modelSelection
		const {
			specialToolFormat,
			contextWindow,
			supportsSystemMessage,
			supportsVision,
		} = getModelCapabilities(providerName, modelName, overridesOfModel)

		const { disableSystemMessage } = this.zeroEgressSettingsService.state.globalSettings;
		const fullSystemMessage = await this._generateChatMessagesSystemMessage(chatMode, toolPolicy, specialToolFormat, agentRoot)
		// the plan steers only runs that may write it (Agent, Plan): Gather and Chat runs don't follow it
		const withPlan = plan && toolPolicy?.plan ? `${fullSystemMessage}\n\nCURRENT PLAN (the user may have edited it; follow it):\n${formatPlan(plan)}` : fullSystemMessage;
		// modeInstructions arrives already headed `MODE INSTRUCTIONS (custom mode “<name>”):`
		const systemMessage = disableSystemMessage ? '' : (modeInstructions ? `${withPlan}\n\n${modeInstructions}` : withPlan);

		const modelSelectionOptions = this.zeroEgressSettingsService.state.optionsOfModelSelection['Chat'][modelSelection.providerName]?.[modelSelection.modelName]

		// Get combined AI instructions
		const aiInstructions = this._getCombinedAIInstructions();
		const isReasoningEnabled = getIsReasoningEnabledState('Chat', providerName, modelName, modelSelectionOptions, overridesOfModel)
		const reservedOutputTokenSpace = getReservedOutputTokenSpace(providerName, modelName, { isReasoningEnabled, overridesOfModel })
		const llmMessages = await this._chatMessagesToSimpleMessages(applyCompaction(chatMessages, compaction), !!supportsVision)

		const { messages, separateSystemMessage } = prepareMessages({
			messages: llmMessages,
			systemMessage,
			aiInstructions,
			supportsSystemMessage,
			specialToolFormat,
			supportsAnthropicReasoning: false, // no kept provider natively supports anthropic-style reasoning blocks
			contextWindow,
			reservedOutputTokenSpace,
			providerName,
			supportsVision: !!supportsVision,
		})
		return { messages, separateSystemMessage };
	}


	// --- FIM ---

	prepareFIMMessage: IConvertToLLMMessageService['prepareFIMMessage'] = ({ messages }) => {
		// Get combined AI instructions with the provided aiInstructions as the base
		const combinedInstructions = this._getCombinedAIInstructions();

		let prefix = `\
${!combinedInstructions ? '' : `\
// Instructions:
// Do not output an explanation. Try to avoid outputting comments. Only output the middle code.
${combinedInstructions.split('\n').map(line => `//${line}`).join('\n')}`}

${messages.prefix}`

		const suffix = messages.suffix
		const stopTokens = messages.stopTokens
		return { prefix, suffix, stopTokens }
	}


}


registerSingleton(IConvertToLLMMessageService, ConvertToLLMMessageService, InstantiationType.Eager);








/*
Gemini has this, but they're openai-compat so we don't need to implement this
gemini request:
{   "role": "assistant",
	"content": null,
	"function_call": {
		"name": "get_weather",
		"arguments": {
			"latitude": 48.8566,
			"longitude": 2.3522
		}
	}
}

gemini response:
{   "role": "assistant",
	"function_response": {
		"name": "get_weather",
			"response": {
			"temperature": "15°C",
				"condition": "Cloudy"
		}
	}
}
*/




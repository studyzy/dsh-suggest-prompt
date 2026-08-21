import z from "@deepseek-ai/schemastery";
import { z as z$1 } from "zod";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS, deadline } from "@deepseek-ai/dsh-timeout";
import { BlockAssembler, ReasoningEffortId, createUserMessage, deepFreeze } from "@deepseek-ai/dsh-llm";
import { deriveEventMessage } from "@deepseek-ai/dsh-session/surface";
//#region lib/types/sanitize.js
/**
* Transcript redaction, suggestion sanitization, and semantic output
* filtering for the suggest-prompt auxiliary call: nothing that reaches the
* model carries secret-shaped text, and nothing the model returns can inject
* terminal control into the web composer or read as meta-text instead of a
* real next prompt. Pure functions, exported for direct unit coverage.
* @module @studyzy/dsh-suggest-prompt/sanitize
*/
/** Common credential shapes masked before the transcript reaches the model. */
const SECRET_PATTERNS = [
	{
		pattern: /\bAKIA[0-9A-Z]{16}\b/g,
		label: "<aws-access-key-id>"
	},
	{
		pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g,
		label: "<secret-token>"
	},
	{
		pattern: /\bgh[opsu]_[A-Za-z0-9]{36,}\b/g,
		label: "<github-token>"
	},
	{
		pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
		label: "<slack-token>"
	},
	{
		pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
		label: "<jwt>"
	},
	{
		pattern: /\brk_(live|test)_[A-Za-z0-9]{16,}\b/g,
		label: "<stripe-key>"
	}
];
/**
* Mask secret-shaped substrings so the auxiliary model never receives them.
* @param text - transcript text.
* @returns the same text with every matched secret replaced by a label.
*/
function redactSecrets(text) {
	let out = text;
	for (const { pattern, label } of SECRET_PATTERNS) {
		pattern.lastIndex = 0;
		out = out.replace(pattern, label);
	}
	return out;
}
/**
* ANSI/OSC/CSI/DCS escape sequences: CSI `ESC[ ...`, OSC `ESC] ... (BEL|ESC\)`,
* and the two-byte `ESC ( X` / `ESC # X` families.
*/
const ESCAPE_SEQUENCE = /\u001b(?:\[[0-9;:]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|[()][0-9A-Za-z]|#[0-9A-Za-z])/g;
/** C0 controls (except tab/newline/CR), C1 controls, bidi overrides, and the chip placeholder. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\uFFFC]/g;
/** Fence delimiters the model may wrap the suggestion in. */
const FENCE_DELIMITER = /^(?:`{3,}|~{3,})[^\n]*\n?|\n?(?:`{3,}|~{3,})$/g;
/** One matched pair of surrounding quotes (optionally after a colon/label), stripped by replace. */
const QUOTED_OUTER = /^(?:.*?:\s*)?(["'“”‘’])([\s\S]*?)\1$/u;
/** Strip unpaired surrogate code units (an emoji's broken half cannot render). */
function stripLoneSurrogates(text) {
	let out = "";
	for (const char of text) {
		const code = char.charCodeAt(0);
		if (code >= 55296 && code <= 57343) continue;
		out += char;
	}
	return out;
}
/**
* Structurally clean one raw model output into composer-safe single-line
* text, without the length cap: control sequences, lone surrogates, fences,
* and surrounding quotes are stripped, and whitespace is collapsed.
* @param text - raw model output.
* @returns the cleaned single-line text.
*/
function cleanSuggestion(text) {
	let value = stripLoneSurrogates(text.replace(ESCAPE_SEQUENCE, "").replace(CONTROL_CHARS, ""));
	value = value.trim();
	value = value.replace(FENCE_DELIMITER, "").trim();
	value = value.replace(QUOTED_OUTER, "$2").trim();
	return value.replace(/\s+/g, " ").trim();
}
/**
* Sanitize one raw suggestion into composer-safe single-line text, truncating
* to the visible-character cap.
* @param text - raw model output.
* @param maxChars - hard visible-character cap (code points).
* @returns the sanitized text and whether it was truncated.
*/
function sanitizeSuggestion(text, maxChars) {
	const value = cleanSuggestion(text);
	const truncated = Array.from(value).length > maxChars;
	if (truncated) return {
		text: Array.from(value).slice(0, maxChars).join(""),
		truncated
	};
	return {
		text: value,
		truncated
	};
}
/**
* Report whether `text` contains a CJK unified ideograph. CJK text has no
* spaces, so word counts need this check; it also picks the suggestion
* language to match the conversation.
* @param text - inspected text.
* @returns true when any code point falls in the CJK unified ideographs range.
*/
function hasCJK(text) {
	for (const char of text) {
		const code = char.charCodeAt(0);
		if (code >= 19968 && code <= 40959) return true;
	}
	return false;
}
/** Meta-text the model might emit instead of a suggestion ("stay silent"). */
const SILENCE_META = /\bsilence\b|\bstay silent\b|\bno more\b/i;
/** Parenthesized or bracketed meta the model may wrap the whole reply in. */
const WRAPPED_META = /^\(.*\)$|^\[.*\]$/u;
/** Two ASCII sentences; CJK sentence punctuation is not space-separated. */
const MULTIPLE_SENTENCE = /[.!?]\s+[A-Z]/;
/** Markdown emphasis or a literal newline that survived sanitization. */
const FORMATTING = /[\n*]/;
const EVALUATIVE = new RegExp(`\\b(?:${[
	"thanks",
	"thank you",
	"looks good",
	"sounds good",
	"that works",
	"that worked",
	"that's all",
	"nice",
	"great",
	"perfect",
	"makes sense",
	"awesome",
	"excellent"
].join("|")})\\b|谢谢|感谢|不错|很好|很棒|太棒了|完美|没毛病`, "i");
const ASSISTANT_VOICE = new RegExp(`^(?:${[
	"let me",
	"i'll",
	"i've",
	"i'm",
	"i can",
	"i would",
	"i think",
	"i notice",
	"here's",
	"here is",
	"here are",
	"that's",
	"this is",
	"this will",
	"you can",
	"you should",
	"you could",
	"sure,",
	"of course",
	"certainly",
	"我来",
	"我帮你",
	"我建议",
	"我可以",
	"让我",
	"这可以",
	"这里可以"
].join("|")})`, "i");
/** Single-word suggestions only count as real next prompts when they are known user commands. */
const ALLOWED_SINGLE_WORDS = /* @__PURE__ */ new Set([
	"yes",
	"yeah",
	"yep",
	"yea",
	"yup",
	"sure",
	"ok",
	"okay",
	"push",
	"commit",
	"deploy",
	"stop",
	"continue",
	"check",
	"exit",
	"quit",
	"no",
	"继续",
	"好",
	"好的",
	"行",
	"可以",
	"提交",
	"推送",
	"停止",
	"退出",
	"完成",
	"检查",
	"部署",
	"测试",
	"运行"
]);
function isAllowedSingleWord(lower) {
	return ALLOWED_SINGLE_WORDS.has(lower) || lower.startsWith("/");
}
/**
* Reject raw model output that is not a usable next prompt: meta-text
* ("no suggestion", "stay silent"), evaluative filler, assistant-voice
* phrasing, multi-sentence or over-long output, or formatting. Returns true
* when the output should be treated as "no suggestion" instead of displayed.
* @param text - sanitized, single-line model output.
* @returns true when the suggestion should be dropped silently.
*/
function shouldFilterSuggestion(text) {
	const value = text.trim();
	if (value === "") return true;
	const lower = value.toLowerCase();
	const wordCount = value.split(/\s+/).filter(Boolean).length;
	if (lower === "done" || lower === "nothing found" || lower.startsWith("nothing to suggest") || lower.startsWith("no suggestion") || lower.startsWith("no follow-up") || SILENCE_META.test(lower)) return true;
	if (WRAPPED_META.test(value)) return true;
	if (lower.startsWith("api error:") || lower.startsWith("error:")) return true;
	if (hasCJK(value)) {
		if (Array.from(value).length < 2 && !isAllowedSingleWord(lower)) return true;
	} else {
		if (wordCount > 12) return true;
		if (wordCount < 2 && !isAllowedSingleWord(lower)) return true;
	}
	if (Buffer.byteLength(value, "utf8") >= 100) return true;
	if (MULTIPLE_SENTENCE.test(value)) return true;
	if (FORMATTING.test(value)) return true;
	if (EVALUATIVE.test(value)) return true;
	if (ASSISTANT_VOICE.test(value)) return true;
	return false;
}
//#endregion
//#region lib/types/generate.js
/**
* Bounded auxiliary suggestion generation: transcript framing, secret
* redaction, route resolution, deadline-fused LLM dispatch, and output
* sanitization. Mirrors the session-title-llm call policy (byte bound, output
* cap, deadline, pre-dispatch request event) so the model-visible⟺logged
* invariant holds for every suggestion request.
* @module @studyzy/dsh-suggest-prompt/generate
*/
var __addDisposableResource = function(env, value, async) {
	if (value !== null && value !== void 0) {
		if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
		var dispose, inner;
		if (async) {
			if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
			dispose = value[Symbol.asyncDispose];
		}
		if (dispose === void 0) {
			if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
			dispose = value[Symbol.dispose];
			if (async) inner = dispose;
		}
		if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
		if (inner) dispose = function() {
			try {
				inner.call(this);
			} catch (e) {
				return Promise.reject(e);
			}
		};
		env.stack.push({
			value,
			dispose,
			async
		});
	} else if (async) env.stack.push({ async: true });
	return value;
};
var __disposeResources = (function(SuppressedError) {
	return function(env) {
		function fail(e) {
			env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
			env.hasError = true;
		}
		var r, s = 0;
		function next() {
			while (r = env.stack.pop()) try {
				if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
				if (r.dispose) {
					var result = r.dispose.call(r.value);
					if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) {
						fail(e);
						return next();
					});
				} else s |= 1;
			} catch (e) {
				fail(e);
			}
			if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
			if (env.hasError) throw env.error;
		}
		return next();
	};
})(typeof SuppressedError === "function" ? SuppressedError : function(error, suppressed, message) {
	var e = new Error(message);
	return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
/** Capability-owned timeout reason code for auxiliary suggestion requests. */
const SUGGEST_PROMPT_TIMEOUT_CODE = "SUGGEST_PROMPT_TIMEOUT";
/**
* Suggestion generation is an opportunistic, must-be-fast-and-cheap auxiliary
* call: reasoning/thinking is disabled. `off` maps to `thinking: disabled` on
* the DeepSeek adapter and to `reasoning_effort: off` on OpenAI-compatible
* (pi-ai) routes, so the request never spends budget on a chain of thought.
*/
const SUGGEST_REASONING_EFFORT = ReasoningEffortId("off");
/**
* Informational purpose tag for auxiliary suggestion calls. The published
* `GenerateOptions['purpose']` union predates the suggest-prompt capability and
* no provider tailors transport for it yet, so the literal widens through
* `unknown` once; the runtime value stays `'suggest-prompt'` for providers that
* learn it later.
*/
const SUGGEST_PURPOSE = "suggest-prompt";
/** Complete configuration key set for direct construction validation. */
const CONFIG_KEYS = /* @__PURE__ */ new Set([
	"maxInputBytes",
	"maxOutputTokens",
	"timeoutMs",
	"maxRecentTurns",
	"maxTranscriptChars",
	"maxSuggestionChars",
	"provider",
	"model",
	"acceptKey"
]);
/** Validate one positive integer limit. */
function assertPositiveInteger(name, value) {
	if (!Number.isInteger(value) || value <= 0) throw new Error(`suggest-prompt: ${name} must be a positive integer`);
}
/**
* Validate and detach the required suggestion policy.
* @param config - untrusted plugin configuration.
* @returns immutable policy with optional route absence preserved.
*/
function resolveSuggestPromptConfig(config) {
	const candidate = config;
	if (candidate === null || typeof candidate !== "object") throw new Error("suggest-prompt: configuration is required");
	const value = candidate;
	for (const key of Object.keys(value)) if (!CONFIG_KEYS.has(key)) throw new Error(`suggest-prompt: unknown config key "${key}"`);
	assertPositiveInteger("maxInputBytes", value.maxInputBytes);
	assertPositiveInteger("maxOutputTokens", value.maxOutputTokens);
	assertPositiveInteger("timeoutMs", value.timeoutMs);
	if (value.maxRecentTurns !== void 0) assertPositiveInteger("maxRecentTurns", value.maxRecentTurns);
	assertPositiveInteger("maxTranscriptChars", value.maxTranscriptChars);
	assertPositiveInteger("maxSuggestionChars", value.maxSuggestionChars);
	if (value.timeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`suggest-prompt: timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`);
	if (value.provider !== void 0 && (typeof value.provider !== "string" || value.provider.length === 0)) throw new Error("suggest-prompt: provider override must be a non-empty string");
	if (value.model !== void 0 && (typeof value.model !== "string" || value.model.length === 0)) throw new Error("suggest-prompt: model override must be a non-empty string");
	if (value.acceptKey !== void 0 && (typeof value.acceptKey !== "string" || value.acceptKey.trim().length === 0)) throw new Error("suggest-prompt: acceptKey must be a non-empty shortcut string");
	return deepFreeze(Object.assign({}, value));
}
/**
* Stable instruction for the suggestion extraction call. The model is bound to
* predicting the user's next prompt in the user's own voice, forbidden from
* generating content or meta-text; `language` constrains the reply language to
* match the conversation.
* @param maxSuggestionChars - visible-character cap baked into the instruction.
* @param language - reply language ("简体中文" for CJK conversations, else "English").
*/
function systemPrompt(maxSuggestionChars, language) {
	return [
		"You are a prompt suggestion generator. Your ONLY purpose is to predict the user's next prompt in a coding-assistant chat — never to generate content.",
		"",
		"Your job:",
		"1. Read the user's most recent message and the assistant's final answer.",
		"2. Predict what the USER would naturally type next — not what the assistant should do.",
		"",
		"CRITICAL CONSTRAINTS:",
		"- You are NOT a code generator, writer, or task executor.",
		"- You MUST respond with ONLY the suggestion text, on a single line.",
		"- NEVER generate, implement, code, or produce any content.",
		"- NEVER provide explanations, reasoning, or extra text.",
		"- NEVER use quotes, labels, Markdown, XML, or formatting.",
		"- Be specific when you can — name files, functions, or actions.",
		"- If the next step is not obvious, reply with nothing at all.",
		"",
		"THE TEST: would the user think \"I was just about to type that\"?",
		"",
		"EXAMPLES:",
		"User asked \"fix the bug and run tests\", bug is fixed -> \"run the tests\"",
		"After code written -> \"try it out\"",
		"Assistant offers options -> pick the one the user would choose",
		"Assistant asks to continue -> \"yes\" or \"go ahead\"",
		"Task complete, obvious follow-up -> \"commit this\" or \"push it\"",
		"After an error or misunderstanding -> reply with nothing",
		"",
		"NEVER SUGGEST:",
		"- Evaluative feedback (\"looks good\", \"thanks\")",
		"- Questions (\"what about...?\")",
		"- Assistant-voice phrasing (\"Let me...\", \"I'll...\", \"Here's...\")",
		"- New ideas the user did not ask about",
		"- Multiple sentences",
		"",
		"Reply with ONLY the suggestion, 3-12 words, no quotes or explanation. If the next step is not obvious, reply with nothing.",
		"",
		`Language: ${language}`,
		`At most ${maxSuggestionChars} visible characters.`
	].join("\n");
}
/** Pick the reply language to match the user's last prompt (CJK → 简体中文). */
function suggestionLanguage(pairs) {
	for (const pair of [...pairs].reverse()) {
		if (pair.role !== "user") continue;
		return hasCJK(pair.text) ? "简体中文" : "English";
	}
	return "English";
}
/** Frame the kept pairs as labelled blocks so the model reads them as context. */
function frameTranscript(pairs) {
	const blocks = [];
	for (const pair of pairs) blocks.push(pair.role === "user" ? `[User Message]\n${pair.text}` : `[Assistant Response]\n${pair.text}`);
	return blocks.join("\n\n");
}
/** Render a message's text blocks; non-text blocks contribute nothing. */
function renderMessageText(message) {
	let out = "";
	for (const block of message.content) if (block.type === "text") out += block.text;
	return out;
}
/** Keep the newest pairs while the budget lasts; always keep the newest one. */
function keepTail(pairs, budget) {
	let remaining = budget;
	let kept = 0;
	for (const pair of [...pairs].reverse()) {
		const cost = pair.role.length + pair.text.length + 2;
		if (cost > remaining && kept > 0) break;
		kept += 1;
		remaining -= cost;
	}
	return Math.max(1, kept);
}
/**
* Build the model-visible transcript from the session log: user/assistant
* messages of the last `maxRecentTurns` completed turns (default 1 — only the
* last completed turn's user input and assistant final answer), redacted,
* tail-trimmed to `maxTranscriptChars`.
* @param session - session whose log is the transcript source.
* @param maxRecentTurns - completed-turn tail to include (1 keeps only the last turn).
* @param maxTranscriptChars - character budget for the kept tail.
* @returns the bounded transcript, or `undefined` when no completed turn has messages.
*/
function buildTranscript(session, maxRecentTurns, maxTranscriptChars) {
	const events = session.events;
	let lastTurn = 0;
	const turnStarts = [];
	for (const event of events) if (event.type === "turn/start") turnStarts.push({
		turn: event.data.turn,
		seq: event.seq
	});
	else if (event.type === "turn/end") lastTurn = event.data.turn;
	if (lastTurn === 0) return void 0;
	const cutoffTurn = Math.max(1, lastTurn - Math.max(1, maxRecentTurns) + 1);
	const cutoffSeq = turnStarts.find((entry) => entry.turn === cutoffTurn)?.seq ?? 0;
	const pairs = [];
	const sourceMessageSeqs = [];
	let baseSeq = 0;
	for (const event of events) {
		if (event.seq < cutoffSeq) continue;
		if (event.type !== "user/message" && event.type !== "assistant/message") continue;
		const message = deriveEventMessage(event);
		if (message === null) continue;
		const text = renderMessageText(message).trim();
		if (text.length === 0) continue;
		pairs.push({
			role: message.role === "user" ? "user" : "assistant",
			text: redactSecrets(text)
		});
		sourceMessageSeqs.push(event.seq);
		baseSeq = event.seq;
	}
	if (pairs.length === 0) return void 0;
	const keptCount = keepTail(pairs, Math.max(1, maxTranscriptChars));
	return {
		pairs: pairs.slice(pairs.length - keptCount),
		sourceMessageSeqs: sourceMessageSeqs.slice(sourceMessageSeqs.length - keptCount),
		baseSeq
	};
}
/**
* Resolve the effective route: an explicit override wins for a member, and a
* missing member falls back to the session's latest logged request route.
* @param session - session whose logged request header supplies the fallback.
* @param config - validated suggestion policy.
* @returns the complete route, or throws when neither a configured pair nor a
* logged session route supplies every member.
*/
function routeOf(session, config) {
	if (config.provider !== void 0 && config.model !== void 0) return {
		provider: config.provider,
		model: config.model
	};
	const route = session.requestHeader()?.config;
	const provider = config.provider ?? route?.provider;
	const model = config.model ?? route?.model;
	if (provider !== void 0 && model !== void 0 && provider.length > 0 && model.length > 0) return {
		provider,
		model
	};
	throw new Error("suggest-prompt: no complete route is available; configure provider and model, or run a turn that logs a session route");
}
/** Translate terminal finish reasons into an auxiliary-call failure. */
function finishError(finish) {
	switch (finish.kind) {
		case "stop": return;
		case "error":
		case "aborted": {
			const error = new Error(finish.failure.message);
			error.code = finish.failure.code;
			return error;
		}
		case "max-tokens": return /* @__PURE__ */ new Error("suggest-prompt: suggestion output reached maxOutputTokens");
		case "tool-calls": return /* @__PURE__ */ new Error("suggest-prompt: suggestion model unexpectedly requested a tool");
		/* v8 ignore next 2 -- FinishReason is a closed five-member union; this default cannot be reached */
		default: return /* @__PURE__ */ new Error(`suggest-prompt: unsupported finish reason "${String(finish.kind)}"`);
	}
}
/**
* Generate one suggestion for a completed turn through the shared auxiliary
* LLM call.
* @param ctx - context exposing the registered LLM service.
* @param config - validated suggestion policy.
* @param session - owning session log.
* @param turn - completed turn whose completion this suggestion answers.
* @param signal - cancellation forwarded to the auxiliary call.
* @returns the durable whole-value suggestion event payload, or `undefined`
* when the model produced no usable suggestion (an empty or semantically
* rejectable reply — the system prompt tells it to reply with nothing when the
* next step is not obvious). Genuine failures throw.
*/
async function generateSuggestion(ctx, config, session, turn, signal) {
	const env_1 = {
		stack: [],
		error: void 0,
		hasError: false
	};
	try {
		signal.throwIfAborted();
		const transcript = buildTranscript(session, config.maxRecentTurns ?? 1, config.maxTranscriptChars);
		if (transcript === void 0) throw new Error("suggest-prompt: session has no model-visible transcript to suggest from");
		const route = routeOf(session, config);
		const language = suggestionLanguage(transcript.pairs);
		const system = systemPrompt(config.maxSuggestionChars, language);
		const framed = frameTranscript(transcript.pairs);
		const inputBytes = Buffer.byteLength(framed, "utf8");
		if (inputBytes > config.maxInputBytes) throw new Error(`suggest-prompt: input is ${inputBytes} bytes, exceeding maxInputBytes ${config.maxInputBytes}`);
		const messages = [createUserMessage({
			content: [{
				type: "text",
				text: framed
			}],
			source: {
				kind: "plugin",
				plugin: "dsh-suggest-prompt"
			}
		})];
		const callDeadline = __addDisposableResource(env_1, deadline(signal, config.timeoutMs, SUGGEST_PROMPT_TIMEOUT_CODE), false);
		const requestOptions = (reasoningOff) => deepFreeze({
			provider: route.provider,
			model: route.model,
			messages,
			system,
			maxTokens: config.maxOutputTokens,
			sessionId: session.id,
			purpose: SUGGEST_PURPOSE,
			...reasoningOff ? { reasoningEffort: SUGGEST_REASONING_EFFORT } : {},
			signal: callDeadline.signal
		});
		const requestEvent = {
			version: 1,
			turn,
			sourceMessageSeqs: [...transcript.sourceMessageSeqs],
			route,
			system,
			messages,
			maxTokens: config.maxOutputTokens
		};
		const firstRequest = session.append("suggest-prompt/request", {
			...requestEvent,
			reasoningOff: true
		});
		callDeadline.signal.throwIfAborted();
		const drain = async (options) => {
			const assembler = new BlockAssembler();
			for await (const chunk of ctx.llm.stream(options)) {
				callDeadline.signal.throwIfAborted();
				assembler.push(chunk);
			}
			callDeadline.signal.throwIfAborted();
			const terminalError = finishError(assembler.finish);
			if (terminalError !== void 0) throw terminalError;
			return assembler.blocks();
		};
		let request = firstRequest;
		let blocks;
		try {
			blocks = await drain(requestOptions(true));
		} catch (error) {
			if (error?.code !== "UNSUPPORTED_REASONING_EFFORT") throw error;
			request = session.append("suggest-prompt/request", {
				...requestEvent,
				reasoningOff: false
			});
			blocks = await drain(requestOptions(false));
		}
		if (blocks.some((block) => block.type === "tool-call")) throw new Error("suggest-prompt: suggestion output must contain text only");
		const cleaned = cleanSuggestion(blocks.filter((block) => block.type === "text").map((block) => block.text).join(" "));
		if (cleaned.length === 0 || shouldFilterSuggestion(cleaned)) return;
		const { text: suggestion, truncated } = sanitizeSuggestion(cleaned, config.maxSuggestionChars);
		const suggested = {
			version: 1,
			turn,
			baseSeq: transcript.baseSeq,
			text: suggestion,
			truncated,
			route,
			requestSeq: request.seq,
			acceptKey: config.acceptKey ?? "Tab"
		};
		session.append("suggest-prompt/suggested", suggested);
		return suggested;
	} catch (e_1) {
		env_1.error = e_1;
		env_1.hasError = true;
	} finally {
		__disposeResources(env_1);
	}
}
//#endregion
//#region lib/types/index.js
/**
* suggest-prompt plugin: after every completed agent turn, generate one
* suggested next prompt for the user through a bounded auxiliary LLM call and
* publish it as the `suggestPrompt` session projection (the web composer
* renders it as ghost placeholder text). Host-driven on `turn/end` (completed); generation
* is per-session deduplicated by turn and superseded on the next completed
* turn. The projection unit activates only where a projection registry is
* composed (headless assemblies stay unaffected).
* @module @studyzy/dsh-suggest-prompt
*/
/** Wire payload schema of the `suggestPrompt` projection (whole suggestion or null). */
const suggestPromptProjectionSchema = z$1.union([z$1.object({
	turn: z$1.number().int().positive(),
	baseSeq: z$1.number().int().nonnegative(),
	text: z$1.string().min(1),
	truncated: z$1.boolean(),
	route: z$1.object({
		provider: z$1.string().min(1),
		model: z$1.string().min(1)
	}).optional(),
	requestSeq: z$1.number().int().nonnegative(),
	acceptKey: z$1.string().min(1)
}), z$1.null()]);
/**
* Light last-wins fold of the `suggestPrompt` projection unit. The state is
* plain JSON; any non-suggested event returns the same reference (the
* registry's Object.is gate), and correctness of the written suggestion is
* the write side's job (generateSuggestion sanitized and truncated it before
* appending; the package invariant rejects a violating stream fail-loud where
* it is installed).
* @param state - the projection covering all prior events.
* @param event - the next committed session event.
* @returns the next projection (same reference when the event is not a suggestion).
*/
function applySuggestPromptProjection(state, event) {
	if (event.type !== "suggest-prompt/suggested") return state;
	const data = event.data;
	return {
		turn: data.turn,
		baseSeq: data.baseSeq,
		text: data.text,
		truncated: data.truncated,
		...data.route !== void 0 ? { route: data.route } : {},
		requestSeq: data.requestSeq,
		acceptKey: data.acceptKey
	};
}
/** Seed the dedupe cursor from the log so reloads never regenerate a turn. */
function lastSuggestedTurnInLog(session) {
	return session.events.findLast((candidate) => candidate.type === "suggest-prompt/suggested")?.data.turn ?? -1;
}
/** Loader schema: every bound is required and provider/model pair optionally overrides the logged route. */
const Config = z.object({
	maxInputBytes: z.number().step(1).min(1).required(),
	maxOutputTokens: z.number().step(1).min(1).required(),
	timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).required(),
	maxRecentTurns: z.number().step(1).min(1).default(1),
	maxTranscriptChars: z.number().step(1).min(1).required(),
	maxSuggestionChars: z.number().step(1).min(1).required(),
	provider: z.string(),
	model: z.string(),
	acceptKey: z.string().default("Tab")
});
/** Cordis plugin identity. */
const name = "suggest-prompt";
/** Services required before this plugin activates. */
const inject = ["llm", "sessions"];
/**
* The settings namespace owning the suggestion route. Editable from the WebUI
* settings surface (`settings.plugin.item`, keyed by this value) and from
* `~/.dsh/settings.yaml`; the cordis.yml entry remains the composition base.
*/
const SUGGEST_PROMPT_NS = settingsNamespace("suggest-prompt");
/**
* Mount the plugin: listen for completed turns, generate per-session
* suggestions, and register the `suggestPrompt` projection unit.
* @param ctx - context exposing the LLM and session services.
* @param config - required bounded-generation policy.
*/
function apply(ctx, config) {
	let source = () => config;
	installSettingsSection(ctx, SUGGEST_PROMPT_NS, Config, config, {
		validate: (value) => {
			resolveSuggestPromptConfig(value);
		},
		setSource: (next) => {
			source = next;
		},
		onChange: () => {}
	});
	const states = /* @__PURE__ */ new WeakMap();
	const tracked = /* @__PURE__ */ new Set();
	const handleTurnEnd = (session, turn) => {
		let state = states.get(session);
		if (state === void 0) {
			state = {
				lastSuggestedTurn: lastSuggestedTurnInLog(session),
				pending: void 0
			};
			states.set(session, state);
			tracked.add(state);
		}
		if (state.lastSuggestedTurn === turn) return;
		const pending = state.pending;
		if (pending !== void 0) {
			if (pending.turn === turn) return;
			pending.controller.abort();
		}
		const controller = new AbortController();
		state.pending = {
			turn,
			controller
		};
		const resolved = resolveSuggestPromptConfig(source());
		Promise.resolve().then(() => generateSuggestion(ctx, resolved, session, turn, controller.signal)).then(() => {
			/* v8 ignore next 2 -- the superseded-success arm is unreachable by construction */
			if (state.pending?.controller !== controller) return;
			state.pending = void 0;
			state.lastSuggestedTurn = turn;
		}, (error) => {
			if (state.pending?.controller === controller) state.pending = void 0;
			if (controller.signal.aborted) return;
			/* v8 ignore next 2 -- non-Error rejections are wrapped by the LLM layer */
			const message = error instanceof Error ? error.message : String(error);
			ctx.logger.warn(`suggest-prompt: suggestion generation failed: ${message}`);
		});
	};
	ctx.on("session/event", (session, event) => {
		if (event.type === "turn/end" && event.data.reason.kind === "completed") handleTurnEnd(session, event.data.turn);
	});
	ctx.effect(() => () => {
		for (const state of tracked) state.pending?.controller.abort();
	});
	ctx.inject(["sessionProjections"], (projectionCtx) => {
		projectionCtx.sessionProjections.register({
			key: "suggestPrompt",
			schema: suggestPromptProjectionSchema,
			init: () => null,
			apply: applySuggestPromptProjection,
			view: (state) => state,
			stateVersion: 1
		});
	});
}
//#endregion
export { Config, SUGGEST_PROMPT_NS, apply, applySuggestPromptProjection, inject, name };

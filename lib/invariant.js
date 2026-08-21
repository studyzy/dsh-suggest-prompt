//#region lib/types/invariant.js
/** Package-owned durable suggest-prompt invariants. @module @studyzy/dsh-suggest-prompt/invariant */
const PACKAGE_NAME = "@studyzy/dsh-suggest-prompt";
/** Cordis companion plugin name. */
const name = "suggest-prompt-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/** One integer payload field (turn/baseSeq/requestSeq/maxTokens are counts). */
function isInteger(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
/** One non-empty route pair. */
function isRoute(value) {
	if (typeof value !== "object" || value === null) return false;
	const record = value;
	return typeof record["provider"] === "string" && record["provider"].length > 0 && typeof record["model"] === "string" && record["model"].length > 0;
}
/** Validate one suggest-prompt event payload before it reaches the durable log. */
function validateEvent(event, fail) {
	if (event.type !== "suggest-prompt/request" && event.type !== "suggest-prompt/suggested") return;
	const data = event.data;
	if (data.version !== 1) {
		fail(`suggest-prompt/${event.type.slice(15)} carries unsupported version ${JSON.stringify(data.version)}`);
		return;
	}
	if (event.type === "suggest-prompt/request") {
		if (!isInteger(data.turn) || !Array.isArray(data.sourceMessageSeqs) || !data.sourceMessageSeqs.every(isInteger) || !isRoute(data.route) || typeof data.system !== "string" || data.system.length === 0 || !Array.isArray(data.messages) || data.messages.length === 0 || !isInteger(data.maxTokens) || data.reasoningOff !== void 0 && typeof data.reasoningOff !== "boolean") fail("suggest-prompt/request carries an invalid request payload");
		return;
	}
	if (!isInteger(data.turn) || !isInteger(data.baseSeq) || typeof data.text !== "string" || data.text.length === 0 || typeof data.truncated !== "boolean" || !isInteger(data.requestSeq)) fail("suggest-prompt/suggested carries an invalid suggestion payload");
}
/** Install validation for loaded and newly appended suggest-prompt state. */
const install = Object.assign((ctx, fail) => {
	const seed = (session) => {
		for (const event of session.events) validateEvent(event, fail);
	};
	for (const session of ctx.sessions.list()) seed(session);
	ctx.on("session/created", (session) => {
		seed(session);
	}, { global: true });
	ctx.on("internal/dispatch", (_mode, eventName, args) => {
		if (eventName !== "session/event") return;
		const [, event] = args;
		validateEvent(event, fail);
	}, { global: true });
}, { inject: ["sessions"] });
/**
* Register the suggest-prompt invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };

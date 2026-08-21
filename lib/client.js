window.__ModuleLoader__.load({
	id: "@studyzy/dsh-suggest-prompt/client",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let _deepseek_ai_dsh_client_runtime_client = require("@deepseek-ai/dsh-client-runtime/client");
		//#region src/browser/accept-key.ts
		/** Key tokens that map to a `KeyboardEvent.code` that is not a letter or digit. */
		const KEY_CODES = {
			tab: "Tab",
			enter: "Enter",
			space: "Space",
			" ": "Space",
			slash: "Slash",
			"/": "Slash",
			backspace: "Backspace",
			delete: "Delete",
			escape: "Escape",
			esc: "Escape",
			insert: "Insert",
			home: "Home",
			end: "End",
			pageup: "PageUp",
			pagedown: "PageDown",
			arrowup: "ArrowUp",
			up: "ArrowUp",
			arrowdown: "ArrowDown",
			down: "ArrowDown",
			arrowleft: "ArrowLeft",
			left: "ArrowLeft",
			arrowright: "ArrowRight",
			right: "ArrowRight",
			period: "Period",
			".": "Period",
			comma: "Comma",
			",": "Comma",
			semicolon: "Semicolon",
			";": "Semicolon",
			quote: "Quote",
			"'": "Quote",
			bracketleft: "BracketLeft",
			"[": "BracketLeft",
			bracketright: "BracketRight",
			"]": "BracketRight",
			backslash: "Backslash",
			"\\": "Backslash",
			minus: "Minus",
			"-": "Minus",
			equal: "Equal",
			"=": "Equal",
			backquote: "Backquote",
			"`": "Backquote"
		};
		/** Map one key token to its `KeyboardEvent.code`; unknown tokens map to nothing. */
		function keyCode(token) {
			const lower = token.toLowerCase();
			const named = KEY_CODES[lower];
			if (named !== void 0) return named;
			if (/^[a-z]$/.test(lower)) return `Key${lower.toUpperCase()}`;
			if (/^[0-9]$/.test(lower)) return `Digit${lower}`;
			if (/^f(?:[1-9]|1[0-2])$/.test(lower)) return `F${lower.slice(1)}`;
		}
		/**
		* Parse a shortcut spec such as `Tab`, `Alt+Slash`, `Alt+/`, or `Ctrl+Enter`
		* into an exact event matcher. Modifiers (`alt`, `ctrl`, `meta`, `shift`, with
		* aliases `option`, `control`, `cmd`, `command`) are case-insensitive and may
		* appear in any order before the single key token.
		* @param spec - the configured shortcut.
		* @returns an exact matcher, or `undefined` when the spec cannot be parsed
		* (an unknown key token, a missing key, or more than one key token).
		*/
		function parseAcceptKey(spec) {
			const parts = spec.trim().split(/\s*\+\s*/).map((part) => part.toLowerCase());
			if (parts.some((part) => part === "")) return void 0;
			let code;
			let alt = false;
			let ctrl = false;
			let meta = false;
			let shift = false;
			for (const part of parts) {
				if (part === "alt" || part === "option") {
					alt = true;
					continue;
				}
				if (part === "ctrl" || part === "control") {
					ctrl = true;
					continue;
				}
				if (part === "meta" || part === "cmd" || part === "command") {
					meta = true;
					continue;
				}
				if (part === "shift") {
					shift = true;
					continue;
				}
				if (code !== void 0) return void 0;
				code = keyCode(part);
				if (code === void 0) return void 0;
			}
			if (code === void 0) return void 0;
			return (event) => event.code === code && event.altKey === alt && event.ctrlKey === ctrl && event.metaKey === meta && event.shiftKey === shift;
		}
		//#endregion
		//#region src/browser/GhostSuggestion.tsx
		/**
		* Suggested-next-prompt ghost text: reads the `suggestPrompt` projection and,
		* when the session just completed a turn and the draft is empty, renders the
		* current suggestion as light placeholder text INSIDE the composer textarea
		* (overlay slot, pointer-events: none, so it never blocks input). Pressing the
		* configured shortcut (default `Tab`, like Claude Code) while focus sits in the
		* composer fills the draft with the suggestion through `inputActions.setDraft`,
		* leaving it editable.
		*/
		/** Fallback shortcut when the projection carries no key or the configured one is unparseable. */
		const DEFAULT_ACCEPT_KEY = "Tab";
		const DEFAULT_ACCEPT_MATCHER = (event) => event.code === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
		const STYLE_TAG_ID$1 = "dsh-suggest-prompt-style";
		let styleUsers = 0;
		const CSS_TEXT = `
.dsh-suggest-prompt-ghost {
  position: absolute;
  /* overlayAnchor sits at the composer card's top edge (inset: 0 0 auto).
     Align the ghost with the textarea's text origin: the card adds 10px top
     padding and the backdrop layer adds 4px top / 16px left (see InputBar).
     pointer-events:none keeps the caret and clicks on the textarea. */
  top: calc(10px + 4px);
  left: 16px;
  right: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: hidden;
  font: inherit;
  font-size: inherit;
  line-height: inherit;
  color: var(--dsw-alias-label-tertiary, #68707d);
  pointer-events: none;
  user-select: none;
}
/* The native composer placeholder (e.g. "给智能体发消息") renders at the same
   text origin as the ghost, so a suggestion would overlap it while the draft
   is empty. Hide it for the composer card that carries a visible ghost.
   WebKit paints placeholder glyphs with -webkit-text-fill-color (which
   outranks color), so BOTH properties must go transparent. */
[data-composer-card]:has(.dsh-suggest-prompt-ghost) textarea::placeholder {
  color: transparent;
  -webkit-text-fill-color: transparent;
}
`;
		const ROOT_STYLE = { display: "contents" };
		/**
		* The session's latest completed turn. `turnEnds` maps in-window turn numbers
		* to their `turn/end` event seqs in event order, so the last key is the newest
		* completed turn.
		*/
		function lastCompletedTurn(turnEnds) {
			let last;
			for (const turn of turnEnds.keys()) last = turn;
			return last;
		}
		/**
		* The suggestion to surface, or `undefined` when none should show: the
		* `suggestPrompt` projection answers the session's latest completed turn while
		* the agent is idle and the draft is empty.
		* @param projection - the live `suggestPrompt` projection value.
		* @param running - whether the session agent is mid-turn.
		* @param lastTurn - the session's latest completed turn.
		* @param draft - the current composer draft.
		* @returns the suggestion text to surface, or `undefined` to show nothing.
		*/
		function currentSuggestion(projection, running, lastTurn, draft) {
			if (running) return void 0;
			if (projection === null || projection === void 0) return void 0;
			if (lastTurn === void 0 || projection.turn !== lastTurn) return void 0;
			if (draft.trim() !== "") return void 0;
			return projection.text;
		}
		/**
		* Render the suggestion as placeholder text inside the composer; accept on the
		* configured shortcut (default Tab).
		* @param props - standard kit faces (session snapshot, input state, actions, projection).
		*/
		function GhostSuggestion({ useSession, useInput, useProjection, inputActions }) {
			const projection = useProjection("suggestPrompt");
			const text = currentSuggestion(projection, useSession((s) => s.running), useSession((s) => lastCompletedTurn(s.turnEnds)), useInput((s) => s.draft));
			const acceptMatcher = (0, react.useMemo)(() => parseAcceptKey(projection?.acceptKey ?? DEFAULT_ACCEPT_KEY) ?? DEFAULT_ACCEPT_MATCHER, [projection?.acceptKey]);
			(0, react.useEffect)(() => {
				if (text === void 0) return;
				const onKeyDown = (event) => {
					if (event.isComposing) return;
					if (!acceptMatcher(event)) return;
					if (!(document.activeElement instanceof HTMLTextAreaElement)) return;
					event.preventDefault();
					inputActions.setDraft(text);
				};
				window.addEventListener("keydown", onKeyDown);
				return () => {
					window.removeEventListener("keydown", onKeyDown);
				};
			}, [
				text,
				acceptMatcher,
				inputActions
			]);
			(0, react.useEffect)(() => {
				styleUsers += 1;
				if (document.getElementById(STYLE_TAG_ID$1) === null) {
					const tag = document.createElement("style");
					tag.id = STYLE_TAG_ID$1;
					tag.textContent = CSS_TEXT;
					document.head.appendChild(tag);
				}
				return () => {
					styleUsers -= 1;
					if (styleUsers !== 0) return;
					document.getElementById(STYLE_TAG_ID$1)?.remove();
				};
			}, []);
			if (text === void 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: ROOT_STYLE,
				"data-suggest-prompt-ghost": "",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsh-suggest-prompt-ghost",
					"aria-hidden": true,
					children: text
				})
			});
		}
		//#endregion
		//#region src/browser/SettingsCard.tsx
		/**
		* The suggest-prompt route card inside the WebUI plugin settings section:
		* provider/model for the ghost suggestion generation, chosen from the installed
		* provider catalog and staged until save. The chrome replicates the harness's
		* plugin settings cards (PluginCard/ValueField) so this card reads identically
		* to the built-in ones.
		* @module @studyzy/dsh-client-ui-suggest-prompt/settings-card
		*/
		/** Style tag id owning this card's copy of the plugin-card chrome. */
		const STYLE_TAG_ID = "dsh-suggest-prompt-settings-style";
		/** The plugin-card chrome, mirrored from the harness PluginCard/fields modules. */
		const CARD_CSS = `
.dsh-sug-card {
  list-style: none;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-3);
  transition: border-color .16s, background .16s;
}
.dsh-sug-card:hover { border-color: var(--dsw-alias-label-dimmed); }
.dsh-sug-card-open {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-label-dimmed);
}
.dsh-sug-header {
  width: 100%;
  appearance: none;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 12px;
}
.dsh-sug-header:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
.dsh-sug-head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dsh-sug-name {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--dsw-alias-label-primary);
}
.dsh-sug-description {
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-sug-chevron {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  transition: transform .16s;
}
.dsh-sug-chevron-open { transform: rotate(180deg); }
.dsh-sug-pending {
  flex: none;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 17px;
  font-weight: 500;
  white-space: nowrap;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
}
.dsh-sug-body {
  border-top: 1px solid var(--dsw-alias-border-l2);
  margin: 0 16px;
  padding-bottom: 8px;
}
.dsh-sug-readonly {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-sug-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0;
}
.dsh-sug-field + .dsh-sug-field { border-top: 1px solid var(--dsw-alias-border-l2); }
.dsh-sug-head { display: flex; align-items: center; gap: 8px; }
.dsh-sug-label {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dsh-sug-badges { display: inline-flex; align-items: center; gap: 8px; }
.dsh-sug-badge {
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 17px;
  white-space: nowrap;
  font-weight: 500;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
}
.dsh-sug-reset {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dsh-sug-reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.dsh-sug-reset:disabled { cursor: default; }
.dsh-sug-input {
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dsh-sug-input:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}
.dsh-sug-input:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.dsh-sug-select { padding-right: 28px; }
.dsh-sug-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-sug-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 0 4px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dsh-sug-failed {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-error);
}
.dsh-sug-discard,
.dsh-sug-save {
  appearance: none;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 5px 14px;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
}
.dsh-sug-discard {
  border-color: var(--dsw-alias-border-l2);
  background: none;
  color: var(--dsw-alias-label-secondary);
}
.dsh-sug-discard:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-label-dimmed);
}
.dsh-sug-save {
  background: var(--dsw-alias-label-primary);
  color: var(--dsw-alias-bg-layer-3);
}
.dsh-sug-discard:disabled,
.dsh-sug-save:disabled { opacity: 0.4; cursor: default; }
.dsh-sug-discard:focus-visible,
.dsh-sug-save:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
`;
		/** One route field row mirroring the harness ValueField, with a select control. */
		function RouteField(props) {
			const { t, id, label, hint, state, field, options, selectable, onEdit, onReset } = props;
			const value = state[field];
			const disabled = !state.writable;
			const className = `dsh-sug-input${selectable ? " dsh-sug-select" : ""}`;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-sug-field",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-sug-head",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							className: "dsh-sug-label",
							htmlFor: id,
							children: label
						}), value.overridden ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dsh-sug-badges",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-sug-badge",
								children: t("overridden")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-sug-reset",
								disabled,
								onClick: onReset,
								children: t("reset")
							})]
						}) : null]
					}),
					selectable ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
						id,
						className,
						value: value.text,
						disabled,
						onChange: (event) => {
							onEdit(event.target.value);
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "",
							children: t("followRoute")
						}), options.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: option.value,
							children: option.label
						}, option.value))]
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id,
						className,
						type: "text",
						value: value.text,
						disabled,
						onChange: (event) => {
							onEdit(event.target.value);
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "dsh-sug-hint",
						children: hint
					})
				]
			});
		}
		/**
		* Render the suggest-prompt route card.
		* @param props - locale copy, the card snapshot, and its form actions.
		* @returns the card, or nothing while the namespace is unavailable.
		*/
		function SettingsCard(props) {
			const { t } = props;
			const state = props.useSuggestPromptCard((snapshot) => snapshot);
			const [open, setOpen] = (0, react.useState)(false);
			if (!state.available) return null;
			const title = t("title");
			const blocked = !state.dirty || state.invalid || state.saving;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", {
				id: STYLE_TAG_ID,
				children: CARD_CSS
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: open ? "dsh-sug-card dsh-sug-card-open" : "dsh-sug-card",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: "dsh-sug-header",
					"aria-expanded": open,
					"aria-label": `${t(open ? "collapse" : "expand")}: ${title}`,
					onClick: () => {
						setOpen(!open);
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dsh-sug-head-text",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-sug-name",
								children: title
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-sug-description",
								children: t("description")
							})]
						}),
						state.dirty ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsh-sug-pending",
							children: t("unsaved")
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, { className: open ? "dsh-sug-chevron dsh-sug-chevron-open" : "dsh-sug-chevron" })
					]
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-sug-body",
					children: [
						!state.writable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsh-sug-readonly",
							children: t("readOnly")
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(RouteField, {
							t,
							id: "suggest-prompt-settings-provider",
							label: t("provider"),
							hint: t("providerHint"),
							state,
							field: "provider",
							options: state.providerOptions,
							selectable: state.providerOptions.length > 0,
							onEdit: (text) => {
								if (text === "") props.resetField("provider");
								else props.edit("provider", text);
							},
							onReset: () => {
								props.resetField("provider");
							}
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(RouteField, {
							t,
							id: "suggest-prompt-settings-model",
							label: t("model"),
							hint: t("modelHint"),
							state,
							field: "model",
							options: state.modelOptions,
							selectable: state.modelSelectable,
							onEdit: (text) => {
								if (text === "") props.resetField("model");
								else props.edit("model", text);
							},
							onReset: () => {
								props.resetField("model");
							}
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-sug-footer",
							children: [
								state.failed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsh-sug-failed",
									children: t("saveFailed")
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-sug-discard",
									disabled: !state.dirty || state.saving,
									onClick: props.discard,
									children: t("discard")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-sug-save",
									disabled: blocked,
									onClick: props.save,
									children: t(state.saving ? "saving" : "save")
								})
							]
						})
					]
				}) : null]
			})] });
		}
		//#endregion
		//#region src/browser/settings-controller.ts
		/**
		* The suggest-prompt settings card's staged form over the `suggest-prompt`
		* settings namespace. Edits are staged until save; a save writes the staged
		* route pair into the user settings document (the host plugin re-resolves its
		* config from the section, so the next completed turn uses the new model).
		*
		* The card's dropdowns read the `llm-pi-ai` settings namespace (the installed
		* provider catalog) read-only: provider names are its `providers` keys and the
		* model list is the selected provider's `models[].id`. A provider without an
		* explicit model list falls back to a free-text model field.
		* @module @studyzy/dsh-client-ui-suggest-prompt/settings-controller
		*/
		/**
		* Settings namespace of the suggest-prompt host plugin. Spelled here rather
		* than imported: a client package must not depend on a Host package, and the
		* host plugin that owns it spells the same value.
		*/
		const SUGGEST_PROMPT_NS = "suggest-prompt";
		/** The built-in DeepSeek adapter's provider route (spelled here, not imported). */
		const DEEPSEEK_PROVIDER = "deepseek-official";
		/** Bridges the `suggest-prompt` scope onto the card's staged form. */
		var SuggestPromptCardController = class {
			scope;
			catalogScope;
			deepSeekScope;
			staged = /* @__PURE__ */ new Map();
			store;
			unsubscribers;
			saving = false;
			failed = false;
			/**
			* @param scope - the bound settings scope for the `suggest-prompt` namespace.
			* @param catalogScope - the bound read-only scope for the `llm-pi-ai` provider catalog.
			* @param deepSeekScope - the bound read-only scope for the built-in DeepSeek adapter.
			*/
			constructor(scope, catalogScope, deepSeekScope) {
				this.scope = scope;
				this.catalogScope = catalogScope;
				this.deepSeekScope = deepSeekScope;
				this.store = (0, _deepseek_ai_dsh_client_runtime_client.createSnapshotStore)(this.projection());
				this.unsubscribers = [
					scope.subscribe(() => {
						this.publish();
					}),
					catalogScope.subscribe(() => {
						this.publish();
					}),
					deepSeekScope.subscribe(() => {
						this.publish();
					})
				];
			}
			/**
			* Stop observing the bound scopes. Call once when the owning fiber unloads.
			*/
			dispose() {
				for (const unsubscribe of this.unsubscribers) unsubscribe();
				this.unsubscribers.length = 0;
			}
			/**
			* Build the face the card's slot registration injects.
			* @returns the card's snapshot and its form actions.
			*/
			inject() {
				return {
					hooks: { suggestPromptCard: this.store },
					...this.actions()
				};
			}
			/** The form actions bound to this controller. */
			actions() {
				return {
					edit: (field, text) => {
						this.stage(field, {
							text,
							clear: false
						});
					},
					resetField: (field) => {
						this.stage(field, {
							text: this.baseValue(field),
							clear: true
						});
					},
					save: () => {
						this.save();
					},
					discard: () => {
						if (this.staged.size === 0 && !this.failed) return;
						this.staged.clear();
						this.failed = false;
						this.publish();
					}
				};
			}
			/** Publish the card state projection. */
			projection() {
				const snapshot = this.scope.getSnapshot();
				const section = snapshot.value ?? {};
				const providerOptions = this.catalogProviderOptions();
				const effectiveProvider = this.effectiveProvider(section);
				const catalogModels = this.catalogModels(effectiveProvider);
				const model = this.field("model", section.model);
				return {
					available: snapshot.status === "ready",
					writable: snapshot.writable,
					dirty: this.staged.size > 0,
					invalid: false,
					saving: this.saving,
					failed: this.failed,
					provider: this.field("provider", section.provider),
					model,
					providerOptions,
					modelOptions: catalogModels.length > 0 && model.text !== "" && !catalogModels.some((o) => o.value === model.text) ? [{
						value: model.text,
						label: model.text
					}, ...catalogModels] : catalogModels,
					modelSelectable: catalogModels.length > 0
				};
			}
			/** One control's draft state: staged text, override presence, and validity. */
			field(field, value) {
				const staged = this.staged.get(field);
				if (staged === void 0) return {
					text: typeof value === "string" ? value : "",
					overridden: this.stored(field),
					invalid: false
				};
				return {
					text: staged.clear ? "" : staged.text,
					overridden: !staged.clear,
					invalid: false
				};
			}
			/** The provider whose model list the card offers: the staged pick, else the section value. */
			effectiveProvider(section) {
				const staged = this.staged.get("provider");
				if (staged !== void 0) return staged.clear ? "" : staged.text.trim();
				return typeof section.provider === "string" ? section.provider : "";
			}
			/** Provider options: the pi-ai catalog routes plus the built-in DeepSeek route. */
			catalogProviderOptions() {
				const options = [];
				if (this.deepSeekScope.getSnapshot().status === "ready") options.push({
					value: DEEPSEEK_PROVIDER,
					label: "DeepSeek"
				});
				const catalog = this.catalogScope.getSnapshot();
				if (catalog.status === "ready" && catalog.value?.providers !== void 0) for (const route of Object.keys(catalog.value.providers).sort()) options.push({
					value: route,
					label: route
				});
				return options;
			}
			/** Explicit model options one provider lists; empty means the catalog defaults apply. */
			catalogModels(provider) {
				if (provider === "") return [];
				const models = provider === DEEPSEEK_PROVIDER ? this.deepSeekScope.getSnapshot().value?.models : this.catalogScope.getSnapshot().status === "ready" ? this.catalogScope.getSnapshot().value?.providers?.[provider]?.models : void 0;
				return models === void 0 ? [] : models.map((model) => ({
					value: model.id,
					label: model.id
				}));
			}
			/** The composition-layer value one field reverts to once cleared. */
			baseValue(field) {
				const value = this.scope.getSnapshot().base?.[field];
				return typeof value === "string" ? value : "";
			}
			/** Whether the user document layer carries this field (marks it overridden). */
			stored(field) {
				const user = this.scope.getSnapshot().user;
				return user !== void 0 && Object.hasOwn(user, field);
			}
			stage(field, edit) {
				this.staged.set(field, edit);
				this.failed = false;
				if (field === "provider") {
					const provider = edit.clear ? "" : edit.text.trim();
					const section = this.scope.getSnapshot().value ?? {};
					const stagedModel = this.staged.get("model");
					const model = stagedModel?.clear ? "" : stagedModel?.text.trim() !== void 0 ? stagedModel.text.trim() : this.stringValue(section.model);
					if (!this.modelServes(model, provider)) {
						const base = this.baseValue("model");
						if (base !== "") this.staged.set("model", {
							text: base,
							clear: true
						});
						else this.staged.delete("model");
					}
				}
				this.publish();
			}
			/** Whether one model id the effective provider route would resolve to. */
			modelServes(model, provider) {
				if (model === "" || provider === "") return true;
				const models = this.catalogModels(provider);
				return models.length === 0 || models.some((option) => option.value === model);
			}
			/** Read one scalar as a string from a settings section, else ''. */
			stringValue(value) {
				return typeof value === "string" ? value : "";
			}
			/** Write every staged edit, then re-seed from what the host accepted. */
			async save() {
				const writes = [...this.staged].flatMap(([field, edit]) => {
					if (edit.clear) return this.stored(field) ? [{
						field,
						run: () => this.scope.unset(field),
						verify: () => !this.stored(field)
					}] : [];
					const value = edit.text.trim();
					return value === "" ? [] : [{
						field,
						run: () => this.scope.set(field, value),
						verify: () => this.scope.getSnapshot().value?.[field] === value
					}];
				});
				for (const field of this.staged.keys()) if (!writes.some((write) => write.field === field)) this.staged.delete(field);
				if (writes.length === 0 || this.saving) {
					if (writes.length === 0) this.publish();
					return;
				}
				this.saving = true;
				this.failed = false;
				this.publish();
				let landed = true;
				for (const write of writes) try {
					await write.run();
					if (!write.verify()) landed = false;
				} catch {
					landed = false;
				}
				if (landed) this.staged.clear();
				this.saving = false;
				this.failed = !landed;
				this.publish();
			}
			publish() {
				this.store.set(this.projection());
			}
		};
		//#endregion
		//#region src/browser/settings-locales.ts
		/** English copy for the card. */
		const en = {
			title: "Suggested next prompt",
			description: "Model that generates the ghost suggestion after each turn",
			provider: "Provider",
			providerHint: "Registered pi-ai provider; choose \"follow session route\" to use the session model.",
			model: "Model",
			modelHint: "A model of the selected provider; choose \"follow session route\" to use the session model.",
			followRoute: "Follow session route",
			overridden: "overridden",
			reset: "Reset",
			readOnly: "Settings are read-only in this deployment.",
			expand: "Expand",
			collapse: "Collapse",
			save: "Save",
			saving: "Saving…",
			discard: "Discard",
			unsaved: "Unsaved",
			saveFailed: "Save failed; the host rejected the values."
		};
		/** Simplified Chinese copy for the card. */
		const zh = {
			title: "建议提示词",
			description: "每轮结束后生成幽灵建议所使用的模型",
			provider: "Provider",
			providerHint: "已注册的 pi-ai provider；选择\"跟随会话路由\"则使用会话模型。",
			model: "Model",
			modelHint: "所选 provider 的模型；选择\"跟随会话路由\"则使用会话模型。",
			followRoute: "跟随会话路由",
			overridden: "已覆盖",
			reset: "重置",
			readOnly: "当前部署下设置为只读。",
			expand: "展开",
			collapse: "收起",
			save: "保存",
			saving: "保存中…",
			discard: "放弃",
			unsaved: "未保存",
			saveFailed: "保存失败：宿主拒绝了该值。"
		};
		//#endregion
		//#region src/browser/index.ts
		/** Locale namespace of the settings card copy. */
		const NS = "suggest-prompt.settings";
		/** Required services for the suggestion ghost bridge (the slot registry only). */
		const inject = ["slots"];
		/**
		* Client plugin body: the GhostSuggestion overlay bridge entry, plus the
		* suggest-prompt settings card when the settings surface is composed. The
		* settings card is an enhancement over the core ghost bridge, so it mounts on
		* a scoped inject rather than the top-level dependency list — a deployment
		* without the WebUI settings surface still gets ghost suggestions.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.slots.inject("conversation.input.overlay", () => ctx.slots.register({
				name: "conversation.input.overlay",
				id: "suggest-prompt",
				order: 30
			}, GhostSuggestion));
			ctx.inject(["settingsScope", "locale"], (settingsCtx) => {
				settingsCtx.effect(() => settingsCtx.locale.register(NS, {
					zh,
					en
				}), "ui-suggest-prompt: settings card dictionary");
				const settings = new SuggestPromptCardController(settingsCtx.settingsScope.bind({ namespace: SUGGEST_PROMPT_NS }), settingsCtx.settingsScope.bind({ namespace: "llm-pi-ai" }), settingsCtx.settingsScope.bind({ namespace: "llm-deepseek" }));
				settingsCtx.effect(() => () => {
					settings.dispose();
				}, "ui-suggest-prompt: settings card scope observers");
				settingsCtx.slots.inject("settings.plugin.item", () => settingsCtx.slots.register({
					name: "settings.plugin.item",
					key: SUGGEST_PROMPT_NS,
					locale: NS,
					inject: () => settings.inject()
				}, SettingsCard));
			});
		}
		//#endregion
		exports.GhostSuggestion = GhostSuggestion;
		exports.SUGGEST_PROMPT_NS = SUGGEST_PROMPT_NS;
		exports.SettingsCard = SettingsCard;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
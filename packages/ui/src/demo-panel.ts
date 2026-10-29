import { createStorage } from "@flow-atlas/compute";
import { type AgentEvent, DemoAgent } from "./demo-agent.js";
import { DemoCommands } from "./demo-commands.js";
import { type DemoPopulation, DemoPopulations, populationName } from "./demo-populations.js";
import { DemoToolError } from "./demo-tool-errors.js";
import { Dictation } from "./dictation.js";
import {
	type ReferencePopulation,
	referencePopulations,
	resolvePopulation,
} from "./population-lookup.js";
import type { PointRenderer } from "./renderer.js";
import {
	intersectSelections,
	type Point,
	type SelectionAnalysis,
	SelectionEngine,
	type SelectionSpec,
	unionSelections,
	validateSelectionSpec,
} from "./selection-engine.js";
import { violinPlots } from "./violin-plots.js";
import type { LoadedWorkspace } from "./workspace.js";

const NS = "http://www.w3.org/2000/svg";
const object = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Tool input must be an object");
	return value as Record<string, unknown>;
};
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
export class DemoPanel {
	private readonly store = new DemoPopulations();
	private readonly agent = new DemoAgent();
	private readonly commands = new DemoCommands();
	private mcpToken: string | null = null;
	private lifecycleBusy = false;
	private readonly dictation: Dictation;
	private speechBase = "";
	private speechConfigured = false;
	private agentConfigured = false;
	private asking = false;
	private readonly engine: SelectionEngine;
	private readonly highlight: GPUBuffer;
	private readonly highlightSpare: GPUBuffer;
	private activeHighlight: GPUBuffer | null = null;
	private readonly mapStatus = document.createElement("div");
	private lastDisplay: { status: string; populationIds: string[]; error?: string } = {
		status: "initial",
		populationIds: [],
	};
	private readonly overlay = document.createElementNS(NS, "svg");
	private readonly root: HTMLElement;
	private readonly controller = new AbortController();
	private operation = new AbortController();
	private generation = 0;
	private draftRevision = 0;
	private draftBusy = false;
	private draftTask: Promise<void> | null = null;
	private selectedId: string | null = null;
	private referenceFocus: {
		id: string;
		name: string;
		source: SelectionSpec;
		analysis: SelectionAnalysis;
	} | null = null;
	private draft: { source: SelectionSpec; analysis: SelectionAnalysis } | null = null;
	private lasso = false;
	private drawing: { points: Point[]; lastX: number; lastY: number; pointer: number } | null = null;
	private hoverTimer: ReturnType<typeof setTimeout> | null = null;
	private displayRevision = 0;
	private highlightTail: Promise<void> = Promise.resolve();
	private highlightRequest: AbortController | null = null;
	private references: ReferencePopulation[];
	private readonly analysisCache = new Map<string, SelectionAnalysis>();

	constructor(
		private readonly device: GPUDevice,
		private readonly workspace: LoadedWorkspace,
		private readonly renderer: PointRenderer,
		private readonly colors: GPUBuffer,
		maxBinding: number,
		private readonly datasetKey: string,
		private readonly setMarker: (channel: string, signal?: AbortSignal) => Promise<void>,
		clearCache: () => Promise<void>,
	) {
		this.root = document.getElementById("demo-panel") as HTMLElement;
		this.root.inert = false;
		this.engine = new SelectionEngine(device, workspace, maxBinding);
		this.highlight = createStorage(device, workspace.n * 4, undefined, "demo.highlight");
		this.highlightSpare = createStorage(device, workspace.n * 4, undefined, "demo.highlight-spare");
		this.mapStatus.className = "map-agent-status";
		this.mapStatus.setAttribute("role", "status");
		this.mapStatus.textContent = "Lasso cells or ask the agent to explore";
		this.renderer.canvas.parentElement?.append(this.mapStatus);
		this.references = referencePopulations(
			workspace.populations,
			workspace.populations.map((name) =>
				workspace.samples.reduce(
					(sum, sample) => sum + (sample.gateCounts.find((gate) => gate.name === name)?.count ?? 0),
					0,
				),
			),
		);
		this.root.innerHTML = `<div class="demo-toolbar"><button id="demo-pan" type="button" aria-pressed="true">Pan</button><button id="demo-lasso" type="button" aria-pressed="false">Lasso</button><button id="demo-reset" type="button">Reset demo</button></div>
		<p id="demo-status" role="status" aria-live="polite">Lasso cells to inspect their expression pattern.</p>
		<div class="demo-name"><input id="demo-name" maxlength="80" placeholder="Name this population" aria-label="Population name"><button id="demo-save" type="button" disabled>Save</button></div>
		<div id="demo-populations" aria-label="Named populations"></div>
		<details open><summary id="demo-distribution-title">Channel distributions</summary><p class="demo-note">Display-transformed fluorescence. Independent channel scales; medians are histogram estimates.</p><div id="demo-violins" class="violin-grid"></div></details>
		<section class="demo-agent"><h2>Explore with the agent</h2><textarea id="demo-prompt" rows="3" maxlength="4000" placeholder="Find other interesting populations and compare them with my selection." aria-label="Agent instruction"></textarea>
		<div class="demo-toolbar"><button id="demo-send" type="button">Ask agent</button><button id="demo-stop" type="button">Stop</button><button id="demo-dictate" type="button" disabled>Dictate</button><span class="demo-note">EN / 日本語</span></div><p class="demo-note">Dictation uses Kotoleaf / Deepgram. Edit before sending. Kotoleaf transcript storage is disabled for this demo.</p>
		<details id="demo-connect"><summary>External agent connection</summary><p id="demo-connection-state">Connecting…</p><button id="demo-unlock" type="button">Reconnect</button><button id="demo-mcp" type="button" disabled>Copy MCP connection</button></details>
		<ol id="demo-activity" aria-label="Agent tool activity" aria-live="polite"></ol></section>
		<details><summary>Demo data</summary><button id="demo-clear-cache" type="button">Clear cached data and reload</button></details>`;
		this.root.hidden = false;
		this.dictation = new Dictation({
			getToken: () => this.agent.connection()?.token ?? null,
			onText: (finalText, interimText) => {
				if (!this.controller.signal.aborted)
					(this.el("demo-prompt") as HTMLTextAreaElement).value = [
						this.speechBase,
						finalText,
						interimText,
					]
						.filter(Boolean)
						.join(" ")
						.slice(0, 4000);
			},
			onState: (state, message) => {
				if (this.controller.signal.aborted) return;
				const active = ["connecting", "recording", "finishing"].includes(state),
					button = this.el("demo-dictate") as HTMLButtonElement;
				button.textContent =
					state === "recording"
						? "Stop dictation"
						: state === "connecting"
							? "Connecting mic…"
							: state === "finishing"
								? "Finishing…"
								: "Dictate";
				button.disabled = !this.speechConfigured || state === "connecting" || state === "finishing";
				button.setAttribute("aria-pressed", String(state === "recording"));
				(this.el("demo-prompt") as HTMLTextAreaElement).readOnly = active;
				(this.el("demo-send") as HTMLButtonElement).disabled =
					!this.agentConfigured || this.asking || active;
				if (message) this.status(message);
				else if (state === "recording")
					this.status("Listening in English / 日本語. Stop dictation to edit the transcript.");
			},
		});
		this.overlay.id = "selection-overlay";
		this.overlay.setAttribute("aria-label", "Population selection overlay");
		this.renderer.canvas.parentElement?.append(this.overlay);
		this.renderer.onViewChange = () => this.drawOverlay();
		const bind = (id: string, event: string, callback: EventListener) =>
			this.el(id).addEventListener(event, callback, { signal: this.controller.signal });
		bind("demo-pan", "click", () => this.setLasso(false));
		bind("demo-lasso", "click", () => this.setLasso(true));
		bind("demo-reset", "click", () => {
			void this.reset().catch((error) => this.status(errorText(error)));
		});
		bind("demo-clear-cache", "click", () => {
			void this.reset()
				.then(clearCache)
				.catch((e) => this.status(errorText(e)));
		});
		bind("demo-save", "click", () => {
			try {
				this.saveDraft();
			} catch (e) {
				this.status(errorText(e));
			}
		});
		bind("demo-unlock", "click", () => {
			void this.connect();
		});
		bind("demo-send", "click", () => {
			void this.ask();
		});
		bind("demo-stop", "click", () => {
			this.dictation.cancel();
			this.commands.stop();
			this.mcpToken = null;
			this.agent.cancel();
			this.operation.abort();
			this.operation = new AbortController();
			this.status(
				"Stopped. Existing selections are preserved. Reconnect to resume external MCP actions.",
			);
		});
		bind("demo-mcp", "click", () => {
			void this.copyMcp().catch((error) => this.status(errorText(error)));
		});
		bind("demo-dictate", "click", () => {
			void this.toggleDictation();
		});
		this.attachLasso();
		window.addEventListener(
			"pagehide",
			() => {
				this.commands.stop();
				this.dictation.cancel();
				void this.agent.disconnect().catch(() => {});
			},
			{ signal: this.controller.signal },
		);
		void this.agent
			.config()
			.then((config) => {
				this.agentConfigured = config.agentConfigured;
				this.speechConfigured = config.speechConfigured;
				(this.el("demo-dictate") as HTMLButtonElement).disabled = !config.speechConfigured;
				this.el("demo-connection-state").textContent = config.agentConfigured
					? `Ready · ${config.model}`
					: "The agent gateway is not configured yet. Lasso and statistics work locally.";
				(this.el("demo-send") as HTMLButtonElement).disabled = !config.agentConfigured;
				if (config.agentConfigured) void this.connect();
			})
			.catch(() => {
				this.el("demo-connection-state").textContent =
					"Agent connection unavailable. Lasso and statistics work locally.";
			});
	}
	private el(id: string) {
		return this.root.querySelector(`#${id}`) as HTMLElement;
	}
	private status(text: string) {
		this.el("demo-status").textContent = text;
	}
	private setLasso(enabled: boolean) {
		this.lasso = enabled;
		this.overlay.classList.toggle("drawing", enabled);
		this.el("demo-pan").setAttribute("aria-pressed", String(!enabled));
		this.el("demo-lasso").setAttribute("aria-pressed", String(enabled));
		this.status(
			enabled
				? "Draw around a population. All cells inside the embedding-space lasso will be analysed."
				: "Pan and zoom the map.",
		);
	}
	private attachLasso() {
		const options = { signal: this.controller.signal };
		this.overlay.addEventListener(
			"pointerdown",
			(event) => {
				if (!this.lasso || this.drawing || this.lifecycleBusy) return;
				event.preventDefault();
				this.overlay.setPointerCapture(event.pointerId);
				this.drawing = {
					pointer: event.pointerId,
					points: [this.renderer.screenToData(event.clientX, event.clientY)],
					lastX: event.clientX,
					lastY: event.clientY,
				};
				this.drawOverlay();
			},
			options,
		);
		this.overlay.addEventListener(
			"pointermove",
			(event) => {
				const drawing = this.drawing;
				if (!drawing || drawing.pointer !== event.pointerId) return;
				if (Math.hypot(event.clientX - drawing.lastX, event.clientY - drawing.lastY) < 5) return;
				if (drawing.points.length >= 128)
					drawing.points = drawing.points.filter((_, i) => i % 2 === 0);
				drawing.points.push(this.renderer.screenToData(event.clientX, event.clientY));
				drawing.lastX = event.clientX;
				drawing.lastY = event.clientY;
				this.drawOverlay();
			},
			options,
		);
		this.overlay.addEventListener(
			"pointerup",
			(event) => {
				const drawing = this.drawing;
				if (!drawing || drawing.pointer !== event.pointerId) return;
				this.drawing = null;
				this.setLasso(false);
				this.drawOverlay();
				if (drawing.points.length < 3) {
					this.status("Draw a closed area containing at least three points.");
					return;
				}
				this.draftTask = this.inspectDraft({ kind: "polygon", points: drawing.points });
			},
			options,
		);
		this.overlay.addEventListener(
			"pointercancel",
			() => {
				this.drawing = null;
				this.drawOverlay();
			},
			options,
		);
	}
	private drawOverlay() {
		this.overlay.replaceChildren();
		this.overlay.setAttribute(
			"viewBox",
			`0 0 ${this.renderer.canvas.clientWidth} ${this.renderer.canvas.clientHeight}`,
		);
		const add = (points: Point[], color: string, name = "", id?: string) => {
			const xy = points.map((point) => this.renderer.dataToScreen(point));
			const polygon = document.createElementNS(NS, "polygon");
			polygon.setAttribute("points", xy.map((p) => `${p.x},${p.y}`).join(" "));
			polygon.setAttribute("fill", color);
			polygon.setAttribute("fill-opacity", id === this.selectedId ? ".12" : ".04");
			polygon.setAttribute("stroke", color);
			polygon.setAttribute("stroke-width", id === this.selectedId ? "3" : "1.5");
			if (id) {
				polygon.classList.add("population-outline");
				polygon.addEventListener("click", () => this.select(id));
			}
			this.overlay.append(polygon);
			if (name && xy[0]) {
				const label = document.createElementNS(NS, "text");
				label.textContent = name;
				label.setAttribute("x", String(xy[0].x));
				label.setAttribute("y", String(xy[0].y - 5));
				label.setAttribute("fill", color);
				this.overlay.append(label);
			}
		};
		for (const item of this.store.items)
			if (item.source.kind === "polygon") add(item.source.points, item.color, item.name, item.id);
		if (this.draft?.source.kind === "polygon") add(this.draft.source.points, "#ffcc66");
		if (this.drawing) add(this.drawing.points, "#ffffff");
	}
	private async inspectDraft(source: SelectionSpec) {
		this.referenceFocus = null;
		this.draftBusy = true;
		this.operation.abort();
		this.operation = new AbortController();
		const draftRevision = ++this.draftRevision,
			signal = this.operation.signal;
		this.draft = null;
		this.selectedId = null;
		(this.el("demo-save") as HTMLButtonElement).disabled = true;
		this.status("Analysing selected cells…");
		try {
			const analysis = await this.engine.analyze(source, { signal });
			if (draftRevision !== this.draftRevision || signal.aborted) return;
			this.draft = { source, analysis };
			this.showAnalysis("Current lasso", analysis, "#ffcc66");
			(this.el("demo-save") as HTMLButtonElement).disabled = analysis.count === 0;
			this.status(
				`${analysis.count.toLocaleString()} cells selected. Inspect the distributions and give this population a name.`,
			);
			this.drawOverlay();
			this.queueHighlight(source);
		} catch (error) {
			if (!signal.aborted) this.status(errorText(error));
		} finally {
			if (draftRevision === this.draftRevision) this.draftBusy = false;
		}
	}
	private saveDraft(automatic = false) {
		if (this.lifecycleBusy) throw new Error("Wait for the session transition to finish");
		if (!this.draft) throw new Error("Draw a selection first");
		const entered = (this.el("demo-name") as HTMLInputElement).value.trim();
		const item = this.store.add(
			{
				name: populationName(
					entered ||
						(automatic
							? `Your lasso ${this.store.items.filter((p) => p.actor === "human").length + 1}`
							: ""),
				),
				actor: "human",
				source: this.draft.source,
				analysis: this.draft.analysis,
				rationale: "User lasso in embedding space",
				refines: null,
			},
			this.store.revision,
		);
		this.draft = null;
		(this.el("demo-save") as HTMLButtonElement).disabled = true;
		this.renderList();
		this.select(item.id);
		this.status(`Saved ${item.name}. Ask the agent to compare or refine it.`);
	}
	private showAnalysis(name: string, analysis: SelectionAnalysis, color: string) {
		this.el("demo-distribution-title").textContent =
			`${name} · ${analysis.count.toLocaleString()} cells`;
		violinPlots(this.el("demo-violins"), analysis, color, this.workspace.originalChannelNames);
	}
	private select(id: string, fromAgent = false) {
		if (fromAgent && (this.draft || this.drawing || this.draftBusy)) return;
		if (!fromAgent) {
			this.operation.abort();
			this.draftRevision++;
			this.draftBusy = false;
			this.draft = null;
			(this.el("demo-save") as HTMLButtonElement).disabled = true;
		}
		const item = this.store.get(id);
		this.referenceFocus = null;
		this.selectedId = item.id;
		this.showAnalysis(item.name, item.analysis, item.color);
		this.drawOverlay();
		this.renderList();
		this.queueHighlight(item.source);
	}
	private restoreInspection() {
		const item = this.store.items.find((population) => population.id === this.selectedId);
		if (item) {
			this.showAnalysis(item.name, item.analysis, item.color);
			this.queueHighlight(item.source);
		} else if (this.referenceFocus) {
			this.showAnalysis(this.referenceFocus.name, this.referenceFocus.analysis, "#82b5ff");
			this.queueHighlight(this.referenceFocus.source);
		} else if (this.draft) {
			this.showAnalysis("Current lasso", this.draft.analysis, "#ffcc66");
			this.queueHighlight(this.draft.source);
		} else {
			this.el("demo-distribution-title").textContent = "Channel distributions";
			this.el("demo-violins").replaceChildren();
			this.queueHighlight(null);
		}
	}
	private queueHighlight(source: SelectionSpec | null) {
		this.highlightRequest?.abort();
		const controller = new AbortController();
		this.highlightRequest = controller;
		const signal = AbortSignal.any([controller.signal, this.controller.signal]);
		const ticket = ++this.displayRevision;
		this.highlightTail = this.highlightTail
			.catch(() => {})
			.then(async () => {
				if (ticket !== this.displayRevision || this.controller.signal.aborted) return;
				const pack = (color: string) =>
					Number.parseInt(color.slice(5, 7) + color.slice(3, 5) + color.slice(1, 3), 16);
				const layers = this.store.items
					.filter((item) => item.source !== source)
					.map((item) => ({ source: item.source, color: pack(item.color) }));
				const focused = this.store.items.find((item) => item.source === source);
				if (source) layers.push({ source, color: pack(focused?.color ?? "#ffcc66") });
				const target =
					this.activeHighlight === this.highlight ? this.highlightSpare : this.highlight;
				if (layers.length) await this.engine.compose(layers, this.colors, target, signal);
				if (ticket !== this.displayRevision || this.controller.signal.aborted) return;
				await this.renderer.pause();
				if (ticket !== this.displayRevision || signal.aborted) return;
				this.renderer.setColors(
					this.workspace.embedding as GPUBuffer,
					layers.length ? target : this.colors,
					layers.length > 0,
				);
				this.activeHighlight = layers.length ? target : null;
				await this.renderer.draw(true);
				if (ticket !== this.displayRevision || signal.aborted) return;
				this.lastDisplay = { status: "rendered", populationIds: this.store.items.map((p) => p.id) };
				this.mapStatus.textContent = focused
					? `Showing ${focused.name} · ${focused.analysis.count.toLocaleString()} cells`
					: source
						? "Showing the current selection"
						: layers.length
							? `Showing ${layers.length} populations`
							: "All cells · ready";
			})
			.catch((e) => {
				if (!signal.aborted) {
					this.lastDisplay = { status: "failed", populationIds: [], error: errorText(e) };
					this.status(errorText(e));
					this.mapStatus.textContent = "Display update failed";
				}
			});
	}
	private displayState() {
		return {
			...this.lastDisplay,
			selectedId: this.selectedId ?? this.referenceFocus?.id ?? null,
			layers: this.store.items.map((p) => ({
				id: p.id,
				name: p.name,
				count: p.analysis.count,
				plottableCount: p.analysis.plottableCount ?? p.analysis.count,
				color: p.color,
			})),
			draftPresent: !!this.draft,
			viewer: this.renderer.viewState(),
		};
	}
	private async present(item: DemoPopulation, signal: AbortSignal, guard?: () => Promise<void>) {
		this.select(item.id, true);
		await this.highlightTail;
		signal.throwIfAborted();
		await guard?.();
		signal.throwIfAborted();
		if (this.selectedId === item.id && !this.drawing && !this.draftBusy && item.analysis.bounds)
			await this.renderer.focus(item.analysis.bounds);
		return this.displayState();
	}
	onColorsChanged() {
		this.queueHighlight(
			this.selectedId
				? this.store.get(this.selectedId).source
				: (this.referenceFocus?.source ?? this.draft?.source ?? null),
		);
	}
	private renderList() {
		const list = this.el("demo-populations");
		list.replaceChildren();
		for (const item of this.store.items) {
			const row = document.createElement("div");
			row.className = "demo-population";
			row.style.borderColor = item.color;
			const pick = document.createElement("button");
			pick.type = "button";
			pick.textContent = `${item.name} · ${item.analysis.count.toLocaleString()}`;
			pick.setAttribute("aria-pressed", String(this.selectedId === item.id));
			pick.onclick = () => this.select(item.id);
			row.onpointerenter = () => {
				if (this.hoverTimer) clearTimeout(this.hoverTimer);
				this.hoverTimer = setTimeout(() => {
					this.showAnalysis(item.name, item.analysis, item.color);
					this.queueHighlight(item.source);
				}, 120);
			};
			row.onpointerleave = () => {
				if (this.hoverTimer) clearTimeout(this.hoverTimer);
				this.restoreInspection();
			};
			const attribution = document.createElement("small");
			attribution.textContent =
				item.actor === "human"
					? "Human selection"
					: item.accepted
						? "Agent suggestion · accepted"
						: "Agent suggestion";
			attribution.title = item.rationale;
			if (item.source.kind === "reference")
				attribution.textContent += ` · imported ${this.workspace.populations[item.source.population]}`;
			else if (item.source.kind === "ranges")
				attribution.textContent += " · display-channel ranges";
			if (item.refines) attribution.textContent += " · refinement proposal";
			if (item.within)
				attribution.textContent += ` · subset of ${this.store.items.find((p) => p.id === item.within)?.name ?? this.references.find((p) => p.id === item.within)?.name ?? item.within}`;
			if (item.source.kind === "intersection") {
				const refs = item.source.selections
					.filter((part) => part.kind === "reference")
					.map((part) => this.workspace.populations[part.population]);
				if (refs.length) attribution.textContent += ` · imported ${refs.join(" + ")}`;
			}
			const rename = document.createElement("button");
			rename.type = "button";
			rename.textContent = "Rename";
			rename.onclick = () => {
				const name = prompt("Population name", item.name);
				if (name !== null) {
					try {
						this.store.rename(item.id, name, "human", this.store.revision);
						this.renderList();
						this.drawOverlay();
						this.restoreInspection();
					} catch (e) {
						this.status(errorText(e));
					}
				}
			};
			const remove = document.createElement("button");
			remove.type = "button";
			remove.textContent = "Remove";
			remove.onclick = () => {
				this.store.remove(item.id, "human", this.store.revision);
				if (this.selectedId === item.id) {
					this.selectedId = null;
					this.queueHighlight(null);
				}
				this.renderList();
				this.drawOverlay();
				this.restoreInspection();
			};
			row.append(pick, attribution, rename, remove);
			if (item.actor === "agent" && !item.accepted) {
				const accept = document.createElement("button");
				accept.textContent = "Accept";
				accept.onclick = () => {
					this.store.accept(item.id);
					this.renderList();
				};
				row.append(accept);
			}
			list.append(row);
		}
	}
	private summary(item: DemoPopulation) {
		return {
			id: item.id,
			name: item.name,
			actor: item.actor,
			accepted: item.accepted,
			count: item.analysis.count,
			refines: item.refines,
			within: item.within ?? null,
			rationale: item.rationale,
			sourceKind: item.source.kind,
		};
	}
	private async analyzeSource(
		source: SelectionSpec,
		signal: AbortSignal,
	): Promise<SelectionAnalysis> {
		signal.throwIfAborted();
		const key = JSON.stringify(source),
			generation = this.generation;
		const cached = this.analysisCache.get(key);
		if (cached) return cached;
		const analysis = await this.engine.analyze(source, { signal });
		signal.throwIfAborted();
		if (generation !== this.generation)
			throw new DemoToolError("state_changed", "The demo changed; inspect_dataset again.");
		if (this.analysisCache.size >= 32)
			this.analysisCache.delete(this.analysisCache.keys().next().value as string);
		this.analysisCache.set(key, analysis);
		return analysis;
	}
	private context() {
		return {
			revision: this.store.revision,
			datasetKey: this.datasetKey,
			total: this.workspace.n,
			selectedId: this.selectedId ?? this.referenceFocus?.id ?? null,
			embeddingBounds: this.workspace.bounds,
			channels: this.workspace.channels.map((name, index) => ({
				index,
				name,
				originalNames: this.workspace.originalChannelNames?.[index] ?? [],
				domain: "display-transformed",
			})),
			populations: this.store.items.map((item) => this.summary(item)),
			referencePopulations: this.references,
			selectionMeaning:
				"Exploratory embedding/display-space selection, not a validated raw-channel gate. Reference populations are imported annotations, not new discoveries.",
		};
	}
	async invoke(
		name: string,
		input: unknown,
		signal: AbortSignal,
		guard?: () => Promise<void>,
	): Promise<unknown> {
		signal.throwIfAborted();
		if (this.lifecycleBusy) throw new Error("Session transition in progress");
		await guard?.();
		signal.throwIfAborted();
		const args = object(input),
			generation = this.generation;
		if (name === "inspect_dataset") return this.context();
		if (name === "inspect_view") {
			await this.highlightTail;
			signal.throwIfAborted();
			return this.displayState();
		}
		if (name === "list_populations")
			return {
				revision: this.store.revision,
				populations: this.store.items.map((p) => this.summary(p)),
				references: this.references,
			};
		if (name === "inspect_population") {
			const target = resolvePopulation(args.id, this.store.items, this.references);
			const within =
				args.within == null
					? null
					: resolvePopulation(args.within, this.store.items, this.references);
			const source = within ? intersectSelections(within.source, target.source) : target.source;
			const analysis =
				!within && target.named ? target.named.analysis : await this.analyzeSource(source, signal);
			const base = within
				? (target.named?.analysis ?? (await this.analyzeSource(target.source, signal)))
				: analysis;
			const parent = within
				? (within.named?.analysis ?? (await this.analyzeSource(within.source, signal)))
				: null;
			signal.throwIfAborted();
			await guard?.();
			signal.throwIfAborted();
			return {
				id: target.id,
				name: target.name,
				actor: target.named?.actor ?? (target.reference ? "imported-reference" : "dataset"),
				accepted: target.named?.accepted ?? false,
				count: analysis.count,
				total: analysis.total,
				within: within?.id ?? null,
				withinName: within?.name ?? null,
				...(within
					? {
							overlap: {
								count: analysis.count,
								ofTarget: base.count ? analysis.count / base.count : null,
								ofWithin: parent?.count ? analysis.count / parent.count : null,
								targetCount: base.count,
								withinCount: parent?.count,
							},
						}
					: {}),
				...(args.includeGeometry === true ? { source } : { sourceKind: source.kind }),
				channels: analysis.channels.map(({ bins, ...channel }) => ({
					...channel,
					// Compact the GPU histogram for the model without sending event data.
					histogram: Array.from({ length: 32 }, (_, i) =>
						bins.slice(i * 4, i * 4 + 4).reduce((sum, count) => sum + count, 0),
					),
				})),
				revision: this.store.revision,
			};
		}
		if (name === "create_population" || name === "combine_populations") {
			this.store.checkRevision(args.expectedRevision);
			const revision = this.store.revision;
			let source: SelectionSpec;
			if (name === "combine_populations") {
				if (!Array.isArray(args.ids) || args.ids.length < 2 || args.ids.length > 8)
					throw new DemoToolError("invalid_union", "Choose 2–8 population ids to combine.");
				source = unionSelections(
					...args.ids.map((id) => resolvePopulation(id, this.store.items, this.references).source),
				);
			} else source = object(args.source) as unknown as SelectionSpec;
			const within =
				args.within == null
					? null
					: resolvePopulation(args.within, this.store.items, this.references);
			if (within) source = intersectSelections(within.source, source);
			validateSelectionSpec(
				source,
				this.workspace.channels.length,
				this.workspace.populations.length,
			);
			const label = populationName(args.name);
			const analysis = await this.analyzeSource(source, signal);
			signal.throwIfAborted();
			await guard?.();
			signal.throwIfAborted();
			if (generation !== this.generation)
				throw new Error("Demo reset or selection changed; inspect the dataset again");
			if (!analysis.count)
				throw new DemoToolError(
					"empty_selection",
					"This selection or intersection contains no cells. Inspect a different reference; do not invent a threshold.",
				);
			const item = this.store.add(
				{
					name: label,
					source,
					analysis,
					actor: "agent",
					rationale:
						typeof args.rationale === "string"
							? args.rationale.slice(0, 1000)
							: "Agent-created candidate",
					refines: typeof args.refines === "string" ? args.refines : null,
					...(within ? { within: within.id } : {}),
				},
				revision,
			);
			this.renderList();
			const display = await this.present(item, signal, guard);
			return {
				...this.summary(item),
				revision: this.store.revision,
				focused: this.selectedId === item.id,
				display,
			};
		}
		if (name === "rename_population") {
			this.store.rename(args.id, args.name, "agent", args.expectedRevision);
			this.renderList();
			this.drawOverlay();
			this.restoreInspection();
			return { revision: this.store.revision };
		}
		if (name === "delete_population") {
			this.store.remove(args.id, "agent", args.expectedRevision);
			if (this.selectedId === args.id) {
				this.selectedId = null;
				this.queueHighlight(null);
			}
			this.renderList();
			this.drawOverlay();
			this.restoreInspection();
			return { revision: this.store.revision };
		}
		if (name === "select_population") {
			const target = resolvePopulation(args.id, this.store.items, this.references);
			if (target.named) {
				this.select(target.id, true);
				await this.highlightTail;
				signal.throwIfAborted();
				await guard?.();
				signal.throwIfAborted();
				const focused = this.selectedId === target.id && !this.drawing && !this.draftBusy;
				if (focused && args.focus !== false && target.named.analysis.bounds)
					await this.renderer.focus(target.named.analysis.bounds);
				return { ...this.summary(target.named), focused, display: this.displayState() };
			}
			const analysis = await this.analyzeSource(target.source, signal);
			await guard?.();
			signal.throwIfAborted();
			if (generation !== this.generation)
				throw new DemoToolError("state_changed", "Demo changed; inspect_dataset again.");
			const focused = !(this.draft || this.drawing || this.draftBusy);
			if (focused) {
				this.selectedId = null;
				this.referenceFocus = { ...target, analysis };
				this.showAnalysis(target.name, analysis, "#82b5ff");
				this.renderList();
				this.drawOverlay();
				this.queueHighlight(target.source);
				await this.highlightTail;
				signal.throwIfAborted();
				await guard?.();
				signal.throwIfAborted();
				if (
					this.referenceFocus?.id === target.id &&
					!this.drawing &&
					!this.draftBusy &&
					args.focus !== false &&
					analysis.bounds
				)
					await this.renderer.focus(analysis.bounds);
			}
			return {
				id: target.id,
				name: target.name,
				count: analysis.count,
				focused,
				display: this.displayState(),
			};
		}
		if (name === "set_marker") {
			if (
				typeof args.channel !== "string" ||
				!["labels", ...this.workspace.channels].includes(args.channel)
			)
				throw new Error("Unknown marker");
			await this.setMarker(args.channel, signal);
			signal.throwIfAborted();
			return { channel: args.channel };
		}
		throw new Error("Unknown tool");
	}
	private activity(event: AgentEvent) {
		if (event.type === "tool-call")
			this.mapStatus.textContent = `Agent working · ${event.name ?? event.text}`;
		const list = this.el("demo-activity"),
			item = document.createElement("li");
		item.className = `activity-${event.type}`;
		item.textContent = event.text;
		if (event.details) {
			const details = document.createElement("details"),
				summary = document.createElement("summary"),
				data = document.createElement("pre");
			summary.textContent = "Tool data (preview)";
			data.textContent = event.details;
			details.append(summary, data);
			item.append(details);
		}
		list.append(item);
		while (list.children.length > 60) list.firstElementChild?.remove();
		list.scrollTop = list.scrollHeight;
	}
	private async connect() {
		if (this.lifecycleBusy || this.controller.signal.aborted) return;
		this.dictation.cancel();
		this.lifecycleBusy = true;
		this.root.inert = true;
		this.commands.stop();
		this.mcpToken = null;
		this.agent.cancel();
		try {
			await this.agent.disconnect();
			await this.agent.connect();
			this.el("demo-connection-state").textContent =
				"Connected. Commands apply only to this demo session.";
			(this.el("demo-connect") as HTMLDetailsElement).open = false;
			(this.el("demo-mcp") as HTMLButtonElement).disabled = false;
		} catch (e) {
			if (!this.controller.signal.aborted)
				this.el("demo-connection-state").textContent = errorText(e);
		} finally {
			this.lifecycleBusy = false;
			if (!this.controller.signal.aborted) this.root.inert = false;
		}
	}
	private async ask() {
		if (this.lifecycleBusy || this.dictation.recording || this.asking) return;
		const field = this.el("demo-prompt") as HTMLTextAreaElement,
			send = this.el("demo-send") as HTMLButtonElement;
		if (!field.value.trim()) return;
		if (!this.agent.connected) {
			await this.connect();
			if (!this.agent.connected) return;
		}
		send.disabled = true;
		this.asking = true;
		try {
			if (this.draftBusy && this.draftTask) {
				this.status("Finishing the lasso before starting the agent…");
				await this.draftTask;
			}
			if (this.draft?.analysis.count) this.saveDraft(true);
			await this.agent.ask(
				field.value,
				this.context(),
				(name, input, signal) => this.invoke(name, input, signal),
				(event) => this.activity(event),
			);
		} catch (e) {
			this.status(errorText(e));
		} finally {
			this.asking = false;
			send.disabled = !this.agentConfigured || this.dictation.recording;
		}
	}
	private async toggleDictation() {
		if (this.lifecycleBusy) return;
		if (!this.agent.connected) {
			await this.connect();
			if (!this.agent.connected) return;
		}
		try {
			if (this.dictation.recording) await this.dictation.stop();
			else {
				this.speechBase = (this.el("demo-prompt") as HTMLTextAreaElement).value.trim();
				await this.dictation.start();
			}
		} catch (error) {
			this.status(errorText(error));
		}
	}
	private async copyMcp() {
		const connection = this.agent.connection();
		if (!connection) return;
		if (this.mcpToken !== connection.token) {
			this.commands.start(
				connection,
				(name, args, signal, guard) => this.invoke(name, args, signal, guard),
				(event) => this.activity(event),
			);
			this.mcpToken = connection.token;
		}
		await navigator.clipboard.writeText(
			JSON.stringify(
				{
					type: "http",
					url: `${location.origin}/api/demo/mcp`,
					headers: { Authorization: `Bearer ${connection.token}` },
				},
				null,
				2,
			),
		);
		this.status("Copied this session's MCP connection. It expires when you reset or disconnect.");
	}
	async reset() {
		if (this.lifecycleBusy || this.controller.signal.aborted) return;
		this.dictation.cancel();
		this.speechBase = "";
		this.lifecycleBusy = true;
		this.root.inert = true;
		this.commands.stop();
		this.mcpToken = null;
		this.generation++;
		this.displayRevision++;
		this.operation.abort();
		this.operation = new AbortController();
		if (this.hoverTimer) clearTimeout(this.hoverTimer);
		this.store.reset();
		this.analysisCache.clear();
		this.draft = null;
		this.selectedId = null;
		this.drawing = null;
		this.referenceFocus = null;
		this.draftBusy = false;
		this.draftRevision++;
		(this.el("demo-name") as HTMLInputElement).value = "";
		(this.el("demo-prompt") as HTMLTextAreaElement).value = "";
		(this.el("demo-save") as HTMLButtonElement).disabled = true;
		(this.el("demo-mcp") as HTMLButtonElement).disabled = true;
		this.el("demo-activity").replaceChildren();
		this.el("demo-violins").replaceChildren();
		this.renderList();
		this.drawOverlay();
		let revocationFailed = false;
		try {
			await this.agent.disconnect();
		} catch {
			revocationFailed = true;
		}
		if (this.controller.signal.aborted) {
			this.lifecycleBusy = false;
			return;
		}
		this.renderer.zoom = 1;
		this.renderer.panX = 0;
		this.renderer.panY = 0;
		try {
			await this.setMarker("labels");
			this.queueHighlight(null);
			await this.highlightTail;
			this.setLasso(false);
			this.status(
				revocationFailed
					? "Local demo reset. Remote session revocation could not be confirmed; the browser is disconnected."
					: "Demo reset. Dataset cache retained; draw a new selection.",
			);
		} finally {
			this.lifecycleBusy = false;
			if (!this.controller.signal.aborted) this.root.inert = false;
		}
		if (this.agentConfigured && !this.controller.signal.aborted) await this.connect();
	}
	async dispose() {
		this.commands.stop();
		this.controller.abort();
		this.dictation.cancel();
		this.operation.abort();
		this.generation++;
		this.displayRevision++;
		if (this.hoverTimer) clearTimeout(this.hoverTimer);
		await this.agent.disconnect().catch(() => {});
		await this.highlightTail;
		this.renderer.onViewChange = null;
		this.overlay.remove();
		this.mapStatus.remove();
		this.root.hidden = true;
		await this.device.queue.onSubmittedWorkDone().catch(() => {});
		this.highlight.destroy();
		this.highlightSpare.destroy();
	}
}

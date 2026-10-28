import { acquireDevice, bind, createStorage, readback, upload } from "@flow-atlas/compute";
import { browserCache } from "./browser-cache.js";
import colorizeSrc from "./colorize.wgsl?raw";
import {
	clearComputationRecord,
	embeddingSettings,
	publishComputationRecord,
} from "./computation.js";
import { DemoPanel } from "./demo-panel.js";
import { createLoadGate, downloadPresentation } from "./loading.js";
import {
	downloadPublicationFiles,
	loadPublicationManifest,
	PUBLICATION_EMBED_OPTIONS,
} from "./publication.js";
import { renderBatches } from "./render-budget.js";
import { PointRenderer } from "./renderer.js";
import {
	computeEmbedding,
	type LoadedWorkspace,
	loadWorkspace,
	PROJECTION_BATCH_EVENTS,
} from "./workspace.js";
import { restoreWorkspaceCache, saveWorkspaceCache, workspaceCacheKey } from "./workspace-cache.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const status = $("status"),
	detail = $("download-detail");
const progressBar = $<HTMLProgressElement>("download-progress");
const retry = $<HTMLButtonElement>("retry-load");
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const clearRecord = () => clearComputationRecord($("computation-record"));
// Optional private demo-launch link: consume the application access code from
// the fragment (never sent to the server in the URL), then remove it from history.
const launchParams = new URLSearchParams(location.hash.slice(1));
const demoAccessCode = launchParams.get("demo") ?? undefined;
if (demoAccessCode) {
	launchParams.delete("demo");
	history.replaceState(
		null,
		"",
		`${location.pathname}${location.search}${launchParams.size ? `#${launchParams}` : ""}`,
	);
}
let lastStage = "initialization";
const log = (value: string) => {
	lastStage = value;
	status.setAttribute("role", "status");
	status.textContent = value;
	detail.textContent = "";
	progressBar.hidden = false;
	progressBar.removeAttribute("value");
	console.log(value);
};
const showError = (error: unknown) => {
	clearRecord();
	$("loading-overlay").hidden = false;
	$("sidebar").hidden = true;
	$("data-summary").hidden = true;
	status.setAttribute("role", "alert");
	status.textContent = message(error);
	detail.textContent = "";
	progressBar.hidden = true;
	retry.hidden = false;
	console.error(error);
};
retry.onclick = () => location.reload();

// Track invocation-owned allocations, including partial loader failures; all GPU
// methods still execute on the actual device. No numerical fallback is introduced.
function bufferScope(device: GPUDevice) {
	const buffers = new Set<GPUBuffer>();
	const tracked = new Proxy(device, {
		get(target, key) {
			if (key === "createBuffer")
				return (descriptor: GPUBufferDescriptor) => {
					if (descriptor.size > target.limits.maxBufferSize)
						throw new Error("The selected sample exceeds this GPU's buffer limit.");
					const buffer = target.createBuffer(descriptor);
					buffers.add(buffer);
					return buffer;
				};
			const value: unknown = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return {
		device: tracked,
		releaseExcept(keep = new Set<GPUBuffer>()) {
			for (const buffer of buffers)
				if (!keep.has(buffer)) {
					buffer.destroy();
					buffers.delete(buffer);
				}
		},
	};
}
const LABEL_PALETTE = [
	"#0173B2",
	"#DE8F05",
	"#029E73",
	"#D55E00",
	"#CC78BC",
	"#CA9161",
	"#FBAFE4",
	"#949494",
	"#ECE133",
	"#56B4E9",
	"#8C564B",
	"#17BECF",
	"#BCBD22",
	"#E377C2",
	"#7F7F7F",
	"#AEC7E8",
	"#FFBB78",
	"#98DF8A",
	"#FF9896",
	"#C5B0D5",
];
const DEFAULT_COLOR = "#663F46";
const CHANNEL_PALETTE = [
	"#440154",
	"#482878",
	"#3E4A89",
	"#31688E",
	"#26828E",
	"#1F9E89",
	"#35B779",
	"#6DCD59",
	"#B4DE2C",
	"#FDE725",
];
const hexToRgba8 = (hex: string, alpha = 255): number => {
	const value = Number.parseInt(hex.slice(1), 16);
	return ((alpha << 24) | ((value & 0xff) << 16) | (value & 0xff00) | (value >> 16)) >>> 0;
};

async function main() {
	log("Preparing map…");
	let dev: Awaited<ReturnType<typeof acquireDevice>>;
	try {
		dev = await acquireDevice();
	} catch (error) {
		showError(new Error(`WebGPU unavailable: ${message(error)}`));
		return;
	}
	const { device, limits } = dev;
	const computeBinding = Math.min(limits.maxStorageBufferBindingSize, 128 * 2 ** 20);
	const gate = createLoadGate();
	let deviceLost = false,
		loadAbort: AbortController | null = null;
	device.lost.then((info) => {
		deviceLost = true;
		loadAbort?.abort(new Error("GPU device lost"));
		showError(
			new Error(
				`GPU device lost (${info.reason}) after ${lastStage}: ${info.message}. Retry to reload.`,
			),
		);
		$("canvas").style.pointerEvents = "none";
		retry.disabled = false;
	});
	let renderer: PointRenderer, colorize: GPUComputePipeline;
	try {
		renderer = new PointRenderer(
			device,
			$<HTMLCanvasElement>("canvas"),
			(error) => {
				if (!deviceLost) showError(error);
			},
			(done, total) => {
				lastStage = "drawing the map";
				if (!deviceLost && gate.busy && total > 0) {
					status.textContent = "Drawing map…";
					progressBar.value = (done / total) * 100;
				}
			},
		);
		colorize = device.createComputePipeline({
			layout: "auto",
			compute: { module: device.createShaderModule({ code: colorizeSrc }), entryPoint: "main" },
		});
	} catch (error) {
		device.destroy();
		showError(error);
		return;
	}
	const emptyPositions = createStorage(device, 8),
		emptyColours = createStorage(device, 4);
	const clearMap = () =>
		renderer.setData(emptyPositions, emptyColours, 0, { minX: -1, maxX: 1, minY: -1, maxY: 1 });
	let currentBuffers: ReturnType<typeof bufferScope> | null = null;
	let demo: DemoPanel | null = null;
	let cacheSaving: Promise<unknown> = Promise.resolve();
	let ws: LoadedWorkspace | null = null,
		colorBuf: GPUBuffer | null = null;
	let repaint: Promise<void> = Promise.resolve();
	const popSelected = new Set<number>(),
		groupSelected = new Set<string>();
	let unlabelledSelected = true,
		colorBy = "labels";
	const popColors: string[] = [],
		groupColors = new Map<string, string>();
	const channelRange = new Map<string, [number, number]>();
	let colorRevision = 0;

	async function recolor(marker = colorBy, revision = colorRevision, signal?: AbortSignal) {
		const current = () => revision === colorRevision && !signal?.aborted && !deviceLost;
		if (!ws?.embedding || !colorBuf || !current()) return;
		await renderer.pause();
		if (!current()) return;
		lastStage = "preparing colours";
		const words = ws.words,
			sel = new Uint32Array(words);
		for (const p of popSelected)
			sel[Math.floor(p / 32)] = (sel[Math.floor(p / 32)] as number) | (1 << (p % 32));
		const sampleVisible = new Uint32Array(Math.max(1, ws.samples.length));
		ws.samples.forEach((sample, index) => {
			if (
				[...(ws?.conditions ?? []), ...(ws?.batches ?? [])].every((group) =>
					groupSelected.has(group),
				)
			) {
				sampleVisible[index] = 1;
				return;
			}
			const condition = ws?.conditions.length
				? sample.groups.some((group) => ws?.conditions.includes(group) && groupSelected.has(group))
				: true;
			const batch = ws?.batches.length
				? sample.groups.some((group) => ws?.batches.includes(group) && groupSelected.has(group))
				: true;
			sampleVisible[index] = condition && batch ? 1 : 0;
		});
		const popColor = Uint32Array.from(
			ws.populations.map((_, index) => hexToRgba8(popColors[index] ?? DEFAULT_COLOR)),
		);
		const palette = Uint32Array.from(CHANNEL_PALETTE.map((hex) => hexToRgba8(hex)));
		const mode = marker === "labels" ? 0 : 1;
		let channel = ws.channelBuffers[0] as GPUBuffer,
			lo = 0,
			hi = 1;
		if (mode === 1) {
			channel = ws.channelBuffers[ws.channels.indexOf(marker)] as GPUBuffer;
			let range = channelRange.get(marker);
			if (!range) {
				const all = await readback(device, channel, Float32Array);
				if (!current()) return;
				const stride = Math.max(1, Math.floor(all.length / 200000)),
					values: number[] = [];
				for (let index = 0; index < all.length; index += stride) {
					const value = all[index] as number;
					if (Number.isFinite(value)) values.push(value);
				}
				values.sort((a, b) => a - b);
				range = [
					values[Math.floor(values.length * 0.1)] ?? 0,
					values[Math.floor(values.length * 0.9)] ?? 1,
				];
				channelRange.set(marker, range);
			}
			[lo, hi] = range;
		}
		const pb = new ArrayBuffer(48);
		new Uint32Array(pb, 0, 4).set([ws.n, words, mode, ws.populations.length]);
		new Float32Array(pb, 16, 2).set([lo, hi]);
		new Uint32Array(pb, 24, 6).set([
			CHANNEL_PALETTE.length,
			hexToRgba8(DEFAULT_COLOR),
			unlabelledSelected ? 1 : 0,
			0,
			0,
			0,
		]);
		const temporary = bufferScope(device);
		try {
			const params = temporary.device.createBuffer({
				size: 48,
				usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
			});
			const visible = upload(temporary.device, sampleVisible),
				selection = upload(temporary.device, sel),
				colors = upload(temporary.device, popColor),
				ramp = upload(temporary.device, palette);
			for (const batch of renderBatches(ws.n)) {
				if (!current()) return;
				const window = { start: batch.first, count: batch.count };
				new Uint32Array(pb)[0] = batch.count;
				device.queue.writeBuffer(params, 0, pb);
				const bg = device.createBindGroup({
					layout: colorize.getBindGroupLayout(0),
					entries: [
						{ buffer: params },
						bind(ws.labels, window, words * 4),
						bind(ws.sampleId, window, 4),
						{ buffer: visible },
						{ buffer: selection },
						{ buffer: colors },
						bind(channel, window, 4),
						{ buffer: ramp },
						bind(colorBuf, window, 4),
					].map((resource, binding) => ({ binding, resource })),
				});
				const encoder = device.createCommandEncoder(),
					pass = encoder.beginComputePass();
				pass.setPipeline(colorize);
				pass.setBindGroup(0, bg);
				pass.dispatchWorkgroups(Math.ceil(batch.count / 256));
				pass.end();
				device.queue.submit([encoder.finish()]);
				await device.queue.onSubmittedWorkDone();
			}
			if (current()) await renderer.draw(!gate.busy);
			await device.queue.onSubmittedWorkDone();
		} finally {
			await device.queue.onSubmittedWorkDone().catch(() => {});
			temporary.releaseExcept();
		}
	}
	function scheduleRecolor() {
		if (!gate.busy && !deviceLost) {
			const revision = ++colorRevision,
				marker = colorBy;
			repaint = repaint
				.then(() => recolor(marker, revision))
				.then(() => {
					if (revision === colorRevision) demo?.onColorsChanged();
				})
				.catch((error) => {
					if (!deviceLost) showError(error);
				});
		}
	}
	function buildLegend() {
		if (!ws) return;
		const legend = $("legend");
		legend.replaceChildren();
		const counts = new Map<string, number>();
		for (const sample of ws.samples)
			for (const population of sample.gateCounts)
				counts.set(population.name, (counts.get(population.name) ?? 0) + population.count);
		const section = (
			title: string,
			items: string[],
			color: (name: string, index: number) => string,
			selected: (name: string, index: number) => boolean,
			toggle: (name: string, index: number) => void,
			setColor: (name: string, index: number, value: string) => void,
			count: (name: string) => number | undefined,
		) => {
			const heading = document.createElement("h3"),
				button = document.createElement("button"),
				list = document.createElement("ul");
			button.type = "button";
			button.textContent = title;
			button.setAttribute("aria-label", `Toggle all ${title.toLowerCase()}`);
			heading.append(button);
			const render = () => {
				list.replaceChildren();
				items.forEach((name, index) => {
					const item = document.createElement("li"),
						input = document.createElement("input"),
						label = document.createElement("button");
					item.classList.toggle("off", !selected(name, index));
					input.type = "color";
					input.value = color(name, index);
					input.setAttribute("aria-label", `Colour for ${name}`);
					input.onclick = (event) => event.stopPropagation();
					input.oninput = () => {
						setColor(name, index, input.value);
						scheduleRecolor();
					};
					label.type = "button";
					label.className = "legend-toggle";
					label.textContent = name;
					label.setAttribute("aria-pressed", String(selected(name, index)));
					item.append(input, label);
					const value = count(name);
					if (value !== undefined) {
						const number = document.createElement("span");
						number.className = "count";
						number.title = "Sampled event count";
						number.textContent = value.toLocaleString();
						item.append(number);
					}
					item.onclick = () => {
						toggle(name, index);
						render();
						scheduleRecolor();
					};
					list.append(item);
				});
			};
			button.onclick = () => {
				const any = items.some(selected);
				items.forEach((name, index) => {
					if (selected(name, index) === any) toggle(name, index);
				});
				render();
				scheduleRecolor();
			};
			render();
			legend.append(heading, list);
		};
		section(
			"Populations",
			[...ws.populations, "Unlabelled"],
			(_, i) => popColors[i] ?? DEFAULT_COLOR,
			(_, i) => (i < popColors.length ? popSelected.has(i) : unlabelledSelected),
			(_, i) => {
				if (i < popColors.length) {
					if (popSelected.has(i)) popSelected.delete(i);
					else popSelected.add(i);
				} else unlabelledSelected = !unlabelledSelected;
			},
			(_, i, value) => {
				if (i < popColors.length) popColors[i] = value;
			},
			(name) => counts.get(name),
		);
		for (const [title, items] of [
			["Conditions", ws.conditions],
			["Batches", ws.batches],
		] as const)
			section(
				title,
				items,
				(name) => groupColors.get(name) ?? "#888888",
				(name) => groupSelected.has(name),
				(name) => {
					if (groupSelected.has(name)) groupSelected.delete(name);
					else groupSelected.add(name);
				},
				(name, _, value) => groupColors.set(name, value),
				(name) =>
					ws?.samples
						.filter((sample) => sample.groups.includes(name))
						.reduce((sum, sample) => sum + sample.count, 0),
			);
		const select = $<HTMLSelectElement>("colour-by");
		select.replaceChildren();
		for (const name of ["labels", ...ws.channels]) {
			const option = document.createElement("option");
			option.value = name;
			option.textContent = name === "labels" ? "Populations" : name;
			select.append(option);
		}
		select.onchange = () => {
			colorBy = select.value;
			scheduleRecolor();
		};
	}

	async function run() {
		if (deviceLost || !gate.begin()) return;
		clearRecord();
		retry.disabled = true;
		retry.hidden = true;
		$("sidebar").hidden = true;
		$("data-summary").hidden = true;
		$("loading-overlay").hidden = false;
		$("map").setAttribute("aria-busy", "true");
		loadAbort = new AbortController();
		let next: ReturnType<typeof bufferScope> | null = null,
			scopeOpen = false;
		try {
			const t0 = performance.now();
			await demo?.dispose();
			demo = null;
			await repaint;
			await renderer.pause();
			clearMap();
			await device.queue.onSubmittedWorkDone();
			currentBuffers?.releaseExcept();
			currentBuffers = null;
			ws = null;
			colorBuf = null;
			popSelected.clear();
			groupSelected.clear();
			groupColors.clear();
			channelRange.clear();
			popColors.length = 0;
			unlabelledSelected = true;
			colorBy = "labels";
			const transport = {
				baseUrl: document.baseURI,
				signal: loadAbort.signal,
				cache: browserCache,
				onProgress: (progress: import("./publication.js").PublicationProgress) => {
					const view = downloadPresentation(progress);
					status.setAttribute("role", "status");
					status.textContent = view.label;
					detail.textContent = view.detail;
					progressBar.hidden = false;
					if (view.percent === null) progressBar.removeAttribute("value");
					else progressBar.value = view.percent;
				},
			};
			const publication = await loadPublicationManifest(transport);
			const cacheKey = await workspaceCacheKey(publication, computeBinding);
			log("Restoring cached map…");
			next = bufferScope(device);
			device.pushErrorScope("validation");
			scopeOpen = true;
			const cached = await restoreWorkspaceCache(browserCache, cacheKey, publication, next.device);
			loadAbort.signal.throwIfAborted();
			let inputMs = performance.now() - t0,
				parseMs = 0;
			const options = { ...PUBLICATION_EMBED_OPTIONS };
			let timing = {
				featurePreparationMs: 0,
				somTrainingMs: 0,
				mapEmbedProjectionMs: 0,
				boundsReadbackMs: 0,
			};
			if (cached) {
				ws = cached.workspace;
				log("Restoring cached map…");
			} else {
				const files = await downloadPublicationFiles(publication, transport);
				inputMs = performance.now() - t0;
				const wsp = files.find((file) => file.name.toLowerCase().endsWith(".wsp")) as File;
				const fcs = new Map(
					files
						.filter((file) => file.name.toLowerCase().endsWith(".fcs"))
						.map((file) => [file.name, file]),
				);
				log("Preparing map…");
				const parseStarted = performance.now();
				ws = await loadWorkspace(next.device, computeBinding, await wsp.text(), fcs, log, {
					expectedSource: {
						eventCount: publication.eventCount,
						samples: publication.files
							.filter((file) => file.kind === "fcs")
							.map((file) => ({
								basename: file.name,
								...(file.events === undefined ? {} : { events: file.events }),
							})),
					},
				});
				await device.queue.onSubmittedWorkDone();
				parseMs = performance.now() - parseStarted;
				timing = await computeEmbedding(next.device, computeBinding, ws, log, options);
			}
			if (
				ws.sourceEventCount !== publication.eventCount ||
				ws.n !== publication.eventCount ||
				ws.sampling !== null
			)
				throw new Error("Workspace does not match the complete verified source");
			ws.populations.forEach((_, i) => {
				popColors[i] = LABEL_PALETTE[i % LABEL_PALETTE.length] as string;
				popSelected.add(i);
			});
			for (const group of [...ws.conditions, ...ws.batches]) groupSelected.add(group);
			ws.conditions.forEach((group, i) => {
				groupColors.set(group, LABEL_PALETTE[i % LABEL_PALETTE.length] as string);
			});
			ws.batches.forEach((group, i) => {
				groupColors.set(group, LABEL_PALETTE[(i + 5) % LABEL_PALETTE.length] as string);
			});
			const displayStarted = performance.now();
			colorBuf = createStorage(next.device, ws.n * 4, undefined, "color");
			renderer.setData(
				ws.embedding as GPUBuffer,
				colorBuf,
				ws.n,
				ws.bounds as NonNullable<typeof ws.bounds>,
			);
			buildLegend();
			await recolor();
			const error = await device.popErrorScope();
			scopeOpen = false;
			if (error) throw new Error(error.message);
			if (deviceLost) throw new Error("GPU device lost");
			const keep = new Set([...ws.channelBuffers, ws.sampleId, ws.labels, colorBuf]);
			if (ws.embedding) keep.add(ws.embedding);
			if (ws.bmu) keep.add(ws.bmu);
			next.releaseExcept(keep);
			const displayMs = timing.boundsReadbackMs + performance.now() - displayStarted,
				totalMs = performance.now() - t0;
			const record: import("./computation.js").ComputationRecord = {
				schemaVersion: 1,
				completedAt: new Date().toISOString(),
				profile: "publication-full-projection-som100k-20x20-e10-seed42-v1",
				source: {
					kind: "publication",
					inputFileCount: publication.files.length,
					sampleCount: ws.samples.length,
					publication: {
						...publication,
						verifiedFileCount: cached ? 0 : publication.files.length,
						verificationScope: cached
							? "Derived cache integrity verified; original raw-input verification belongs to the retained computation."
							: "All raw files SHA-256 verified during this load, from cache or network.",
					},
				},
				sourceEventCount: ws.sourceEventCount,
				sampling: ws.sampling,
				settings: embeddingSettings(options, ws.n),
				projectedEventCount: ws.n,
				renderedEventCount: ws.n,
				featureCount: ws.embedChannels.length,
				features: ws.embedChannels.map((index) => ws?.channels[index] as string),
				renderScope:
					"All source events are gated, projected and supplied to the renderer. Only SOM training has a 100,000-event cap. Filters and viewport affect visibility.",
				gpu: {
					adapterDescription: dev.description.trim() || null,
					effectiveStorageWindowBytes: computeBinding,
					deviceMaxStorageBindingBytes: limits.maxStorageBufferBindingSize,
					deviceMaxBufferBytes: limits.maxBufferSize,
					projectionBatchEventLimit: PROJECTION_BATCH_EVENTS,
				},
				wallMs: {
					input: inputMs,
					parseTransformsGating: parseMs,
					featurePreparation: timing.featurePreparationMs,
					somTraining: timing.somTrainingMs,
					mapEmbedProjection: timing.mapEmbedProjectionMs,
					displayPreparation: displayMs,
					total: totalMs,
				},
				timingScope: cached
					? "Cache restore/hash/upload and display wall time; no new SOM or embedding computation. Original computation timings are retained separately."
					: "performance.now wall phases with queue drains, not GPU timestamps. All source events are projected; SOM training is capped. Cache persistence and later interaction time are excluded.",
				cache: {
					status: cached ? "hit" : "miss",
					key: cacheKey,
					...(cached
						? {
								originalCompletedAt: cached.computation.completedAt,
								originalWallMs: cached.computation.wallMs,
								originalGpu: cached.computation.gpu,
							}
						: {}),
				},
				gpuTimestampMeasurement: false,
				resources: {
					gpuMemoryBytes: null,
					gpuUtilizationPercent: null,
					browserMemoryBytes: null,
					cpuUtilizationPercent: null,
					scope: "Not instrumented; limits are not memory usage.",
				},
			};
			publishComputationRecord(record, $("computation-record"));
			currentBuffers = next;
			next = null;
			$("data-summary").textContent = `${ws.n.toLocaleString()} events`;
			$("data-summary").hidden = false;
			$("sidebar").hidden = false;
			$("loading-overlay").hidden = true;
			demo = new DemoPanel(
				device,
				ws,
				renderer,
				colorBuf,
				computeBinding,
				cacheKey,
				async (channel, signal) => {
					signal?.throwIfAborted();
					const previous = colorBy,
						revision = ++colorRevision;
					colorBy = channel;
					$<HTMLSelectElement>("colour-by").value = channel;
					const task = repaint
						.catch(() => {})
						.then(async () => {
							await recolor(channel, revision, signal);
							if (revision !== colorRevision)
								throw new Error("Marker request superseded by a newer display change");
							if (signal?.aborted) {
								colorBy = previous;
								$<HTMLSelectElement>("colour-by").value = previous;
								await recolor(previous, ++colorRevision);
							}
							demo?.onColorsChanged();
							signal?.throwIfAborted();
						});
					repaint = task.catch(() => {});
					await task;
				},
				async () => {
					await cacheSaving;
					await browserCache.retain(new Set());
					location.reload();
				},
				demoAccessCode,
			);
			console.log(
				`Ready: ${ws.n} events in ${(totalMs / 1000).toFixed(1)}s wall time (${cached ? "cached map" : "computed"})`,
			);
			if (!cached) {
				const readyWorkspace = ws;
				lastStage = "saving the map cache";
				cacheSaving = saveWorkspaceCache(
					browserCache,
					cacheKey,
					publication,
					device,
					readyWorkspace,
					record,
					(reason) => {
						if (record.cache) record.cache.error = reason;
					},
				)
					.then((saved) => {
						if (ws === readyWorkspace && !deviceLost && record.cache) {
							record.cache.saved = saved;
							publishComputationRecord(record, $("computation-record"));
						}
					})
					.catch(() => {});
			}
		} catch (error) {
			try {
				clearMap();
			} catch {
				/* Lost devices cannot redraw. */
			}
			ws = null;
			colorBuf = null;
			if (!deviceLost) showError(error);
		} finally {
			if (scopeOpen) await device.popErrorScope().catch(() => null);
			await device.queue.onSubmittedWorkDone().catch(() => {});
			next?.releaseExcept();
			loadAbort = null;
			gate.finish();
			retry.disabled = false;
			$("map").setAttribute("aria-busy", "false");
		}
	}
	retry.onclick = () => {
		if (deviceLost) location.reload();
		else void run();
	};
	$<HTMLInputElement>("size").oninput = (event) => {
		renderer.pointPx = Number((event.target as HTMLInputElement).value);
		void renderer.draw().catch((error) => {
			if (!deviceLost) showError(error);
		});
	};
	// The bare URL and historical query strings all use this one quick-demo path.
	void run();
}
void main().catch(showError);

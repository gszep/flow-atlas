import { acquireDevice, createStorage, readback, upload } from "@flow-atlas/compute";
import colorizeSrc from "./colorize.wgsl?raw";
import { createSyntheticDemoFiles, DEMO_EMBED_OPTIONS } from "./demo.js";
import { PointRenderer } from "./renderer.js";
import { computeEmbedding, type LoadedWorkspace, loadWorkspace } from "./workspace.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const status = $("status");
const log = (msg: string) => {
	status.setAttribute("role", "status");
	status.dataset.state = "info";
	status.textContent = msg;
	console.log(msg);
};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const showError = (error: unknown) => {
	status.setAttribute("role", "alert");
	status.dataset.state = "error";
	status.textContent = `Unable to load: ${message(error)}`;
	console.error(error);
};
const unavailable = (detail: string) => {
	$("unsupported").hidden = false;
	$("unsupported-detail").textContent = detail;
	$("gpu-info").textContent = "WebGPU plotting is unavailable in this browser/session.";
	$("map-empty-detail").textContent =
		"Interactive plotting is unavailable here. You can still read the current state and planned direction in the sidebar.";
	$("map-empty").hidden = false;
	$("controls").hidden = true;
	$("canvas").style.opacity = "0";
	$("canvas").style.pointerEvents = "none";
	$<HTMLButtonElement>("load-demo").disabled = true;
	$<HTMLInputElement>("files").disabled = true;
	log("Overview available; interactive plotting requires WebGPU.");
};

// The existing prototype loaders do not expose partially allocated buffers on failure.
// Track only this invocation's allocations while delegating all real GPU operations.
function bufferScope(device: GPUDevice) {
	const buffers = new Set<GPUBuffer>();
	const tracked = new Proxy(device, {
		get(target, key) {
			if (key === "createBuffer")
				return (descriptor: GPUBufferDescriptor) => {
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

// seaborn colorblind + extras, used cyclically for populations
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
// viridis, 10 levels (stand-in for reverse(matter))
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
	const v = Number.parseInt(hex.slice(1), 16);
	return ((alpha << 24) | ((v & 0xff) << 16) | (v & 0xff00) | (v >> 16)) >>> 0;
};

async function main() {
	let dev: Awaited<ReturnType<typeof acquireDevice>>;
	try {
		dev = await acquireDevice();
	} catch (e) {
		unavailable(message(e));
		return;
	}
	const { device, limits } = dev;
	$("gpu-info").textContent =
		`GPU: ${dev.description} · binding ${(limits.maxStorageBufferBindingSize / 2 ** 20).toFixed(0)} MiB`;
	let deviceLost = false;
	device.lost.then((info) => {
		deviceLost = true;
		unavailable(`The GPU device was lost: ${info.message}. Reload the page to retry.`);
	});

	const canvas = $<HTMLCanvasElement>("canvas");
	let renderer: PointRenderer, colorize: GPUComputePipeline;
	try {
		renderer = new PointRenderer(device, canvas);
		colorize = device.createComputePipeline({
			layout: "auto",
			compute: { module: device.createShaderModule({ code: colorizeSrc }), entryPoint: "main" },
		});
	} catch (error) {
		device.destroy();
		unavailable(message(error));
		return;
	}
	const emptyPositions = createStorage(device, 8),
		emptyColours = createStorage(device, 4);
	const clearMap = () =>
		renderer.setData(emptyPositions, emptyColours, 0, { minX: -1, maxX: 1, minY: -1, maxY: 1 });
	let currentBuffers: ReturnType<typeof bufferScope> | null = null;
	let loading = false;
	let repaint: Promise<void> = Promise.resolve();
	const demoButton = $<HTMLButtonElement>("load-demo");
	const filePicker = $<HTMLInputElement>("files");
	const setLoading = (value: boolean) => {
		loading = value;
		demoButton.disabled = value || deviceLost;
		filePicker.disabled = value || deviceLost;
		$("controls").inert = value || deviceLost;
		$("map").setAttribute("aria-busy", String(value));
		demoButton.textContent = value ? "Loading…" : "Load synthetic demo";
	};

	let ws: LoadedWorkspace | null = null;
	let colorBuf: GPUBuffer | null = null;
	const popSelected = new Set<number>();
	const groupSelected = new Set<string>();
	let unlabelledSelected = true;
	const popColors: string[] = [];
	const groupColors = new Map<string, string>();
	let colorBy = "labels";
	const channelRange = new Map<string, [number, number]>();

	async function recolor() {
		if (!ws?.embedding || !colorBuf) return;
		const words = ws.words;
		const sel = new Uint32Array(words);
		for (const p of popSelected)
			sel[Math.floor(p / 32)] = (sel[Math.floor(p / 32)] as number) | (1 << (p % 32));
		const sampleVisible = new Uint32Array(Math.max(1, ws.samples.length));
		ws.samples.forEach((s, i) => {
			const cond = ws?.conditions.length
				? s.groups.some((g) => ws?.conditions.includes(g) && groupSelected.has(g))
				: true;
			const batch = ws?.batches.length
				? s.groups.some((g) => ws?.batches.includes(g) && groupSelected.has(g))
				: true;
			sampleVisible[i] = cond && batch ? 1 : 0;
		});
		const popColor = Uint32Array.from(
			ws.populations.map((_, i) => hexToRgba8(popColors[i] ?? DEFAULT_COLOR)),
		);
		const palette = Uint32Array.from(CHANNEL_PALETTE.map((h) => hexToRgba8(h)));
		const mode = colorBy === "labels" ? 0 : 1;
		let channel = ws.channelBuffers[0] as GPUBuffer;
		let lo = 0;
		let hi = 1;
		if (mode === 1) {
			const ci = ws.channels.indexOf(colorBy);
			channel = ws.channelBuffers[ci] as GPUBuffer;
			let r = channelRange.get(colorBy);
			if (!r) {
				const all = await readback(device, channel, Float32Array);
				const stride = Math.max(1, Math.floor(all.length / 200_000));
				const s: number[] = [];
				for (let i = 0; i < all.length; i += stride) {
					const v = all[i] as number;
					if (Number.isFinite(v)) s.push(v);
				}
				s.sort((a, b) => a - b);
				r = [s[Math.floor(s.length * 0.1)] ?? 0, s[Math.floor(s.length * 0.9)] ?? 1];
				channelRange.set(colorBy, r);
			}
			[lo, hi] = r;
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
			device.queue.writeBuffer(params, 0, pb);
			const tmp = [
				upload(temporary.device, sampleVisible),
				upload(temporary.device, sel),
				upload(temporary.device, popColor),
				upload(temporary.device, palette),
			];
			const bg = device.createBindGroup({
				layout: colorize.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: { buffer: params } },
					{ binding: 1, resource: { buffer: ws.labels } },
					{ binding: 2, resource: { buffer: ws.sampleId } },
					{ binding: 3, resource: { buffer: tmp[0] as GPUBuffer } },
					{ binding: 4, resource: { buffer: tmp[1] as GPUBuffer } },
					{ binding: 5, resource: { buffer: tmp[2] as GPUBuffer } },
					{ binding: 6, resource: { buffer: channel } },
					{ binding: 7, resource: { buffer: tmp[3] as GPUBuffer } },
					{ binding: 8, resource: { buffer: colorBuf } },
				],
			});
			const enc = device.createCommandEncoder();
			const pass = enc.beginComputePass();
			pass.setPipeline(colorize);
			pass.setBindGroup(0, bg);
			pass.dispatchWorkgroups(Math.ceil(ws.n / 256));
			pass.end();
			device.queue.submit([enc.finish()]);
			await device.queue.onSubmittedWorkDone();
			if (!new URLSearchParams(location.search).has("nodraw")) renderer.draw();
			await device.queue.onSubmittedWorkDone();
		} finally {
			await device.queue.onSubmittedWorkDone().catch(() => {});
			temporary.releaseExcept();
		}
	}
	function scheduleRecolor() {
		if (loading || deviceLost) return;
		repaint = repaint.then(recolor).catch(showError);
	}

	function buildLegend() {
		if (!ws) return;
		const legend = $("legend");
		legend.innerHTML = "";
		const popCounts = new Map<string, number>();
		for (const s of ws.samples)
			for (const g of s.gateCounts) popCounts.set(g.name, (popCounts.get(g.name) ?? 0) + g.count);
		const section = (
			title: string,
			items: string[],
			colorOf: (n: string, i: number) => string,
			isOn: (n: string, i: number) => boolean,
			toggle: (n: string, i: number) => void,
			setColor: (n: string, i: number, c: string) => void,
			count?: (n: string) => number | undefined,
		) => {
			const h = document.createElement("h3");
			const sectionButton = document.createElement("button");
			sectionButton.type = "button";
			sectionButton.textContent = title;
			sectionButton.setAttribute("aria-label", `Toggle all ${title.toLowerCase()}`);
			h.append(sectionButton);
			const ul = document.createElement("ul");
			sectionButton.onclick = () => {
				const anyOn = items.some((n, i) => isOn(n, i));
				items.forEach((n, i) => {
					if (isOn(n, i) === anyOn) toggle(n, i);
				});
				render();
				scheduleRecolor();
			};
			const render = () => {
				ul.innerHTML = "";
				items.forEach((n, i) => {
					const li = document.createElement("li");
					li.classList.toggle("off", !isOn(n, i));
					const c = document.createElement("input");
					c.type = "color";
					c.setAttribute("aria-label", `Colour for ${n}`);
					c.value = colorOf(n, i);
					c.onclick = (e) => e.stopPropagation();
					c.oninput = () => {
						setColor(n, i, c.value);
						scheduleRecolor();
					};
					const span = document.createElement("button");
					span.type = "button";
					span.className = "legend-toggle";
					span.setAttribute("aria-pressed", String(isOn(n, i)));
					span.textContent = n;
					li.append(c, span);
					const cnt = count?.(n);
					if (cnt !== undefined) {
						const s = document.createElement("span");
						s.className = "count";
						s.textContent = cnt.toLocaleString();
						li.append(s);
					}
					li.onclick = () => {
						toggle(n, i);
						render();
						scheduleRecolor();
					};
					ul.append(li);
				});
			};
			render();
			legend.append(h, ul);
		};
		const pops = [...ws.populations, "Unlabelled"];
		section(
			"Populations",
			pops,
			(_, i) => (i < popColors.length ? (popColors[i] as string) : DEFAULT_COLOR),
			(_, i) => (i < popColors.length ? popSelected.has(i) : unlabelledSelected),
			(_, i) => {
				if (i < popColors.length) {
					if (popSelected.has(i)) popSelected.delete(i);
					else popSelected.add(i);
				} else unlabelledSelected = !unlabelledSelected;
			},
			(_, i, c) => {
				if (i < popColors.length) popColors[i] = c;
			},
			(n) => (n === "Unlabelled" ? undefined : popCounts.get(n)),
		);
		for (const [title, items] of [
			["Conditions", ws.conditions],
			["Batches", ws.batches],
		] as const) {
			section(
				title,
				items,
				(n) => groupColors.get(n) ?? "#888888",
				(n) => groupSelected.has(n),
				(n) => {
					if (groupSelected.has(n)) groupSelected.delete(n);
					else groupSelected.add(n);
				},
				(n, _, c) => groupColors.set(n, c),
				(n) => ws?.samples.filter((s) => s.groups.includes(n)).reduce((a, s) => a + s.count, 0),
			);
		}
		const sel = $<HTMLSelectElement>("colour-by");
		sel.innerHTML = "";
		for (const name of ["labels", ...ws.channels]) {
			const o = document.createElement("option");
			o.value = name;
			o.textContent = name === "labels" ? "Populations" : name;
			sel.append(o);
		}
		sel.onchange = () => {
			colorBy = sel.value;
			scheduleRecolor();
		};
	}

	async function run(input: File[] | (() => Promise<File[]>), synthetic = false) {
		if (loading || deviceLost) return;
		setLoading(true);
		let nextBuffers: ReturnType<typeof bufferScope> | null = null;
		let scopeOpen = false;
		try {
			const t0 = performance.now();
			log(
				synthetic
					? "Generating a small seeded synthetic example…"
					: "Opening local files in this browser…",
			);
			const files = typeof input === "function" ? await input() : input;
			const workspaces = files.filter((file) => file.name.toLowerCase().endsWith(".wsp"));
			const dataFiles = files.filter((file) => file.name.toLowerCase().endsWith(".fcs"));
			if (workspaces.length !== 1 || dataFiles.length === 0)
				throw new Error("Choose one WSP and its matching FCS files, or use the synthetic demo.");
			const fcs = new Map(dataFiles.map((file) => [file.name, file]));
			if (fcs.size !== dataFiles.length)
				throw new Error("Several FCS files share a filename. Choose one unambiguous sample set.");
			await repaint;
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
			$("controls").hidden = true;
			$("legend").replaceChildren();
			$("map-empty").hidden = false;
			$("map-empty-detail").textContent = "Preparing the WebGPU view…";
			$("data-summary").textContent = synthetic
				? "Loading synthetic illustration · no biological validation"
				: "Loading local files · not uploaded";
			nextBuffers = bufferScope(device);
			device.pushErrorScope("validation");
			scopeOpen = true;
			ws = await loadWorkspace(
				nextBuffers.device,
				limits.maxStorageBufferBindingSize,
				await (workspaces[0] as File).text(),
				fcs,
				log,
			);
			if (ws.n < 1) throw new Error("The selected workspace has no events to plot.");
			ws.populations.forEach((_, i) => {
				popColors[i] = LABEL_PALETTE[i % LABEL_PALETTE.length] as string;
				popSelected.add(i);
			});
			for (const g of [...ws.conditions, ...ws.batches]) groupSelected.add(g);
			ws.conditions.forEach((g, i) => {
				groupColors.set(g, LABEL_PALETTE[i % LABEL_PALETTE.length] as string);
			});
			ws.batches.forEach((g, i) => {
				groupColors.set(g, LABEL_PALETTE[(i + 5) % LABEL_PALETTE.length] as string);
			});
			await computeEmbedding(
				nextBuffers.device,
				limits.maxStorageBufferBindingSize,
				ws,
				log,
				synthetic ? DEMO_EMBED_OPTIONS : {},
			);
			colorBuf = createStorage(nextBuffers.device, ws.n * 4, undefined, "color");
			renderer.setData(
				ws.embedding as GPUBuffer,
				colorBuf,
				ws.n,
				ws.bounds as NonNullable<typeof ws.bounds>,
			);
			buildLegend();
			await recolor();
			const validationError = await device.popErrorScope();
			scopeOpen = false;
			if (validationError) throw new Error(validationError.message);
			if (deviceLost) throw new Error("GPU device lost. Reload the page to retry.");
			const keep = new Set([...ws.channelBuffers, ws.sampleId, ws.labels, colorBuf]);
			if (ws.embedding) keep.add(ws.embedding);
			if (ws.bmu) keep.add(ws.bmu);
			nextBuffers.releaseExcept(keep);
			currentBuffers = nextBuffers;
			nextBuffers = null;
			$("controls").hidden = false;
			$("map-empty").hidden = true;
			$("data-summary").textContent =
				`${synthetic ? "Synthetic demo" : "Local files"} · ${ws.n.toLocaleString()} events · ${ws.populations.length} populations · ${synthetic ? "not biologically validated" : "browser prototype, not a host receipt"}`;
			log(
				`Ready in ${((performance.now() - t0) / 1000).toFixed(1)}s — drag to pan, scroll to zoom.`,
			);
			if (matchMedia("(max-width: 760px)").matches)
				$("map").scrollIntoView({
					block: "start",
					behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
				});
		} catch (e) {
			if (nextBuffers) {
				try {
					clearMap();
				} catch (cleanupError) {
					console.error(cleanupError);
				}
				ws = null;
				colorBuf = null;
				$("controls").hidden = true;
				$("map-empty").hidden = false;
				$("map-empty-detail").textContent =
					"No plot loaded. Try the synthetic demo or another WSP/FCS selection.";
				$("data-summary").textContent = "Load failed · no data uploaded";
			}
			showError(e);
		} finally {
			if (scopeOpen) await device.popErrorScope().catch(() => null);
			await device.queue.onSubmittedWorkDone().catch(() => {});
			nextBuffers?.releaseExcept();
			filePicker.value = "";
			setLoading(false);
		}
	}
	demoButton.onclick = () => void run(createSyntheticDemoFiles, true);
	setLoading(false);
	log("Ready for a synthetic demo or your local WSP/FCS files.");

	// Dev convenience: ?oracle[=N] loads the oracle dataset served by the Vite dev server (first N files).
	const q = new URLSearchParams(location.search);
	if (import.meta.env.DEV && q.has("oracle")) {
		const limit = Number(q.get("oracle")) || 0;
		const names = (await (await fetch("/oracle/index.json")).json()) as string[];
		const wanted = names
			.filter((n) => n.endsWith(".wsp"))
			.concat(names.filter((n) => n.endsWith(".fcs")).slice(0, limit || undefined));
		log(`fetching ${wanted.length} oracle files`);
		const files = await Promise.all(
			wanted.map(
				async (n) =>
					new File(
						[await (await fetch(`/oracle/${n}`)).arrayBuffer()],
						n.split("/").pop() as string,
					),
			),
		);
		void run(files);
	}

	$<HTMLInputElement>("files").onchange = (e) =>
		void run([...((e.target as HTMLInputElement).files ?? [])]);
	$<HTMLInputElement>("size").oninput = (e) => {
		renderer.pointPx = Number((e.target as HTMLInputElement).value);
		renderer.draw();
	};

	// Drag & drop of files or a directory.
	const app = $("app");
	app.addEventListener("dragover", (e) => {
		e.preventDefault();
		app.classList.add("drop");
	});
	app.addEventListener("dragleave", () => app.classList.remove("drop"));
	app.addEventListener("drop", async (e) => {
		e.preventDefault();
		app.classList.remove("drop");
		if (loading || deviceLost) return;
		try {
			const out: File[] = [];
			const walk = async (entry: FileSystemEntry): Promise<void> => {
				if (entry.isFile) {
					const f = await new Promise<File>((res, rej) =>
						(entry as FileSystemFileEntry).file(res, rej),
					);
					out.push(f);
				} else if (entry.isDirectory) {
					const reader = (entry as FileSystemDirectoryEntry).createReader();
					const readAll = async (): Promise<FileSystemEntry[]> => {
						const acc: FileSystemEntry[] = [];
						for (;;) {
							const batch = await new Promise<FileSystemEntry[]>((res, rej) =>
								reader.readEntries(res, rej),
							);
							if (batch.length === 0) return acc;
							acc.push(...batch);
						}
					};
					for (const child of await readAll()) await walk(child);
				}
			};
			for (const item of e.dataTransfer?.items ?? []) {
				const entry = item.webkitGetAsEntry?.();
				if (entry) await walk(entry);
				else {
					const file = item.getAsFile();
					if (file) out.push(file);
				}
			}
			void run(out);
		} catch (error) {
			showError(error);
		}
	});
}

void main().catch((error) => unavailable(message(error)));

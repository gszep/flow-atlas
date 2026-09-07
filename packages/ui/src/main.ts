import { acquireDevice, createStorage, readback, upload } from "@flow-atlas/compute";
import colorizeSrc from "./colorize.wgsl?raw";
import { PointRenderer } from "./renderer.js";
import { computeEmbedding, type LoadedWorkspace, loadWorkspace } from "./workspace.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const status = $("status");
const log = (msg: string) => {
	status.textContent = msg;
	console.log(msg);
};

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
		const el = $("unsupported");
		el.hidden = false;
		el.innerHTML = `<div><h2>WebGPU is required</h2><p>${(e as Error).message}</p>
			<p>Use Chrome/Edge 113+, Firefox 141+ (Windows / Apple-Silicon macOS 26), or Safari 26 on macOS 26.</p></div>`;
		return;
	}
	const { device, limits } = dev;
	$("gpu-info").textContent =
		`GPU: ${dev.description} · binding ${(limits.maxStorageBufferBindingSize / 2 ** 20).toFixed(0)} MiB`;
	device.lost.then((info) => log(`GPU device lost: ${info.message} — reload the page`));

	const canvas = $<HTMLCanvasElement>("canvas");
	const renderer = new PointRenderer(device, canvas);
	const colorize = device.createComputePipeline({
		layout: "auto",
		compute: { module: device.createShaderModule({ code: colorizeSrc }), entryPoint: "main" },
	});

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
		const params = device.createBuffer({
			size: 48,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(params, 0, pb);
		const tmp = [
			upload(device, sampleVisible),
			upload(device, sel),
			upload(device, popColor),
			upload(device, palette),
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
		console.log("colorize done");
		if (!new URLSearchParams(location.search).has("nodraw")) renderer.draw();
		await device.queue.onSubmittedWorkDone();
		console.log("draw done");
		params.destroy();
		for (const b of tmp) b.destroy();
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
			h.textContent = title;
			const ul = document.createElement("ul");
			h.onclick = () => {
				const anyOn = items.some((n, i) => isOn(n, i));
				items.forEach((n, i) => {
					if (isOn(n, i) === anyOn) toggle(n, i);
				});
				render();
				void recolor();
			};
			const render = () => {
				ul.innerHTML = "";
				items.forEach((n, i) => {
					const li = document.createElement("li");
					li.classList.toggle("off", !isOn(n, i));
					const c = document.createElement("input");
					c.type = "color";
					c.value = colorOf(n, i);
					c.onclick = (e) => e.stopPropagation();
					c.oninput = () => {
						setColor(n, i, c.value);
						void recolor();
					};
					const span = document.createElement("span");
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
						void recolor();
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
			void recolor();
		};
	}

	async function run(files: File[]) {
		const wsp = files.find((f) => f.name.toLowerCase().endsWith(".wsp"));
		const fcs = new Map(
			files.filter((f) => f.name.toLowerCase().endsWith(".fcs")).map((f) => [f.name, f]),
		);
		if (!wsp) {
			log("no .wsp file found in the selection");
			return;
		}
		if (fcs.size === 0) {
			log("no .fcs files found");
			return;
		}
		try {
			const t0 = performance.now();
			ws = await loadWorkspace(
				device,
				limits.maxStorageBufferBindingSize,
				await wsp.text(),
				fcs,
				log,
			);
			// FlowJo-parity report in the console
			let exact = 0;
			let total = 0;
			for (const s of ws.samples)
				for (const g of s.gateCounts) {
					total++;
					if (g.count === g.expected) exact++;
				}
			console.log(`gating: ${total} gates, ${exact} exactly matching FlowJo counts`);
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
			await computeEmbedding(device, limits.maxStorageBufferBindingSize, ws, log);
			colorBuf = createStorage(device, ws.n * 4, undefined, "color");
			renderer.setData(
				ws.embedding as GPUBuffer,
				colorBuf,
				ws.n,
				ws.bounds as NonNullable<typeof ws.bounds>,
			);
			$("controls").hidden = false;
			buildLegend();
			await recolor();
			log(`ready in ${((performance.now() - t0) / 1000).toFixed(1)}s — drag to pan, wheel to zoom`);
		} catch (e) {
			console.error(e);
			log(`error: ${(e as Error).message}`);
		}
	}

	// Dev convenience: ?oracle[=N] loads the oracle dataset served by the Vite dev server (first N files).
	const q = new URLSearchParams(location.search);
	if (q.has("oracle")) {
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
			const entry = item.webkitGetAsEntry();
			if (entry) await walk(entry);
		}
		void run(out);
	});
}

void main();

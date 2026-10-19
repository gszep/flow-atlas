import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import type { FcsFile } from "@flow-atlas/fcs";
import { ModelError, serializeWorkspace, type WorkspaceDocument } from "@flow-atlas/model";
import {
	attr,
	child,
	childrenOf,
	descendants,
	localName,
	parseXml,
	readWsp,
	type WspGate,
	type XmlElement,
	XmlError,
} from "../../wsp/src/index.js";
import { type ArtifactStore, canonical, digest, fileSource, writeAll } from "./artifact-store.js";
import { AnalysisError, boundedJson, type OperationArgs, validateOperation } from "./contracts.js";

export type MaterializeWspRequest = OperationArgs<"materialize_wsp_sample">;
type Imported = { id: string; size: number; metadata: Omit<FcsFile, "data"> };
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function reject(reason: string): never {
	throw new AnalysisError("WSP_UNSUPPORTED_STRUCTURE", reason);
}
function text(value: string | undefined, reason: string): string {
	if (value === undefined || !value.length || value.length > 4096) reject(reason);
	return value;
}
function number(value: string | undefined, reason: string): number {
	if (value === undefined || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))
		reject(reason);
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || Object.is(parsed, -0)) reject(reason);
	if (parsed === 0 && /[1-9]/.test(value.split(/[eE]/)[0] as string))
		reject(`Numeric literal underflow: ${reason}`);
	return parsed;
}
function count(value: string | undefined, reason: string): number | null {
	if (value === undefined) return null;
	const parsed = number(value, reason);
	if (!Number.isSafeInteger(parsed) || parsed < 0) reject(reason);
	return parsed;
}
function attrs(element: XmlElement, allowed: string[]): void {
	for (const key of Object.keys(element.attrs))
		if (key !== "xmlns" && !key.startsWith("xmlns:") && !allowed.includes(localName(key)))
			reject(`Unsupported attribute ${element.name}/${key}`);
}
function children(element: XmlElement, allowed: string[]): void {
	if (element.text.trim()) reject(`Unsupported text in ${element.name}`);
	for (const item of element.children)
		if (!allowed.includes(localName(item.name)))
			reject(`Unsupported element ${element.name}/${item.name}`);
}
function one(element: XmlElement, name: string): XmlElement {
	const matches = childrenOf(element, name);
	if (matches.length !== 1) reject(`Expected exactly one ${element.name}/${name}`);
	return matches[0] as XmlElement;
}
function preflight(root: XmlElement, request: MaterializeWspRequest) {
	const ws = one(root, "Workspace");
	if (ws.attrs.version !== request.expectedWspVersion)
		throw new AnalysisError("WSP_VERSION_CONFLICT", "Expected WSP root format version differs", {
			expected: request.expectedWspVersion,
			actual: ws.attrs.version ?? null,
		});
	const list = one(ws, "SampleList");
	const samples = childrenOf(list, "Sample");
	const selected = samples.filter(
		(sample) => child(sample, "DataSet")?.attrs.sampleID === request.wspSampleId,
	);
	if (selected.length !== 1)
		throw new AnalysisError("WSP_SAMPLE_NOT_FOUND", "WSP sample ID must select exactly one sample");
	const sample = selected[0] as XmlElement;
	attrs(sample, []);
	children(sample, ["DataSet", "Keywords", "Transformations", "SampleNode"]);
	const dataset = one(sample, "DataSet"),
		node = one(sample, "SampleNode"),
		keywords = one(sample, "Keywords");
	attrs(dataset, ["sampleID", "uri"]);
	children(dataset, []);
	attrs(node, ["sampleID", "name", "count", "expanded", "owningGroup"]);
	attrs(keywords, []);
	text(dataset.attrs.uri, "Selected DataSet must declare uri");
	if (node.attrs.sampleID !== undefined && node.attrs.sampleID !== request.wspSampleId)
		reject("DataSet/SampleNode sample IDs disagree");
	const sourceCount = count(node.attrs.count, "Invalid SampleNode count");
	children(node, ["Subpopulations"]);
	const kw: Record<string, string> = Object.create(null);
	children(keywords, ["Keyword"]);
	for (const entry of keywords.children) {
		attrs(entry, ["name", "value"]);
		children(entry, []);
		const name = text(entry.attrs.name, "Keyword needs a name").toUpperCase();
		if (Object.hasOwn(kw, name) || entry.attrs.value === undefined)
			reject("Duplicate keyword or missing keyword value");
		kw[name] = entry.attrs.value;
	}
	const par = count(kw.$PAR, "Invalid $PAR");
	if (par === null || par < 1 || par > 4096)
		reject("Selected WSP sample requires 1..4096 channels");
	const names: string[] = [];
	for (let index = 1; index <= par; index++) {
		names.push(text(kw[`$P${index}N`], "Missing channel name"));
		number(kw[`$P${index}B`], "Invalid channel bit width");
		number(kw[`$P${index}R`], "Invalid channel range");
	}
	if (new Set(names).size !== names.length) reject("Duplicate WSP channel names");
	const keywordCount = count(kw.$TOT, "Invalid $TOT");
	const definitions: WspGate[] = [];
	const populations = descendants(node, "Population");
	for (const population of populations) {
		attrs(population, ["name", "count", "expanded", "owningGroup"]);
		children(population, ["Gate", "Subpopulations"]);
		const wrapper = one(population, "Gate");
		attrs(wrapper, ["id", "parent_id"]);
		if (wrapper.text.trim() || wrapper.children.length !== 1)
			reject("Gate requires exactly one geometry");
		const geometry = wrapper.children[0] as XmlElement;
		attrs(geometry, []);
		const id = text(attr(wrapper, "id"), "Gate requires ID");
		const parentId = attr(wrapper, "parent_id") ?? null;
		let ancestor = population.parent;
		while (ancestor && ancestor !== node && localName(ancestor.name) !== "Population")
			ancestor = ancestor.parent;
		const nestedParent = ancestor && ancestor !== node ? attr(one(ancestor, "Gate"), "id") : null;
		if (parentId !== nestedParent) reject(`Gate ${id}: nested population and parent_id disagree`);
		const dimensions = childrenOf(geometry, "dimension").map((dimension) => {
			attrs(dimension, ["min", "max"]);
			children(dimension, ["fcs-dimension"]);
			const axis = one(dimension, "fcs-dimension");
			attrs(axis, ["name"]);
			children(axis, []);
			const name = text(attr(axis, "name"), "Gate dimension requires exact channel name");
			if (!names.includes(name)) reject(`Unknown dimension ${name}`);
			return name;
		});
		if (new Set(dimensions).size !== dimensions.length) reject("Duplicate gate dimension");
		let shape: WspGate["geometry"];
		if (localName(geometry.name) === "RectangleGate") {
			children(geometry, ["dimension"]);
			if (!dimensions.length) reject("Rectangle requires dimensions");
			const min: number[] = [],
				max: number[] = [];
			for (const dimension of childrenOf(geometry, "dimension")) {
				const lo = attr(dimension, "min"),
					hi = attr(dimension, "max");
				min.push(lo === undefined ? -Infinity : number(lo, "Invalid present rectangle minimum"));
				max.push(hi === undefined ? Infinity : number(hi, "Invalid present rectangle maximum"));
				if ((min.at(-1) as number) > (max.at(-1) as number)) reject("Reversed rectangle bounds");
			}
			shape = { type: "rectangle", min, max };
		} else if (localName(geometry.name) === "PolygonGate") {
			children(geometry, ["dimension", "vertex"]);
			if (dimensions.length !== 2) reject("Polygon requires exactly two dimensions");
			for (const dimension of childrenOf(geometry, "dimension")) attrs(dimension, []);
			const vertices = childrenOf(geometry, "vertex").map((vertex): [number, number] => {
				attrs(vertex, []);
				children(vertex, ["coordinate"]);
				if (vertex.children.length !== 2) reject("Polygon vertex requires two coordinates");
				const values = vertex.children.map((coordinate) => {
					attrs(coordinate, ["value"]);
					children(coordinate, []);
					return number(attr(coordinate, "value"), "Invalid polygon coordinate");
				});
				return [values[0] as number, values[1] as number];
			});
			if (vertices.length < 3) reject("Polygon requires at least three vertices");
			shape = { type: "polygon", vertices };
		} else if (localName(geometry.name) === "BooleanGate") {
			children(geometry, ["and", "or", "not"]);
			if (geometry.children.length !== 1 || dimensions.length)
				reject("Boolean requires one flat operator and no dimensions");
			const operator = geometry.children[0] as XmlElement;
			attrs(operator, []);
			children(operator, ["gateReference"]);
			const op = localName(operator.name) as "and" | "or" | "not";
			const refs = operator.children.map((reference) => {
				attrs(reference, ["ref"]);
				children(reference, []);
				return text(attr(reference, "ref"), "Boolean requires exact external gate ID");
			});
			if (!refs.length || (op === "not" && refs.length !== 1) || new Set(refs).size !== refs.length)
				reject("Invalid Boolean references/arity");
			shape = { type: "boolean", op, refs };
		} else reject(`Unsupported gate geometry ${geometry.name}`);
		definitions.push({
			id,
			parentId,
			name: text(population.attrs.name, "Population requires name"),
			count: count(population.attrs.count, "Invalid Population count"),
			dimensions,
			geometry: shape,
		});
	}
	// Do not allow hidden Population nodes in an unrecognized container to disappear.
	for (const element of [node, ...descendants(node, "Subpopulations")]) {
		if (element !== node) {
			attrs(element, []);
			children(element, ["Population"]);
		}
	}
	const ids = new Set(definitions.map((gate) => gate.id));
	if (ids.size !== definitions.length) reject("Duplicate gate IDs");
	for (const gate of definitions)
		for (const ref of [
			...(gate.parentId === null ? [] : [gate.parentId]),
			...(gate.geometry.type === "boolean" ? gate.geometry.refs : []),
		])
			if (!ids.has(ref)) reject(`Missing selected-sample gate reference ${ref}`);
	const transforms = childrenOf(sample, "Transformations");
	if (transforms.length > 1) reject("Duplicate Transformations");
	if (transforms[0]) {
		attrs(transforms[0], []);
		if (transforms[0].text.trim()) reject("Unexpected transform container text");
	}
	const transformed = new Set<string>();
	for (const transform of transforms[0]?.children ?? []) {
		children(transform, ["parameter"]);
		const parameter = one(transform, "parameter");
		attrs(parameter, ["name"]);
		children(parameter, []);
		const name = text(attr(parameter, "name"), "Transform parameter missing");
		if (!names.includes(name) || transformed.has(name))
			reject("Missing/duplicate transform channel");
		transformed.add(name);
		const type = localName(transform.name);
		const allowed =
			type === "linear"
				? ["minRange", "maxRange", "gain"]
				: type === "log"
					? ["offset", "decades", "minRange", "maxRange"]
					: type === "biex"
						? ["width", "neg", "pos", "maxRange", "channelRange", "length"]
						: null;
		if (allowed) {
			attrs(transform, allowed);
			for (const [key, value] of Object.entries(transform.attrs))
				if (!key.startsWith("xmlns")) number(value, `Invalid transform parameter ${key}`);
		}
	}
	return {
		definitions,
		sourceGroupCount: descendants(ws, "GroupNode").length,
		sourceCount,
		keywordCount,
		rootAttributes: { ...ws.attrs },
		datasetAttributes: { ...dataset.attrs },
		nodeAttributes: { ...node.attrs },
	};
}

export async function materializeWspSample(
	store: ArtifactStore,
	input: MaterializeWspRequest,
	getSample: (id: string) => Promise<Imported>,
	buildId: string,
	signal: AbortSignal,
) {
	boundedJson(input, 64 * 1024);
	const request = Object.freeze(
		validateOperation("materialize_wsp_sample", structuredClone(input)) as MaterializeWspRequest,
	);
	signal.throwIfAborted();
	const lexical = relative(store.root, resolve(store.root, request.path));
	if (
		isAbsolute(request.path) ||
		win32.isAbsolute(request.path) ||
		lexical === ".." ||
		lexical.startsWith(`..${sep}`)
	)
		throw new AnalysisError(
			"PATH_OUTSIDE_ROOT",
			"WSP path must remain relative to the configured root",
		);
	const file = await fileSource(join(store.root, request.path), store.root);
	let bytes: Uint8Array, xml: string;
	try {
		signal.throwIfAborted();
		if (file.source.size > 8 * 2 ** 20)
			throw new AnalysisError("WSP_TOO_LARGE", "WSP exceeds 8 MiB");
		bytes = await file.source.read(0, file.source.size);
		signal.throwIfAborted();
		if (sha(bytes) !== request.expectedSha256)
			throw new AnalysisError("WSP_HASH_MISMATCH", "WSP content revision differs");
		try {
			xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw new AnalysisError("WSP_ENCODING", "WSP must be valid UTF-8");
		}
	} finally {
		try {
			await file.assertUnchanged();
		} finally {
			try {
				await file.close();
			} finally {
				signal.throwIfAborted();
			}
		}
	}
	let checked: ReturnType<typeof preflight>, parsed: ReturnType<typeof readWsp>;
	try {
		checked = preflight(parseXml(xml, { strict: true }), request);
		parsed = readWsp(xml, { strict: true, sampleId: request.wspSampleId });
	} catch (error) {
		if (error instanceof AnalysisError) throw error;
		throw new AnalysisError(
			error instanceof XmlError ? "WSP_INVALID_XML" : "WSP_INVALID_SOURCE",
			error instanceof Error ? error.message : String(error),
		);
	}
	const selected = parsed.samples[0];
	if (
		!selected ||
		parsed.samples.length !== 1 ||
		canonical(selected.gates) !== canonical(checked.definitions)
	)
		reject("WSP reader projection differs from validated selected definitions");
	const source = await getSample(request.sampleId);
	signal.throwIfAborted();
	if (source.id !== request.sampleId || source.size !== request.expectedSampleBytes)
		throw new AnalysisError("WSP_SAMPLE_MISMATCH", "Imported sample identity/size differs");
	if (digest(source.metadata) !== request.expectedMetadataHash)
		throw new AnalysisError("WSP_METADATA_MISMATCH", "Imported sample metadata hash differs");
	if (
		[checked.sourceCount, checked.keywordCount].some(
			(value) => value !== null && value !== source.metadata.eventCount,
		)
	)
		throw new AnalysisError("WSP_SAMPLE_MISMATCH", "WSP and imported event counts conflict");
	const names = source.metadata.channels.map((channel) => channel.name);
	if (
		new Set(names).size !== names.length ||
		names.length !== selected.channels.length ||
		selected.channels.some((channel) => !names.includes(channel.name))
	)
		throw new AnalysisError(
			"WSP_CHANNEL_MISMATCH",
			"Selected WSP and imported channel names must match uniquely and completely",
		);
	const sampleId = `s-${digest([request.expectedSha256, request.wspSampleId, source.id])}`;
	const channelMapping = selected.channels.map((channel) => ({
		id: `c-${digest([sampleId, channel.name])}`,
		name: channel.name,
		wspIndex: channel.index,
		fcsIndex: source.metadata.channels[names.indexOf(channel.name)]?.index,
	}));
	const channelIds = new Map(channelMapping.map((channel) => [channel.name, channel.id]));
	const gateIds = new Map(
		selected.gates.map((gate) => [gate.id, `g-${digest([sampleId, gate.id])}`]),
	);
	const warnings = [
		"Coordinates are preserved as declared XML values under an explicit caller choice; FlowJo raw/display/compensation interpretation is unvalidated.",
		"Numeric execution and source population counts are not validated; display transforms are unapplied.",
		"All source groups and other samples are omitted from the single-sample model; full source XML is retained.",
	];
	const model: WorkspaceDocument = {
		schemaVersion: 1,
		id: `w-${digest([request.expectedSha256, sampleId, request.coordinateConvention])}`,
		revision: 0,
		samples: [
			{
				id: sampleId,
				file: { sha256: source.id, basename: selected.basename, size: source.size },
				channels: channelMapping.map(({ id, name }) => {
					const transform = selected.transforms[name];
					if (transform?.type === "unsupported")
						warnings.push(
							`Unsupported display transform retained without evaluation: ${name} (${transform.originalType})`,
						);
					return { id, name, ...(transform ? { transform: structuredClone(transform) } : {}) };
				}),
			},
		],
		gates: selected.gates.map((gate) => {
			const geometry =
				gate.geometry.type === "rectangle"
					? {
							type: "rectangle" as const,
							min: gate.geometry.min.map((v) => (v === -Infinity ? null : v)),
							max: gate.geometry.max.map((v) => (v === Infinity ? null : v)),
						}
					: gate.geometry.type === "boolean"
						? { ...gate.geometry, refs: gate.geometry.refs.map((id) => gateIds.get(id) as string) }
						: gate.geometry.type === "polygon"
							? structuredClone(gate.geometry)
							: reject("Unsupported projected geometry");
			return {
				id: gateIds.get(gate.id) as string,
				sampleId,
				name: gate.name,
				parentId: gate.parentId === null ? null : (gateIds.get(gate.parentId) as string),
				dimensions: gate.dimensions.map((name) => channelIds.get(name) as string),
				geometry,
			};
		}),
		groups: [],
		annotations: [],
	};
	let workspaceBytes: Buffer;
	try {
		workspaceBytes = Buffer.from(serializeWorkspace(model));
	} catch (error) {
		if (error instanceof ModelError) throw new AnalysisError(error.code, error.message);
		throw error;
	}
	if (workspaceBytes.length > 1024 * 1024)
		throw new AnalysisError("WORKSPACE_TOO_LARGE", "Materialized model exceeds 1 MiB");
	const gateMapping = selected.gates.map((gate) => ({
		id: gateIds.get(gate.id),
		sourceId: gate.id,
		name: gate.name,
		sourceParentId: gate.parentId,
		sourceReferences: gate.geometry.type === "boolean" ? gate.geometry.refs : [],
		sourceCount: gate.count,
	}));
	const provenance = {
		schemaVersion: 1,
		semantics: "structural-preservation-only",
		flowJoInterpretation: "unvalidated",
		numericExecution: "not-validated",
		request,
		requestHash: digest(request),
		buildId,
		agentId: request.agentId,
		contentRevision: request.expectedSha256,
		wspFormatVersion: parsed.version,
		flowJoVersion: parsed.flowJoVersion,
		coordinateConvention: request.coordinateConvention,
		source: {
			path: request.path,
			sha256: sha(bytes),
			bytes: bytes.length,
			rootAttributes: checked.rootAttributes,
			datasetAttributes: checked.datasetAttributes,
			sampleNodeAttributes: checked.nodeAttributes,
		},
		imported: { sha256: source.id, bytes: source.size, metadataHash: request.expectedMetadataHash },
		sample: {
			id: sampleId,
			sourceId: selected.id,
			sourceName: selected.name,
			sourceUri: selected.uri,
			sourceEventCount: selected.eventCount,
		},
		channelMapping,
		gateMapping,
		groups: { policy: "omit-all", sourceGroupCount: checked.sourceGroupCount },
		warnings,
		attribution:
			"agentId in receipt/provenance; revision-zero model has no human or agent edit stamps",
		sourceCounts: "reported-source-metadata-not-computed-truth",
	};
	const provenanceBytes = Buffer.from(`${boundedJson(provenance, 256 * 1024 - 1)}\n`);
	const id = randomUUID(),
		stage = join(store.temporary, id),
		destination = join(store.outputs, id);
	const descriptor = (name: string, value: Uint8Array) => ({
		path: store.relative(join(destination, name)),
		sha256: sha(value),
		bytes: value.length,
	});
	const receipt = {
		schemaVersion: 1,
		operation: "materialize_wsp_sample",
		artifactId: id,
		buildId,
		requestHash: digest(request),
		agentId: request.agentId,
		semantics: "structural-preservation-only",
		flowJoInterpretation: "unvalidated",
		numericExecution: "not-validated",
		coordinateConvention: request.coordinateConvention,
		model: {
			id: model.id,
			revision: 0,
			sampleId,
			channelCount: channelMapping.length,
			gateCount: gateMapping.length,
		},
		files: {
			workspace: descriptor("workspace.flowatlas.json", workspaceBytes),
			source: descriptor("source.wsp", bytes),
			provenance: descriptor("provenance.json", provenanceBytes),
		},
		warnings,
	};
	const receiptBytes = Buffer.from(`${boundedJson(receipt, 256 * 1024 - 1)}\n`);
	const result = {
		...receipt,
		channelMapping,
		gateMapping,
		receipt: descriptor("receipt.json", receiptBytes),
	};
	boundedJson(result, 256 * 1024);
	let owned = false;
	try {
		signal.throwIfAborted();
		await mkdir(stage, { mode: 0o700 });
		owned = true;
		for (const [name, content] of [
			["workspace.flowatlas.json", workspaceBytes],
			["source.wsp", bytes],
			["provenance.json", provenanceBytes],
			["receipt.json", receiptBytes],
		] as const) {
			signal.throwIfAborted();
			const handle = await open(join(stage, name), "wx", 0o600);
			try {
				await writeAll(handle, content);
				await handle.sync();
			} finally {
				await handle.close();
			}
		}
		signal.throwIfAborted();
		try {
			await lstat(destination);
			throw new AnalysisError("OUTPUT_EXISTS", "Materialization output already exists");
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		signal.throwIfAborted();
		await rename(stage, destination);
		return result;
	} finally {
		if (owned) await rm(stage, { recursive: true, force: true });
	}
}

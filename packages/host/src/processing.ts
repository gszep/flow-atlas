import type { FcsFile } from "@flow-atlas/fcs";
import { canonical } from "./artifact-store.js";
import { AnalysisError } from "./contracts.js";

export type Metadata = Omit<FcsFile, "data">;
export type InputSpace = "stored" | "linearized";
export interface AcquisitionRequest {
	timeChannel?: string | undefined;
	timeStep?: number | undefined;
}
export interface ProcessingRequest {
	inputSpace?: InputSpace | undefined;
	acquisition?: AcquisitionRequest | undefined;
}
export interface InputContext {
	inputSpace: InputSpace;
	acquisition?: { timeChannel?: string; timeStep: number };
}
export interface SpectralDefinition {
	id: string;
	sampleId: string;
	detectors: string[];
	fluorochromes: string[];
	matrix: number[];
	residualChannel?: string;
	outputRanges: number[];
	residualRange: number;
	context: InputContext;
	diagnostics: unknown;
}

export function parseTimeStep(value: string): number {
	const text = value.trim();
	if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return Number.NaN;
	const number = Number(text);
	return Number.isFinite(number) && number > 0 ? number : Number.NaN;
}

/** Resolve an explicit acquisition profile; this derives metadata only, never event values. */
export function inputContext(metadata: Metadata, request: ProcessingRequest): InputContext {
	const inputSpace = request.inputSpace ?? "stored";
	if (inputSpace === "stored") {
		if (request.acquisition !== undefined)
			throw new AnalysisError(
				"INVALID_PROCESSING_CONTEXT",
				"Acquisition options require inputSpace=linearized",
			);
		return { inputSpace };
	}
	const requestedTime = request.acquisition?.timeChannel;
	const matching = metadata.channels.filter((channel) =>
		requestedTime === undefined
			? channel.name.toLowerCase() === "time"
			: channel.name === requestedTime,
	);
	if (matching.length > 1 || (requestedTime !== undefined && matching.length !== 1))
		throw new AnalysisError(
			"INVALID_PROCESSING_CONTEXT",
			"Time channel is missing or ambiguous; select one exact channel name",
		);
	if (matching[0]?.amplification.some((value) => value !== 0))
		throw new AnalysisError(
			"INVALID_PROCESSING_CONTEXT",
			"Selected Time acquisition must have linear amplification",
		);
	const rawStep = metadata.keywords.$TIMESTEP ?? metadata.keywords.TIMESTEP;
	if (
		request.acquisition?.timeStep === undefined &&
		metadata.keywords.$TIMESTEP !== undefined &&
		metadata.keywords.TIMESTEP !== undefined &&
		parseTimeStep(metadata.keywords.$TIMESTEP) !== parseTimeStep(metadata.keywords.TIMESTEP)
	)
		throw new AnalysisError(
			"INVALID_PROCESSING_CONTEXT",
			"Conflicting TIMESTEP aliases require an explicit time-step override",
		);
	const step =
		request.acquisition?.timeStep ?? (rawStep === undefined ? 1 : parseTimeStep(rawStep));
	if (!Number.isFinite(step) || step <= 0)
		throw new AnalysisError(
			"INVALID_PROCESSING_CONTEXT",
			"Time step must be a finite positive number",
		);
	if (!matching.length && step !== 1)
		throw new AnalysisError(
			"INVALID_PROCESSING_CONTEXT",
			"A non-unit time step requires a time channel",
		);
	return {
		inputSpace,
		acquisition: { timeStep: step, ...(matching[0] ? { timeChannel: matching[0].name } : {}) },
	};
}

/** Matrix definitions bind their input space; requests cannot silently reinterpret them. */
export function resolveContext(
	metadata: Metadata,
	request: ProcessingRequest,
	bound?: InputContext,
): InputContext {
	if (!bound) return inputContext(metadata, request);
	if (request.inputSpace !== undefined && request.inputSpace !== bound.inputSpace)
		throw new AnalysisError(
			"PROCESSING_CONTEXT_MISMATCH",
			"Requested input space differs from the registered matrix",
		);
	if (request.acquisition !== undefined) {
		const chosen = inputContext(metadata, {
			inputSpace: bound.inputSpace,
			acquisition: request.acquisition,
		});
		if (canonical(chosen) !== canonical(bound))
			throw new AnalysisError(
				"PROCESSING_CONTEXT_MISMATCH",
				"Requested acquisition settings differ from the registered matrix",
			);
	}
	return structuredClone(bound);
}

export function processingMetadata(
	metadata: Metadata,
	context: InputContext,
	spectral?: SpectralDefinition,
): Metadata {
	const channels = metadata.channels.map((channel) =>
		context.inputSpace === "linearized"
			? { ...channel, bits: 32, amplification: [0, 0] as [number, number], gain: 1 }
			: { ...channel, amplification: [...channel.amplification] as [number, number] },
	);
	const keywords = { ...metadata.keywords };
	if (context.inputSpace === "linearized") {
		keywords.FLOWATLAS_INPUT_SPACE = "linearized";
		keywords.FLOWATLAS_ACQUISITION_PROFILE = "stored-to-acquisition-linear-f32-v1";
		keywords.$TIMESTEP = "1";
		delete keywords.TIMESTEP;
	}
	if (spectral) {
		const append = (name: string, range: number) =>
			channels.push({
				index: channels.length + 1,
				name,
				bits: 32,
				range,
				amplification: [0, 0],
				gain: 1,
			});
		for (let i = 0; i < spectral.fluorochromes.length; i++)
			append(spectral.fluorochromes[i] as string, spectral.outputRanges[i] as number);
		if (spectral.residualChannel !== undefined)
			append(spectral.residualChannel, spectral.residualRange);
		keywords.FLOWATLAS_UNMIXING_ID = spectral.id;
	}
	return {
		version: metadata.version,
		eventCount: metadata.eventCount,
		channels,
		keywords,
		...(metadata.spill ? { spill: metadata.spill } : {}),
	};
}

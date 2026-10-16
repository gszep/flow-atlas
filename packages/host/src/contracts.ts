import { z } from "zod";

export interface AnalysisService {
	invoke(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
	close(): Promise<void>;
}

export class AnalysisError extends Error {
	override readonly name = "AnalysisError";
	constructor(
		public readonly code: string,
		message: string,
		public readonly details?: unknown,
	) {
		super(message);
	}
}

const index = z.number().int().nonnegative();
const limit = z.number().int().min(1).max(100);
const id = z.string().min(1);
export const operationSchemas = {
	list_capabilities: z.strictObject({}),
	import_fcs: z.strictObject({ path: z.string().min(1) }),
	list_samples: z.strictObject({ offset: index.optional(), limit: limit.optional() }),
	inspect_fcs: z.strictObject({
		sampleId: id,
		channelOffset: index.optional(),
		channelLimit: limit.optional(),
	}),
	get_spillover: z.strictObject({ sampleId: id }),
	preview_fcs: z.strictObject({
		sampleId: id,
		offset: index.optional(),
		limit: limit.optional(),
		channels: z.array(z.string()).max(32).optional(),
		compensationId: id.optional(),
	}),
	register_compensation: z.strictObject({
		sampleId: id,
		spillover: z
			.strictObject({
				channels: z.array(z.string()).min(1).max(128),
				matrix: z.array(z.number().finite()).max(16384),
			})
			.optional(),
	}),
	start_fcs_export: z.strictObject({
		sampleId: id,
		compensationId: id.optional(),
		channels: z.array(z.string()).min(1).max(1024).optional(),
		renameChannels: z.record(z.string(), z.string()).optional(),
		keywords: z.record(z.string(), z.string()).optional(),
		startEvent: index.optional(),
		eventCount: index.optional(),
		outputName: z.string().optional(),
	}),
	get_job: z.strictObject({ jobId: id }),
	cancel_job: z.strictObject({ jobId: id }),
	get_receipt: z.strictObject({ jobId: id }),
} as const;
export type OperationName = keyof typeof operationSchemas;
export type OperationArgs<N extends OperationName> = z.infer<(typeof operationSchemas)[N]>;

export function validateOperation(name: string, args: unknown): unknown {
	if (!Object.hasOwn(operationSchemas, name))
		throw new AnalysisError("METHOD_NOT_FOUND", "Unknown analysis operation");
	const result = operationSchemas[name as OperationName].safeParse(args);
	if (!result.success)
		throw new AnalysisError(
			"INVALID_PARAMS",
			"Invalid operation arguments",
			result.error.issues.map(({ code, path, message }) => ({ code, path, message })),
		);
	return result.data;
}

export function errorFields(error: unknown): { code: string; message: string; details?: unknown } {
	if (error instanceof AnalysisError)
		return {
			code: error.code,
			message: error.message,
			...(error.details === undefined ? {} : { details: error.details }),
		};
	return { code: "INTERNAL_ERROR", message: "Internal analysis error" };
}

export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
// Bound before serialization, including traversal, nesting and escaped strings.
export function boundedJson(value: unknown, maximum = MAX_RESPONSE_BYTES): string {
	let remaining = maximum;
	const chunks: string[] = [];
	const ancestors = new Set<object>();
	const fail = () => {
		throw new AnalysisError("RESPONSE_TOO_LARGE", "Response exceeds JSON size or complexity limit");
	};
	const append = (text: string) => {
		remaining -= Buffer.byteLength(text);
		if (remaining < 0) fail();
		chunks.push(text);
	};
	const string = (text: string) => {
		if (text.length > remaining) fail();
		append(JSON.stringify(text));
	};
	let nodes = 0;
	const visit = (item: unknown, depth: number): void => {
		if (++nodes > 50000 || depth > 64) fail();
		if (typeof item === "string") {
			string(item);
			return;
		}
		if (
			item === null ||
			typeof item === "boolean" ||
			(typeof item === "number" && Number.isFinite(item))
		) {
			append(String(item));
			return;
		}
		if (typeof item !== "object" || item === null || ancestors.has(item))
			throw new AnalysisError("INVALID_RESULT", "Backend must return finite JSON data");
		ancestors.add(item);
		if (Array.isArray(item)) {
			append("[");
			for (let i = 0; i < item.length; i++) {
				if (i) append(",");
				visit(item[i], depth + 1);
			}
			append("]");
		} else {
			if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
				throw new AnalysisError("INVALID_RESULT", "Backend must return plain JSON objects");
			append("{");
			let first = true;
			for (const key in item) {
				if (!Object.hasOwn(item, key)) continue;
				if (++nodes > 50000) fail();
				const value = (item as Record<string, unknown>)[key];
				// Match JSON.stringify's omission of optional object properties (SDK metadata).
				if (value === undefined) continue;
				if (!first) append(",");
				first = false;
				string(key);
				append(":");
				visit(value, depth + 1);
			}
			append("}");
		}
		ancestors.delete(item);
	};
	visit(value, 0);
	return chunks.join("");
}

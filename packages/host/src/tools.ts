import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import {
	type AnalysisService,
	boundedJson,
	errorFields,
	type OperationName,
	operationSchemas,
	validateOperation,
} from "./contracts.js";

export const operationDescriptions: Record<OperationName, string> = {
	inspect_workspace:
		"Read a confined model-schema workspace JSON (up to 1 MiB), returning byte hash/revision and byte-bounded sample, gate, channel, group or group-member metadata pages. Optional hash/revision guard keeps pages consistent. No workspace edits or implicit FCS import.",
	start_workspace_gate_counts:
		"Count one workspace sample's gates from an admitted document snapshot bound to expected byte hash and revision. Resolves channel IDs to exact names and requires an already-imported FCS artifact. Stored-F32 computation and immutable receipt lineage; no document writes.",
	start_workspace_population_medians:
		"Compute median-rank endpoints for one workspace sample/population and target channel IDs, bound to expected document hash/revision. Root uses null populationId. Existing stored-F32 rank policy, admitted-snapshot semantics and already-imported FCS inputs; no workspace edits.",
	start_batch_population_medians:
		"Compute per-sample exact median-rank tables for one shared stored-F32 population and channel list across 1–32 distinct immutable samples. At most 512 sample/channel rows. Four passes per source, atomic publication, no pooling/midpoint interpolation; empty or selected-nonfinite sources reject with source diagnostics.",
	start_population_medians:
		"Compute exact lower/upper F32 median rank endpoints for one explicit stored-F32 gate population (or null for the selected root). Four replay passes; 1–32 named channels; no midpoint interpolation or vendor parity. Empty populations and selected nonfinite targets reject with diagnostics.",
	start_batch_gate_counts:
		"Apply one explicit stored-F32 gate recipe across 1–32 distinct immutable samples. Returns an indexed per-sample count/frequency table; maximum 512 sample/gate rows, no pooled statistics or workspace edits. Atomic job with provenance and cancellation.",
	start_gate_counts:
		"Count explicit raw stored-F32 rectangle, polygon and Boolean populations in streamed immutable FCS input. Returns parent/root denominators and frequencies through a job receipt; no display transforms or workspace edits.",
	start_control_estimation:
		"Estimate a conventional primary-normalized median-difference matrix from explicit positive/negative FCS populations. GPU rank selection and arithmetic, with support/separation and conditioning diagnostics. Not AutoSpill or vendor parity.",
	list_capabilities:
		"Discover supported data spaces, algorithms, resource bounds and explicit unsupported operations. No CPU fallback or weighted unmixing is implied.",
	import_fcs: "Import an FCS file relative to the backend's configured input root.",
	list_samples: "List a bounded page of imported sample metadata.",
	inspect_fcs: "Inspect a bounded page of channel metadata without returning event arrays.",
	get_spillover:
		"Inspect conventional FCS spillover metadata; spectral references are supplied separately through register_unmixing.",
	preview_fcs:
		"Preview a bounded event/channel page in an explicit input space, optionally using conventional compensation or named spectral OLS. Returns channel roles and preprocessing evidence.",
	register_compensation:
		"Register conventional spillover compensation, using embedded metadata by default, bound to an explicit input space. Backend validates on GPU; use register_unmixing for spectral OLS.",
	register_unmixing:
		"Register named-detector/fluorochrome spectral OLS, with explicit input space and optional per-event residual. Appends derived channels; not weighted or vendor-specific unmixing.",
	start_fcs_export:
		"Start a streamed FCS export with explicit acquisition scaling and optional conventional compensation or spectral OLS. Returns job metadata and later a reproducible receipt, not file bytes.",
	get_job: "Inspect an export job's bounded progress metadata.",
	cancel_job: "Request cancellation of a backend-owned export job.",
	get_receipt: "Read the backend's export receipt; not a human provenance stamp.",
};

export async function invokeOperation(
	service: AnalysisService,
	name: string,
	args: unknown,
	signal?: AbortSignal,
): Promise<unknown> {
	return service.invoke(name, validateOperation(name, args), signal);
}

export function createAnalysisMcpServer(service: AnalysisService, signal?: AbortSignal): McpServer {
	const server = new McpServer({ name: "flow-atlas", version: "0.0.0" });
	for (const name of Object.keys(operationSchemas) as OperationName[]) {
		server.registerTool(
			name,
			{ description: operationDescriptions[name], inputSchema: operationSchemas[name] },
			async (args: unknown, context: ServerContext) => {
				try {
					const result = await invokeOperation(
						service,
						name,
						args,
						signal ? AbortSignal.any([signal, context.mcpReq.signal]) : context.mcpReq.signal,
					);
					return {
						content: [{ type: "text" as const, text: boundedJson(result, MAX_TOOL_BYTES) }],
					};
				} catch (error) {
					let fields = errorFields(error);
					try {
						boundedJson(fields, MAX_TOOL_BYTES);
					} catch (failure) {
						fields = errorFields(failure);
					}
					return {
						isError: true,
						content: [{ type: "text" as const, text: boundedJson({ error: fields }) }],
						structuredContent: { error: fields },
					};
				}
			},
		);
	}
	return server;
}
// Leave room for MCP envelope and escaped text in the 1 MiB HTTP response.
const MAX_TOOL_BYTES = 256 * 1024;

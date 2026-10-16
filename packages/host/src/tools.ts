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
	list_capabilities:
		"Discover backend capabilities and explicit unsupported operations. No CPU fallback or spectral unmixing is implied.",
	import_fcs: "Import an FCS file relative to the backend's configured input root.",
	list_samples: "List a bounded page of imported sample metadata.",
	inspect_fcs: "Inspect a bounded page of channel metadata without returning event arrays.",
	get_spillover: "Inspect conventional spillover metadata; spectral unmixing is unsupported.",
	preview_fcs:
		"Preview a bounded event/channel page, optionally using registered conventional GPU compensation; no CPU fallback.",
	register_compensation:
		"Register conventional spillover compensation, using embedded metadata by default. Backend validates on GPU; spectral unmixing is unsupported.",
	start_fcs_export:
		"Start a backend-owned FCS export job, optionally with conventional GPU compensation. Returns job metadata, not file bytes.",
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

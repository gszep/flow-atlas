// Shared, bounded demo contract. No event arrays, arbitrary code, files or URLs.
const string = { type: "string", minLength: 1, maxLength: 160 };
const revision = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const channel = { type: "integer", minimum: 0, maximum: 255 };
const populationId = { oneOf: [string, { type: "integer", minimum: 0, maximum: 65535 }] };
const optionalPopulationId = { oneOf: [...populationId.oneOf, { type: "null" }] };
const object = (properties, required = Object.keys(properties)) => ({
	type: "object",
	properties,
	required,
	additionalProperties: false,
});
const tool = (name, description, input_schema) => ({ name, description, input_schema });
export const DEMO_TOOLS = [
	tool("inspect_dataset", "Inspect aggregate demo dataset metadata, not raw events.", object({})),
	tool(
		"list_populations",
		"List saved populations and imported references, with directly inspectable ids. Use ref:<index> for references and all for the dataset baseline.",
		object({}),
	),
	tool(
		"inspect_population",
		"Inspect marker distributions for a named population, an imported reference (id e.g. ref:18, or its integer index), or all for the dataset baseline. Optional within computes the actual intersection with that population and reports overlap counts. Use returned ids; reference inspection does not create populations.",
		object(
			{ id: populationId, within: optionalPopulationId, includeGeometry: { type: "boolean" } },
			["id"],
		),
	),
	tool(
		"create_population",
		"Create an agent-owned candidate. For a subset of a lasso, pass within=<lasso id>: membership is the intersection, not the whole reference. refines only records a proposed correction and can expand the original. Reference sources use the reference index from list_populations. Preserve human originals; no raw-event access is needed for these tools.",
		object(
			{
				expectedRevision: revision,
				name: string,
				source: {
					oneOf: [
						object({
							kind: { const: "polygon" },
							points: {
								type: "array",
								minItems: 3,
								maxItems: 128,
								items: object({ x: { type: "number" }, y: { type: "number" } }),
							},
						}),
						object({
							kind: { const: "reference" },
							population: { type: "integer", minimum: 0, maximum: 65535 },
						}),
						object({
							kind: { const: "ranges" },
							ranges: {
								type: "array",
								minItems: 1,
								maxItems: 8,
								items: object({
									channel,
									min: { type: ["number", "null"] },
									max: { type: ["number", "null"] },
								}),
							},
						}),
					],
				},
				rationale: { type: "string", maxLength: 2000 },
				refines: { ...string, type: ["string", "null"] },
				within: optionalPopulationId,
			},
			["expectedRevision", "name", "source"],
		),
	),
	tool(
		"rename_population",
		"Rename an agent-owned population at the expected revision.",
		object({ expectedRevision: revision, id: string, name: string }),
	),
	tool(
		"delete_population",
		"Delete only an agent-owned population at the expected revision; never delete human originals.",
		object({ expectedRevision: revision, id: string }),
	),
	tool(
		"select_population",
		"Highlight, inspect and zoom to a named population, imported ref:<index> reference, or all. Set focus=false to preserve the current camera. This changes the view, not membership.",
		object({ id: populationId, focus: { type: "boolean" } }, ["id"]),
	),
	tool("set_marker", "Choose a marker channel for the demo view.", object({ channel: string })),
];

// Deliberately implements only the schema vocabulary above, not arbitrary JSON Schema.
function matches(value, schema) {
	if (schema.oneOf) return schema.oneOf.filter((s) => matches(value, s)).length === 1;
	if ("const" in schema) return value === schema.const;
	if (Array.isArray(schema.type))
		return schema.type.some((type) => matches(value, { ...schema, type }));
	switch (schema.type) {
		case "boolean":
			return typeof value === "boolean";
		case "null":
			return value === null;
		case "string":
			return (
				typeof value === "string" &&
				value.length >= (schema.minLength ?? 0) &&
				value.length <= schema.maxLength
			);
		case "integer":
			return Number.isSafeInteger(value) && value >= schema.minimum && value <= schema.maximum;
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "array":
			return (
				Array.isArray(value) &&
				value.length >= schema.minItems &&
				value.length <= schema.maxItems &&
				value.every((v) => matches(v, schema.items))
			);
		case "object":
			return (
				value !== null &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				Object.keys(value).every((k) => Object.hasOwn(schema.properties, k)) &&
				schema.required.every((k) => Object.hasOwn(value, k)) &&
				Object.entries(value).every(([k, v]) => matches(v, schema.properties[k]))
			);
		default:
			return false;
	}
}
export function validToolInput(name, input) {
	const definition = DEMO_TOOLS.find((t) => t.name === name);
	return !!definition && matches(input, definition.input_schema);
}

export const MCP_TOOLS = DEMO_TOOLS.map(({ name, description, input_schema }) => ({
	name,
	description,
	inputSchema: input_schema,
	annotations: {
		readOnlyHint: ["inspect_dataset", "list_populations", "inspect_population"].includes(name),
		destructiveHint: name === "delete_population",
		openWorldHint: false,
	},
}));

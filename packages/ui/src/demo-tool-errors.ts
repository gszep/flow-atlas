export class DemoToolError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly recovery?: unknown,
	) {
		super(message);
	}
}

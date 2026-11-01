import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Authenticate the complete archive before tar is allowed to extract any entries. */
export async function verifyPublicationArchive(filename, expected) {
	if (
		!Number.isSafeInteger(expected.bytes) ||
		expected.bytes < 1 ||
		!/^[a-f0-9]{64}$/.test(expected.sha256)
	)
		throw new Error("Invalid archive descriptor");
	const info = await lstat(filename);
	if (!info.isFile() || info.isSymbolicLink() || info.size !== expected.bytes)
		throw new Error("Publication archive size/type mismatch");
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filename)) hash.update(chunk);
	if (hash.digest("hex") !== expected.sha256) throw new Error("Publication archive hash mismatch");
	return { verifiedBytes: info.size, sha256: expected.sha256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const expected = JSON.parse(
		await readFile(new URL("./publication-artifact.json", import.meta.url), "utf8"),
	);
	console.log(JSON.stringify(await verifyPublicationArchive(process.argv[2], expected)));
}

import type { PublicationProgress } from "./publication.js";

export function downloadPresentation(progress: PublicationProgress) {
	if (progress.phase === "manifest" || progress.totalBytes === 0)
		return { label: "Loading dataset…", detail: "Reading manifest", percent: null };
	const percent = Math.min(100, (progress.downloadedBytes / progress.totalBytes) * 100);
	return {
		label:
			percent === 100 && progress.verifiedFiles < progress.fileCount
				? "Verifying downloaded files…"
				: progress.cachedFiles
					? "Loading cached data…"
					: "Downloading dataset…",
		detail: `${Math.floor(percent)}% · ${(progress.downloadedBytes / 2 ** 20).toFixed(1)} / ${(progress.totalBytes / 2 ** 20).toFixed(1)} MiB · ${progress.verifiedFiles}/${progress.fileCount} files verified`,
		percent,
	};
}
/** One automatic invocation; subsequent attempts require a user retry after settlement. */
export function createLoadGate() {
	let busy = false;
	return {
		get busy() {
			return busy;
		},
		begin() {
			if (busy) return false;
			busy = true;
			return true;
		},
		finish() {
			busy = false;
		},
	};
}

export interface Camera {
	zoom: number;
	panX: number;
	panY: number;
}

/** Map the completed image's clip coordinates into the live gesture camera. */
export function previewTransform(completed: Camera, live: Camera): Float32Array<ArrayBuffer> {
	const scale = live.zoom / completed.zoom;
	return new Float32Array([
		scale,
		scale,
		live.panX - scale * completed.panX,
		live.panY - scale * completed.panY,
	]);
}

/** Keep the data point under the old gesture centre under the new one. */
export function moveCamera(
	camera: Camera,
	fromX: number,
	fromY: number,
	toX: number,
	toY: number,
	factor: number,
): Camera {
	const zoom = Math.max(0.02, Math.min(10000, camera.zoom * factor));
	const ratio = zoom / camera.zoom;
	return {
		zoom,
		panX: toX - (fromX - camera.panX) * ratio,
		panY: toY - (fromY - camera.panY) * ratio,
	};
}

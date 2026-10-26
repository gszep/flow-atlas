export interface Camera {
	zoom: number;
	panX: number;
	panY: number;
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

/** Display-only selection by workspace sample index, not an inferred patient identity. */
export function sampleVisible(
	index: number,
	selectedSample: number | null,
	groups: readonly string[],
	conditions: readonly string[],
	batches: readonly string[],
	selectedGroups: ReadonlySet<string>,
): boolean {
	if (selectedSample !== null && selectedSample !== index) return false;
	if ([...conditions, ...batches].every((group) => selectedGroups.has(group))) return true;
	const matches = (names: readonly string[]) =>
		names.length === 0 ||
		groups.some((group) => names.includes(group) && selectedGroups.has(group));
	return matches(conditions) && matches(batches);
}

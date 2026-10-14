// DEPRECATED: legacy v2 `run()` plugin; the engine only invokes named
// PostProcessingPluginModule hooks, nothing calls `run()`, and no active
// workflow references this file.
/**
 * Aggregate Rundown Items - Post-Processing Plugin
 * Aggregates analysis results into structured rundown items.
 * Version 2 — receives PostProcessingInput (TimeSlice[])
 */
export const version = 2;

export const run = async (input, _config) => {
  console.log('[AGGREGATE-RUNDOWN-ITEMS] Plugin executed');
  console.log('[AGGREGATE-RUNDOWN-ITEMS] Total slices:', input.length);

  const counts = {};
  for (const slice of input) {
    counts[slice.type] = (counts[slice.type] || 0) + 1;
    console.log(`[AGGREGATE-RUNDOWN-ITEMS] ${slice.from} - ${slice.to}: ${slice.type} (scene ${slice.sceneIndex})`);
  }

  console.log('[AGGREGATE-RUNDOWN-ITEMS] Counts by type:', counts);
  console.log('[AGGREGATE-RUNDOWN-ITEMS] Done');

  return input;
};

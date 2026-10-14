/**
 * Convert a host-side media path inside the sample_data tree to the path the
 * inference containers see: the tree is bind-mounted at /sample_data, so
 * everything up to the first "/sample_data/" segment is dropped. Paths outside
 * the sample_data tree pass through unchanged (and will fail server-side).
 */
export const toSampleDataContainerPath = (hostPath: string): string => {
    const marker = "/sample_data/";
    const idx = hostPath.indexOf(marker);
    return idx >= 0 ? hostPath.slice(idx) : hostPath;
};

/**
 * ASR endpoint URL building.
 *
 * Configured ASR endpoints vary in shape: bare hosts ("http://host:8999"),
 * API-root suffixes ("http://host:8998/v1"), or even full paths
 * ("http://host:8999/v1/audio/transcriptions"). Naive concatenation would
 * produce doubled path segments, so the suffix is normalized here.
 */

/**
 * Build the full URL for an endpoint path (e.g. "v1/audio/transcriptions"),
 * tolerating endpoints that already include "/v1" or the full path.
 */
export const buildEndpointUrl = (endpoint: string, path: string): string => {
    const trimmed = endpoint.replace(/\/+$/, "");
    const normalizedPath = path.replace(/^\/+/, "");
    if (trimmed.endsWith(`/${normalizedPath}`)) return trimmed;
    if (trimmed.endsWith("/v1") && normalizedPath.startsWith("v1/")) {
        return `${trimmed}/${normalizedPath.slice("v1/".length)}`;
    }
    return `${trimmed}/${normalizedPath}`;
};

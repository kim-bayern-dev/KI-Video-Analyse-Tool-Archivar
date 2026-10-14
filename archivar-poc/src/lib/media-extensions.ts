/**
 * File extensions the pre-processing services (segment-scenes /
 * segment-temporal) can decode — the UI lists exactly these, and the server
 * classifies media types from them. Kept in sync with the segment-temporal
 * README ("Supported formats").
 *
 * Isomorphic (no Node/DOM APIs): imported by both the server (file-api.ts)
 * and the client (dashboard).
 */
export const VIDEO_EXTENSIONS = [
  "mp4", "mov", "mkv", "webm", "avi", "3g2", "3gp", "asf", "divx", "dv",
  "f4v", "flv", "m1v", "m2ts", "m4v", "mk3d", "mpe", "mpeg", "mpg", "mts",
  "mxf", "nut", "ogm", "ogv", "qt", "rm", "rmvb", "ts", "vob", "wmv",
  "xvid", "y4m",
];
export const AUDIO_EXTENSIONS = [
  "mp3", "wav", "flac", "m4a", "ogg", "ac3", "aiff", "au", "caf", "mp2", "wma",
];
export const IMAGE_EXTENSIONS = [
  "png", "jpg", "jpeg", "webp", "avif", "bmp", "dpx", "exr", "fits", "gif",
  "hdr", "j2k", "jls", "jp2", "ljpg", "pam", "pbm", "pcx", "pgm", "ppm",
  "qoi", "ras", "sgi", "tga", "tiff", "wbmp", "xbm", "xwd",
];

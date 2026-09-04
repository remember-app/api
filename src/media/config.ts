// The numbers architecture.md «Лимиты» proposes, and they live in the
// environment rather than in the code that enforces them: they are expected to
// move once real material lands, and there is no admin screen to move them from.
//
// `positive` comes from the auth config because it is the same rule and there
// is one of it: a value that is not a positive number is a typo, not an intent,
// so it falls back instead of being obeyed — `MEMORY_MAX_FILES=-1` must not
// quietly mean «no ceiling».
import { positive } from "../auth/config.ts";

/** One file: 1 GiB. */
export const maxFileBytes = () => positive("MEDIA_MAX_FILE_BYTES", 1024 ** 3);

/** One video: 5 minutes. */
export const maxVideoSeconds = () => positive("MEDIA_MAX_VIDEO_SECONDS", 300);

/** One memory: 10 GiB and 1000 files. */
export const memoryMaxBytes = () => positive("MEMORY_MAX_STORAGE_BYTES", 10 * 1024 ** 3);
export const memoryMaxFiles = () => positive("MEMORY_MAX_FILES", 1000);

/**
 * The slice the client cuts the file into. Inside S3's 5–10 MB band from
 * architecture.md, and above the 5 MiB floor S3 puts on every part but the last.
 */
export const partBytes = () => positive("MEDIA_UPLOAD_PART_BYTES", 8 * 1024 ** 2);

/** How long a handed-out upload link lives — ~1 h, per architecture.md. */
export const uploadTtlSeconds = () => positive("R2_UPLOAD_TTL_SECONDS", 3600);

/**
 * And a handed-out download link — ~15 min, per the same. Far shorter than the
 * upload one because it is handed out by the screenful: a gallery link that
 * outlived the membership behind it would keep opening after the person was
 * excluded, so it expires long before that matters.
 */
export const downloadTtlSeconds = () => positive("R2_DOWNLOAD_TTL_SECONDS", 900);

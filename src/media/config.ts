import { positive } from "../auth/config.ts";
export const maxFileBytes = () => positive("MEDIA_MAX_FILE_BYTES", 1024 ** 3);
export const maxVideoSeconds = () => positive("MEDIA_MAX_VIDEO_SECONDS", 300);
export const memoryMaxBytes = () => positive("MEMORY_MAX_STORAGE_BYTES", 10 * 1024 ** 3);
export const memoryMaxFiles = () => positive("MEMORY_MAX_FILES", 1000);
export const partBytes = () => positive("MEDIA_UPLOAD_PART_BYTES", 8 * 1024 ** 2);
export const uploadTtlSeconds = () => positive("R2_UPLOAD_TTL_SECONDS", 3600);
export const downloadTtlSeconds = () => positive("R2_DOWNLOAD_TTL_SECONDS", 900);

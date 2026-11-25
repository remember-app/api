import { fileURLToPath } from "node:url";

export const ASSETS = fileURLToPath(new URL("../../../assets", import.meta.url));

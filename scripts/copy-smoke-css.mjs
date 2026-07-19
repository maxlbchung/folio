import { copyFile } from "node:fs/promises";

await copyFile(new URL("../src/styles/app.css", import.meta.url), new URL("../dist-smoke/app.css", import.meta.url));

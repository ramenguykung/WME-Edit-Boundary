"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** The SDK bundle accidentally repeats an unavailable internal import. */
const brokenImport = 'import type { WmeSDK } from "Waze/MapEditor/UI/Userscripts/WmeSDK";';
/** Resolve only the installed official SDK dependency. */
const declarationPath = path.join(path.dirname(require.resolve("wme-sdk-typings/package.json")), "index.d.ts");
const declarations = fs.readFileSync(declarationPath, "utf8");
const occurrences = declarations.split(brokenImport).length - 1;

if (occurrences !== 0) {
  if (occurrences !== 1 || !declarations.includes("export declare class WmeSDK extends SdkModule")) {
    throw new Error("The installed SDK declaration layout changed; review its import repair before continuing.");
  }
  fs.writeFileSync(declarationPath, declarations.replace(brokenImport, ""), "utf8");
  process.stdout.write("Repaired the redundant internal import in the official WME SDK declarations.\n");
}

# SDK declaration compatibility

The official `wme-sdk-typings` archive at version `v2.367-2-g5ef3c024df` exports `WmeSDK`, then repeats a trailing import of the same name from `Waze/MapEditor/UI/Userscripts/WmeSDK`. That internal path is not included in the package. TypeScript reports TS2395 and TS2307 before checking the userscript.

`repair-sdk-types.cjs` runs after dependency installation. It removes only that exact redundant import after verifying that there is exactly one occurrence and that the exported SDK class exists. The global `Window` declarations then use the official exported class already present in the bundle. Repeated runs do nothing, including when a future SDK package no longer contains the broken import.

This is a development declaration repair. It adds no runtime import, changes no WME API definitions, and does not alter Waze or Tampermonkey. The project retains strict JavaScript checking, `noEmit`, and `skipLibCheck: false` so SDK and application errors remain visible. `package-lock.json` pins the checked dependency artifact and TypeScript version.

If dependencies were installed with lifecycle scripts disabled, run `node types/repair-sdk-types.cjs` before `npm run typecheck`.

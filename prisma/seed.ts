import { bootstrapDemo } from "../src/server/demo.js";

await bootstrapDemo({ reset: true });
console.log("Demo data is ready.");

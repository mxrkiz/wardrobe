// Run with: node tests/e2e/fixtures/create-fixtures.js
// Generates red1x1.png — a minimal 1×1 red PNG for E2E test uploads.
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Minimal valid 1×1 red pixel PNG (hand-crafted, no deps)
const PNG = Buffer.from(
  "89504e470d0a1a0a" + // PNG signature
  "0000000d49484452" + // IHDR chunk length + type
  "00000001" +         // width: 1
  "00000001" +         // height: 1
  "08020000" +         // bit depth 8, colour type 2 (RGB), compression, filter, interlace
  "0090wc3d" +         // IHDR CRC (placeholder — use real file instead)
  "",
  "hex",
);

// Use a known-good base64-encoded 1×1 red PNG instead
const RED1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADklEQVQI12P4z8BQDwAEgAF/QualIQAAAABJRU5ErkJggg==",
  "base64",
);

writeFileSync(path.join(__dirname, "red1x1.png"), RED1X1);
console.log("created red1x1.png");

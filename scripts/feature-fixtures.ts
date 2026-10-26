import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { alphaFixture, isoFixture } from "../test/helpers/heif";
const directory = process.argv[2];
if (!directory) throw Error("Provide an output directory");
mkdirSync(directory, { recursive: true });
for (const depth of [8, 10, 12]) {
  writeFileSync(join(directory, `alpha-${depth}.heic`), alphaFixture(depth));
  writeFileSync(join(directory, `iso-${depth}.heic`), isoFixture(depth));
}

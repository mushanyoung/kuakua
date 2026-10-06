// One-off directory sync from whichever DIRECTORY_SOURCE is configured: `bun run sync`
import { syncDirectory } from "./directory";

const result = await syncDirectory("cli");
console.log(result);

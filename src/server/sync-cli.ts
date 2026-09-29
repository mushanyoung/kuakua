// One-off directory sync: `bun run sync`
import { syncDirectory } from "./lark";

const result = await syncDirectory("cli");
console.log(result);

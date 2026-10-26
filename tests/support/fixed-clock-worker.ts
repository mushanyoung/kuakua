// Test-only entry: concurrent requests deliberately share one millisecond.
// The production Worker and all its D1 statements execute unchanged.
import worker from "../../src/server/worker.ts";

Date.now = () => Date.parse("2026-10-26T12:00:00.000Z");
export default worker;

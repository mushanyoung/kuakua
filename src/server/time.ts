import { createCalendar } from "../shared/calendar.ts";
import { config } from "./config";

export { isPeriod, type Range } from "../shared/calendar.ts";
export const { periodOf, periodBounds, rangeStart } = createCalendar(config.timezone);

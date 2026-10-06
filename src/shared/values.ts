// Recognition "values" a kudos can be tagged with. Shared by server (validation,
// Lark notifications) and web (chips, filters, profile breakdown). A deployment can
// replace the defaults with VALUES_FILE; the server loads it and sends it to the web
// in /api/me, and both sides call setValues() before using them.
export const VALUE_ICONS = ["users", "rocket", "bulb", "target", "gem", "book", "lifebuoy", "heart"] as const;

export type ValueTag = {
  id: string;
  zh: string;
  en: string;
  color: string;
  icon: (typeof VALUE_ICONS)[number];
};

export const DEFAULT_VALUES: ValueTag[] = [
  { id: "teamwork", zh: "团队协作", en: "Teamwork", color: "#7FB2FF", icon: "users" },
  { id: "ownership", zh: "使命必达", en: "Ownership", color: "#FF9F6B", icon: "rocket" },
  { id: "innovation", zh: "创新突破", en: "Innovation", color: "#B79BFF", icon: "bulb" },
  { id: "customer", zh: "客户至上", en: "Customer first", color: "#5EE6C0", icon: "target" },
  { id: "craft", zh: "精益求精", en: "Craftsmanship", color: "#FFD27A", icon: "gem" },
  { id: "sharing", zh: "乐于分享", en: "Knowledge sharing", color: "#8FE388", icon: "book" },
  { id: "rescue", zh: "雪中送炭", en: "Came to the rescue", color: "#FF8FB1", icon: "lifebuoy" },
  { id: "kindness", zh: "温暖有爱", en: "Kindness", color: "#FF6B8B", icon: "heart" },
];

let current = DEFAULT_VALUES;
export const values = () => current;
export const setValues = (list: ValueTag[]) => void (current = list);
export const valueById = (id: string | null | undefined) => current.find((v) => v.id === id);
export const isValueId = (id: string) => current.some((v) => v.id === id);

// Validates a VALUES_FILE's parsed JSON; throws with a readable message.
export function parseValues(raw: unknown): ValueTag[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("expected a non-empty JSON array");
  const seen = new Set<string>();
  return raw.map((v, i) => {
    const where = `entry ${i + 1}`;
    if (!v || typeof v !== "object") throw new Error(`${where}: expected an object`);
    const { id, zh, en, color, icon } = v as Record<string, unknown>;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error(`${where}: id must be a lowercase slug`);
    if (seen.has(id)) throw new Error(`${where}: duplicate id "${id}"`);
    seen.add(id);
    if (typeof zh !== "string" || !zh.trim()) throw new Error(`${where}: zh is required`);
    if (color !== undefined && (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color))) {
      throw new Error(`${where}: color must look like #RRGGBB`);
    }
    if (icon !== undefined && !VALUE_ICONS.includes(icon as never)) {
      throw new Error(`${where}: icon must be one of ${VALUE_ICONS.join(", ")}`);
    }
    return {
      id,
      zh: zh.trim(),
      en: typeof en === "string" && en.trim() ? en.trim() : zh.trim(),
      color: (color as string | undefined) ?? DEFAULT_VALUES[i % DEFAULT_VALUES.length]!.color,
      icon: (icon as ValueTag["icon"] | undefined) ?? "heart",
    };
  });
}

// "+1" renders as text and is also offered as a one-tap button on every card.
export const PLUS_ONE = "+1";
export const REACTIONS = [PLUS_ONE, "❤️", "👏", "🎉", "🔥", "🙌", "💯"] as const;

export const LIMITS = {
  messageMax: 1000,
  messageMinBonus: 10,
  commentMax: 500,
  recipientsMax: 20,
  ccMax: 10,
};

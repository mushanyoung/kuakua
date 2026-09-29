// Recognition "values" a kudos can be tagged with. Shared by server (validation,
// Lark notifications) and web (chips, filters, profile breakdown).
export type ValueTag = {
  id: string;
  zh: string;
  en: string;
  color: string;
  icon: "users" | "rocket" | "bulb" | "target" | "gem" | "book" | "lifebuoy" | "heart";
};

export const VALUES: ValueTag[] = [
  { id: "teamwork", zh: "团队协作", en: "Teamwork", color: "#7FB2FF", icon: "users" },
  { id: "ownership", zh: "使命必达", en: "Ownership", color: "#FF9F6B", icon: "rocket" },
  { id: "innovation", zh: "创新突破", en: "Innovation", color: "#B79BFF", icon: "bulb" },
  { id: "customer", zh: "客户至上", en: "Customer first", color: "#5EE6C0", icon: "target" },
  { id: "craft", zh: "精益求精", en: "Craftsmanship", color: "#FFD27A", icon: "gem" },
  { id: "sharing", zh: "乐于分享", en: "Knowledge sharing", color: "#8FE388", icon: "book" },
  { id: "rescue", zh: "雪中送炭", en: "Came to the rescue", color: "#FF8FB1", icon: "lifebuoy" },
  { id: "kindness", zh: "温暖有爱", en: "Kindness", color: "#FF6B8B", icon: "heart" },
];

export const VALUE_IDS = new Set(VALUES.map((v) => v.id));
export const valueById = (id: string | null | undefined) => VALUES.find((v) => v.id === id);

export const REACTIONS = ["❤️", "👏", "🎉", "🔥", "🙌", "💯"] as const;

export const LIMITS = {
  messageMax: 1000,
  messageMinBonus: 10,
  commentMax: 500,
  recipientsMax: 20,
};

export type User = {
  id: number;
  name: string;
  enName: string | null;
  avatar: string;
  dept: string | null;
  deptEn: string | null;
  title: string | null;
  active: boolean;
  joinedAt: number | null;
  handle: string | null;
  leaderId: number | null;
  received?: number;
};

export type Users = Record<number, User>;

export type Post = {
  id: number;
  kind: "kudos" | "bonus";
  senderId: number;
  recipientIds: number[];
  ccIds: number[];
  message: string;
  valueTag: string | null;
  points: number;
  createdAt: number;
  reactions: { emoji: string; userIds: number[] }[];
  commentCount: number;
  canDelete: boolean;
};

export type Comment = { id: number; userId: number; body: string; createdAt: number; canDelete: boolean };

export type Allowance = { period: string; total: number; spent: number; remaining: number; resetsAt: number };

export type Me = {
  user: User;
  email: string;
  isAdmin: boolean;
  lang: "zh" | "en" | null;
  allowance: Allowance;
  config: { monthlyAllowance: number; bonusAmounts: number[]; lark: boolean; timezone: string };
};

export type Feed = { posts: Post[]; users: Users; nextCursor: number | null };
export type PostDetail = { post: Post; users: Users; comments: Comment[] };

export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init?.method ?? "GET",
      headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError("network", 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? "internal", res.status);
  }
  return (await res.json()) as T;
}

// English name only when it adds something (many colleagues' name is already English).
export const altName = (u: User) =>
  u.enName && u.enName.trim().toLowerCase() !== u.name.trim().toLowerCase() ? u.enName : null;

export const avatarSrc = (u: Pick<User, "avatar"> | undefined, size: 240 | 640 = 240) =>
  !u ? "" : size === 640 ? `${u.avatar}${u.avatar.includes("?") ? "&" : "?"}s=640` : u.avatar;

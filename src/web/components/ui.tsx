import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  BookOpenIcon,
  HeartIcon,
  LifebuoyIcon,
  LightBulbIcon,
  RocketLaunchIcon,
  UsersIcon,
  ViewfinderCircleIcon,
  WrenchScrewdriverIcon,
} from "@heroicons/react/24/outline";
import { avatarSrc, type User } from "../api";
import { Link } from "../router";
import { useApp } from "../state";
import { valueById, type ValueTag } from "../../shared/values";

const VALUE_ICONS: Record<ValueTag["icon"], typeof HeartIcon> = {
  users: UsersIcon,
  rocket: RocketLaunchIcon,
  bulb: LightBulbIcon,
  target: ViewfinderCircleIcon,
  gem: WrenchScrewdriverIcon,
  book: BookOpenIcon,
  lifebuoy: LifebuoyIcon,
  heart: HeartIcon,
};

export function ValueIcon({ icon, className }: { icon: ValueTag["icon"]; className?: string }) {
  const Icon = VALUE_ICONS[icon];
  return <Icon className={className} aria-hidden="true" />;
}

export function ValueChip({
  id,
  count,
  active,
  onClick,
  size = "md",
}: {
  id: string;
  count?: number;
  active?: boolean;
  onClick?: () => void;
  size?: "sm" | "md";
}) {
  const { lang } = useApp();
  const v = valueById(id);
  if (!v) return null;
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      className={`value-chip ${size} ${active ? "active" : ""}`}
      style={{ "--c": v.color } as CSSProperties}
      onClick={onClick}
      aria-pressed={onClick ? Boolean(active) : undefined}
    >
      <ValueIcon icon={v.icon} className="ic" />
      <span>{lang === "zh" ? v.zh : v.en}</span>
      {count !== undefined && <b>{count}</b>}
    </Tag>
  );
}

export function Avatar({
  user,
  size = 40,
  ring,
  link = true,
  className = "",
}: {
  user: User | undefined;
  size?: number;
  ring?: boolean;
  link?: boolean;
  className?: string;
}) {
  const { name } = useApp();
  const img = (
    <span className={`avatar ${ring ? "ring" : ""} ${className}`} style={{ width: size, height: size }}>
      {user && <img src={avatarSrc(user, size > 88 ? 640 : 240)} alt="" loading="lazy" draggable={false} />}
    </span>
  );
  if (!user || !link) return img;
  return (
    <Link to={`/u/${user.id}`} className="avatar-link" title={name(user)} aria-label={name(user)}>
      {img}
    </Link>
  );
}

export function AvatarStack({ users, size = 28, max = 4 }: { users: (User | undefined)[]; size?: number; max?: number }) {
  const shown = users.slice(0, max);
  return (
    <span className="avatar-stack" style={{ "--s": `${size}px` } as CSSProperties}>
      {shown.map((u, i) => (
        <Avatar key={u?.id ?? i} user={u} size={size} />
      ))}
      {users.length > max && <span className="avatar more" style={{ width: size, height: size }}>+{users.length - max}</span>}
    </span>
  );
}

export function UserName({ user, className = "" }: { user: User | undefined; className?: string }) {
  const { name } = useApp();
  if (!user) return <span className={className}>…</span>;
  return (
    <Link to={`/u/${user.id}`} className={`user-name ${className}`}>
      {name(user)}
    </Link>
  );
}

export function Segmented<V extends string>({
  value,
  options,
  onChange,
  size = "md",
}: {
  value: V;
  options: { value: V; label: ReactNode }[];
  onChange: (v: V) => void;
  size?: "sm" | "md";
}) {
  return (
    <div className={`segmented ${size}`} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          className={o.value === value ? "on" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function CountUp({ value, duration = 900 }: { value: number; duration?: number }) {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const start = performance.now();
    const origin = from.current;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(value);
      from.current = value;
      return;
    }
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(Math.round(origin + (value - origin) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <>{shown.toLocaleString()}</>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="spinner-wrap" role="status">
      <span className="spinner" />
      {label && <span>{label}</span>}
    </div>
  );
}

export function Empty({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <HeartMark className="empty-mark" />
      <h3>{title}</h3>
      {sub && <p>{sub}</p>}
      {action}
    </div>
  );
}

export function HeartMark({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="hm-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FF6B8B" />
          <stop offset=".55" stopColor="#FF9F6B" />
          <stop offset="1" stopColor="#FFD27A" />
        </linearGradient>
      </defs>
      <path
        fill="url(#hm-g)"
        d="M32 55s-19-11.5-24.2-23.4C4.1 23.3 9.1 13.5 18.4 13.5c5.3 0 9 2.8 13.6 7.6 4.6-4.8 8.3-7.6 13.6-7.6 9.3 0 14.3 9.8 10.6 18.1C51 43.5 32 55 32 55z"
      />
      <path fill="#FFF6E8" d="M50 4l1.8 4.2L56 10l-4.2 1.8L50 16l-1.8-4.2L44 10l4.2-1.8z" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="logo">
      <HeartMark className="logo-mark" />
      <span className="logo-word">
        夸<i>夸</i>
      </span>
    </span>
  );
}

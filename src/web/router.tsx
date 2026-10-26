import { type AnchorHTMLAttributes, type MouseEvent, useSyncExternalStore } from "react";
import { required } from "../shared/required.ts";

const listeners = new Set<() => void>();
const emit = () =>
  listeners.forEach((l) => {
    l();
  });
window.addEventListener("popstate", emit);

export function navigate(to: string, { replace = false, keepScroll = false } = {}) {
  if (to === location.pathname + location.search) return;
  history[replace ? "replaceState" : "pushState"](null, "", to);
  emit();
  if (!keepScroll) window.scrollTo({ top: 0 });
}

export function useLocation() {
  const href = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => location.pathname + location.search,
  );
  const url = new URL(href, location.origin);
  return { path: url.pathname, query: url.searchParams };
}

export function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/").filter(Boolean);
  const b = path.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (required(a[i]).startsWith(":")) params[required(a[i]).slice(1)] = decodeURIComponent(required(b[i]));
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      href={to}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    />
  );
}

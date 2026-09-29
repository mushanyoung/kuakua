import { useEffect, useRef } from "react";
import { avatarSrc, type Users } from "../api";

export type GraphEdge = { id: number; source: number; target: number; kind: string; at: number };

type Node = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  recv: number;
  phase: number;
  img: HTMLImageElement;
};

const WARM = ["#FF6B8B", "#FF9F6B", "#FFD27A"];

function glowSprite(color: string) {
  const c = document.createElement("canvas");
  c.width = c.height = 48;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(24, 24, 0, 24, 24, 24);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.18, color);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 48, 48);
  return c;
}

// "Gratitude constellation": avatars as stars, recent thanks as glowing particles
// flowing from sender to recipient. Plain canvas 2D with a tiny force layout.
export function Constellation({
  nodeIds,
  edges,
  users,
  meId,
  label,
  onPick,
}: {
  nodeIds: number[];
  edges: GraphEdge[];
  users: Users;
  meId: number;
  label: (id: number) => string;
  onPick: (id: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const labelRef = useRef(label);
  labelRef.current = label;
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || nodeIds.length === 0) return;
    const ctx = canvas.getContext("2d")!;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let W = 0;
    let H = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, devicePixelRatio || 1);
      W = rect.width;
      H = rect.height;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const scale = Math.max(0.68, Math.min(1, Math.min(W, H) / 440));
    // Before many thanks exist, draw a calmer "constellation" of colleagues instead.
    const sparse = edges.length < 4;

    const degree = new Map<number, number>();
    const recv = new Map<number, number>();
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
      recv.set(e.target, (recv.get(e.target) ?? 0) + 1);
    }
    const index = new Map<number, number>();
    const nodes: Node[] = nodeIds.map((id, i) => {
      index.set(id, i);
      const a = (i / nodeIds.length) * Math.PI * 2;
      const rr = 0.32 * Math.min(W, H) * (0.55 + Math.random() * 0.6);
      const img = new Image();
      img.src = avatarSrc(users[id]);
      return {
        id,
        x: W / 2 + Math.cos(a) * rr * 1.5,
        y: H / 2 + Math.sin(a) * rr,
        vx: 0,
        vy: 0,
        r: ((sparse ? 19 : 14) + Math.min(10, (degree.get(id) ?? 0) * 1.4) + (id === meId ? 2 : 0)) * scale,
        recv: recv.get(id) ?? 0,
        phase: Math.random() * Math.PI * 2,
        img,
      };
    });

    const pairMap = new Map<string, { a: number; b: number; count: number; bonus: boolean }>();
    for (const e of edges) {
      const a = index.get(e.source);
      const b = index.get(e.target);
      if (a === undefined || b === undefined || a === b) continue;
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      const p = pairMap.get(key) ?? { a: Math.min(a, b), b: Math.max(a, b), count: 0, bonus: false };
      p.count++;
      p.bonus ||= e.kind === "bonus";
      pairMap.set(key, p);
    }
    const pairs = [...pairMap.values()];
    type Particle = { s: number; t: number; p: number; speed: number; bonus: boolean; ambient?: boolean };
    const particles: Particle[] = edges
      .slice(0, 48)
      .map((e) => ({
        s: index.get(e.source)!,
        t: index.get(e.target)!,
        p: Math.random(),
        speed: 0.0022 + Math.random() * 0.0028,
        bonus: e.kind === "bonus",
      }))
      .filter((p) => p.s !== undefined && p.t !== undefined && p.s !== p.t);
    const nearest = (i: number, k: number) =>
      nodes
        .map((n, j) => [j, (n.x - nodes[i]!.x) ** 2 + (n.y - nodes[i]!.y) ** 2] as const)
        .filter(([j]) => j !== i)
        .sort((a, b) => a[1] - b[1])
        .slice(0, k)
        .map(([j]) => j);
    const ambient = (): Particle => {
      const s = Math.floor(Math.random() * nodes.length);
      const near = nearest(s, 3);
      return { s, t: near[Math.floor(Math.random() * near.length)] ?? s, p: 0, speed: 0.004 + Math.random() * 0.004, bonus: Math.random() < 0.25, ambient: true };
    };
    const ripples: { n: number; t: number; bonus: boolean }[] = [];
    const pink = glowSprite("rgba(255,120,150,0.9)");
    const gold = glowSprite("rgba(255,210,122,0.95)");
    let hovered = -1;
    let time = 0;

    const control = (a: Node, b: Node, i: number, j: number) => {
      // Same curve regardless of direction: orient by index.
      const [p, q] = i < j ? [a, b] : [b, a];
      const mx = (p.x + q.x) / 2;
      const my = (p.y + q.y) / 2;
      return { x: mx - (q.y - p.y) * 0.18, y: my + (q.x - p.x) * 0.18 };
    };

    const step = () => {
      const n = nodes.length;
      for (let i = 0; i < n; i++) {
        const a = nodes[i]!;
        for (let j = i + 1; j < n; j++) {
          const b = nodes[j]!;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d2 = dx * dx + dy * dy + 0.01;
          const d = Math.sqrt(d2);
          if (d > 240) continue;
          let f = (1100 * scale * scale) / d2;
          const min = a.r + b.r + 22 * scale;
          if (d < min) f += (min - d) * 0.05;
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          a.vx -= fx;
          a.vy -= fy;
          b.vx += fx;
          b.vy += fy;
        }
      }
      for (const p of pairs) {
        const a = nodes[p.a]!;
        const b = nodes[p.b]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
        const f = (d - 120 * scale) * 0.0022;
        a.vx += (dx / d) * f;
        a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f;
        b.vy -= (dy / d) * f;
      }
      for (const a of nodes) {
        a.vx += (W / 2 - a.x) * 0.0011 + Math.cos(time * 0.0005 + a.phase) * 0.012;
        a.vy += (H / 2 - a.y) * 0.0024 + Math.sin(time * 0.0006 + a.phase) * 0.012;
        a.vx *= 0.86;
        a.vy *= 0.86;
        a.x = Math.min(W - a.r - 6, Math.max(a.r + 6, a.x + a.vx));
        a.y = Math.min(H - a.r - 18, Math.max(a.r + 6, a.y + a.vy));
      }
    };

    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      const breathe = 0.8 + Math.sin(time * 0.0012) * 0.2;
      const glow = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.55);
      glow.addColorStop(0, `rgba(255,107,139,${0.12 * breathe})`);
      glow.addColorStop(0.5, `rgba(183,155,255,${0.05 * breathe})`);
      glow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);

      if (sparse && nodes.length > 2) {
        const seen = new Set<string>();
        ctx.lineWidth = 1;
        nodes.forEach((a, i) => {
          for (const j of nearest(i, 2)) {
            const key = i < j ? `${i}-${j}` : `${j}-${i}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const b = nodes[j]!;
            const lit = hovered === i || hovered === j;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.strokeStyle = lit ? "rgba(255,190,170,0.45)" : "rgba(255,190,200,0.09)";
            ctx.stroke();
          }
        });
      }

      for (const p of pairs) {
        const a = nodes[p.a]!;
        const b = nodes[p.b]!;
        const c = control(a, b, p.a, p.b);
        const lit = hovered === p.a || hovered === p.b;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(c.x, c.y, b.x, b.y);
        const alpha = lit ? 0.7 : 0.1 + Math.min(p.count, 4) * 0.04;
        ctx.strokeStyle = p.bonus ? `rgba(255,210,122,${alpha})` : `rgba(255,150,140,${alpha})`;
        ctx.lineWidth = lit ? 1.6 : 1;
        ctx.stroke();
      }

      ctx.globalCompositeOperation = "lighter";
      for (const pt of particles) {
        const a = nodes[pt.s]!;
        const b = nodes[pt.t]!;
        const c = pt.ambient ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : control(a, b, pt.s, pt.t);
        for (const [offset, size] of [
          [0, 18],
          [-0.035, 11],
          [-0.07, 7],
        ] as const) {
          const u = pt.p + offset;
          if (u < 0) continue;
          const v = 1 - u;
          const x = v * v * a.x + 2 * v * u * c.x + u * u * b.x;
          const y = v * v * a.y + 2 * v * u * c.y + u * u * b.y;
          ctx.drawImage(pt.bonus ? gold : pink, x - size / 2, y - size / 2, size, size);
        }
      }
      ctx.globalCompositeOperation = "source-over";

      for (let i = ripples.length - 1; i >= 0; i--) {
        const rp = ripples[i]!;
        const age = (time - rp.t) / 900;
        if (age >= 1) {
          ripples.splice(i, 1);
          continue;
        }
        const nd = nodes[rp.n]!;
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, nd.r + 2 + age * 18, 0, Math.PI * 2);
        ctx.strokeStyle = rp.bonus ? `rgba(255,210,122,${0.6 * (1 - age)})` : `rgba(255,120,150,${0.6 * (1 - age)})`;
        ctx.lineWidth = 2 * (1 - age) + 0.5;
        ctx.stroke();
      }

      nodes.forEach((nd, i) => {
        const r = nd.r * (hovered === i ? 1.18 : 1);
        if (nd.recv > 0 || nd.id === meId) {
          const ring = ctx.createLinearGradient(nd.x - r, nd.y - r, nd.x + r, nd.y + r);
          WARM.forEach((c, k) => ring.addColorStop(k / (WARM.length - 1), c));
          ctx.beginPath();
          ctx.arc(nd.x, nd.y, r + 2.5, 0, Math.PI * 2);
          ctx.strokeStyle = nd.id === meId ? "#FFF1E6" : ring;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        ctx.save();
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, r, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        if (nd.img.complete && nd.img.naturalWidth > 0) ctx.drawImage(nd.img, nd.x - r, nd.y - r, r * 2, r * 2);
        else {
          ctx.fillStyle = "#2a2338";
          ctx.fill();
        }
        ctx.restore();
        if (hovered !== -1 && hovered !== i) {
          ctx.beginPath();
          ctx.arc(nd.x, nd.y, r, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(11,9,18,0.45)";
          ctx.fill();
        }
      });

      if (hovered !== -1) {
        const nd = nodes[hovered]!;
        const text = labelRef.current(nd.id);
        ctx.font = "600 12px 'Figtree Variable', 'PingFang SC', 'Noto Sans SC', sans-serif";
        const w = ctx.measureText(text).width + 18;
        const x = Math.min(W - w - 4, Math.max(4, nd.x - w / 2));
        const y = Math.max(4, nd.y - nd.r * 1.18 - 34);
        ctx.fillStyle = "rgba(20,16,30,0.92)";
        ctx.strokeStyle = "rgba(255,255,255,0.14)";
        ctx.beginPath();
        ctx.roundRect(x, y, w, 24, 12);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#F7F1EC";
        ctx.textBaseline = "middle";
        ctx.fillText(text, x + 9, y + 12.5);
      }
    };

    let raf = 0;
    let visible = true;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(48, now - last);
      last = now;
      time += dt;
      step();
      for (const pt of particles) {
        pt.p += pt.speed * (dt / 16);
        if (pt.p >= 1) {
          pt.p = 0;
          if (ripples.length < 12) ripples.push({ n: pt.t, t: time, bonus: pt.bonus });
          if (pt.ambient) Object.assign(pt, ambient());
        }
      }
      draw();
      raf = visible ? requestAnimationFrame(loop) : 0;
    };

    if (sparse) for (let i = 0; i < Math.min(8, nodes.length); i++) particles.push({ ...ambient(), p: Math.random() * 0.8 });

    if (reduced) {
      for (let i = 0; i < 400; i++) step();
      particles.length = 0;
      draw();
    } else {
      for (let i = 0; i < 120; i++) step();
      raf = requestAnimationFrame(loop);
    }
    const redrawStatic = () => reduced && draw();
    nodes.forEach((n) => (n.img.onload = redrawStatic));

    const io = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting) && !document.hidden;
      if (visible && !raf && !reduced) {
        last = performance.now();
        raf = requestAnimationFrame(loop);
      }
    });
    io.observe(canvas);
    const ro = new ResizeObserver(() => {
      resize();
      redrawStatic();
    });
    ro.observe(canvas);

    const hit = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      let best = -1;
      let bestD = Infinity;
      nodes.forEach((n, i) => {
        const d = Math.hypot(n.x - x, n.y - y);
        if (d < n.r + 6 && d < bestD) (best = i), (bestD = d);
      });
      return best;
    };
    const onMove = (e: PointerEvent) => {
      const h = hit(e);
      if (h !== hovered) {
        hovered = h;
        canvas.style.cursor = h === -1 ? "default" : "pointer";
        redrawStatic();
      }
    };
    const onLeave = () => {
      hovered = -1;
      redrawStatic();
    };
    const onClick = (e: PointerEvent) => {
      const h = hit(e);
      if (h !== -1) pickRef.current(nodes[h]!.id);
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("click", onClick as EventListener);

    return () => {
      cancelAnimationFrame(raf);
      raf = -1;
      io.disconnect();
      ro.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("click", onClick as EventListener);
    };
  }, [nodeIds.join(","), edges.map((e) => e.id).join(",")]);

  return <canvas ref={ref} className="constellation" aria-hidden="true" />;
}

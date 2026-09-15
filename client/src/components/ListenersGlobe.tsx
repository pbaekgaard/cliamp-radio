import { geoGraticule10, geoOrthographic, geoPath, geoRotation, type GeoPermissibleObjects } from "d3-geo";
import { useEffect, useRef, useState } from "react";
import { feature } from "topojson-client";
import type { Topology } from "topojson-specification";
import { api, type Listener } from "../api";
import ErrorBoundary from "./ErrorBoundary";
import ListenersFallback from "./ListenersFallback";
import StationList from "./StationList";
import StatsPanel from "./StatsPanel";

// Plain 2D canvas + d3-geo orthographic projection — no WebGL, so there's no
// GPU/driver context to lose and crash the page (see git history for the
// three.js/react-globe.gl version this replaced). Country outlines come from
// a bundled world-atlas topojson (public/countries-110m.json) so the globe
// works fully self-hosted, with no third-party CDN dependency at runtime.

const ACCENT = "#7cf7c4";
const BG = "#05070d";
const TEXT = "#e8ecf3";

function hexToRgb(hex: string): [number, number, number] {
  const n = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(n.substring(i, i + 2), 16)) as [number, number, number];
}

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return a.map((v, i) => Math.round(v + (b[i] - v) * t)) as [number, number, number];
}

const rgbStr = (c: [number, number, number]) => c.join(",");

function useListeners() {
  const [listeners, setListeners] = useState<Listener[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const data = await api.listeners();
        if (!cancelled) setListeners(data);
      } catch {
        // ignore transient network errors
      }
    }
    poll();
    const id = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return listeners;
}

interface CountryFeature {
  type: string;
  id?: string | number;
  properties?: Record<string, unknown>;
  geometry: unknown;
}

function CanvasGlobe({ listeners }: { listeners: Listener[] }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const listenersRef = useRef<Listener[]>(listeners);
  const [mapError, setMapError] = useState(false);
  listenersRef.current = listeners;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const tip = tipRef.current;
    if (!canvas || !wrap || !tip) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setMapError(true);
      return;
    }

    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const projection = geoOrthographic().clipAngle(90);
    const path = geoPath(projection, ctx);
    const graticule = graticuleObj();
    const sphere: GeoPermissibleObjects = { type: "Sphere" } as GeoPermissibleObjects;

    const accentRgb = hexToRgb(ACCENT);
    const bgRgb = hexToRgb(BG);
    const textRgb = hexToRgb(TEXT);
    const ocean = mix(bgRgb, textRgb, 0.03);
    const land = mix(bgRgb, textRgb, 0.07);
    const coast = mix(bgRgb, textRgb, 0.14);

    let W = 0;
    let H = 0;
    let R = 0;
    let cx = 0;
    let cy = 0;
    const rot: [number, number] = [-18, -14];
    let centered = false;
    let dragging = false;
    let hovering = false;
    let last: [number, number] | null = null;
    let t = 0;
    let raf = 0;
    let lastDraw = 0;
    let visible = true;
    let destroyed = false;
    let features: CountryFeature[] = [];

    // The default rotation is an arbitrary starting angle — if a listener's
    // dot happens to be on the far side of the globe from it, it'd be
    // invisible until someone manually drags to find it. Once we know where
    // listeners actually are, rotate to face their average position instead,
    // once, so the very first render already shows them.
    function centerOnListenersOnce() {
      if (centered) return;
      const rows = listenersRef.current;
      if (rows.length === 0) return;
      let sumLat = 0;
      let sumLng = 0;
      for (const l of rows) {
        sumLat += l.lat;
        sumLng += l.lng;
      }
      rot[0] = -(sumLng / rows.length);
      rot[1] = -(sumLat / rows.length);
      centered = true;
    }

    function resize() {
      const rect = wrap!.getBoundingClientRect();
      W = Math.max(200, rect.width);
      H = Math.max(200, rect.height);
      canvas!.width = Math.round(W * dpr);
      canvas!.height = Math.round(H * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      R = Math.min(W, H) / 2 - 8;
      cx = W / 2;
      cy = H / 2;
      projection.translate([cx, cy]).scale(R);
    }

    function draw() {
      projection.rotate(rot);
      ctx!.clearRect(0, 0, W, H);

      ctx!.beginPath();
      path(sphere);
      ctx!.fillStyle = `rgb(${rgbStr(ocean)})`;
      ctx!.fill();

      ctx!.beginPath();
      path(graticule);
      ctx!.strokeStyle = `rgba(${rgbStr(accentRgb)},0.08)`;
      ctx!.lineWidth = 0.6;
      ctx!.stroke();

      for (const f of features) {
        ctx!.beginPath();
        path(f as unknown as GeoPermissibleObjects);
        ctx!.fillStyle = `rgb(${rgbStr(land)})`;
        ctx!.fill();
        ctx!.strokeStyle = `rgb(${rgbStr(coast)})`;
        ctx!.lineWidth = 0.6;
        ctx!.stroke();
      }

      const rr = geoRotation(rot);
      for (const l of listenersRef.current) {
        const rp = rr([l.lng, l.lat]);
        if (Math.abs(rp[0]) > 89) continue;
        const p = projection([l.lng, l.lat]);
        if (!p) continue;
        const facing = Math.cos((rp[0] * Math.PI) / 180) * Math.cos((rp[1] * Math.PI) / 180);
        const depth = 0.45 + 0.55 * Math.max(0, facing);
        const pulse = reduceMotion ? 1 : 1 + 0.06 * Math.sin(t * 1.9 + l.lng * 0.05);
        const rad = 4;
        ctx!.beginPath();
        ctx!.arc(p[0], p[1], rad * 2.4 * pulse, 0, Math.PI * 2);
        ctx!.fillStyle = `rgba(${rgbStr(accentRgb)},${0.1 * depth})`;
        ctx!.fill();
        ctx!.beginPath();
        ctx!.arc(p[0], p[1], rad * pulse, 0, Math.PI * 2);
        ctx!.fillStyle = `rgba(${rgbStr(accentRgb)},${0.9 * depth})`;
        ctx!.fill();
        ctx!.lineWidth = 1;
        ctx!.strokeStyle = `rgba(${rgbStr(bgRgb)},0.85)`;
        ctx!.stroke();
      }

      ctx!.beginPath();
      ctx!.arc(cx, cy, R, 0, Math.PI * 2);
      ctx!.strokeStyle = `rgba(${rgbStr(accentRgb)},0.28)`;
      ctx!.lineWidth = 1;
      ctx!.stroke();
    }

    function frame(now: number) {
      raf = 0;
      if (!visible || destroyed) return;
      if (now - lastDraw >= 33) {
        lastDraw = now;
        t += 0.033;
        centerOnListenersOnce();
        if (!dragging && !hovering && !reduceMotion) rot[0] += 0.32;
        draw();
      }
      raf = requestAnimationFrame(frame);
    }

    function start() {
      if (!raf && !destroyed) raf = requestAnimationFrame(frame);
    }

    resize();
    draw();

    fetch("/countries-110m.json")
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((topo: Topology) => {
        const objects = topo.objects as Record<string, unknown>;
        features = (feature(topo, objects.countries as never) as unknown as { features: CountryFeature[] })
          .features;
        resize();
        start();
      })
      .catch(() => setMapError(true));

    const ro = new ResizeObserver(() => {
      resize();
      draw();
    });
    ro.observe(wrap);

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          visible = e.isIntersecting;
          if (visible) start();
        }
      },
      { threshold: 0.05 }
    );
    io.observe(wrap);

    function onDown(e: PointerEvent) {
      dragging = true;
      last = [e.clientX, e.clientY];
      canvas!.classList.add("drag");
      try {
        canvas!.setPointerCapture(e.pointerId);
      } catch {
        // ignore — not critical if pointer capture isn't supported
      }
    }
    function onUp() {
      dragging = false;
      last = null;
      canvas!.classList.remove("drag");
    }
    function onEnter() {
      hovering = true;
    }
    function onLeave() {
      hovering = false;
      tip!.style.opacity = "0";
      onUp();
    }
    function onMove(e: PointerEvent) {
      if (dragging && last) {
        rot[0] += (e.clientX - last[0]) * 0.3;
        rot[1] = Math.max(-80, Math.min(80, rot[1] - (e.clientY - last[1]) * 0.3));
        last = [e.clientX, e.clientY];
        tip!.style.opacity = "0";
        return;
      }
      const rect = canvas!.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const rr = geoRotation(rot);
      let best: Listener | null = null;
      let bestD = 14;
      for (const l of listenersRef.current) {
        if (Math.abs(rr([l.lng, l.lat])[0]) > 89) continue;
        const p = projection([l.lng, l.lat]);
        if (!p) continue;
        const d = Math.hypot(p[0] - mx, p[1] - my);
        if (d < bestD) {
          bestD = d;
          best = l;
        }
      }
      if (best) {
        tip!.textContent = `${best.stationName} — ${best.city}, ${best.country}`;
        tip!.style.left = `${e.clientX}px`;
        tip!.style.top = `${e.clientY}px`;
        tip!.style.opacity = "1";
      } else {
        tip!.style.opacity = "0";
      }
    }

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("pointerenter", onEnter);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("pointermove", onMove);

    return () => {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("pointerenter", onEnter);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("pointermove", onMove);
    };
  }, []);

  return (
    <div className="globe-hero" ref={wrapRef}>
      <canvas ref={canvasRef} className="globe-canvas" />
      <div className="globe-tip" ref={tipRef} />
      {mapError && <div className="globe-empty">map outlines unavailable — showing listener dots on a plain globe</div>}
    </div>
  );
}

function graticuleObj(): GeoPermissibleObjects {
  return geoGraticule10();
}

export default function ListenersGlobe() {
  const listeners = useListeners();
  const live = listeners.length > 0;

  return (
    <div className="globe-page">
      <p className="globe-page-subtitle">Self-hosted internet radio, live from baekgaard.dev</p>
      <StationList />
      <div className="stats-grid">
        <div className="globe-card">
          <div className="globe-card-bar">
            <span className="globe-card-title">Live Listener Map</span>
            <span>
              <span className={`live-dot${live ? "" : " idle"}`} />
              {live ? `${listeners.length} tuned in right now` : "quiet right now"}
            </span>
          </div>
          <ErrorBoundary fallback={<ListenersFallback listeners={listeners} />}>
            <CanvasGlobe listeners={listeners} />
          </ErrorBoundary>
        </div>
        <StatsPanel />
      </div>
    </div>
  );
}

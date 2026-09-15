import { useEffect, useRef, useState } from "react";
import GlobeGL from "react-globe.gl";
import { api, type Listener } from "../api";
import ErrorBoundary from "./ErrorBoundary";
import ListenersFallback from "./ListenersFallback";
import { isWebGLAvailable } from "../webgl";

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

function Globe3D({ listeners }: { listeners: Listener[] }) {
  const globeRef = useRef<{ pointOfView: (v: object, ms?: number) => void } | undefined>(undefined);

  useEffect(() => {
    globeRef.current?.pointOfView({ lat: 20, lng: 0, altitude: 2.2 }, 0);
  }, []);

  return (
    <div className="globe-wrap">
      <GlobeGL
        ref={globeRef as never}
        width={window.innerWidth}
        height={window.innerHeight}
        globeImageUrl="//unpkg.com/three-globe/example/img/earth-night.jpg"
        backgroundColor="rgba(0,0,0,0)"
        pointsData={listeners}
        pointLat={(d) => (d as Listener).lat}
        pointLng={(d) => (d as Listener).lng}
        pointColor={() => "#7cf7c4"}
        pointAltitude={0.02}
        pointRadius={0.4}
        pointLabel={(d) => {
          const l = d as Listener;
          return `<div class="globe-tooltip"><b>${l.stationName}</b><br/>${l.city}, ${l.country}</div>`;
        }}
        ringsData={listeners}
        ringLat={(d) => (d as Listener).lat}
        ringLng={(d) => (d as Listener).lng}
        ringColor={() => (t: number) => `rgba(124,247,196,${1 - t})`}
        ringMaxRadius={3}
        ringPropagationSpeed={2}
        ringRepeatPeriod={1200}
      />
      <div className="globe-count">
        {listeners.length} listener{listeners.length === 1 ? "" : "s"} tuned in right now
      </div>
    </div>
  );
}

export default function ListenersGlobe() {
  const listeners = useListeners();
  const [webglOk] = useState(isWebGLAvailable);

  if (!webglOk) return <ListenersFallback listeners={listeners} />;

  return (
    <ErrorBoundary fallback={<ListenersFallback listeners={listeners} />}>
      <Globe3D listeners={listeners} />
    </ErrorBoundary>
  );
}

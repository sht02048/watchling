import { useEffect, useReducer, useRef, useState } from "react";
import type { SemanticState } from "@watchling/shared/ui-contract.ts";
import { createDemo, type Demo, type Timing } from "./demo.ts";

const destroyed = new WeakSet<Demo>();

export function useDemo(timing: () => Timing): {
  demo: Demo;
  found: ReadonlySet<SemanticState>;
} {
  const [found, setFound] = useState<ReadonlySet<SemanticState>>(
    () => new Set(["idle"]),
  );
  const [, changed] = useReducer((count: number) => count + 1, 0);
  const latestTiming = useRef(timing);
  useEffect(() => {
    latestTiming.current = timing;
  });

  const make = (): Demo => {
    const next: Demo = createDemo({
      timing: () => latestTiming.current(),
      onChange: () => {
        // A flow can pass through a state within one event, before React renders it.
        const state = next.snapshot().state;
        setFound((seen) => (seen.has(state) ? seen : new Set(seen).add(state)));
        changed();
      },
    });
    return next;
  };
  const [demo, setDemo] = useState(make);

  useEffect(() => {
    let current = demo;
    // StrictMode's simulated unmount destroys the first demo before it is used.
    if (destroyed.has(current)) {
      current = make();
      setDemo(current);
    }
    return () => {
      current.destroy();
      destroyed.add(current);
    };
  }, []);

  return { demo, found };
}

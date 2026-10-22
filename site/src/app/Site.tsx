import type { Config } from "@/config/config.ts";
import { useDemo } from "@/demo/useDemo.ts";
import { Desktop } from "./Desktop.tsx";
import { useMediaQuery } from "./useMediaQuery.ts";

const compactQuery = "(max-width: 719px)";
const reducedQuery = "(prefers-reduced-motion: reduce)";

export function Site({ config }: { config: Config }) {
  const compact = useMediaQuery(compactQuery);
  const { demo, found } = useDemo(() => ({
    typeSpeed: matchMedia(reducedQuery).matches ? 0 : config.typeSpeed,
    agentDurations: config.agentDurations,
  }));

  return (
    <Desktop
      key={compact ? "compact" : "wide"}
      demo={demo}
      config={config}
      compact={compact}
      found={found}
    />
  );
}

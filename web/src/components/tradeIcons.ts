import { Zap, Wrench, Hammer, Leaf } from "lucide-react";
import type { LucideProps } from "lucide-react";

export type TradeType = "HVAC" | "PLUMBING" | "FLOORING" | "ROOFING" | "GARDENING";

export const TradeIcons: Record<TradeType, React.ComponentType<LucideProps>> = {
  HVAC: Zap,
  PLUMBING: Wrench,
  FLOORING: Hammer,
  ROOFING: Hammer,
  GARDENING: Leaf,
};

export const getTradeIconComponent = (tradeName: TradeType) => {
  return TradeIcons[tradeName];
};

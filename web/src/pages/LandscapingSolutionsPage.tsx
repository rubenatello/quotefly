import { TradeSolutionsPage } from "./TradeSolutionsPage";

interface LandscapingSolutionsPageProps {
  onOpenAuth: () => void;
}

export function LandscapingSolutionsPage({ onOpenAuth }: LandscapingSolutionsPageProps) {
  return <TradeSolutionsPage trade="landscaping" onOpenAuth={onOpenAuth} />;
}

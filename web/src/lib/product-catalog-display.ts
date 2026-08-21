import type { WorkPreset } from "./api";

export type ProductCatalogSource = {
  label: "QuoteFly starter" | "Customized starter" | "Your item";
  tone: "blue" | "amber" | "slate";
  detail: string;
};

export function productCatalogSource(
  product: Pick<WorkPreset, "catalogKey" | "catalogCustomizedAtUtc">,
): ProductCatalogSource {
  if (!product.catalogKey) {
    return {
      label: "Your item",
      tone: "slate",
      detail: "Created in this workspace.",
    };
  }

  if (product.catalogCustomizedAtUtc) {
    return {
      label: "Customized starter",
      tone: "amber",
      detail: "QuoteFly starter item, tailored for this workspace.",
    };
  }

  return {
    label: "QuoteFly starter",
    tone: "blue",
    detail: "Starter item · saved to your workspace.",
  };
}

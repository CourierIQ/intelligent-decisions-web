export type BidLensProduct = {
  sku: "analyses_10" | "analyses_30";
  name: string;
  credits: number;
  priceCents: number;
};

export const BIDLENS_PRODUCTS: readonly BidLensProduct[] = [
  { sku: "analyses_10", name: "10 RFP analyses", credits: 10, priceCents: 2900 },
  { sku: "analyses_30", name: "30 RFP analyses", credits: 30, priceCents: 6900 },
] as const;

export function getBidLensProduct(sku: unknown) {
  return BIDLENS_PRODUCTS.find((product) => product.sku === sku) || null;
}

export function formatBidLensPrice(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

// Supplier adapter contract. Every supplier (AliExpress, Alibaba, a local wholesaler…) implements this so the
// rest of the app (import, pricing, order webhook, supplier orders UI) never depends on a specific marketplace.

export type Money = {
  amount: number;
  currency: string;
};

export type SupplierProduct = {
  supplierProductId: string;
  supplierUrl?: string;
  title: string;
  description?: string;
  images: string[];
  variants: Array<{
    supplierVariantId: string;
    sku: string;
    title: string;
    cost: Money;
    availableQuantity?: number;
    weightKg?: number;
  }>;
};

export type SupplierQuoteRequest = {
  supplierVariantId: string;
  quantity: number;
  destinationCountry: string;
  destinationRegion?: string;
  destinationCity?: string;
  destinationPostalCode?: string;
};

export type SupplierQuote = {
  supplierId: string;
  supplierVariantId: string;
  available: boolean;
  unitCost: Money;
  shippingCost: Money;
  maximumQuantity?: number;
  estimatedDeliveryMinDays?: number;
  estimatedDeliveryMaxDays?: number;
  expiresAt?: string;
  rawReference?: string;
};

export type SupplierAddress = {
  fullName: string;
  phone: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode?: string;
  countryCode: string;
};

export type SupplierOrderRequest = {
  idempotencyKey: string;
  externalOrderReference: string;
  shippingAddress: SupplierAddress;
  lines: Array<{
    supplierVariantId: string;
    quantity: number;
    expectedUnitCost: Money;
  }>;
};

export type SupplierOrderResult = {
  supplierOrderId: string;
  status: "SUBMITTED" | "ACCEPTED" | "REJECTED";
  confirmedTotal?: Money;
  message?: string;
};

export type SupplierTracking = {
  supplierOrderId: string;
  status: string;
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
};

export interface SupplierAdapter {
  readonly supplierId: string;
  readonly supportsAutomaticPurchasing: boolean;

  getProduct(productId: string): Promise<SupplierProduct>;

  getQuote(request: SupplierQuoteRequest): Promise<SupplierQuote>;

  checkInventory(
    supplierVariantId: string
  ): Promise<{ available: boolean; quantity?: number }>;

  createPurchaseOrder(
    request: SupplierOrderRequest
  ): Promise<SupplierOrderResult>;

  getTracking(supplierOrderId: string): Promise<SupplierTracking[]>;

  cancelPurchaseOrder?(
    supplierOrderId: string
  ): Promise<{ cancelled: boolean; message?: string }>;
}

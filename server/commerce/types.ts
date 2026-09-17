export type CommerceEventType = "SALE" | "BILL" | "RFND" | "CGBK" | "INSF" | "CANCEL-REBILL" | "UNCANCEL-REBILL" | string;

export type NormalizedPurchaseEvent = {
  source: "JVZOO" | "MANUAL";
  externalEventId: string;
  externalPurchaseId: string;
  eventType: CommerceEventType;
  status?: string;
  productId: string;
  productName?: string;
  customerEmail: string;
  customerFirstName?: string;
  customerLastName?: string;
  customerName: string;
  purchasedAt: Date;
  amount?: string;
  raw: Record<string, unknown>;
};

export interface CommerceAdapter {
  verifyAndNormalize(request: Request): Promise<NormalizedPurchaseEvent>;
}

export type PaxBreakdown = {
  adults: number;
  /** Age 5-11 */
  children: number;
  /** Age 12-17 */
  youngAdults: number;
  /** Age 0-4, free of accommodation charge */
  under4: number;
};

export type StayLineItemInput = {
  propertySlug: string;
  tier: string;
  residency: string;
  checkIn: Date;
  checkOut: Date;
  /** undefined for single-accommodation-category properties */
  roomCategory?: string;
  mealPlan: string; // "fullBoard" | "groundPackage" | "halfBoard"
  occupancyMode: "sharing" | "single" | "perVilla";
  pax: PaxBreakdown;
};

export type NightBreakdown = {
  date: Date;
  season: string | null;
  accommodation: {
    total: number;
    perPersonBreakdown: { type: string; count: number; rate: number; subtotal: number }[];
    unverified: boolean;
  };
  mandatoryFees: {
    total: number;
    lineItems: { path: string; occupancy?: string; amount: number; count: number; subtotal: number }[];
  };
  christmasSupplement: number;
  flags: string[];
};

export type StayResult = {
  input: StayLineItemInput;
  nights: NightBreakdown[];
  accommodationSubtotal: number;
  mandatoryFeesSubtotal: number;
  christmasSupplementSubtotal: number;
  circuitDiscountPct: number;
  circuitDiscountAmount: number;
  total: number;
  flags: string[];
};

export type QuoteResult = {
  stays: StayResult[];
  grandTotal: number;
  flags: string[];
};

// Register of the City of Lugano's bonds: terms only (ISIN, coupon, maturity, volume, listing date).
// Compiled from city press releases and public listings (SIX, finanzen.net, cbonds, LUKB).
// Market prices are deliberately not collected: SIX market data is licensed. Each listed bond links
// to its SIX page for live quotes instead.

export interface Bond {
  isin: string;
  coupon: number;
  maturity: string;
  volumeMCHF: number | null;
  /** First trading day on SIX (≈ issue date); null when not listed or not recorded. */
  listed: string | null;
  /** "private" = placement not listed on SIX. City/RSI bond totals (1.12bn → 1.0bn after 1.9.2025) only
   *  reconcile when these are excluded, so they are counted separately. */
  kind?: "public" | "private";
  note?: string;
}

export const BONDS: Bond[] = [
  // matured — kept so historical snapshots (end-2024) count them; all issued well before 2024
  { isin: "CH0261541863", coupon: 0.875, maturity: "2024-12-09", volumeMCHF: 100, listed: null, note: "matured" },
  { isin: "CH0290876512", coupon: 0.625, maturity: "2025-09-01", volumeMCHF: 120, listed: null, note: "matured; the 120M repaid 1.9.2025 (RSI, Jul 2025)" },
  { isin: "CH0536893263", coupon: 0.03, maturity: "2025-09-01", volumeMCHF: null, listed: null, kind: "private", note: "matured; volume unknown" },
  { isin: "CH0485261116", coupon: 0.03, maturity: "2025-11-21", volumeMCHF: 30, listed: null, kind: "private", note: "matured; CHF 10k denomination (cbonds)" },
  // outstanding
  { isin: "CH0387879080", coupon: 0.25, maturity: "2027-12-20", volumeMCHF: 120, listed: "2017-12-18" },
  { isin: "CH1199660007", coupon: 1.125, maturity: "2028-09-01", volumeMCHF: 100, listed: "2022-08-31" },
  { isin: "CH1232107172", coupon: 1.625, maturity: "2029-02-01", volumeMCHF: 100, listed: "2023-02-01", note: "first digital bond (SDX), Jan 2023" },
  { isin: "CH0116880672", coupon: 2.0, maturity: "2030-08-30", volumeMCHF: 20, listed: null, kind: "private", note: "not on SIX; listed by finanzen.net" },
  { isin: "CH1433241267", coupon: 0.6125, maturity: "2032-06-16", volumeMCHF: 100, listed: "2025-06-12", note: "digital, wCBDC settlement (Helvetia III)" },
  { isin: "CH1392903543", coupon: 1.0, maturity: "2033-11-25", volumeMCHF: 120, listed: "2024-11-25" },
  { isin: "CH1319968462", coupon: 1.415, maturity: "2034-03-07", volumeMCHF: 100, listed: "2024-03-07" },
  { isin: "CH1462229902", coupon: 0.9525, maturity: "2035-08-08", volumeMCHF: 100, listed: "2025-08-06", note: "5th digital bond, Jul 2025" },
  { isin: "CH1562934682", coupon: 0.95, maturity: "2036-07-16", volumeMCHF: 100, listed: "2026-07-15", note: "issued Jul 2026" },
  { isin: "CH0205500017", coupon: 1.75, maturity: "2043-02-20", volumeMCHF: 120, listed: "2013-02-18" },
  { isin: "CH0579132918", coupon: 0.15, maturity: "2070-11-28", volumeMCHF: 140, listed: "2020-11-26" },
];

/** SIX bond page with live quotes; only meaningful for SIX-listed (public) bonds. */
export const sixUrl = (isin: string) =>
  `https://www.six-group.com/en/market-data/bonds/bond-explorer/bond-details.${isin}CHF4.html`;

/** The register with a SIX link for public bonds that are still outstanding on `today`. */
export function bondRegister(today = new Date().toISOString().slice(0, 10)) {
  return BONDS.map((b) => ({ ...b, sixUrl: b.kind !== "private" && b.maturity > today ? sixUrl(b.isin) : null }));
}
export type RegisteredBond = ReturnType<typeof bondRegister>[number];

// Catalog of every known source for Lugano's financial health.
// "cadence" is how often new numbers appear; only market data is anywhere near live.

export type Cadence = "daily-market" | "annual" | "event" | "static";
export type Format = "pdf" | "xlsx" | "xls" | "html" | "dashboard" | "api" | "zip";

export interface Source {
  id: string;
  publisher: string;
  title: string;
  url: string;
  formats: Format[];
  coverage: string;
  cadence: Cadence;
  machineReadable: boolean;
  luganoSpecific: boolean;
  notes: string;
}

export const SEL_BASE =
  "https://www4.ti.ch/fileadmin/DI/DI_DI/SEL/Comuni/DatiFinanziari/StatisticaFinanziaria";

export const sources: Source[] = [
  {
    id: "city-evoluzione-finanziaria",
    publisher: "Città di Lugano – Divisione Finanze",
    title: "Evoluzione finanziaria (preventivi, consuntivi, piano finanziario)",
    url: "https://www.lugano.ch/la-mia-citta/amministrazione/evoluzione-finanziaria/",
    formats: ["pdf"],
    coverage: "Consuntivi 2021–2025, preventivi 2022–2026, piano finanziario 2026–2033",
    cadence: "annual",
    machineReadable: false,
    luganoSpecific: true,
    notes:
      "Most current official numbers (consuntivo published ~April, preventivo ~October). PDF only. " +
      "Consuntivo 2025: surplus 23.7M CHF, financial debt 1,049.9M CHF at 31.12.2025.",
  },
  {
    id: "city-consuntivo-2025",
    publisher: "Città di Lugano",
    title: "Consuntivo 2025 – messaggio municipale",
    url: "https://www.lugano.ch/dam/jcr:ba72012d-214d-44e7-b29c-f94db736fe98/20260423-consuntivo-2025-messaggio.pdf",
    formats: ["pdf"],
    coverage: "2025",
    cadence: "annual",
    machineReadable: false,
    luganoSpecific: true,
    notes: "Newer than the cantonal annex (which stops at 2024).",
  },
  {
    id: "city-consuntivo-2025-slides",
    publisher: "Città di Lugano",
    title: "Consuntivo 2025 – conferenza stampa",
    url: "https://www.lugano.ch/dam/jcr:8e5c3ada-87b4-4397-a3c7-e55dd4a9199a/20260423-consuntivo-2025-presentazione.pdf",
    formats: ["pdf"],
    coverage: "2025",
    cadence: "annual",
    machineReadable: false,
    luganoSpecific: true,
    notes: "Summary tables; easiest place to read the headline 2025 numbers.",
  },
  {
    id: "city-consuntivo-2024-slides",
    publisher: "Città di Lugano",
    title: "Consuntivo 2024 – conferenza stampa",
    url: "https://www.lugano.ch/dam/jcr:66e7b5df-519e-4fcb-83aa-a9db062b7081/20250404-cs-consuntivo-2024-presentazione.pdf",
    formats: ["pdf"],
    coverage: "2024",
    cadence: "annual",
    machineReadable: false,
    luganoSpecific: true,
    notes: "Used to cross-check the cantonal annex (risultato d'esercizio -2,019,659.04 CHF matches).",
  },
  {
    id: "sel-statistica-finanziaria",
    publisher: "Cantone Ticino – Sezione degli enti locali (SEL)",
    title: "Statistica finanziaria dei comuni – rapporto + allegato statistico",
    url: "https://www4.ti.ch/di/sel/comuni/dati-finanziari/statistica-finanziaria",
    formats: ["pdf", "xlsx", "xls"],
    coverage: "2000–2024 (xlsx from 2023; comparable MCA2 data from 2022/2023)",
    cadence: "annual",
    machineReadable: true,
    luganoSpecific: false,
    notes:
      "Best structured source: per-municipality income statement, investments, balance sheet and the 8 official " +
      "financial indicators with rating scales. Published ~Feb, about 14 months after year end. Parsed by src/annex.ts.",
  },
  {
    id: "sel-dati-finanziari",
    publisher: "Cantone Ticino – SEL",
    title: "Dati finanziari: indice di forza finanziaria, perequazione",
    url: "https://www4.ti.ch/di/sel/comuni/dati-finanziari",
    formats: ["html", "pdf", "xlsx"],
    coverage: "Multi-year IFF series",
    cadence: "annual",
    machineReadable: true,
    luganoSpecific: false,
    notes: "Financial-strength index (Lugano 131.75 for 2025–26, canton = 100).",
  },
  {
    id: "ustat-scheda-comune",
    publisher: "Ufficio di statistica del Cantone Ticino (USTAT)",
    title: "Scheda statistica comunale – Lugano",
    url: "https://m3.ti.ch/DFE/DR/USTAT/allegati/comune/142lugano.pdf",
    formats: ["pdf"],
    coverage: "Snapshot dated February 2017 (verified); other comuni have 2025–2026 editions, Lugano's is stale",
    cadence: "annual",
    machineReadable: false,
    luganoSpecific: true,
    notes: "Context indicators (population, fiscal resources, debt per capita).",
  },
  {
    id: "ustat-finanze-pubbliche",
    publisher: "USTAT",
    title: "Annuario statistico – cap. 18 Finanze pubbliche",
    url: "https://m3.ti.ch/DFE/DR/USTAT/allegati/prodima/4418_finanze_pubbliche.pdf",
    formats: ["pdf"],
    coverage: "Canton-wide municipal aggregates 2022–2024",
    cadence: "annual",
    machineReadable: false,
    luganoSpecific: false,
    notes: "Benchmark context for all Ticino comuni.",
  },
  {
    id: "lugano-statistica-urbana",
    publisher: "Città di Lugano – Servizio Statistica Urbana",
    title: "Portale statistico + Dati OGD",
    url: "https://statistica.lugano.ch/site/dati-ogd/",
    formats: ["dashboard", "zip"],
    coverage: "Demography, taxation (fiscalità), economy, housing",
    cadence: "annual",
    machineReadable: true,
    luganoSpecific: true,
    notes:
      "Browser-driven dashboards; only shapefiles are linked statically. Has tax-base data (fiscalità) but NOT the " +
      "city's accounts. Checked 2026-10-14: opendata.swiss CKAN search 'lugano' = 23 datasets, none published by " +
      "the city and none financial (MeteoSwiss, EnviDat, ARE, BAFU, USTAT).",
  },
  {
    id: "efv-finanzstatistik",
    publisher: "Federal Finance Administration (EFV/AFF)",
    title: "Financial statistics data portal",
    url: "https://www.efv.admin.ch/en/data-fs",
    formats: ["xlsx", "api"],
    coverage: "Confederation, cantons, municipalities (aggregated per canton)",
    cadence: "annual",
    machineReadable: true,
    luganoSpecific: false,
    notes: "Use for inter-cantonal comparison of Ticino municipalities as a whole; no Lugano-only series found.",
  },
  {
    id: "moodys-rating",
    publisher: "Moody's (via Città di Lugano press release)",
    title: "Credit rating Aa3 stable (9th consecutive year, Oct 2025)",
    url: "https://www.lugano.ch/en/news/20251027-cs-conferma-rating-moodys.html",
    formats: ["html"],
    coverage: "Annual review",
    cadence: "event",
    machineReadable: false,
    luganoSpecific: true,
    notes: "Moody's debt metric: net direct+indirect debt / operating revenue = 234% (2025), 224% (2026e), 216% (2027e).",
  },
  {
    id: "six-bond-explorer",
    publisher: "SIX Swiss Exchange",
    title: "Bond Explorer – Stadt Lugano bonds",
    url: "https://www.six-group.com/en/market-data/bonds/bond-explorer.html",
    formats: ["dashboard"],
    coverage: "Live prices/yields (15 min delayed)",
    cadence: "daily-market",
    machineReadable: false,
    luganoSpecific: true,
    notes: "Live prices for each bond (not reproduced here: SIX market data is licensed). out/bonds.json links every listed bond to its SIX page.",
  },
];

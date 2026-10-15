# Dati di Lugano

Open data tools and a public dashboard for the finances of the City of Lugano, Switzerland: debt, the city's financial plan to 2033, its bonds, and the Canton of Ticino's official indicators.

**Dashboard:** https://nslotus.github.io/dati-di-lugano/ (source in `docs/index.html`)

> This is an independent project. It is not produced, reviewed or endorsed by the City of Lugano or the Canton of Ticino. Figures come from their public documents; check the original source before relying on any number.

## What's here

| Command | What it does | Output |
|---|---|---|
| `npm run map` | Builds the source catalog and reads the canton's per-municipality statistics (2023–2024): Lugano's accounts and the 8 official indicators, with rating, and rank and median among Ticino's 106 municipalities (not Switzerland-wide) | `out/sources.json`, `out/lugano-indicators.json` / `.csv`, `out/bonds.json` |
| `npm run figures` | Extracts headline figures from the city's own PDFs (final accounts 2024 and 2025, budget 2026 with the financial plan), using [TypeSafe](https://docs.typesafe.ai). Needs `TYPESAFE_API_KEY` | `out/city-figures.json` |
| `npm run budget` | Reads budget vs actual from the recap tables of the city's final-accounts decks (2024, 2025); every row must satisfy actual − budget = printed difference | `out/budget-vs-actual.json` |
| `npm run debt` | Combines city debt figures with the bond register: share of debt in bonds, the plan's debt path, maturity ladder | `out/debt-profile.json` |
| `npm run watch` | Checks lugano.ch for new financial documents and press releases; TypeSafe classifies new releases. Needs `TYPESAFE_API_KEY` | `out/news-alerts.json` |
| `npm run watch -- --eval` | Scores the press-release classifier on 8 labelled past releases | console |
| `npm run provenance` | Archives the exact source files with SHA-256 fingerprints and traces every extracted figure to its page | `sources/`, `TRACE.md` |

```
npm install
npm run map
TYPESAFE_API_KEY=... npm run figures
npm run debt
```

**Provenance.** [`METHODOLOGY.md`](METHODOLOGY.md) explains where every dashboard figure comes from, how it was checked, and the corrections made along the way. [`sources/`](sources/README.md) archives the exact documents used, and [`TRACE.md`](TRACE.md) gives the page and printed text of every extracted figure.

Working downloads go to `data/raw/` and TypeSafe responses are cached in `data/cache/`; neither is committed.

## How the PDF figures are extracted

`src/figures.ts` uses TypeSafe's pre-parsed value extraction pattern, so the model never types a number:

1. Code finds every amount in the PDF text and records its table row (`rowLabel`) and position in that row (1 = actual, 2 = budget, 3 = difference).
2. Jev answers one Choice question per field, picking a candidate id or `none`.
3. Code copies the chosen number unchanged. Probability is pooled across repeat printings of the same value (for example `23’734’916.92` in a table and `CHF 23.7 Mio` on a summary slide). A field is `accepted` at a pooled probability of 0.8 or more, otherwise `review`.

The 2024 figures are checked against the canton's statistics (5 of 5 match). Budget figures are checked for internal consistency (self-financing − net investment = overall financing result). Values marked `review` were checked by hand before going on the dashboard.

## Reading the numbers

- **Three different debt measures**, not comparable with each other:
  - the city's *gross financial debt* (1’049.9M at end of 2025);
  - the canton's *net public debt I*, debt minus financial assets (655.5M in 2024, CHF 10’302 per resident);
  - Moody's *net direct and indirect debt / operating revenue*: expected 234% for 2025, 224% for 2026, 216% for 2027 (Moody's April 2026 review, as quoted by Corriere del Ticino).
- **Units.** Canton amounts are in CHF thousands; ratios are stored as fractions (0.26 = 26%).
- **Estimates.** These are calculated here, not published by the city:
  - the end-2026 debt implied by the budget (end-2025 debt + 2026 borrowing need, before asset sales);
  - treating bonds not listed on SIX as private placements (the city's public-bond total of CHF 1.0bn after September 2025 only reconciles without them);
  - describing non-bond debt as bank and short-term borrowing.
- **One-offs.** The 2023 self-financing ratio (501.6%) reflects one-off investment receipts and is not meaningful; the code flags it automatically.
- **Coverage.** The canton publishes about 14 months after year end, so 2025 comes only from the city's PDFs. Years before 2023 use the old accounting model (MCA1) and are not parsed.

## Bond prices

This project records bond terms only (ISIN, coupon, maturity, volume, listing date). It does not collect or publish prices or yields: SIX market data is licensed. Each listed bond in `out/bonds.json` and on the dashboard links to its SIX page for live quotes.

## Sources

- City of Lugano, [financial documents](https://www.lugano.ch/la-mia-citta/amministrazione/evoluzione-finanziaria/) and press releases.
- Canton of Ticino, Sezione degli enti locali, [municipal financial statistics](https://www4.ti.ch/di/sel/comuni/dati-finanziari/statistica-finanziaria).
- City of Lugano, [Moody's rating announcement](https://www.lugano.ch/en/news/20251027-cs-conferma-rating-moodys.html), 27 October 2025.
- Corriere del Ticino, [Moody's promuove governance e risparmi](https://www.cdt.ch/news/ticino/moodys-promuove-governance-e-risparmi-425707), 22 April 2026, for Moody's debt ratios.
- RSI, [Finanze pubbliche, la corsa ai bond](https://www.rsi.ch/info/ticino-grigioni-e-insubria/Finanze-pubbliche-la-corsa-ai-bond--3000204.html), July 2025.
- Bond terms from city press releases and public listings (SIX, finanzen.net, cbonds).

The data belongs to its publishers; credit them when you reuse it. The code is MIT-licensed (see `LICENSE`).

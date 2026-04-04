# StreetEasy Userscripts — TODO

## Completed
- [x] Script 1: Commute Tracker (walking via OSRM, transit via MTA OTP, Google Maps embed)
- [x] Script 2: 311 Complaint Lookup (building + radius queries, categorized, collapsible UI)
- [x] Performance: shared geocoding cache, MutationObserver startup, 30-day geocode TTL
- [x] Script 3: HPD Violations (building violation history by severity class A/B/C)
- [x] Script 4: DOB Permits & Complaints (active construction permits nearby, building complaints)
- [x] Script 5: Export to Google Sheets ("Save to Compare" button, Apps Script webhook)

## Next Up

### Violent Crime / NYPD Data Integration
Add actual crime data to the 311 script (or as a new companion section).

**Data source**: NYPD Complaint Data (Current Year-to-Date)
- Socrata endpoint: `https://data.cityofnewyork.us/resource/5uac-w243.json`
- Free, no API key required for basic use
- Has `latitude`/`longitude` fields — supports `within_circle()` radius queries
- Key fields: `ofns_desc` (offense), `law_cat_cd` (FELONY/MISDEMEANOR/VIOLATION), `pd_desc` (penal code detail), `crm_atpt_cptd_cd` (attempted/completed), `cmplnt_fr_dt` (date)
- Can filter by severity: `$where=law_cat_cd='FELONY'` for serious crimes
- Covers: assault, robbery, burglary, arson, grand larceny, murder, rape, etc.

### Sunlight Estimator
Use NYC PLUTO building data (publicly available) to estimate sunlight exposure.
- Building heights, lot dimensions, and orientation data available via NYC Open Data
- Cross-reference with floor number from the listing
- Could show a simple score: "High/Medium/Low sunlight" based on surrounding building heights and cardinal direction

### Embeddable Crime Map Viewer
Look into embedding an interactive crime map for the listing's area.
- **Custom map**: Plot NYPD complaint data on a Leaflet/OpenStreetMap tile layer — most control
- **NYC Crime Map** (`maps.nyc.gov/crime/`) — official city resource

## Future Ideas
- [ ] Noise complaint heatmap overlay (using 311 noise data + Leaflet)
- [ ] Walk Score / Transit Score integration (walkscore.com has an API)
- [ ] Nearby amenities lookup (grocery, pharmacy, gym via Nominatim/Overpass)
- [ ] Price history chart using StreetEasy's own data (scrape from the listing page)
- [ ] Flood zone / climate risk indicator (FEMA + NYC Open Data)
- [ ] Landlord lookup (ACRIS + HPD registration data + worst landlords list)
- [ ] True monthly cost calculator (rent + broker fee amortized + utilities + MetroCard)

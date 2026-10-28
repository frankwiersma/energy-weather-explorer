import { fmtDate } from "../data.js";

export function renderAbout(root, state) {
  const m = state.meta;
  const proj = m.projections;
  root.innerHTML = `
    <h2>About the data</h2>
    <div class="accent-line"></div>
    <p>All figures come from the <b>Pan-European Climate Database (PECD) v4.2</b>, produced by the Copernicus
      Climate Change Service (C3S) together with ENTSO-E. The historical part is based on the ERA5 reanalysis and
      runs from ${m.firstYear} up to ${fmtDate(m.lastDate)}.</p>

    <h3>Variables</h3>
    <ul>
      <li><b>Solar PV</b>: capacity factor of the national PV fleet, per country (NUTS 0). PECD gives four PV types
        (60 industrial rooftop, 61 residential rooftop, 62 utility fixed, 63 utility tracking); they are weighted by each
        country's capacity per type from ERAA 2025. Countries without that split use utility fixed PV. The projections
        are available for utility fixed PV, so the Future view compares changes of that type.</li>
      <li><b>Wind onshore</b>: capacity factor of the existing onshore fleet (technology 30, resource grade B).
        PECD delivers it per zone (PEON); the national value weights the zones by their installed capacity.</li>
      <li><b>Wind offshore</b>: the same for the operating offshore fleet (technology 20) and the PECD offshore zones
        (PEOF). Zones without turbines do not count, and countries without operating offshore wind have no series.</li>
      <li><b>Temperature</b>: 2 m air temperature, area mean per country.</li>
    </ul>
    <p>A capacity factor is output as a share of installed capacity: 30% means a 1 GW fleet delivers 300 MW on
      average. PECD keeps the technology fixed over all years, so differences between years come from the weather
      alone, not from growth of the fleet.</p>

    <h3>From zones to countries</h3>
    <p>No official table of installed capacity per PECD zone is published. The weights are built from open data:
      each turbine of GOWIRES (onshore) and the Open European offshore wind turbine database is assigned to the PECD
      zone of its own country it lies in, using the PECD region masks. Onshore turbines without a rated power get the
      median of their country. These databases give good shares within a country, so they are only used for that.
      The per-zone view in Country year shows each zone and its share.</p>
    <p>Between countries and technologies (the default Dunkelflaute mix, the onshore/offshore split, pooling) the
      weights are national capacities from ENTSO-E ERAA 2025, expected for 2028; for the Netherlands and Germany the
      Dunkelflaute defaults are the installed capacity at the end of 2024. The weights describe today's fleet, while
      PECD's own weighting inside each zone uses the 2020 fleet.</p>

    <h3>Definitions</h3>
    <p><b>Normal range</b>: 10th to 90th percentile of the same calendar day (±7 days) over 1991–2020.</p>
    <p><b>Dunkelflaute</b>: a run of days on which the daily mean of the capacity-weighted wind and solar mix stays
      below the threshold. There is no single official definition, so threshold, length and capacities are adjustable.</p>
    <p><b>Low-wind day</b> (Europe together): the pooled wind fleet, each country weighted by its installed wind
      capacity, delivers less than the threshold share of its capacity as a daily mean.</p>
    <p><b>Low-wind days</b> (Future climate): days on which the national wind fleet stays under 10% of capacity.</p>
    ${
      proj
        ? `<p><b>Future climate</b>: PECD v4.2 projections ${proj.years[0]}–${proj.years[1]} from ${proj.models.length} CMIP6 models
            (${proj.models.map((x) => x.label).join(", ")}) under ${proj.scenarios.map((x) => x.label).join(" and ")}. The
            technology and the fleet weights are the same as in the historical data, so the change comes from the climate.
            The models match ERA5 mean capacity factors but overstate how long calm spells last, so each model is compared
            with its own 2015–2044 baseline and that change is added to today's ERA5 level (delta method).</p>`
        : ""
    }

    <h3>Outlook for the Netherlands</h3>
    <p>The Outlook NL view joins three parts on one hourly axis: PECD where it is published; then the first day of
      each earlier <b>KNMI HARMONIE-AROME</b> run; and the newest run, 60 hours ahead on a 2 km grid. It is rebuilt
      every three hours.</p>
    <p>The weather is turned into capacity factors the way PECD does it, learned back from PECD itself: for each
      Dutch PECD zone a curve from the 100 m wind speed (averaged over the zone like PECD averages it) to that zone's
      capacity factor, and for solar a curve per month from radiation over land to the national PV capacity factor.
      The curves are fitted on ERA5 2016–2024 and checked on 2025. HARMONIE is then compared with PECD on archived
      runs since January 2026, and its wind speed and radiation get a small scale per zone so that it reproduces
      PECD. National values use the same capacity weights as the rest of the app.</p>
    <p>The forecast is a single deterministic run: it shows the most likely course, not the spread of possible
      outcomes, and its errors grow with the lead time.</p>

    <h3>Source and licence</h3>
    <p>Copernicus Climate Change Service (2024): Climate and energy related variables from the Pan-European Climate
      Database derived from reanalysis and climate projections. C3S Climate Data Store (CDS),
      DOI <code>10.24381/cds.f323c5ec</code>. Licence CC BY 4.0. Neither the European Commission nor ECMWF is
      responsible for any use of this information.</p>
    <p>Wind farm locations: GOWIRES v1.0 (Zenodo 10.5281/zenodo.18768952, CC BY 4.0) and the Open European offshore
      wind turbine database (Zenodo record 17311571, ODbL). National capacities: ENTSO-E ERAA 2025.</p>
    <p>Weather forecast: KNMI HARMONIE-AROME Cy43 P1 (KNMI Data Platform, CC BY 4.0). Reanalysis for the
      outlook's curves: Copernicus Climate Change Service, ERA5 hourly time series on single levels, contains modified
      Copernicus Climate Change Service information.</p>
    <p>Map outlines: © EuroGeographics for the administrative boundaries (Eurostat GISCO).</p>
    <p>Data refreshed on ${fmtDate(m.generated)}.</p>`;
}

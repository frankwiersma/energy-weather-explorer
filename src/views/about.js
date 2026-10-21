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
      <li><b>Solar PV</b>: capacity factor of utility-scale fixed PV (technology 62), per country (NUTS 0).</li>
      <li><b>Wind onshore</b>: capacity factor of the existing onshore fleet (technology 30, resource grade B),
        per PECD onshore zone, averaged per country.</li>
      <li><b>Wind offshore</b>: the same for the existing offshore fleet (technology 20), per PECD offshore zone.</li>
      <li><b>Temperature</b>: 2 m air temperature, area mean per country.</li>
    </ul>
    <p>A capacity factor is output as a share of installed capacity: 30% means a 1 GW fleet delivers 300 MW on
      average. PECD keeps the technology fixed over all years, so differences between years come from the weather
      alone, not from growth of the fleet.</p>

    <h3>Definitions</h3>
    <p><b>Normal range</b>: 10th to 90th percentile of the same calendar day (±7 days) over 1991–2020.</p>
    <p><b>Dunkelflaute</b>: a run of days on which the daily mean of the capacity-weighted wind and solar mix stays
      below the threshold. There is no single official definition, so threshold, length and capacities are adjustable.</p>
    <p><b>Low-wind day</b> (Europe together): each country's daily wind capacity factor (mean of onshore and offshore
      where both exist) is divided by its own long-term mean. A pool averages these relative values with equal weight,
      and a low-wind day is a day on which the pool stays under the threshold, for example 30% of normal output.</p>
    <p><b>Low-wind days</b> (Future climate): days on which the national wind capacity factor stays under 10%.</p>
    ${
      proj
        ? `<p><b>Future climate</b>: PECD v4.2 projections ${proj.years[0]}–${proj.years[1]} from ${proj.models.length} CMIP6 models
            (${proj.models.map((x) => x.label).join(", ")}) under ${proj.scenarios.map((x) => x.label).join(" and ")}. The
            technology is the same as in the historical data, so the change comes from the climate. The models match
            ERA5 mean capacity factors but overstate how long calm spells last, so each model is compared with its own
            2015–2044 baseline and that change is added to today's ERA5 level (delta method).</p>`
        : ""
    }

    <h3>Source and licence</h3>
    <p>Copernicus Climate Change Service (2024): Climate and energy related variables from the Pan-European Climate
      Database derived from reanalysis and climate projections. C3S Climate Data Store (CDS),
      DOI <code>10.24381/cds.f323c5ec</code>. Licence CC BY 4.0. Neither the European Commission nor ECMWF is
      responsible for any use of this information.</p>
    <p>Map outlines: © EuroGeographics for the administrative boundaries (Eurostat GISCO).</p>
    <p>Data refreshed on ${fmtDate(m.generated)}.</p>`;
}

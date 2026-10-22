/* The Unemployment Gap: renders site/data/*.json with D3. Colors come from CSS variables
   so light/dark themes switch without re-rendering. */
(() => {
  "use strict";
  const themeParam = new URLSearchParams(location.search).get("theme");
  if (themeParam === "light" || themeParam === "dark") document.documentElement.dataset.theme = themeParam;

  const parseMonth = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, 1));
  const fmtMonth = d3.utcFormat("%b %Y");
  const fmtMonthLong = d3.utcFormat("%B %Y");
  const comma = d3.format(",.0f");
  const fmt1 = d3.format(".1f");
  const UNIT_FMT = {
    pct: (v) => `${fmt1(v)}%`,
    weeks: (v) => `${fmt1(v)} wks`,
    count: (v) => comma(v),
    index: (v) => fmt1(v),
  };
  const AXIS_FMT = { pct: (v) => `${v}%`, weeks: (v) => `${v}`, count: d3.format("~s"), index: (v) => `${v}` };

  const state = { range: "2000", st: "US" };
  const charts = [];                 // {section, render()}
  const groups = new Map();          // crosshair sync: group -> Set of chart handles
  let LABOR, BENEFITS, SIPP, SECT, IND;

  // ---------- helpers ----------
  const el = (tag, attrs = {}, text) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  };
  const series = (id) => LABOR.series[id].points.map(([m, v]) => [parseMonth(m), v]);
  const last = (pts) => pts[pts.length - 1];
  const at = (pts, date) => { const p = pts.find((q) => +q[0] === +date); return p ? p[1] : null; };
  const yearAvg = (pts, y) => {
    const v = pts.filter((p) => p[0].getUTCFullYear() === y && p[1] != null).map((p) => p[1]);
    return v.length ? d3.mean(v) : null;
  };
  const rangeStart = (latest) => {
    if (state.range === "all") return null;
    if (state.range === "3y") return d3.utcMonth.offset(latest, -36);
    return new Date(Date.UTC(+state.range, 0, 1));
  };

  // ---------- line chart ----------
  function lineChart(container, opts) {
    const { group, unit, yZero = true, height = 220 } = opts;
    const wrap = el("div", { class: "chart" });
    const legend = el("ul", { class: "legend" });
    container.append(legend, wrap);
    const tip = el("div", { class: "tip", hidden: "" });
    wrap.append(tip);
    const handle = { showAt: () => {}, hide: () => {} };
    if (group) { if (!groups.has(group)) groups.set(group, new Set()); groups.get(group).add(handle); }

    function render() {
      const { series: all, domain, shades = [] } = opts.data();
      wrap.querySelectorAll("svg, .empty").forEach((s) => s.remove());
      legend.replaceChildren();
      const width = Math.max(260, wrap.clientWidth);
      const visible = all.map((s) => ({ ...s, pts: s.points.filter((p) => p[1] != null && p[0] >= domain[0] && p[0] <= domain[1]) }))
        .filter((s) => s.pts.length);
      if (!visible.length) { wrap.prepend(el("p", { class: "empty" }, "No data in this range.")); return; }

      // Legend: always for 2+ series; shading keys when shading is on screen
      if (visible.length > 1) for (const s of visible) {
        const li = el("li"); const k = el("span", { class: "key-line" }); k.style.background = `var(${s.color})`;
        li.append(k, document.createTextNode(s.label)); legend.append(li);
      }
      const onScreen = shades.filter((r) => r.end >= domain[0] && r.start <= domain[1]);
      for (const cls of new Set(onScreen.map((r) => r.cls))) {
        const li = el("li"); li.append(el("span", { class: `key-box ${cls}` }), document.createTextNode(cls === "rec" ? "Recession" : "Federal benefit extension"));
        legend.append(li);
      }

      const vals = visible.flatMap((s) => s.pts.map((p) => p[1]));
      const lo = yZero ? 0 : d3.min(vals), hi = d3.max(vals);
      const pad = yZero ? 0 : (hi - lo) * 0.08;
      const y0 = d3.scaleLinear().domain([lo - pad, hi + pad]).nice(5);
      const fmtAxis = AXIS_FMT[unit];
      const labelW = Math.max(...y0.ticks(5).map((t) => fmtAxis(t).length)) * 6.5 + 8;
      const showEnds = visible.length <= 4 && width >= 420;
      const m = { top: 8, right: showEnds ? 78 : 12, bottom: 24, left: labelW };
      const x = d3.scaleUtc().domain(domain).range([m.left, width - m.right]);
      const y = y0.range([height - m.bottom, m.top]);

      const svg = d3.select(wrap).insert("svg", ".tip").attr("viewBox", `0 0 ${width} ${height}`).attr("height", height)
        .attr("role", "img").attr("aria-label", `${opts.title}. Use left and right arrow keys to read values.`).attr("tabindex", 0);

      for (const r of onScreen) {
        const x1 = Math.max(x(r.start), m.left), x2 = Math.min(x(d3.utcMonth.offset(r.end, 1)), width - m.right);
        svg.append("rect").attr("class", r.cls === "rec" ? "shade-rec" : "shade-pol")
          .attr("x", x1).attr("width", Math.max(1, x2 - x1)).attr("y", m.top).attr("height", height - m.top - m.bottom);
      }
      svg.append("g").selectAll("line").data(y.ticks(5)).join("line").attr("class", (d) => (d === y.domain()[0] && yZero ? "baseline" : "gridline"))
        .attr("x1", m.left).attr("x2", width - m.right).attr("y1", (d) => Math.round(y(d)) + 0.5).attr("y2", (d) => Math.round(y(d)) + 0.5);
      if (opts.ref != null && opts.ref > y.domain()[0] && opts.ref < y.domain()[1]) {
        svg.append("line").attr("class", "ref-line").attr("x1", m.left).attr("x2", width - m.right)
          .attr("y1", Math.round(y(opts.ref)) + 0.5).attr("y2", Math.round(y(opts.ref)) + 0.5);
      }
      svg.append("g").attr("class", "axis").attr("transform", `translate(${m.left - 6},0)`)
        .call(d3.axisLeft(y).ticks(5).tickSize(0).tickFormat(fmtAxis)).call((g) => g.select(".domain").remove());
      const years = (domain[1] - domain[0]) / 3.156e10;
      svg.append("g").attr("class", "axis").attr("transform", `translate(0,${height - m.bottom + 6})`)
        .call(d3.axisBottom(x).ticks(Math.max(2, Math.min(Math.floor((width - m.left - m.right) / 70), 10)))
          .tickSize(0).tickFormat(years < 4 ? d3.utcFormat("%b %Y") : d3.utcFormat("%Y")))
        .call((g) => g.select(".domain").remove());

      const line = d3.line().x((p) => x(p[0])).y((p) => y(p[1])).defined((p) => p[1] != null);
      for (const s of visible) svg.append("path").attr("class", "series-line").style("stroke", `var(${s.color})`).attr("d", line(s.pts));

      // End labels unless they would collide; the legend and tooltip carry identity either way
      if (showEnds) {
        const ends = visible.map((s) => ({ s, p: last(s.pts) })).map((e) => ({ ...e, yy: y(e.p[1]) }));
        const collide = ends.some((a, i) => ends.some((b, j) => i < j && Math.abs(a.yy - b.yy) < 28));
        if (!collide) for (const e of ends) {
          svg.append("circle").attr("class", "dot").attr("r", 4).attr("cx", x(e.p[0])).attr("cy", e.yy).style("fill", `var(${e.s.color})`);
          const t = svg.append("text").attr("class", "end-label").attr("x", x(e.p[0]) + 8).attr("y", e.yy + 4);
          t.append("tspan").attr("class", "v").text(UNIT_FMT[unit](e.p[1]));
          if (visible.length > 1) t.append("tspan").attr("x", x(e.p[0]) + 8).attr("dy", 13).text(e.s.short || "");
        }
      }

      // Crosshair + tooltip, synced across the section's charts
      const dates = Array.from(new Set(visible.flatMap((s) => s.pts.map((p) => +p[0])))).sort((a, b) => a - b).map((t) => new Date(t));
      const bis = d3.bisector((d) => d).center;
      const hair = svg.append("line").attr("class", "crosshair").attr("y1", m.top).attr("y2", height - m.bottom).style("display", "none");
      const dots = svg.append("g");
      let idx = dates.length - 1;
      handle.showAt = (date, withTip) => {
        const i = bis(dates, date); const d = dates[i]; if (!d) return;
        const xx = x(d);
        hair.attr("x1", xx).attr("x2", xx).style("display", null);
        const rows = visible.map((s) => ({ s, v: at(s.pts, d) })).filter((r) => r.v != null);
        dots.selectAll("circle").data(rows).join("circle").attr("class", "dot").attr("r", 4).attr("cx", xx)
          .attr("cy", (r) => y(r.v)).style("fill", (r) => `var(${r.s.color})`);
        if (!withTip) { tip.hidden = true; return; }
        tip.replaceChildren(el("div", { class: "when" }, fmtMonthLong(d)));
        for (const r of rows) {
          const row = el("div", { class: "row" }); const k = el("span", { class: "key-line" }); k.style.background = `var(${r.s.color})`;
          row.append(k, el("b", {}, UNIT_FMT[unit](r.v)), el("span", { class: "n" }, r.s.label)); tip.append(row);
        }
        const extra = opts.tipExtra && opts.tipExtra(d);
        if (extra) tip.append(el("div", { class: "note" }, extra));
        const inShade = onScreen.find((r) => d >= r.start && d <= r.end && r.cls === "pol");
        if (inShade) tip.append(el("div", { class: "note" }, inShade.label));
        tip.hidden = false;
        const tw = tip.offsetWidth, left = xx + 12 + tw > width ? xx - 12 - tw : xx + 12;
        tip.style.left = `${Math.max(0, left)}px`; tip.style.top = `${m.top}px`;
        idx = i;
      };
      handle.hide = () => { hair.style("display", "none"); dots.selectAll("*").remove(); tip.hidden = true; };
      const peers = () => (group ? groups.get(group) : new Set([handle]));
      const show = (date) => { for (const h of peers()) h.showAt(date, h === handle); };
      const hide = () => { for (const h of peers()) h.hide(); };
      svg.append("rect").attr("x", m.left).attr("y", 0).attr("width", width - m.left - m.right + (showEnds ? 40 : 0)).attr("height", height)
        .attr("fill", "transparent")
        .on("pointermove", (ev) => show(x.invert(d3.pointer(ev)[0])))
        .on("pointerleave", hide);
      svg.on("focus", () => show(dates[idx])).on("blur", hide).on("keydown", (ev) => {
        if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
        ev.preventDefault();
        idx = Math.max(0, Math.min(dates.length - 1, idx + (ev.key === "ArrowRight" ? 1 : -1)));
        show(dates[idx]);
      });
    }
    charts.push({ render });
    new ResizeObserver(() => render()).observe(container);
    return { render };
  }

  function card(parent, title, sub, cls = "") {
    const c = el("div", { class: `card ${cls}`.trim() });
    c.append(el("h3", {}, title));
    if (sub) c.append(el("p", { class: "sub" }, sub));
    parent.append(c);
    return c;
  }

  function table(container, head, rows) {
    const t = el("table"); const thead = el("thead"); const tr = el("tr");
    for (const h of head) tr.append(el("th", { scope: "col" }, h));
    thead.append(tr); t.append(thead);
    const tb = el("tbody");
    for (const r of rows) { const row = el("tr"); for (const c of r) row.append(el("td", {}, c == null ? "" : String(c))); tb.append(row); }
    t.append(tb); container.replaceChildren(t);
  }

  // ---------- section 1 & 2: national monthly series ----------
  function recessionShades() {
    return LABOR.recessions.map((r) => ({ start: parseMonth(r.start), end: parseMonth(r.end), cls: "rec" }));
  }

  function sectionDomain(ids) {
    const pts = ids.map(series);
    const first = d3.min(pts, (p) => p[0][0]), latest = d3.max(pts, (p) => last(p)[0]);
    const start = rangeStart(latest);
    return [start && start > first ? start : first, latest];
  }

  function buildSection1() {
    const host = document.getElementById("s1-charts");
    const ids = ["UNRATE", "U6RATE", "LNS13025703", "UEMPMED", "LNS12300060"];
    const mk = (title, sub, list, unit, yZero = true) => {
      const c = card(host, title, sub);
      lineChart(c, { title, unit, yZero, group: "s1", data: () => ({
        domain: sectionDomain(ids), shades: recessionShades(),
        series: list.map(([id, color, label, short]) => ({ label, short, color, points: series(id) })),
      }) });
    };
    mk("Unemployment rate", "Percent of the labor force", [["UNRATE", "--s1", "U-3 (headline)", "U-3"], ["U6RATE", "--s2", "U-6 (broader)", "U-6"]], "pct");
    mk("Unemployed more than 6 months", "Share of unemployed people looking 27 weeks or longer", [["LNS13025703", "--s1", "Share out 27+ weeks"]], "pct");
    mk("Median time unemployed", "Weeks, among people currently unemployed", [["UEMPMED", "--s1", "Median weeks"]], "weeks");
    mk("Employment rate, ages 25-54", "Percent of the population with a job (not limited to people looking)", [["LNS12300060", "--s1", "Employed, 25-54"]], "pct", false);

    const t = document.getElementById("s1-table");
    charts.push({ render: () => {
      const [a, b] = sectionDomain(ids);
      const months = series("UNRATE").map((p) => p[0]).filter((d) => d >= a && d <= b).reverse();
      const S = Object.fromEntries(ids.map((id) => [id, series(id)]));
      table(t, ["Month", "U-3 %", "U-6 %", "Out 27+ wks %", "Median wks", "Employed 25-54 %"],
        months.map((d) => [fmtMonth(d), ...ids.map((id) => at(S[id], d))]));
    } });
  }

  function buildSection2() {
    const host = document.getElementById("s2-chart");
    host.append(el("h3", {}, "Hiring rate vs. layoff rate"), el("p", { class: "sub" }, "Hires and layoffs each month as a percent of total employment (JOLTS, starts Dec 2000)"));
    const ids = ["JTSHIR", "JTSLDR"];
    lineChart(host, { title: "Hiring rate vs. layoff rate", unit: "pct", group: "s2", height: 260, data: () => ({
      domain: sectionDomain(ids), shades: recessionShades(),
      series: [{ label: "Hiring rate", short: "Hires", color: "--s1", points: series("JTSHIR") },
               { label: "Layoff and discharge rate", short: "Layoffs", color: "--s2", points: series("JTSLDR") }],
    }) });
    const t = document.getElementById("s2-table");
    charts.push({ render: () => {
      const [a, b] = sectionDomain(ids); const h = series("JTSHIR"), l = series("JTSLDR");
      table(t, ["Month", "Hiring rate %", "Layoff rate %"], h.filter((p) => p[0] >= a && p[0] <= b).reverse().map((p) => [fmtMonth(p[0]), p[1], at(l, p[0])]));
    } });
  }

  // ---------- section 3: state benefits ----------
  const B_COL = { month: 0, first: 1, final: 2, first_avg12: 3, final_avg12: 4, exhaust_rate: 5 };
  const bpts = (st, col) => BENEFITS.data[st].map((r) => [parseMonth(r[0]), r[B_COL[col]]]);

  function benefitsDomain() {
    const rows = BENEFITS.data[state.st];
    const latest = parseMonth(rows[rows.length - 1][0]);
    const first = parseMonth(rows.find((r) => r[B_COL.exhaust_rate] != null)?.[0] || rows[0][0]);
    const start = rangeStart(latest);
    return [start && start > first ? start : first, latest];
  }

  function buildSection3() {
    const sel = document.getElementById("state");
    const names = BENEFITS.names;
    for (const k of ["US", ...Object.keys(names).filter((k) => k !== "US").sort((a, b) => names[a].localeCompare(names[b]))]) {
      sel.append(el("option", { value: k }, names[k]));
    }
    const setState = (st) => {
      state.st = st; sel.value = st;
      document.querySelectorAll(".chip[data-st]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.st === st)));
      for (const c of charts.filter((c) => c.section === 3)) c.render();
      writeLede3();
      try { localStorage.setItem("ug-state", st); } catch (e) { /* storage unavailable */ }
    };
    sel.addEventListener("change", () => setState(sel.value));
    document.querySelectorAll(".chip[data-st]").forEach((b) => b.addEventListener("click", () => setState(b.dataset.st)));

    const host = document.getElementById("s3-charts");
    const shades = () => [...recessionShades(), ...BENEFITS.policy_periods.map((p) => ({ start: parseMonth(p.start), end: parseMonth(p.end), cls: "pol", label: p.label }))];
    const mk = (title, sub, col, unit, rawCol, cls) => {
      const c = card(host, title, sub, cls);
      const ch = lineChart(c, { title, unit, group: "s3", data: () => ({
        domain: benefitsDomain(), shades: shades(),
        series: [{ label: title, color: "--s1", points: bpts(state.st, col) }],
      }), tipExtra: rawCol ? (d) => { const v = at(bpts(state.st, rawCol), d); return v != null ? `This month alone: ${comma(v)}` : null; } : null });
      charts[charts.length - 1].section = 3;
      return ch;
    };
    mk("Exhaustion rate", "Share of people starting benefits who later used up all their state benefits (DOL formula)", "exhaust_rate", "pct");
    mk("People using up benefits", "Final payments per month, 12-month average", "final_avg12", "count", "final");
    mk("People starting benefits", "First payments per month, 12-month average", "first_avg12", "count", "first");
    host.firstElementChild.style.gridColumn = "1 / -1";

    const t = document.getElementById("s3-table");
    charts.push({ section: 3, render: () => {
      const [a, b] = benefitsDomain();
      const rows = BENEFITS.data[state.st].filter((r) => { const d = parseMonth(r[0]); return d >= a && d <= b; }).reverse();
      table(t, ["Month", "First payments", "Final payments", "First, 12-mo avg", "Final, 12-mo avg", "Exhaustion rate %"],
        rows.map((r) => [fmtMonth(parseMonth(r[0])), ...r.slice(1).map((v, i) => (v == null ? null : i < 4 ? comma(v) : v))]));
    } });
    let saved = null; try { saved = localStorage.getItem("ug-state"); } catch (e) { /* storage unavailable */ }
    state.st = saved && names[saved] ? saved : "US";
    sel.value = state.st;
    document.querySelectorAll(".chip[data-st]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.st === state.st)));
  }

  // ---------- section 4: SIPP stacked bars ----------
  const CATS = [["employed", "Working", "c1"], ["looking", "No job, looking", "c2"], ["not_looking", "No job, not looking", "c3"]];

  function buildSection4() {
    const host = document.getElementById("s4-chart");
    const lg = el("ul", { class: "legend" });
    for (const [, label, c] of CATS) { const li = el("li"); const k = el("span", { class: "key-box" }); k.style.background = `var(--s${c.slice(1)})`; li.append(k, document.createTextNode(label)); lg.append(li); }
    host.append(lg);
    const tip = el("div", { class: "tip", hidden: "" });
    host.style.position = "relative";
    for (const g of ["long", "short"]) {
      const G = SIPP.groups[g];
      const box = el("div", { class: "stack-group" });
      box.append(el("h3", {}, G.label), el("p", { class: "sub" }, `${G.spells} people in the survey`));
      for (const r of G.rows) {
        const row = el("div", { class: "stack-row" });
        const rl = el("div", { class: "rl" }, `${r.months_after} month${r.months_after > 1 ? "s" : ""} after`);
        rl.append(el("small", {}, `n = ${r.n}`));
        const bar = el("div", { class: "bar", role: "img", "aria-label": `${r.months_after} months after benefits ended: ${CATS.map(([k, l]) => `${l} ${r[k]}%`).join(", ")}` });
        for (const [k, label, c] of CATS) {
          const s = el("div", { class: `seg-fill ${c}`, tabindex: "0" });
          s.style.flex = `${r[k]} 1 0`;
          const txt = `${Math.round(r[k])}%`;
          s.dataset.label = txt;
          const showTip = () => {
            tip.replaceChildren(el("div", { class: "when" }, `${r.months_after} month${r.months_after > 1 ? "s" : ""} after benefits ended`));
            const row2 = el("div", { class: "row" }); const kk = el("span", { class: "key-line" }); kk.style.background = `var(--s${c.slice(1)})`;
            row2.append(kk, el("b", {}, `${fmt1(r[k])}%`), el("span", { class: "n" }, label)); tip.append(row2);
            if (k === "employed") tip.append(el("div", { class: "note" }, `About ±${fmt1(r.employed_moe90)} points (90% margin)`));
            tip.append(el("div", { class: "note" }, `${r.n} people in the survey`));
            tip.hidden = false;
            const hb = host.getBoundingClientRect(), sb = s.getBoundingClientRect();
            const left = Math.min(sb.left - hb.left, hb.width - tip.offsetWidth);
            tip.style.left = `${Math.max(0, left)}px`; tip.style.top = `${sb.bottom - hb.top + 6}px`;
          };
          s.addEventListener("pointerenter", showTip); s.addEventListener("focus", showTip);
          s.addEventListener("pointerleave", () => (tip.hidden = true)); s.addEventListener("blur", () => (tip.hidden = true));
          bar.append(s);
        }
        row.append(rl, bar); box.append(row);
      }
      host.append(box);
    }
    host.append(tip);
    // Inline labels only where they fit
    const fit = () => host.querySelectorAll(".seg-fill").forEach((s) => { s.textContent = s.clientWidth >= 38 ? s.dataset.label : ""; });
    new ResizeObserver(fit).observe(host); fit();

    const rows = [];
    for (const [g, G] of Object.entries(SIPP.groups)) for (const r of G.rows) rows.push([G.label, r.months_after, r.n, r.employed, `±${r.employed_moe90}`, r.looking, r.not_looking]);
    table(document.getElementById("s4-table"), ["Group", "Months after", "n", "Working %", "Margin (90%)", "Looking %", "Not looking %"], rows);
    document.getElementById("sipp-method").textContent = `${SIPP.definition} Pooled across SIPP interview years ${SIPP.interview_years.join(", ")} (covering ${SIPP.reference_years}). Cells with fewer than ${SIPP.min_n} people are not shown.`;
    document.getElementById("s4-note").textContent = `Census SIPP, ${SIPP.reference_years}. Small samples: the share working has a margin of error of about ±10 points, so treat differences smaller than that as noise. Hover or focus a bar segment for detail.`;
  }

  // ---------- text that follows the data ----------
  const dir = (now, then, eps = 0.05) => (now > then + eps ? "up from" : now < then - eps ? "down from" : "about the same as");

  function writeTiles() {
    const host = document.getElementById("tiles"); host.replaceChildren();
    const defs = [
      ["UNRATE", "Unemployment rate", "pct", "bad"],
      ["LNS13025703", "Unemployed people out 6+ months", "pct", "bad"],
      ["UEMPMED", "Median time unemployed", "weeks", "bad"],
      ["JTSHIR", "Hiring rate", "pct", "good"],
    ];
    for (const [id, label, unit, upIs] of defs) {
      const pts = series(id); const [d, v] = last(pts);
      const prevD = d3.utcMonth.offset(d, -24); const pv = at(pts, prevD);
      const t = el("div", { class: "tile" });
      t.append(el("p", { class: "label" }, `${label}, ${fmtMonth(d)}`));
      const val = el("p", { class: "value" }, unit === "weeks" ? fmt1(v) : `${fmt1(v)}%`);
      if (unit === "weeks") val.append(el("small", {}, "weeks"));
      t.append(val);
      const delta = el("p", { class: "delta" });
      if (pv != null) {
        const diff = v - pv; const up = diff > 0.05, down = diff < -0.05;
        const word = up ? "Up" : down ? "Down" : "Unchanged";
        const cls = up ? (upIs === "bad" ? "bad" : "good") : down ? (upIs === "bad" ? "good" : "bad") : "";
        const b = el("b", { class: cls }, `${word}${up || down ? ` ${fmt1(Math.abs(diff))}${unit === "weeks" ? " wks" : " pts"}` : ""}`);
        delta.append(b, document.createTextNode(` from ${fmtMonth(prevD)}`));
      } else delta.textContent = fmtMonth(d);
      t.append(delta); host.append(t);
    }
  }

  function writeLedes() {
    const u = series("UNRATE"), lt = series("LNS13025703"), md = series("UEMPMED"), h = series("JTSHIR"), l = series("JTSLDR");
    const [d] = last(u);
    const p1 = document.getElementById("lede1"); p1.replaceChildren();
    const b = (t) => el("b", {}, t);
    p1.append(`In ${fmtMonthLong(d)} the unemployment rate was `, b(`${fmt1(last(u)[1])}%`),
      `, ${dir(last(u)[1], yearAvg(u, 2019))} a 2019 average of ${fmt1(yearAvg(u, 2019))}%. Of the people counted as unemployed, `,
      b(`${fmt1(last(lt)[1])}%`), ` had been looking for more than six months (2019 average: ${fmt1(yearAvg(lt, 2019))}%), and the median search had lasted `,
      b(`${fmt1(last(md)[1])} weeks`), ` (2019: ${fmt1(yearAvg(md, 2019))}). The headline rate counts people; it does not show how long they have been looking.`);

    const p2 = document.getElementById("lede2"); p2.replaceChildren();
    const [hd, hv] = last(h), lv = at(l, hd), h19 = yearAvg(h, 2019), l19 = yearAvg(l, 2019);
    p2.append(`In ${fmtMonthLong(hd)} employers hired `, b(`${fmt1(hv)}%`), ` of their workforce and laid off or discharged `, b(`${fmt1(lv)}%`),
      `. The 2019 averages were ${fmt1(h19)}% and ${fmt1(l19)}%. `);
    if (hv < h19 - 0.2 && lv <= l19 + 0.1) p2.append("Few layoffs keep the unemployment rate low. Slow hiring means people who do lose a job stay unemployed longer.");
    writeLede3();

    const L = SIPP.groups.long.rows, byH = (k) => L.find((r) => r.months_after === k);
    const p4 = document.getElementById("lede4"); p4.replaceChildren();
    if (byH(1) && byH(6)) p4.append(`Among people who had no job when their benefits stopped after 5 or more months, `, b(`${Math.round(byH(1).employed)}%`),
      ` were working a month later and `, b(`${Math.round(byH(6).employed)}%`), ` six months later. At six months, ${Math.round(byH(6).not_looking)}% had no job and had stopped looking, which takes them out of the unemployment rate. Data covers ${SIPP.reference_years}.`);
  }

  function writeLede3() {
    const rows = BENEFITS.data[state.st]; const r = [...rows].reverse().find((x) => x[B_COL.exhaust_rate] != null);
    const r19 = rows.find((x) => x[0] === "2019-12");
    const p = document.getElementById("lede3"); p.replaceChildren();
    const name = state.st === "US" ? "the United States" : BENEFITS.names[state.st];
    p.append(`In ${name}, `, el("b", {}, `${fmt1(r[B_COL.exhaust_rate])}%`), ` of people who started receiving state unemployment benefits later used up all of them (12 months ending ${fmtMonthLong(parseMonth(r[0]))})`,
      r19 && r19[B_COL.exhaust_rate] != null ? `, compared with ${fmt1(r19[B_COL.exhaust_rate])}% in 2019. ` : ". ",
      `About `, el("b", {}, comma(r[B_COL.final_avg12])), ` people a month receive their final payment. The claims data stops tracking them once benefits end.`);
  }

  function writeMeta() {
    const rows = LABOR.freshness.map((f) => [f.label, f.source, f.first ? fmtMonth(parseMonth(f.first)) : "Pending confirmation", f.latest ? fmtMonth(parseMonth(f.latest)) : ""]);
    rows.push(["What happens after benefits end (Section 5)", "Census SIPP", SIPP.reference_years.split("-")[0], SIPP.reference_years.split("-")[1]]);
    table(document.getElementById("freshness"), ["Series", "Source", "From", "Latest"], rows);
    document.getElementById("built").textContent = `Data checked ${new Date(LABOR.built).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}. Each source updates on its own schedule; see the table above for the latest month of each.`;
  }

  // ---------- section 3: sectors ----------
  const METRICS = [["unemp", "Unemployment rate"], ["hires", "Hiring rate"], ["layoffs", "Layoff rate"]];
  const S_COL = { unemp_avg12: 4, hires_avg12: 5, layoffs_avg12: 6 };

  function buildSectors() {
    const host = document.getElementById("sector-dumbbell");
    const metricCtl = document.getElementById("sector-metric");
    const tip = el("div", { class: "tip", hidden: "" });
    host.append(tip);
    const all = SECT.sectors.find((s) => s.key === "all");
    const change = (s, m) => s.summary[m].now - s.summary[m].base;
    const rows = SECT.sectors.filter((s) => s.key !== "all").sort((a, b) => change(b, "unemp") - change(a, "unemp"));
    rows.push(all);
    const sel = { key: rows[0].key, metric: "unemp" };
    const signed = (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmt1(Math.abs(v))} pts`;

    function renderDumbbell() {
      host.querySelectorAll("svg").forEach((s) => s.remove());
      const width = Math.max(280, host.clientWidth);
      const wide = width >= 760;
      metricCtl.hidden = wide;
      metricCtl.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.m === sel.metric)));
      const metrics = wide ? METRICS : METRICS.filter(([m]) => m === sel.metric);
      const labelW = wide ? 236 : 0;
      const rowH = wide ? 30 : 44, head = 34, gap = 28, sepGap = 10;
      const height = head + rows.length * rowH + sepGap + 8;
      const colW = (width - labelW - gap * (metrics.length - 1)) / metrics.length;
      const svg = d3.select(host).insert("svg", ".tip").attr("viewBox", `0 0 ${width} ${height}`).attr("height", height)
        .attr("role", "group").attr("aria-label", "Sectors: 2019 average vs. last 12 months. Select a sector to see its trend.");
      const rowY = (i) => head + i * rowH + (i === rows.length - 1 ? sepGap : 0);

      const scales = metrics.map(([m], j) => {
        const x0 = labelW + j * (colW + gap);
        // Dot plot: fit the data range (no zero baseline needed) so changes are visible
        const lo = d3.min(rows, (s) => Math.min(s.summary[m].base, s.summary[m].now));
        const hi = d3.max(rows, (s) => Math.max(s.summary[m].base, s.summary[m].now));
        const x = d3.scaleLinear().domain([Math.max(0, lo - 0.25), hi + 0.25]).range([x0 + 34, x0 + colW - 40]);
        svg.append("text").attr("class", "db-col-title").attr("x", x0 + 4).attr("y", 13).text(METRICS.find((d) => d[0] === m)[1]);
        const g = svg.append("g");
        for (const t of x.ticks(4)) {
          g.append("line").attr("class", "gridline").attr("x1", Math.round(x(t)) + 0.5).attr("x2", Math.round(x(t)) + 0.5).attr("y1", head - 4).attr("y2", height - 4);
          g.append("text").attr("class", "axis").attr("x", x(t)).attr("y", 28).attr("text-anchor", "middle").append("tspan").style("fill", "var(--muted)").style("font-size", "11px").text(`${t}%`);
        }
        return { m, x };
      });
      svg.append("line").attr("class", "gridline").attr("x1", 0).attr("x2", width).attr("y1", rowY(rows.length - 1) - sepGap / 2).attr("y2", rowY(rows.length - 1) - sepGap / 2);

      rows.forEach((s, i) => {
        const y0 = rowY(i), cy = wide ? y0 + rowH / 2 : y0 + 30;
        const g = svg.append("g").attr("class", `db-row${s.key === "all" ? " total" : ""}${s.key === sel.key ? " selected" : ""}`)
          .attr("tabindex", 0).attr("role", "button").attr("aria-pressed", String(s.key === sel.key))
          .attr("aria-label", `${s.label}. ${METRICS.map(([m, l]) => `${l} ${fmt1(s.summary[m].base)}% in 2019, ${fmt1(s.summary[m].now)}% now`).join("; ")}`);
        g.append("rect").attr("class", "band").attr("x", 0).attr("y", y0).attr("width", width).attr("height", rowH).attr("rx", 6);
        g.append("text").attr("class", "db-label").attr("x", wide ? 8 : 4).attr("y", wide ? cy + 4 : y0 + 14).text(s.label);
        for (const { m, x } of scales) {
          const { base, now } = s.summary[m];
          g.append("line").attr("class", "db-link").attr("x1", x(base)).attr("x2", x(now)).attr("y1", cy).attr("y2", cy);
          g.append("circle").attr("class", "db-base").attr("r", 4).attr("cx", x(base)).attr("cy", cy);
          g.append("circle").attr("class", "db-now").attr("r", 5).attr("cx", x(now)).attr("cy", cy);
          const right = now >= base;
          g.append("text").attr("class", "db-val").attr("x", x(now) + (right ? 9 : -9)).attr("y", cy + 4)
            .attr("text-anchor", right ? "start" : "end").text(`${fmt1(now)}%`);
        }
        const showTip = (ev) => {
          tip.replaceChildren(el("div", { class: "when" }, s.label));
          for (const [m, l] of METRICS) {
            const r = el("div", { class: "row" });
            r.append(el("b", {}, `${fmt1(s.summary[m].base)}% → ${fmt1(s.summary[m].now)}%`), el("span", { class: "n" }, `${l} (${signed(change(s, m))})`));
            tip.append(r);
          }
          tip.append(el("div", { class: "note" }, "2019 average → last 12 months. Click for trend."));
          tip.hidden = false;
          const tx = ev && ev.offsetX != null ? ev.offsetX : width / 2;
          tip.style.left = `${Math.max(0, Math.min(tx + 12, width - tip.offsetWidth))}px`;
          tip.style.top = `${y0 + rowH + 4}px`;
        };
        const choose = () => { sel.key = s.key; renderDumbbell(); renderDetailTitle(); for (const c of charts.filter((c) => c.section === "sector")) c.render(); };
        g.on("pointermove", showTip).on("pointerleave", () => (tip.hidden = true)).on("focus", () => showTip(null)).on("blur", () => (tip.hidden = true))
          .on("click", choose).on("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); choose(); } });
      });
    }
    metricCtl.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { sel.metric = b.dataset.m; renderDumbbell(); }));
    new ResizeObserver(() => renderDumbbell()).observe(host);

    const u = all.summary.unemp, h = all.summary.hires;
    document.getElementById("sector-period").textContent =
      `Last 12 months: through ${fmtMonth(parseMonth(u.through))} for unemployment, ${fmtMonth(parseMonth(h.through))} for hiring and layoffs. Sorted by change in unemployment rate since 2019. Select a sector to see its trend below.`;

    // Detail charts for the selected sector
    const spts = (key, col) => SECT.sectors.find((s) => s.key === key).data.map((r) => [parseMonth(r[0]), r[S_COL[col]]]);
    const label = () => SECT.sectors.find((s) => s.key === sel.key).label;
    const renderDetailTitle = () => { document.getElementById("sector-detail-title").textContent = `Trend: ${label()}`; };
    renderDetailTitle();
    const domain = () => {
      const latest = d3.max(SECT.sectors.find((s) => s.key === sel.key).data.filter((r) => r[S_COL.unemp_avg12] != null), (r) => parseMonth(r[0]));
      const first = parseMonth("2001-01"), start = rangeStart(latest);
      return [start && start > first ? start : first, latest];
    };
    const grid = document.getElementById("sector-charts");
    const c1 = card(grid, "Unemployment rate", "12-month average");
    lineChart(c1, { title: "Sector unemployment rate", unit: "pct", group: "sector", data: () => ({
      domain: domain(), shades: recessionShades(),
      series: [{ label: label(), short: "Sector", color: "--s1", points: spts(sel.key, "unemp_avg12") },
               ...(sel.key === "all" ? [] : [{ label: "All industries", short: "All", color: "--muted", points: spts("all", "unemp_avg12") }])],
    }) });
    charts[charts.length - 1].section = "sector";
    const c2 = card(grid, "Hiring and layoffs", "12-month average, percent of employment");
    lineChart(c2, { title: "Sector hiring and layoff rates", unit: "pct", group: "sector", data: () => ({
      domain: domain(), shades: recessionShades(),
      series: [{ label: "Hiring rate", short: "Hires", color: "--s1", points: spts(sel.key, "hires_avg12") },
               { label: "Layoff rate", short: "Layoffs", color: "--s2", points: spts(sel.key, "layoffs_avg12") }],
    }) });
    charts[charts.length - 1].section = "sector";

    // Lede and table
    const up = rows.filter((s) => s.key !== "all" && change(s, "unemp") > 0.1);
    const hireDown = rows.filter((s) => s.key !== "all" && change(s, "hires") < -0.1);
    const layNotUp = rows.filter((s) => s.key !== "all" && change(s, "layoffs") <= 0.1);
    const n = rows.length - 1;
    const p = document.getElementById("lede-sector"); p.replaceChildren();
    const top = up.slice(0, 3).map((s) => `${s.label.toLowerCase()} (${fmt1(s.summary.unemp.base)}% to ${fmt1(s.summary.unemp.now)}%)`);
    p.append(`Compared with 2019, unemployment is higher in `, el("b", {}, `${up.length} of ${n}`), ` sectors and hiring is lower in `, el("b", {}, `${hireDown.length} of ${n}`),
      `, while layoffs are at or below 2019 in ${layNotUp.length} of ${n}. `);
    if (top.length) p.append(`The largest increases in unemployment: ${top.slice(0, -1).join(", ")}${top.length > 1 ? ", and " : ""}${top[top.length - 1]}.`);

    table(document.getElementById("sector-table"),
      ["Sector", ...METRICS.flatMap(([, l]) => [`${l} 2019 %`, "Last 12 mo %", "Change (pts)"])],
      rows.map((s) => [s.label, ...METRICS.flatMap(([m]) => [fmt1(s.summary[m].base), fmt1(s.summary[m].now), (change(s, m) > 0 ? "+" : "") + fmt1(change(s, m))])]));
  }

  // ---------- section 3 (cont.): tech and biotech payroll employment ----------
  function buildIndustries() {
    const all = IND.industries;
    const ok = all.filter((i) => i.status === "confirmed"), pending = all.filter((i) => i.status === "pending");
    // Color follows the industry, fixed by its slot in the group, so a series confirmed later does not repaint others
    const SLOT = { csd: "--s1", hosting: "--s2", software: "--s3", semis: "--s4", rnd: "--s1", pharma: "--s2", chem: "--s2", instruments: "--s3" };
    const pts = (i) => i.points.map((p) => [parseMonth(p[0]), p[2]]);
    const domain = () => {
      const first = d3.min(ok, (i) => parseMonth(i.points[0][0])), latest = d3.max(ok, (i) => parseMonth(i.points[i.points.length - 1][0]));
      const start = rangeStart(latest);
      return [start && start > first ? start : first, latest];
    };
    const grid = document.getElementById("ind-charts");
    for (const [g, title] of [["tech", "Tech"], ["biotech", "Biotech and life science tools"]]) {
      const c = card(grid, title, "Payroll employment, 2019 average = 100");
      lineChart(c, { title: `${title} employment index`, unit: "index", yZero: false, ref: 100, group: "ind", data: () => ({
        domain: domain(), shades: recessionShades(),
        series: ok.filter((i) => i.group === g).map((i) => ({ label: i.label, short: i.short, color: SLOT[i.key] || "--s1", points: pts(i) })),
      }) });
    }
    const latestIdx = (i) => i.points[i.points.length - 1][2];
    const lc = (t) => (/^[A-Z]{2}/.test(t) ? t : t[0].toLowerCase() + t.slice(1)); // keep IT, R&D
    const ranked = [...ok].sort((a, b) => latestIdx(b) - latestIdx(a));
    const pctTxt = (v) => `${v >= 100 ? "+" : "\u2212"}${Math.abs(Math.round(v - 100))}%`;
    const p = document.getElementById("lede-ind"); p.replaceChildren();
    const months = ok.map((i) => i.points[i.points.length - 1][0]).sort();
    const asOf = months[0] === months[months.length - 1] ? fmtMonth(parseMonth(months[0]))
      : `${d3.utcFormat("%b")(parseMonth(months[0]))} or ${fmtMonth(parseMonth(months[months.length - 1]))}`;
    p.append(`Payroll employment through ${asOf} compared with 2019: `,
      ...ranked.flatMap((i, k) => [k ? (k === ranked.length - 1 ? ", and " : ", ") : "", `${lc(i.short)} `, el("b", {}, pctTxt(latestIdx(i)))]), ". ");
    // Off the post-2020 peak by 3% or more: growth since 2019 can hide recent cuts
    const offPeak = ok.map((i) => {
      const post = i.points.filter((q) => q[0] >= "2020-01");
      const pk = post.reduce((a, b) => (b[1] > a[1] ? b : a));
      return { i, pk, drop: 100 * (1 - i.points[i.points.length - 1][1] / pk[1]) };
    }).filter((x) => x.drop >= 3).sort((a, b) => b.drop - a.drop);
    if (offPeak.length) p.append(`Below their post-2020 peaks: `, ...offPeak.flatMap((x, k) => [k ? ", " : "",
      `${lc(x.i.short)} `, el("b", {}, `\u2212${Math.round(x.drop)}%`), ` since ${fmtMonth(parseMonth(x.pk[0]))}`]), ". ");
    p.append("Employment shows whether an industry is growing, not how easy it is to get hired there.");
    // Where each industry sits among the broad sectors above, one line per group
    const where = (g) => {
      const bySector = d3.group(all.filter((i) => i.group === g && !(i.key === "chem" && all.some((j) => j.key === "pharma" && j.status === "confirmed"))), (i) => i.sector);
      return Array.from(bySector, ([sec, xs]) => `${sec} (${xs.map((i) => lc(i.short)).join(", ")})`).join("; ");
    };
    const notes = [`Where these sit in the sectors above. Tech: ${where("tech")}. Biotech: ${where("biotech")}.`];
    if (pending.length) notes.push(`Pending: ${pending.map((i) => lc(i.short)).join(", ")}. BLS series being confirmed; added automatically once data arrives.`);
    if (ok.some((i) => i.key === "chem")) notes.push("Chemical manufacturing stands in for pharma until then.");
    if (ok.some((i) => !i.seasonally_adjusted)) notes.push("Some series are not seasonally adjusted (see table).");
    document.getElementById("ind-note").textContent = notes.join(" ");
    table(document.getElementById("ind-table"), ["Industry", "Sector on this site", "2019 avg (thousands)", "Latest (thousands)", "Index", "Latest month", "BLS series", "Seasonally adjusted"],
      all.map((i) => i.status === "confirmed"
        ? [i.label, i.sector, fmt1(i.base_2019), fmt1(i.points[i.points.length - 1][1]), fmt1(latestIdx(i)), fmtMonth(parseMonth(i.points[i.points.length - 1][0])), i.series_id, i.seasonally_adjusted ? "Yes" : "No"]
        : [i.label, i.sector, "", "", "", "Pending", i.candidates.join(", "), ""]));
  }

  function setRange(r) {
    state.range = r;
    document.querySelectorAll("#range button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.range === r)));
    document.getElementById("range-note").textContent = r === "all" ? "Each series from its first month" : "";
    for (const c of charts) c.render();
    try { localStorage.setItem("ug-range", r); } catch (e) { /* storage unavailable */ }
  }

  Promise.all(["data/labor.json", "data/benefits.json", "data/sipp.json", "data/sectors.json", "data/industries.json"].map((u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u); return r.json(); })))
    .then(([labor, benefits, sipp, sectors, industries]) => {
      LABOR = labor; BENEFITS = benefits; SIPP = sipp; SECT = sectors; IND = industries;
      let saved = null; try { saved = localStorage.getItem("ug-range"); } catch (e) { /* storage unavailable */ }
      if (saved && ["2000", "2015", "3y", "all"].includes(saved)) state.range = saved;
      document.querySelectorAll("#range button").forEach((b) => b.addEventListener("click", () => setRange(b.dataset.range)));
      buildSection1(); buildSection2(); buildSectors(); buildIndustries(); buildSection3(); buildSection4();
      writeTiles(); writeLedes(); writeMeta();
      setRange(state.range);
    })
    .catch((err) => {
      document.getElementById("tiles").replaceChildren(el("p", { class: "empty" }, `Could not load data (${err.message}). Try reloading.`));
    });
})();

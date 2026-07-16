(function () {
  "use strict";

  const state = {
    dashboard: null,
    activeViewer: null,
    requestToken: 0,
    tableSort: { key: "normalized_accuracy", direction: "desc" },
    representationMode: "dynamic_3d",
    representationTab: "identity",
  };

  const main = document.getElementById("main-content");
  const errorOverlay = document.getElementById("error-overlay");

  window.addEventListener("hashchange", renderRoute);
  window.addEventListener("unhandledrejection", (event) => showError(event.reason));
  window.addEventListener("error", (event) => showError(event.error || event.message));

  init();

  async function init() {
    try {
      state.dashboard = await fetchJson("data/dashboard.json");
      if (!location.hash) {
        location.replace("#overview");
        return;
      }
      await renderRoute();
    } catch (error) {
      showError(error);
      main.innerHTML = `<div class="empty-state">The accepted evaluation data could not be loaded.</div>`;
    }
  }

  async function renderRoute() {
    if (!state.dashboard) {
      return;
    }
    const token = ++state.requestToken;
    state.activeViewer?.destroy();
    state.activeViewer = null;
    const route = parseRoute();
    setActiveNavigation(route.view);
    errorOverlay.hidden = true;
    try {
      if (route.view === "representation") {
        await renderRepresentation(token);
      } else if (route.view === "studies") {
        await renderStudy(route.study, token);
      } else if (route.view === "diagnostics") {
        renderDiagnostics();
      } else {
        renderOverview();
      }
      if (token === state.requestToken) {
        main.focus({ preventScroll: true });
        window.scrollTo(0, 0);
      }
    } catch (error) {
      if (token === state.requestToken) {
        showError(error);
        main.innerHTML = `<div class="empty-state">This dashboard view failed to render.</div>`;
      }
    }
  }

  function parseRoute() {
    const raw = location.hash.replace(/^#/, "");
    const [view = "overview", study] = raw.split("/");
    if (!["overview", "representation", "studies", "diagnostics"].includes(view)) {
      return { view: "overview", study: null };
    }
    return { view, study: study || null };
  }

  function setActiveNavigation(view) {
    document.querySelectorAll("[data-route]").forEach((link) => {
      if (link.dataset.route === view) {
        link.setAttribute("aria-current", "page");
      } else {
        link.removeAttribute("aria-current");
      }
    });
  }

  function renderOverview() {
    const dashboard = state.dashboard;
    main.innerHTML = `
      <div class="page overview-page">
        <div class="page-header">
          <div>
            <h1 class="page-title">Evaluation overview</h1>
            <p class="page-subtitle">
              Accepted Physics QA run with canonical prediction-only 4D code and Qwen3-selected toolbox evidence.
            </p>
          </div>
          <div class="method-note">
            Scores are task-native. Quality and confidence remain separate measurements; correlation is not causal attribution.
          </div>
        </div>
        ${metricsStrip(dashboard.totals)}
        ${bassVlmComparison(dashboard.bass_vlm_comparison)}
        <section class="analysis-grid" aria-label="Controlled-condition and confidence diagnostics">
          <div class="analysis-panel">
            <span class="panel-label">Question-only, native-tool, and oracle-tool task score</span>
            ${conditionComparisonChart(dashboard.condition_overview || [])}
            <div class="chart-legend">
              <span class="legend-key"><span class="legend-swatch question"></span>Question only</span>
              <span class="legend-key"><span class="legend-swatch"></span>Native tools</span>
              <span class="legend-key"><span class="legend-swatch oracle"></span>Oracle tools</span>
            </div>
          </div>
          <div class="analysis-panel">
            <span class="panel-label">Question-conditioned 4D confidence versus task score</span>
            ${scatterChart(dashboard.scatter)}
            <div class="chart-legend">
              <span class="legend-key"><span class="legend-swatch"></span>Correct / high task score</span>
              <span class="legend-key"><span class="legend-swatch question"></span>Incorrect / low task score</span>
            </div>
          </div>
        </section>
        <section class="section-band">
          <div class="section-heading">
            <h2>Study results</h2>
            <p>Click a row to inspect its representative code, QA trace, and evidence quality.</p>
          </div>
          <div id="results-table"></div>
        </section>
        <section class="section-band">
          <div class="section-heading">
            <h2>Study-level bottleneck status</h2>
            <p>Controlled gaps use 1,000 grouped bootstrap resamples by experiment.</p>
          </div>
          ${bottleneckStatusTable(dashboard.bottleneck_studies || [])}
        </section>
      </div>`;
    renderResultsTable();
  }

  function metricsStrip(totals) {
    const metrics = [
      [formatInteger(totals.canonical_codes), "canonical codes"],
      [formatInteger(totals.qa_items), "questions"],
      [formatInteger(totals.scored_items), "scored questions"],
      [formatInteger(totals.study_count), "studies"],
      [formatPercent(totals.weighted_accuracy), "question-weighted score"],
      [formatPercent(totals.macro_accuracy), "study-macro score"],
    ];
    return `<section class="metrics-strip" aria-label="Global evaluation totals">
      ${metrics.map(([value, label]) => `
        <div class="metric-cell">
          <span class="metric-value">${escapeHtml(value)}</span>
          <span class="metric-label">${escapeHtml(label)}</span>
        </div>`).join("")}
    </section>`;
  }

  function renderResultsTable() {
    const target = document.getElementById("results-table");
    const columns = [
      ["title", "Study"],
      ["question_count", "QA"],
      ["scored_count", "Scored"],
      ["answer_types", "Answer types"],
      ["normalized_accuracy", "LLM score"],
      ["mean_llm_confidence", "LLM confidence"],
      ["mean_code_quality", "4D quality"],
      ["mean_4d_confidence", "4D confidence"],
      ["quality_coverage", "Quality coverage"],
      ["human_reference", "Human reference"],
    ];
    const rows = [...state.dashboard.results].sort((left, right) => {
      const key = state.tableSort.key;
      const direction = state.tableSort.direction === "asc" ? 1 : -1;
      const a = sortableValue(left[key], key);
      const b = sortableValue(right[key], key);
      if (a === null && b === null) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      if (typeof a === "string") return a.localeCompare(b) * direction;
      return (a - b) * direction;
    });
    target.innerHTML = `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr>${columns.map(([key, label]) => `
            <th scope="col">
              <button class="sort-button" type="button" data-sort="${key}">
                ${escapeHtml(label)}${sortMarker(key)}
              </button>
            </th>`).join("")}</tr></thead>
          <tbody>${rows.map(resultRow).join("")}</tbody>
        </table>
      </div>`;
    target.querySelectorAll("[data-sort]").forEach((button) => {
      button.addEventListener("click", () => {
        const key = button.dataset.sort;
        if (state.tableSort.key === key) {
          state.tableSort.direction = state.tableSort.direction === "asc" ? "desc" : "asc";
        } else {
          state.tableSort = { key, direction: key === "title" ? "asc" : "desc" };
        }
        renderResultsTable();
      });
    });
  }

  function resultRow(row) {
    const hasQa = row.question_count > 0;
    return `<tr data-study="${escapeAttribute(row.study)}">
      <td><a class="study-link" href="#studies/${escapeAttribute(row.study)}">${escapeHtml(row.title)}</a></td>
      <td>${hasQa ? formatInteger(row.question_count) : na()}</td>
      <td>${hasQa ? formatInteger(row.scored_count) : na()}</td>
      <td>${hasQa ? escapeHtml(row.answer_types.join(", ")) : na()}</td>
      <td>${hasQa ? formatScore(row.normalized_accuracy) : na()}</td>
      <td>${hasQa ? formatScore(row.mean_llm_confidence) : na()}</td>
      <td>${formatScore(row.mean_code_quality)}</td>
      <td>${hasQa ? formatScore(row.mean_4d_confidence) : na()}</td>
      <td>${formatPercent(row.quality_coverage)}</td>
      <td>${humanReferenceLabel(row.human_reference)}</td>
    </tr>`;
  }

  function sortableValue(value, key) {
    if (key === "human_reference") return value?.status || "";
    if (Array.isArray(value)) return value.join(",");
    if (value === null || value === undefined) return null;
    return typeof value === "number" ? value : String(value);
  }

  function sortMarker(key) {
    if (state.tableSort.key !== key) return "";
    return state.tableSort.direction === "asc" ? " ↑" : " ↓";
  }

  async function renderRepresentation(token) {
    const dashboard = state.dashboard;
    const modes = [
      ["dynamic_2d", "2D dynamic"],
      ["dynamic_3d", "Dynamic 3D"],
      ["frozen_multiview_3d", "Frozen / multiview 3D"],
    ];
    const entry = dashboard.representation_examples[state.representationMode];
    const sample = await fetchJson(entry.data_path);
    if (token !== state.requestToken) return;
    main.innerHTML = `
      <div class="page representation-page">
        <div class="page-header">
          <div>
            <h1 class="page-title">Canonical 4D Spatial Code</h1>
            <p class="page-subtitle">
              One strict schema spans all studies. Field availability changes with modality; unavailable evidence is explicit and never fabricated.
            </p>
          </div>
          <div class="method-note">Real accepted code: ${escapeHtml(sample.code.code_id)} · ${escapeHtml(sample.code.study)}</div>
        </div>
        <section class="representation-layout">
          <aside class="schema-rail">
            <div class="schema-rail-header">
              <h2>Representation anatomy</h2>
              <p>Prediction-only fields exposed through validated toolbox functions.</p>
            </div>
            <ol class="schema-groups">
              <li class="schema-group identity"><strong>Identity + relations</strong><span>Entities, provenance, temporal relations, events, and camera.</span></li>
              <li class="schema-group direct"><strong>Direct fields</strong><span>SAM masks and bboxes, tracklets, depth and point-map references.</span></li>
              <li class="schema-group computed"><strong>Computed fields</strong><span>Centers, motion, 3D cuboids, local SE(3), and rigidity.</span></li>
            </ol>
          </aside>
          <div class="representation-workspace">
            <div class="control-bar" aria-label="Representation modality">
              ${modes.map(([key, label]) => `
                <button class="segmented-button" type="button" data-mode="${key}"
                  aria-pressed="${key === state.representationMode}">${escapeHtml(label)}</button>`).join("")}
            </div>
            <div class="tab-bar" role="tablist" aria-label="Canonical code groups">
              ${[
                ["identity", "Identity, relations, events, camera"],
                ["direct", "Direct fields"],
                ["computed", "Computed fields"],
              ].map(([key, label]) => `
                <button class="tab-button" type="button" role="tab" data-tab="${key}"
                  aria-selected="${key === state.representationTab}">${escapeHtml(label)}</button>`).join("")}
            </div>
            <div class="code-shell">
              <div class="code-meta">
                <span>${escapeHtml(entry.title)} · ${escapeHtml(sample.code.scenes[0].parse_mode)}</span>
                <span>schema ${escapeHtml(sample.code.schema_version)}</span>
              </div>
              <pre class="code-view representation-code" tabindex="0">${escapeHtml(JSON.stringify(representationSlice(sample.code, state.representationTab), null, 2))}</pre>
            </div>
          </div>
        </section>
      </div>`;
    main.querySelectorAll("[data-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        state.representationMode = button.dataset.mode;
        renderRepresentation(state.requestToken).catch(showError);
      });
    });
    main.querySelectorAll("[data-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        state.representationTab = button.dataset.tab;
        renderRepresentation(state.requestToken).catch(showError);
      });
    });
  }

  function representationSlice(code, tab) {
    const scene = code.scenes[0];
    if (tab === "identity") {
      return {
        code_id: code.code_id,
        study: code.study,
        scene: {
          scene_id: scene.scene_id,
          parse_mode: scene.parse_mode,
          timebase: scene.timebase,
          objects: scene.objects.map((object) => ({
            object_id: object.object_id,
            label: object.label,
            role: object.role,
            identity_source: object.identity_source,
            identity_confidence: object.identity_confidence,
          })),
          relations: compactEnvelope(scene.relations, 4),
          events: compactEnvelope(scene.events, 6),
          camera: compactEnvelope(scene.scene_fields?.camera, 2),
        },
      };
    }
    if (tab === "direct") {
      return {
        code_id: code.code_id,
        direct_fields: Object.fromEntries(scene.objects.map((object) => [
          object.object_id,
          Object.fromEntries(Object.entries(object.direct_fields).map(([name, field]) => [
            name,
            compactEnvelope(field, name.includes("tracklet") ? 1 : 2),
          ])),
        ])),
        depth: compactEnvelope(scene.scene_fields?.depth, 1),
        point_map: compactEnvelope(scene.scene_fields?.point_map, 1),
      };
    }
    return {
      code_id: code.code_id,
      computed_fields: Object.fromEntries(scene.objects.map((object) => [
        object.object_id,
        Object.fromEntries(Object.entries(object.computed_fields).map(([name, field]) => [
          name,
          compactEnvelope(field, 2),
        ])),
      ])),
    };
  }

  function compactEnvelope(field, limit) {
    if (!field) {
      return { availability: "unavailable", unavailable_reason: "field not defined by schema" };
    }
    const result = {
      availability: field.availability,
      source: field.source,
      units: field.units,
      frame_range: field.frame_range,
      confidence: field.confidence,
    };
    if (field.availability === "available") {
      const records = field.records || [];
      result.record_count = records.length;
      result.records = records.slice(0, limit);
      if (records.length > limit) result.records_omitted = records.length - limit;
    } else {
      result.unavailable_reason = field.unavailable_reason;
    }
    return result;
  }

  async function renderStudy(requestedStudy, token) {
    const studyKey = state.dashboard.study_order.includes(requestedStudy)
      ? requestedStudy
      : state.dashboard.study_order[0];
    if (requestedStudy !== studyKey) {
      location.replace(`#studies/${studyKey}`);
      return;
    }
    const indexEntry = state.dashboard.studies.find((item) => item.study === studyKey);
    const study = await fetchJson(indexEntry.data_path);
    const sample = await fetchJson(study.selected_sample.data_path);
    if (token !== state.requestToken) return;
    const question = sample.question;
    const selectedQuality = question?.code_quality?.find((item) => item.code_id === sample.code.code_id)
      || question?.code_quality?.[0]
      || null;
    const codeConfidence = question?.code_confidence?.score ?? null;
    const llmConfidence = question?.answer?.calibrated_answer_confidence ?? null;
    main.innerHTML = `
      <div class="studies-page">
        <div class="study-shell">
          ${studyRail(studyKey)}
          <article class="study-main">
            <header class="study-intro">
              <h1>${escapeHtml(study.title)}</h1>
              <p>${escapeHtml(study.description)}</p>
              <span class="reasoning-label">Reasoning: ${escapeHtml(study.reasoning)}</span>
            </header>
            <section class="viewer-section">
              <div id="canonical-viewer"></div>
            </section>
            ${qualityStrip(selectedQuality, codeConfidence, llmConfidence)}
            ${studyStatistics(study)}
            ${studyMetricMethods(study.formulas)}
          </article>
          ${evidencePanel(study, sample)}
        </div>
      </div>`;
    state.activeViewer = new window.CanonicalViewer(
      document.getElementById("canonical-viewer"),
      sample,
    );
  }

  function studyRail(activeStudy) {
    return `<aside class="study-rail" aria-label="Studies">
      <div class="study-rail-title">Studies (${state.dashboard.studies.length})</div>
      <ol class="study-rail-list">
        ${state.dashboard.studies.map((study, index) => `
          <li><a class="study-rail-link" href="#studies/${escapeAttribute(study.study)}"
            ${study.study === activeStudy ? 'aria-current="page"' : ""}>
            <span>${String(index + 1).padStart(2, "0")}</span>
            <span>${escapeHtml(study.title)}</span>
          </a></li>`).join("")}
      </ol>
    </aside>`;
  }

  function qualityStrip(quality, codeConfidence, llmConfidence) {
    const cells = [
      ["Internal 4D quality", quality?.internal_consistency_score, "teal"],
      ["Question-conditioned 4D confidence", codeConfidence, "cobalt"],
      ["Calibrated LLM answer confidence", llmConfidence, "amber"],
    ];
    return `<section class="quality-strip" aria-label="Selected question confidence and code quality">
      ${cells.map(([label, value, kind]) => `
        <div class="quality-cell">
          <span>${escapeHtml(label)}</span>
          <strong>${value === null || value === undefined ? "N/A" : formatScore(value)}</strong>
          <div class="meter ${kind}" style="--value: ${value ?? 0}"><span></span></div>
        </div>`).join("")}
    </section>`;
  }

  function studyStatistics(study) {
    const quality = study.quality_statistics;
    const confidence = study.confidence_statistics;
    const tools = study.tool_statistics;
    const human = study.human_reference;
    const bottleneck = study.bottleneck;
    const topTools = (tools.by_tool || []).slice(0, 6);
    const evidenceGroups = Object.entries(tools.evidence_groups || {}).slice(0, 6);
    const correlation = study.correlations || {};
    return `<section class="study-stats">
      <div class="section-heading"><h2>Study statistics</h2><p>All aggregates use the complete accepted study records, not only the displayed sample.</p></div>
      <div class="study-stats-grid">
        <section class="stat-block">
          <h3>4D-code quality</h3>
          <dl>
            ${statRow("codes", study.summary.code_count)}
            ${statRow("internal mean", quality.internal.mean, "score")}
            ${statRow("GT quality mean", quality.gt.mean, "score")}
            ${statRow("quality coverage", quality.coverage.mean, "percent")}
            ${statRow("source failures", quality.source_failure_count)}
          </dl>
        </section>
        <section class="stat-block">
          <h3>Confidence and task score</h3>
          <dl>
            ${statRow("QA / scored", `${study.summary.question_count} / ${study.summary.scored_count}`)}
            ${statRow("task score", study.summary.normalized_accuracy, "score")}
            ${statRow("LLM confidence", confidence.llm.mean, "score")}
            ${statRow("4D confidence", confidence.code.mean, "score")}
            ${statRow("answer types", study.summary.answer_types.join(", ") || "N/A")}
          </dl>
        </section>
        <section class="stat-block">
          <h3>Tool and evidence use</h3>
          <dl>
            ${statRow("tool calls", tools.total_calls)}
            ${statRow("invalid / duplicate", `${tools.invalid_calls} / ${tools.duplicate_calls}`)}
            ${topTools.map((item) => statRow(item.tool, `${item.call_count} (${formatPercent(item.question_coverage)})`)).join("")}
            ${evidenceGroups.map(([group, score]) => statRow(`evidence: ${group}`, score, "score")).join("")}
          </dl>
        </section>
        <section class="stat-block">
          <h3>Human comparison and diagnostics</h3>
          <dl>
            ${statRow("human reference", humanReferenceText(human))}
            ${statRow("human-target QA", human.human_target_question_count)}
            ${statRow("individual responses", human.individual_response_count)}
            ${statRow("objective human score", human.objective_human_task_score, "score")}
            ${statRow("bottleneck status", bottleneck?.attribution?.label || "N/A")}
            ${statRow("routing gap", bottleneck?.routing_tool_use_gap?.mean_gap, "signed")}
            ${statRow("routing CI95", formatInterval(bottleneck?.routing_tool_use_gap?.ci95))}
          </dl>
        </section>
        <section class="stat-block">
          <h3>Score relationships</h3>
          <dl>
            ${correlationRows(correlation)}
          </dl>
        </section>
        <section class="stat-block">
          <h3>Measured field status</h3>
          <dl>
            ${Object.entries(quality.metric_status || {}).slice(0, 10).map(([name, counts]) =>
              statRow(name, Object.entries(counts).map(([status, count]) => `${status}:${count}`).join(" · "))
            ).join("")}
          </dl>
        </section>
      </div>
    </section>`;
  }

  function studyMetricMethods(formulas) {
    return `<section class="study-stats section-band">
      <div class="section-heading">
        <h2>Quality, task-score, and confidence definitions</h2>
        <p>Unsupported measurements remain null; quality is the mean of measured applicable metrics.</p>
      </div>
      ${formulaTable(formulas)}
    </section>`;
  }

  function evidencePanel(study, sample) {
    const question = sample.question;
    if (!question) {
      return `<aside class="evidence-panel">
        <div class="evidence-header"><h2>Evidence inspector</h2><p>Selected representative sample</p></div>
        <dl class="evidence-table">
          ${evidenceRow("4D code", sample.code.code_id)}
          ${evidenceRow("Sample", sample.code.sample_id)}
          ${evidenceRow("QA status", "Not applicable")}
          ${evidenceRow("Reason", "This accepted Beller2025 sample is instructional media with no answer-bearing target.")}
        </dl>
      </aside>`;
    }
    const answer = question.answer || {};
    const evidenceSummary = question.evidence_path.length
      ? question.evidence_path.map((item) => `${item.tool}: ${item.availability}`).join("; ")
      : "No valid toolbox evidence returned.";
    return `<aside class="evidence-panel">
      <div class="evidence-header"><h2>Evidence inspector</h2><p>${escapeHtml(question.qa_id)} · no hidden chain-of-thought</p></div>
      <dl class="evidence-table">
        ${evidenceRow("Input question", question.prompt)}
        ${evidenceRow("Answer schema", answerSchema(question))}
        ${evidenceRow("Ground truth", question.ground_truth_display)}
        ${evidenceRow("LLM answer", `<span class="answer-text">${escapeHtml(question.answer_display)}</span>`, true)}
        ${evidenceRow("LLM confidence", `${formatScore(answer.calibrated_answer_confidence)} · ${escapeHtml(answer.calibration_status || "uncalibrated")}`, true)}
        ${evidenceRow("Task score", formatScore(question.score))}
        ${evidenceRow("4D code used", (question.used_code_ids.length ? question.used_code_ids : question.code_ids).join(", "))}
        ${evidenceRow("Evidence summary", evidenceSummary)}
        ${evidenceRow("Tool path", toolPath(question.evidence_path), true)}
        ${evidenceRow("4D confidence", confidenceGroups(question.code_confidence), true)}
        ${evidenceRow("Unsupported quality", unsupportedQuality(question.code_quality), true)}
        ${evidenceRow("Human reference", humanReferenceText(study.human_reference))}
      </dl>
    </aside>`;
  }

  function evidenceRow(label, value, trustedHtml = false) {
    return `<div class="evidence-row"><dt>${escapeHtml(label)}</dt><dd>${trustedHtml ? value : escapeHtml(value ?? "N/A")}</dd></div>`;
  }

  function toolPath(path) {
    if (!path.length) return `<span class="na">No valid calls</span>`;
    return `<ol class="tool-path">${path.map((item) => `
      <li>
        <span class="tool-name">${item.order}. ${escapeHtml(item.tool)} · ${escapeHtml(item.availability || "unknown")}</span>
        <span class="tool-detail">args=${escapeHtml(shortJson(item.arguments))}</span>
        <span class="tool-detail">evidence=${escapeHtml((item.evidence_ids || []).slice(0, 3).join(", ") || "none")}</span>
      </li>`).join("")}</ol>`;
  }

  function confidenceGroups(confidence) {
    const groups = Object.entries(confidence?.group_scores || {});
    if (!groups.length) return `<span class="na">N/A</span>`;
    return `<dl>${groups.map(([name, score]) => `
      <div><dt>${escapeHtml(name)}</dt><dd>${formatScore(score)}</dd></div>`).join("")}</dl>`;
  }

  function unsupportedQuality(reports) {
    const unsupported = [];
    (reports || []).forEach((report) => {
      (report.metrics || []).forEach((metric) => {
        if (metric.status === "unsupported") {
          unsupported.push(`${metric.name}: ${metric.reason}`);
        }
      });
    });
    return unsupported.length
      ? `<ul>${unsupported.slice(0, 8).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
      : `<span>None for selected code</span>`;
  }

  function answerSchema(question) {
    if (question.answer_type === "slider") {
      return `slider [${question.slider.minimum}, ${question.slider.maximum}]`;
    }
    if (question.answer_type === "multi_select") {
      return `multi-select: ${question.options.join(" | ")}`;
    }
    return `categorical: ${question.options.join(" | ")}`;
  }

  function renderDiagnostics() {
    const dashboard = state.dashboard;
    main.innerHTML = `
      <div class="page diagnostics-page">
        <div class="page-header">
          <div>
            <h1 class="page-title">Metric and bottleneck diagnostics</h1>
            <p class="page-subtitle">Measured quality, calibrated confidence, task-native scores, and controlled condition gaps remain distinct.</p>
          </div>
        </div>
        <div class="diagnostics-grid">
          <section>
            <div class="section-heading"><h2>Exact metric methods</h2><p>All values are computed by the site builder from structured artifacts.</p></div>
            ${formulaTable(dashboard.formulas)}
          </section>
          <aside>
            <div class="section-heading"><h2>Attribution boundary</h2></div>
            <div class="diagnostic-callout">
              <h2>Insufficient diagnostic coverage</h2>
              <p>${escapeHtml(dashboard.diagnostic_note)}</p>
            </div>
            <div class="section-heading"><h2>Controlled gaps by study</h2></div>
            ${bottleneckCompactList(dashboard.bottleneck_studies || [])}
          </aside>
        </div>
      </div>`;
  }

  function formulaTable(formulas) {
    return `<div class="formula-table">
      ${(formulas || []).map((item) => `
        <div class="formula-row">
          <div class="formula-name">${escapeHtml(item.name)}</div>
          <div class="formula-expression">${escapeHtml(item.formula)}</div>
          <div class="formula-detail">${escapeHtml(item.detail)}</div>
        </div>`).join("")}
    </div>`;
  }

  function bassVlmComparison(comparison) {
    if (!comparison) return "";
    const codeEffect = comparison.comparisons.find((item) => item.name === "code_gain_within_vlm");
    const videoEffect = comparison.comparisons.find((item) => item.name === "video_gain_within_vlm");
    return `<section class="section-band vlm-ablation" aria-labelledby="vlm-ablation-title">
      <div class="section-heading vlm-ablation-heading">
        <div>
          <span class="section-kicker">Bass2022Partial · multimodal ablation</span>
          <h2 id="vlm-ablation-title">${escapeHtml(comparison.title)}</h2>
        </div>
        <p>${formatInteger(comparison.question_count)} questions · ${formatInteger(comparison.unique_video_count)} videos · ${formatInteger(comparison.bootstrap_repeats)} grouped bootstrap resamples</p>
      </div>
      <div class="vlm-takeaway">
        <strong>Structured 4D evidence adds ${formatPercentagePoints(codeEffect?.mean_difference)}.</strong>
        <span>Its 95% interval is ${formatPercentagePointInterval(codeEffect?.ci95)}; direct video evidence is ${escapeHtml(videoEffect?.verdict || "unavailable")} at ${formatPercentagePoints(videoEffect?.mean_difference)}.</span>
      </div>
      <div class="vlm-ablation-grid">
        <div class="vlm-condition-panel">
          <div class="subsection-heading"><h3>Condition results</h3><span>Question-weighted</span></div>
          ${vlmConditionTable(comparison.conditions)}
          ${vlmScoreBars(comparison.conditions)}
        </div>
        <div class="vlm-effects-panel">
          <div class="subsection-heading"><h3>Paired effects</h3><span>95% video-group bootstrap</span></div>
          <div class="effect-list">
            ${comparison.comparisons.map(vlmEffectRow).join("")}
          </div>
          <p class="vlm-method-line">LLM confidence is answer-option likelihood after out-of-fold calibration. Human split-half reliability: ${formatPercent(comparison.human_noise_ceiling)}.</p>
        </div>
      </div>
    </section>`;
  }

  function vlmConditionTable(rows) {
    return `<div class="vlm-table-wrap"><table class="vlm-table">
      <thead><tr><th>Condition</th><th>Score</th><th>LLM conf.</th><th>Latency</th><th>Scored</th></tr></thead>
      <tbody>${rows.map((row) => `<tr>
        <td><strong>${escapeHtml(row.label)}</strong><span>${escapeHtml(row.description)}</span></td>
        <td>${formatPercent(row.normalized_task_score)}</td>
        <td>${formatPercent(row.mean_llm_confidence)}</td>
        <td>${formatSeconds(row.mean_generation_time_sec)}</td>
        <td>${formatInteger(row.scored_count)}/${formatInteger(row.qa_count)}</td>
      </tr>`).join("")}</tbody>
    </table></div>`;
  }

  function vlmScoreBars(rows) {
    return `<div class="vlm-score-bars" aria-label="Condition score comparison">
      ${rows.map((row) => {
        const value = Number(row.normalized_task_score || 0);
        const emphasis = row.condition === "qwen25vl_7b_video_plus_4d" ? " emphasis" : "";
        return `<div class="vlm-score-row${emphasis}">
          <span>${escapeHtml(row.label)}</span>
          <div class="vlm-score-track"><span style="width:${Math.max(0, Math.min(1, value)) * 100}%"></span></div>
          <strong>${formatPercentOne(value)}</strong>
        </div>`;
      }).join("")}
    </div>`;
  }

  function vlmEffectRow(item) {
    const positive = Number(item.mean_difference) > 0 && item.verdict === "positive";
    return `<article class="effect-row" data-verdict="${escapeAttribute(item.verdict)}">
      <div class="effect-row-heading">
        <h4>${escapeHtml(item.label)}</h4>
        <strong class="effect-value${positive ? " positive" : ""}">${formatPercentagePoints(item.mean_difference)}</strong>
      </div>
      <p>95% CI ${formatPercentagePointInterval(item.ci95)} · ${formatInteger(item.wins)} wins / ${formatInteger(item.ties)} ties / ${formatInteger(item.losses)} losses</p>
      <p>${formatInteger(item.paired_count)} scored questions across ${formatInteger(item.group_count)} source videos · ${escapeHtml(item.verdict)}</p>
    </article>`;
  }

  function conditionComparisonChart(rows) {
    if (!rows.length) return `<div class="empty-state">No controlled-condition data.</div>`;
    const width = 560;
    const rowHeight = 31;
    const top = 23;
    const left = 128;
    const chartWidth = width - left - 34;
    const height = top + rows.length * rowHeight + 28;
    const labels = {
      question_only: "Question only",
      predicted_code_qwen_tools: "Native tools",
      predicted_code_oracle_tools: "Oracle tools",
    };
    const colors = {
      question_only: "#df681b",
      predicted_code_qwen_tools: "#0f8f83",
      predicted_code_oracle_tools: "#155eef",
    };
    return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Global task scores by controlled condition">
      ${[0, 0.25, 0.5, 0.75, 1].map((tick) => `
        <line class="grid-line" x1="${left + tick * chartWidth}" y1="10" x2="${left + tick * chartWidth}" y2="${height - 24}"></line>
        <text x="${left + tick * chartWidth}" y="${height - 7}" text-anchor="middle">${Math.round(tick * 100)}%</text>`).join("")}
      ${rows.map((row, index) => {
        const y = top + index * rowHeight;
        const value = Number(row.score || 0);
        return `
          <text x="${left - 10}" y="${y + 9}" text-anchor="end">${escapeHtml(labels[row.condition] || row.condition)}</text>
          <rect x="${left}" y="${y}" width="${chartWidth}" height="12" fill="#edf0f5"></rect>
          <rect x="${left}" y="${y}" width="${value * chartWidth}" height="12" fill="${colors[row.condition] || "#155eef"}"></rect>
          <text x="${Math.min(left + value * chartWidth + 6, width - 34)}" y="${y + 10}">${formatPercent(value)}</text>`;
      }).join("")}
    </svg>`;
  }

  function scatterChart(points) {
    const width = 660;
    const height = 260;
    const left = 48;
    const top = 12;
    const chartWidth = width - left - 24;
    const chartHeight = height - top - 36;
    return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="4D confidence versus task score scatterplot">
      ${[0, 0.25, 0.5, 0.75, 1].map((tick) => `
        <line class="grid-line" x1="${left}" y1="${top + chartHeight - tick * chartHeight}" x2="${left + chartWidth}" y2="${top + chartHeight - tick * chartHeight}"></line>
        <text x="${left - 8}" y="${top + chartHeight - tick * chartHeight + 3}" text-anchor="end">${tick.toFixed(2)}</text>
        <text x="${left + tick * chartWidth}" y="${height - 9}" text-anchor="middle">${tick.toFixed(2)}</text>`).join("")}
      <line class="trend-line" x1="${left}" y1="${top + chartHeight}" x2="${left + chartWidth}" y2="${top}"></line>
      ${points.map((point) => {
        const x = left + Number(point.code_confidence) * chartWidth;
        const y = top + chartHeight - Number(point.score) * chartHeight;
        const fill = Number(point.score) >= 0.5 ? "#0f8f83" : "#df681b";
        return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="2.2" fill="${fill}" fill-opacity="0.46">
          <title>${escapeHtml(point.study)} · score ${formatScore(point.score)} · confidence ${formatScore(point.code_confidence)}</title>
        </circle>`;
      }).join("")}
      <text x="${left + chartWidth / 2}" y="${height - 1}" text-anchor="middle">4D-code confidence</text>
      <text transform="translate(12 ${top + chartHeight / 2}) rotate(-90)" text-anchor="middle">task score</text>
    </svg>`;
  }

  function bottleneckStatusTable(rows) {
    return `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>Study</th><th>Question only</th><th>Native tools</th><th>Oracle tools</th><th>Routing gap</th><th>95% interval</th><th>Status</th></tr></thead>
      <tbody>${rows.map((row) => {
        const means = row.condition_mean_task_score || {};
        return `<tr>
          <td><a class="study-link" href="#studies/${escapeAttribute(row.study)}">${escapeHtml(titleForStudy(row.study))}</a></td>
          <td>${formatScore(means.question_only)}</td>
          <td>${formatScore(means.predicted_code_qwen_tools)}</td>
          <td>${formatScore(means.predicted_code_oracle_tools)}</td>
          <td>${formatSigned(row.routing_tool_use_gap?.mean_gap)}</td>
          <td>${escapeHtml(formatInterval(row.routing_tool_use_gap?.ci95))}</td>
          <td>${escapeHtml(row.attribution?.label || "N/A")}</td>
        </tr>`;
      }).join("")}</tbody>
    </table></div>`;
  }

  function bottleneckCompactList(rows) {
    return `<ul class="compact-list">${rows.map((row) => `
      <li><strong>${escapeHtml(titleForStudy(row.study))}</strong><span>${escapeHtml(row.attribution?.label || "N/A")}</span></li>`).join("")}</ul>`;
  }

  function correlationRows(correlations) {
    return Object.entries(correlations).map(([name, item]) => {
      const value = item?.status === "measured"
        ? `r=${formatSigned(item.pearson)} · ρ=${formatSigned(item.spearman)}`
        : "insufficient variation";
      return statRow(name.replaceAll("_", " "), value);
    }).join("");
  }

  function statRow(label, value, format = null) {
    let rendered = value;
    if (value === null || value === undefined || value === "") rendered = "N/A";
    else if (format === "score") rendered = formatScore(value);
    else if (format === "percent") rendered = formatPercent(value);
    else if (format === "signed") rendered = formatSigned(value);
    return `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(rendered)}</dd>`;
  }

  function humanReferenceLabel(reference) {
    return `<span class="human-ref" data-status="${escapeAttribute(reference.status)}">${escapeHtml(humanReferenceText(reference))}</span>`;
  }

  function humanReferenceText(reference) {
    if (!reference) return "N/A";
    if (reference.status === "measured_reliability") {
      const values = (reference.noise_ceilings || []).map((item) => item.noise_ceiling).filter(Number.isFinite);
      const score = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
      return score === null ? "Measured split-half reliability" : `Reliability ${formatScore(score)}`;
    }
    if (reference.status === "distribution_only") return "Human distribution; reliability unavailable";
    if (reference.status === "objective_rule_ground_truth") return "Hidden objective-rule target";
    return "No answer-bearing human reference";
  }

  function formatInterval(interval) {
    return Array.isArray(interval) && interval.length === 2
      ? `[${formatSigned(interval[0])}, ${formatSigned(interval[1])}]`
      : "N/A";
  }

  function titleForStudy(study) {
    return state.dashboard.studies.find((item) => item.study === study)?.title || study;
  }

  async function fetchJson(path) {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while loading ${path}`);
    }
    return response.json();
  }

  function shortJson(value) {
    const raw = JSON.stringify(value || {});
    return raw.length > 180 ? `${raw.slice(0, 177)}...` : raw;
  }

  function formatInteger(value) {
    return Number(value || 0).toLocaleString("en-US");
  }

  function formatScore(value) {
    return Number.isFinite(Number(value)) ? Number(value).toFixed(3) : "N/A";
  }

  function formatSigned(value) {
    if (!Number.isFinite(Number(value))) return "N/A";
    const number = Number(value);
    return `${number >= 0 ? "+" : ""}${number.toFixed(3)}`;
  }

  function formatPercent(value) {
    return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(2)}%` : "N/A";
  }

  function formatPercentOne(value) {
    return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : "N/A";
  }

  function formatPercentagePoints(value) {
    if (!Number.isFinite(Number(value))) return "N/A";
    const points = Number(value) * 100;
    return `${points >= 0 ? "+" : ""}${points.toFixed(1)} pp`;
  }

  function formatPercentagePointInterval(interval) {
    return Array.isArray(interval) && interval.length === 2
      ? `[${formatPercentagePoints(interval[0])}, ${formatPercentagePoints(interval[1])}]`
      : "N/A";
  }

  function formatSeconds(value) {
    return Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)} s` : "N/A";
  }

  function na() {
    return `<span class="na">N/A</span>`;
  }

  function showError(error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    errorOverlay.textContent = message;
    errorOverlay.hidden = false;
    console.error(error);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value);
  }
})();


(async function () {
  const exampleId = document.body.dataset.exampleId;
  if (!exampleId) return;
  const response = await fetch(`../data/${exampleId}.json`);
  const data = await response.json();
  const code = data.code;
  const state = { frame: 0, selectedObject: null, selectedPoint: null, activeTab: 'current' };
  const video = document.querySelector('#video');
  const canvas = document.querySelector('#overlay');
  const ctx = canvas.getContext('2d');
  const timeline = document.querySelector('#timeline');
  const objectList = document.querySelector('#objectList');
  const pointList = document.querySelector('#pointList');
  const frameCount = Math.max(1, (code.metadata.sampled_frame_indices || []).length);
  const sourceSize = code.metadata.resolution || [1000, 510];
  const objectIds = (code.objects || []).map((obj) => obj.object_id);
  const maskImages = new Map();
  let suppressTimeUpdate = false;

  document.querySelector('#pageTitle').textContent = data.sample.title || exampleId;
  document.querySelector('#pageMeta').textContent = `${data.sample.role} / ${data.sample.condition_id} / ${data.sample.is_mirror ? 'mirror' : 'original'} / ${data.sample.trial_ids.join(', ') || data.sample.file_name}`;
  video.innerHTML = `<source src="../${data.media.path}" type="video/mp4" />`;
  video.playbackRate = Number(code.metadata.playback_rate || 0.35);
  timeline.max = String(frameCount - 1);

  objectIds.forEach((objectId) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.objectId = objectId;
    button.textContent = objectId;
    button.addEventListener('click', () => selectObject(objectId, null));
    objectList.appendChild(button);
  });

  document.querySelectorAll('.tab').forEach((button) => {
    button.addEventListener('click', () => {
      state.activeTab = button.dataset.tab;
      updateTabs();
      renderCode();
    });
  });
  document.querySelector('#playPause').addEventListener('click', () => {
    if (video.paused) video.play(); else video.pause();
  });
  document.querySelector('#prevFrame').addEventListener('click', () => setFrame(state.frame - 1, true));
  document.querySelector('#nextFrame').addEventListener('click', () => setFrame(state.frame + 1, true));
  timeline.addEventListener('input', () => setFrame(Number(timeline.value), true));
  video.addEventListener('loadedmetadata', () => { video.playbackRate = 0.35; });
  video.addEventListener('timeupdate', () => {
    if (suppressTimeUpdate) return;
    if (!video.duration) return;
    const next = Math.round((video.currentTime / video.duration) * (frameCount - 1));
    if (next !== state.frame) setFrame(next, false);
  });
  canvas.addEventListener('click', (event) => {
    const hit = pick(event.offsetX, event.offsetY);
    if (hit) selectObject(hit.objectId, hit.pointId);
  });
  window.addEventListener('resize', renderOverlay);

  setFrame(0, false);

  function setFrame(frame, syncVideo) {
    state.frame = Math.max(0, Math.min(frameCount - 1, Number(frame) || 0));
    timeline.value = String(state.frame);
    document.querySelector('#frameLabel').textContent = `${state.frame}`;
    if (syncVideo && video.duration) {
      suppressTimeUpdate = true;
      video.currentTime = (state.frame / Math.max(1, frameCount - 1)) * video.duration;
      window.setTimeout(() => { suppressTimeUpdate = false; }, 180);
    }
    renderPointButtons();
    renderOverlay();
    renderCode();
  }

  function selectObject(objectId, pointId) {
    state.selectedObject = objectId;
    state.selectedPoint = pointId;
    state.activeTab = 'current';
    document.querySelector('#objectLabel').textContent = pointId ? `${objectId}.${pointId}` : objectId;
    document.querySelectorAll('#objectList button').forEach((node) => node.classList.toggle('is-active', node.dataset.objectId === objectId));
    renderPointButtons();
    updateTabs();
    renderOverlay();
    renderCode();
  }

  function renderPointButtons() {
    pointList.innerHTML = '';
    const ids = state.selectedObject ? [state.selectedObject] : objectIds;
    ids.forEach((objectId) => {
      const maskRow = recordForFrame(code.direct_fields.mask_sequence[objectId], state.frame);
      (maskRow?.tracking_points || []).slice(0, 3).forEach((point, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.objectId = objectId;
        button.dataset.pointId = point.point_id;
        button.className = state.selectedPoint === point.point_id ? 'is-active' : '';
        button.textContent = `${objectId} p${index + 1}`;
        button.addEventListener('click', () => selectObject(objectId, point.point_id));
        pointList.appendChild(button);
      });
    });
  }

  function updateTabs() {
    document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('is-active', button.dataset.tab === state.activeTab));
  }

  function renderOverlay() {
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width));
    canvas.height = Math.max(1, Math.round(rect.height));
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const ids = state.selectedObject ? [state.selectedObject] : objectIds;
    ids.forEach((objectId) => drawObject(objectId));
  }

  function drawObject(objectId) {
    const maskRow = recordForFrame(code.direct_fields.mask_sequence[objectId], state.frame);
    const centerRows = code.computed_fields.center_2d_trajectory[objectId] || [];
    const center = recordForFrame(centerRows, state.frame);
    const color = objectId === 'pink_sphere' ? '#d382a3' : '#939294';
    drawMask(maskRow, color);
    drawRainbowTrail(centerRows, color);
    if (maskRow && Array.isArray(maskRow.bbox_2d)) drawBBox(maskRow.bbox_2d, color, objectId === state.selectedObject);
    if (center && Array.isArray(center.uv)) drawPoint(center.uv, color, objectId, 7);
    drawTrackingPoints(maskRow, objectId);
  }

  function drawMask(row, color) {
    if (!row || !row.mask_ref) return;
    const key = `${data.mask_base}/${row.mask_ref}.png`;
    const image = imageFor(key);
    if (!image.complete || !image.naturalWidth) return;
    const offscreen = document.createElement('canvas');
    offscreen.width = canvas.width;
    offscreen.height = canvas.height;
    const octx = offscreen.getContext('2d');
    octx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = octx.getImageData(0, 0, offscreen.width, offscreen.height);
    const rgb = hexToRgb(color);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const alpha = pixels.data[i];
      pixels.data[i] = rgb[0];
      pixels.data[i + 1] = rgb[1];
      pixels.data[i + 2] = rgb[2];
      pixels.data[i + 3] = Math.round(alpha * 0.24);
    }
    octx.putImageData(pixels, 0, 0);
    ctx.drawImage(offscreen, 0, 0);
  }

  function imageFor(key) {
    if (maskImages.has(key)) return maskImages.get(key);
    const image = new Image();
    image.onload = renderOverlay;
    image.src = `../${key}`;
    maskImages.set(key, image);
    return image;
  }

  function drawBBox(bbox, color, selected) {
    const a = scalePoint([bbox[0], bbox[1]]);
    const b = scalePoint([bbox[2], bbox[3]]);
    ctx.save();
    ctx.strokeStyle = selected ? '#facc15' : color;
    ctx.lineWidth = selected ? 4 : 2;
    ctx.setLineDash([7, 4]);
    ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    ctx.restore();
  }

  function drawRainbowTrail(rows) {
    const ordered = (rows || []).filter((row) => Array.isArray(row.uv) && Number(row.frame_index) <= state.frame);
    if (ordered.length < 2) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 1; i < ordered.length; i += 1) {
      const a = scalePoint(ordered[i - 1].uv);
      const b = scalePoint(ordered[i].uv);
      const progress = i / Math.max(1, ordered.length - 1);
      ctx.strokeStyle = `hsla(${Math.round(progress * 300)}, 95%, 55%, .92)`;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawTrackingPoints(maskRow, objectId) {
    const points = Array.isArray(maskRow?.tracking_points) ? maskRow.tracking_points : [];
    points.slice(0, 3).forEach((point, index) => {
      if (!Array.isArray(point.uv)) return;
      drawPoint(point.uv, trackingColor(index), point.point_id, state.selectedPoint === point.point_id ? 8 : 5.6);
    });
  }

  function drawPoint(uv, color, label, radius) {
    const p = scalePoint(uv);
    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p[0], p[1], radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.86)';
    ctx.fillRect(p[0] + 10, p[1] - 12, Math.max(72, String(label).length * 7), 24);
    ctx.fillStyle = '#17212b';
    ctx.font = '12px sans-serif';
    ctx.fillText(label, p[0] + 14, p[1] + 4);
    ctx.restore();
  }

  function pick(x, y) {
    for (const objectId of objectIds) {
      const maskRow = recordForFrame(code.direct_fields.mask_sequence[objectId], state.frame);
      for (const point of (maskRow?.tracking_points || [])) {
        const p = scalePoint(point.uv);
        if (Math.hypot(x - p[0], y - p[1]) <= 16) return {objectId, pointId: point.point_id};
      }
      const bbox = maskRow?.bbox_2d;
      if (Array.isArray(bbox)) {
        const a = scalePoint([bbox[0], bbox[1]]);
        const b = scalePoint([bbox[2], bbox[3]]);
        if (x >= a[0] && x <= b[0] && y >= a[1] && y <= b[1]) return {objectId, pointId: null};
      }
    }
    return null;
  }

  function renderCode() {
    const current = currentFramePayload();
    const selected = selectedObjectPayload();
    const gt = gtPayload();
    const raw = code;
    const panels = {
      current,
      object: selected,
      gt,
      raw
    };
    const container = document.querySelector('#codePanels');
    container.innerHTML = Object.entries(panels).map(([name, payload]) => {
      const active = name === state.activeTab ? ' is-active' : '';
      if (name === 'raw') {
        return `<section class="code-section${active}" data-panel="${name}"><details class="raw-details"><summary>Open raw JSON</summary><pre><code>${highlight(JSON.stringify(payload, null, 2))}</code></pre></details></section>`;
      }
      return `<section class="code-section${active}" data-panel="${name}"><pre><code>${highlight(JSON.stringify(payload, null, 2))}</code></pre></section>`;
    }).join('');
  }

  function currentFramePayload() {
    const ids = state.selectedObject ? [state.selectedObject] : objectIds;
    const objects = {};
    ids.forEach((objectId) => {
      objects[objectId] = {
        object: (code.objects || []).find((obj) => obj.object_id === objectId),
        bbox_2d: recordForFrame(code.direct_fields.bbox_2d_sequence[objectId], state.frame),
        mask: recordForFrame(code.direct_fields.mask_sequence[objectId], state.frame),
        center_2d: recordForFrame(code.computed_fields.center_2d_trajectory[objectId], state.frame),
        velocity_2d: recordForFrame(code.computed_fields.velocity_2d[objectId], state.frame),
        visibility: recordForFrame(code.computed_fields.visibility[objectId], state.frame)
      };
    });
    return {
      sample_id: code.sample_id,
      parse_mode: code.parse_mode,
      frame_index: state.frame,
      source_frame_index: (code.metadata.sampled_frame_indices || [])[state.frame],
      selected_object: state.selectedObject,
      selected_point: state.selectedPoint,
      objects,
      relations: code.relations,
      events: code.events
    };
  }

  function selectedObjectPayload() {
    if (!state.selectedObject) return {selected_object: null};
    return {
      object: (code.objects || []).find((obj) => obj.object_id === state.selectedObject),
      direct_fields: {
        bbox_2d_sequence: code.direct_fields.bbox_2d_sequence[state.selectedObject],
        mask_sequence: code.direct_fields.mask_sequence[state.selectedObject],
        point_tracks_2d: code.direct_fields.point_tracks_2d[state.selectedObject]
      },
      computed_fields: {
        center_2d_trajectory: code.computed_fields.center_2d_trajectory[state.selectedObject],
        velocity_2d: code.computed_fields.velocity_2d[state.selectedObject],
        acceleration_2d: code.computed_fields.acceleration_2d[state.selectedObject],
        visibility: code.computed_fields.visibility[state.selectedObject]
      }
    };
  }

  function gtPayload() {
    return {
      role: code.metadata.bass.role,
      file_name: code.metadata.bass.file_name,
      condition_id: code.metadata.bass.condition_id,
      is_mirror: code.metadata.bass.is_mirror,
      expected_objects: code.metadata.bass.expected_objects,
      symbolic_scene: code.metadata.bass.symbolic_scene,
      world_physics: code.metadata.bass.world_physics,
      attached_trials: code.metadata.bass.attached_trials,
      attached_instructions: code.metadata.bass.attached_instructions
    };
  }

  function highlight(json) {
    let text = escapeHtml(json);
    const tokens = [state.selectedObject, state.selectedPoint].filter(Boolean).sort((a, b) => b.length - a.length);
    tokens.forEach((token) => {
      text = text.replaceAll(escapeHtml(token), `<mark>${escapeHtml(token)}</mark>`);
    });
    return text;
  }

  function recordForFrame(rows, frame) {
    if (!Array.isArray(rows)) return null;
    return rows.find((row) => Number(row.frame_index) === Number(frame)) || null;
  }

  function scalePoint(uv) {
    const sx = Number(sourceSize[0] || 1);
    const sy = Number(sourceSize[1] || 1);
    return [Number(uv[0]) / sx * canvas.width, Number(uv[1]) / sy * canvas.height];
  }

  function trackingColor(index) {
    const colors = ['#06b6d4', '#d946ef', '#84cc16'];
    return colors[index % colors.length];
  }

  function hexToRgb(hex) {
    const clean = String(hex).replace('#', '');
    return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16), parseInt(clean.slice(4, 6), 16)];
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, (ch) => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;'}[ch]));
  }
})();

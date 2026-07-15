(function () {
  "use strict";

  const COLORS = [
    "#2f7df6",
    "#15a394",
    "#f17c28",
    "#d84f68",
    "#7d65d8",
    "#1a9ed1",
    "#9a7515",
    "#d14ea0",
    "#4e9d53",
    "#e14b3b",
  ];

  const CUBOID_EDGES = [
    [0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3],
    [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7],
  ];

  class CanonicalViewer {
    constructor(root, payload) {
      this.root = root;
      this.payload = payload;
      this.code = payload.code;
      this.scene = this.code.scenes[0];
      this.frames = this.scene.timebase.sampled_frames || [];
      this.objects = this.scene.objects || [];
      this.selectedObjectId = this.objects[0]?.object_id || null;
      this.selectedPointId = null;
      this.frameIndex = 0;
      this.maskCache = new Map();
      this.hitPoints = [];
      this.destroyed = false;
      this.animationFrame = null;
      this.renderShell();
      this.bind();
      this.refresh();
    }

    renderShell() {
      const viewer = this.payload.viewer;
      const aspect = `${viewer.source_width} / ${viewer.source_height}`;
      this.root.innerHTML = `
        <div class="viewer-grid">
          <div class="media-viewer">
            <div class="media-stage" style="--media-aspect: ${aspect}">
              <video preload="metadata" playsinline muted
                src="${escapeAttribute(viewer.media_url)}"
                poster="${escapeAttribute(viewer.poster_url)}"></video>
              <canvas aria-label="Current 4D-code mask, trajectory, point, and cuboid overlay"></canvas>
              <div class="viewer-status" aria-live="polite"></div>
            </div>
            <div class="viewer-controls">
              <button class="icon-button play-button" type="button" title="Play" aria-label="Play">
                <span aria-hidden="true">▶</span>
              </button>
              <button class="icon-button step-button" type="button" title="Next sampled frame" aria-label="Next sampled frame">
                <span aria-hidden="true">▮▶</span>
              </button>
              <input class="timeline" type="range" min="0" max="1000" value="0" aria-label="Video position">
              <span class="time-readout">00:00.00 / 00:00.00</span>
            </div>
          </div>
          <section class="viewer-code" aria-label="Playback-synchronized current-frame code">
            <div class="code-meta">
              <span>current frame / prediction-only code</span>
              <span class="frame-readout">t=0</span>
            </div>
            <div class="object-bar" aria-label="Object and point selection"></div>
            <pre class="code-view" tabindex="0"></pre>
          </section>
        </div>`;
      this.video = this.root.querySelector("video");
      this.canvas = this.root.querySelector("canvas");
      this.mediaStage = this.root.querySelector(".media-stage");
      this.mediaViewer = this.root.querySelector(".media-viewer");
      this.viewerCode = this.root.querySelector(".viewer-code");
      this.codeMeta = this.root.querySelector(".code-meta");
      this.context = this.canvas.getContext("2d");
      this.playButton = this.root.querySelector(".play-button");
      this.stepButton = this.root.querySelector(".step-button");
      this.timeline = this.root.querySelector(".timeline");
      this.timeReadout = this.root.querySelector(".time-readout");
      this.status = this.root.querySelector(".viewer-status");
      this.frameReadout = this.root.querySelector(".frame-readout");
      this.objectBar = this.root.querySelector(".object-bar");
      this.codeView = this.root.querySelector(".code-view");
      this.video.playbackRate = Number(this.payload.viewer.playback_rate || 0.5);
    }

    bind() {
      this.onTimeUpdate = () => {
        this.frameIndex = nearestFrameIndex(this.frames, this.video.currentTime);
        this.refresh();
      };
      this.video.addEventListener("loadedmetadata", () => {
        this.video.playbackRate = Number(this.payload.viewer.playback_rate || 0.5);
        this.refresh();
      });
      this.video.addEventListener("timeupdate", this.onTimeUpdate);
      this.video.addEventListener("seeked", this.onTimeUpdate);
      this.video.addEventListener("play", () => this.updatePlayButton());
      this.video.addEventListener("pause", () => this.updatePlayButton());
      this.video.addEventListener("ended", () => this.updatePlayButton());
      this.video.addEventListener("error", () => {
        this.status.textContent = "Media failed to load";
        this.status.dataset.error = "true";
      });
      this.playButton.addEventListener("click", () => {
        if (this.video.paused) {
          this.video.play().catch((error) => {
            this.status.textContent = `Playback blocked: ${error.message}`;
          });
        } else {
          this.video.pause();
        }
      });
      this.stepButton.addEventListener("click", () => this.step(1));
      this.timeline.addEventListener("input", () => {
        const duration = this.duration();
        this.video.currentTime = duration * (Number(this.timeline.value) / 1000);
      });
      this.canvas.addEventListener("click", (event) => this.selectAt(event));
      this.resizeObserver = new ResizeObserver(() => {
        this.syncPanelHeight();
        this.requestDraw();
      });
      this.resizeObserver.observe(this.canvas);
    }

    destroy() {
      this.destroyed = true;
      this.video.pause();
      this.resizeObserver?.disconnect();
      if (this.animationFrame !== null) {
        cancelAnimationFrame(this.animationFrame);
      }
    }

    duration() {
      const declared = Number(this.scene.timebase.duration_sec || 0);
      return Number.isFinite(this.video.duration) && this.video.duration > 0
        ? this.video.duration
        : declared;
    }

    step(delta) {
      const target = Math.max(0, Math.min(this.frames.length - 1, this.frameIndex + delta));
      this.frameIndex = target;
      this.video.currentTime = Number(this.frames[target]?.timestamp_sec || 0);
      this.refresh();
    }

    setObject(objectId, pointId = null) {
      if (!this.objects.some((object) => object.object_id === objectId)) {
        return;
      }
      this.selectedObjectId = objectId;
      this.selectedPointId = pointId;
      this.refresh();
      this.codeView.focus({ preventScroll: true });
    }

    selectAt(event) {
      const rect = this.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const point = this.hitPoints
        .map((candidate) => ({
          ...candidate,
          distance: Math.hypot(candidate.x - x, candidate.y - y),
        }))
        .filter((candidate) => candidate.distance <= 14)
        .sort((left, right) => left.distance - right.distance)[0];
      if (point) {
        this.setObject(point.objectId, point.pointId);
        return;
      }
      const source = this.canvasToSource(x, y);
      if (!source) {
        return;
      }
      const object = [...this.objects].reverse().find((candidate) => {
        const bbox = currentRecord(candidate.direct_fields.bbox_2d, this.frameIndex)?.bbox_2d;
        return validBbox(bbox) && pointInsideBbox(source, bbox);
      });
      if (object) {
        this.setObject(object.object_id);
      }
    }

    refresh() {
      if (this.destroyed) {
        return;
      }
      const frame = this.frames[this.frameIndex] || {};
      const timestamp = Number(frame.timestamp_sec || 0);
      const duration = Math.max(this.duration(), 0.001);
      this.timeline.value = String(Math.round((timestamp / duration) * 1000));
      this.timeReadout.textContent = `${formatTime(timestamp)} / ${formatTime(duration)}`;
      this.frameReadout.textContent = `t=${this.frameIndex} · ${timestamp.toFixed(2)}s`;
      const behavior = this.payload.viewer.scene_behavior === "frozen_multiview_observation"
        ? "frozen tower observation"
        : "dynamic sequence";
      this.status.textContent = `${this.scene.parse_mode} · ${behavior} · ${this.video.playbackRate.toFixed(1)}x`;
      this.updatePlayButton();
      this.renderObjectBar();
      this.renderCode();
      this.syncPanelHeight();
      this.requestDraw();
    }

    updatePlayButton() {
      if (!this.playButton) {
        return;
      }
      const playing = !this.video.paused && !this.video.ended;
      this.playButton.innerHTML = `<span aria-hidden="true">${playing ? "❚❚" : "▶"}</span>`;
      this.playButton.title = playing ? "Pause" : "Play";
      this.playButton.setAttribute("aria-label", playing ? "Pause" : "Play");
    }

    renderObjectBar() {
      const selected = this.objects.find((object) => object.object_id === this.selectedObjectId);
      const tracks = selected ? visualTracks(selected).slice(0, 3) : [];
      const objectButtons = this.objects.map((object) => `
        <button class="object-button" type="button"
          data-object="${escapeAttribute(object.object_id)}"
          aria-pressed="${object.object_id === this.selectedObjectId}">
          ${escapeHtml(object.label || object.object_id)}
        </button>`).join("");
      const pointButtons = tracks.map((track, index) => {
        const pointId = track.point_id || track.tracklet_id || `point_${index + 1}`;
        return `
          <button class="object-button point-button" type="button"
            data-object="${escapeAttribute(this.selectedObjectId)}"
            data-point="${escapeAttribute(pointId)}"
            aria-pressed="${pointId === this.selectedPointId}">
            P${index + 1}
          </button>`;
      }).join("");
      this.objectBar.innerHTML = objectButtons + pointButtons;
      this.objectBar.querySelectorAll("button").forEach((button) => {
        button.addEventListener("click", () => {
          this.setObject(button.dataset.object, button.dataset.point || null);
        });
      });
    }

    renderCode() {
      const payload = currentFramePayload(
        this.code,
        this.scene,
        this.frameIndex,
        this.selectedObjectId,
        this.selectedPointId,
      );
      const raw = JSON.stringify(payload, null, 2);
      const marker = this.selectedPointId || this.selectedObjectId;
      this.codeView.innerHTML = raw.split("\n").map((line) => {
        const escaped = escapeHtml(line);
        return marker && line.includes(`\"${marker}\"`)
          ? `<span class="highlight-line">${escaped}</span>`
          : escaped;
      }).join("\n");
      const highlighted = this.codeView.querySelector(".highlight-line");
      if (highlighted) {
        this.codeView.scrollTop = Math.max(
          0,
          highlighted.offsetTop - this.codeView.clientHeight / 2,
        );
      }
    }

    syncPanelHeight() {
      if (window.matchMedia("(max-width: 820px)").matches) {
        this.codeView.style.removeProperty("height");
        this.codeView.style.removeProperty("min-height");
        this.codeView.style.removeProperty("max-height");
        return;
      }
      const controls = this.root.querySelector(".viewer-controls");
      const available = Math.max(
        150,
        this.mediaStage.getBoundingClientRect().height
          + controls.getBoundingClientRect().height
          - this.codeMeta.getBoundingClientRect().height
          - this.objectBar.getBoundingClientRect().height,
      );
      const height = `${Math.round(available)}px`;
      this.codeView.style.height = height;
      this.codeView.style.minHeight = height;
      this.codeView.style.maxHeight = height;
    }

    requestDraw() {
      if (this.animationFrame !== null) {
        return;
      }
      this.animationFrame = requestAnimationFrame(() => {
        this.animationFrame = null;
        this.draw();
      });
    }

    draw() {
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.round(rect.width * pixelRatio);
      const height = Math.round(rect.height * pixelRatio);
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      const context = this.context;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, rect.width, rect.height);
      const transform = this.transform();
      this.hitPoints = [];
      let overlayPrimitives = 0;
      this.objects.forEach((object, index) => {
        overlayPrimitives += this.drawObject(context, transform, object, index);
      });
      this.canvas.dataset.overlayFrame = String(this.frameIndex);
      this.canvas.dataset.overlayPrimitives = String(overlayPrimitives);
      this.canvas.dataset.overlayReady = overlayPrimitives > 0 ? "true" : "false";
    }

    drawObject(context, transform, object, objectIndex) {
      let overlayPrimitives = 0;
      const selected = object.object_id === this.selectedObjectId;
      const color = COLORS[objectIndex % COLORS.length];
      const mask = currentRecord(object.direct_fields.mask, this.frameIndex);
      if (mask && Number(mask.area || 0) > 0 && mask.mask_ref) {
        overlayPrimitives += this.drawMask(
          context,
          transform,
          String(mask.mask_ref),
          color,
          selected,
        ) ? 1 : 0;
      }
      const bboxRecord = currentRecord(object.direct_fields.bbox_2d, this.frameIndex);
      if (validBbox(bboxRecord?.bbox_2d)) {
        drawBbox(context, transform, bboxRecord.bbox_2d, color, selected, object.label || object.object_id);
        overlayPrimitives += 1;
      }
      const cuboid = currentRecord(object.computed_fields.bbox_3d, this.frameIndex);
      if (cuboid?.corners_image?.length === 8) {
        drawCuboid(context, transform, cuboid.corners_image, color, selected);
        overlayPrimitives += 1;
      }
      if (selected) {
        visualTracks(object).slice(0, 3).forEach((track, index) => {
          overlayPrimitives += this.drawTrack(context, transform, object, track, index) ? 1 : 0;
        });
      }
      return overlayPrimitives;
    }

    drawMask(context, transform, maskRef, color, selected) {
      const suffix = maskRef.toLowerCase().endsWith(".png") ? "" : ".png";
      const encoded = maskRef.split("/").map(encodeURIComponent).join("/");
      const url = `${this.payload.viewer.mask_root}/${encoded}${suffix}`;
      const key = `${url}|${color}`;
      const cached = this.maskCache.get(key);
      if (cached?.status === "ready") {
        context.save();
        context.globalAlpha = selected ? 0.36 : 0.17;
        context.drawImage(
          cached.canvas,
          transform.offsetX,
          transform.offsetY,
          transform.sourceWidth * transform.scale,
          transform.sourceHeight * transform.scale,
        );
        context.restore();
        return true;
      }
      if (!cached) {
        const entry = { status: "loading", canvas: null };
        this.maskCache.set(key, entry);
        loadTintedMask(url, color).then((canvas) => {
          entry.status = "ready";
          entry.canvas = canvas;
          this.requestDraw();
        }).catch(() => {
          entry.status = "failed";
        });
      }
      return false;
    }

    drawTrack(context, transform, object, track, trackIndex) {
      const sequence = trackUvSequence(track);
      const points = [];
      for (let index = 0; index <= this.frameIndex && index < sequence.length; index += 1) {
        const uv = sequence[index];
        if (validPoint(uv)) {
          points.push({ index, uv });
        }
      }
      if (!points.length) {
        return false;
      }
      context.save();
      context.lineCap = "round";
      context.lineJoin = "round";
      context.lineWidth = 2.2;
      for (let index = 1; index < points.length; index += 1) {
        const previous = transformPoint(points[index - 1].uv, transform);
        const current = transformPoint(points[index].uv, transform);
        context.beginPath();
        context.moveTo(previous[0], previous[1]);
        context.lineTo(current[0], current[1]);
        context.strokeStyle = `hsl(${205 - (index / Math.max(points.length - 1, 1)) * 180} 88% 54%)`;
        context.stroke();
      }
      const last = transformPoint(points[points.length - 1].uv, transform);
      const pointId = track.point_id || track.tracklet_id || `point_${trackIndex + 1}`;
      const active = pointId === this.selectedPointId;
      context.beginPath();
      context.arc(last[0], last[1], active ? 6 : 4.5, 0, Math.PI * 2);
      context.fillStyle = COLORS[(trackIndex + 1) % COLORS.length];
      context.fill();
      context.lineWidth = active ? 3 : 2;
      context.strokeStyle = "#ffffff";
      context.stroke();
      context.fillStyle = "#ffffff";
      context.font = "600 9px Segoe UI, sans-serif";
      context.fillText(`P${trackIndex + 1}`, last[0] + 7, last[1] - 7);
      context.restore();
      this.hitPoints.push({
        x: last[0],
        y: last[1],
        objectId: object.object_id,
        pointId,
      });
      return true;
    }

    transform() {
      const rect = this.canvas.getBoundingClientRect();
      const sourceWidth = Number(this.payload.viewer.source_width);
      const sourceHeight = Number(this.payload.viewer.source_height);
      const scale = Math.min(rect.width / sourceWidth, rect.height / sourceHeight);
      return {
        sourceWidth,
        sourceHeight,
        scale,
        offsetX: (rect.width - sourceWidth * scale) / 2,
        offsetY: (rect.height - sourceHeight * scale) / 2,
      };
    }

    canvasToSource(x, y) {
      const transform = this.transform();
      const sourceX = (x - transform.offsetX) / transform.scale;
      const sourceY = (y - transform.offsetY) / transform.scale;
      if (
        sourceX < 0 || sourceY < 0 ||
        sourceX > transform.sourceWidth || sourceY > transform.sourceHeight
      ) {
        return null;
      }
      return [sourceX, sourceY];
    }
  }

  function currentFramePayload(code, scene, frameIndex, objectId, pointId) {
    const frame = scene.timebase.sampled_frames[frameIndex] || {};
    const objects = {};
    scene.objects.forEach((object) => {
      if (objectId && object.object_id !== objectId) {
        return;
      }
      const direct = {};
      Object.entries(object.direct_fields || {}).forEach(([name, field]) => {
        direct[name] = currentFieldSlice(field, frameIndex);
      });
      const computed = {};
      Object.entries(object.computed_fields || {}).forEach(([name, field]) => {
        computed[name] = currentFieldSlice(field, frameIndex);
      });
      objects[object.object_id] = {
        identity: {
          label: object.label,
          role: object.role,
          source: object.identity_source,
          confidence: object.identity_confidence,
        },
        selected_point: pointId ? selectedPointSlice(object, pointId, frameIndex) : null,
        direct_fields: direct,
        computed_fields: computed,
      };
    });
    return {
      code_id: code.code_id,
      scene_id: scene.scene_id,
      parse_mode: scene.parse_mode,
      frame: {
        sampled_index: frameIndex,
        source_frame_index: frame.source_frame_index,
        timestamp_sec: frame.timestamp_sec,
      },
      selected_object: objectId,
      selected_point: pointId,
      objects,
      relations: temporalEnvelopeSlice(scene.relations, frameIndex),
      events: temporalEnvelopeSlice(scene.events, frameIndex),
      camera: currentFieldSlice(scene.scene_fields?.camera, frameIndex),
    };
  }

  function currentFieldSlice(field, frameIndex) {
    if (!field) {
      return { availability: "unavailable", reason: "field not defined" };
    }
    if (field.availability !== "available") {
      return {
        availability: field.availability,
        reason: field.unavailable_reason,
        source: field.source,
      };
    }
    const record = currentRecord(field, frameIndex);
    return {
      availability: record ? "available" : "not_available_at_t",
      source: field.source,
      units: field.units,
      confidence: field.confidence,
      record,
    };
  }

  function temporalEnvelopeSlice(field, frameIndex) {
    if (!field || field.availability !== "available") {
      return {
        availability: field?.availability || "unavailable",
        reason: field?.unavailable_reason || "field not defined",
      };
    }
    const records = (field.records || []).filter((record) => {
      if (record.frame_index !== undefined) {
        return Number(record.frame_index) === frameIndex;
      }
      const start = record.start_t ?? record.start_frame;
      const end = record.end_t ?? record.end_frame;
      if (start !== undefined || end !== undefined) {
        return frameIndex >= Number(start ?? frameIndex) && frameIndex <= Number(end ?? frameIndex);
      }
      return true;
    });
    return {
      availability: records.length ? "available" : "not_available_at_t",
      source: field.source,
      records,
    };
  }

  function selectedPointSlice(object, pointId, frameIndex) {
    const track = visualTracks(object).find((candidate) =>
      (candidate.point_id || candidate.tracklet_id) === pointId
    );
    if (!track) {
      return { availability: "unavailable", point_id: pointId };
    }
    const sequence = trackUvSequence(track);
    return {
      availability: validPoint(sequence[frameIndex]) ? "available" : "not_visible_at_t",
      point_id: pointId,
      object_id: object.object_id,
      uv: sequence[frameIndex] || null,
      source: track.source,
      confidence: Array.isArray(track.confidence) ? track.confidence[frameIndex] : null,
    };
  }

  function visualTracks(object) {
    const points = object.direct_fields?.point_tracks_2d;
    if (points?.availability === "available") {
      return points.records || [];
    }
    const accepted = object.direct_fields?.accepted_tracklets;
    if (accepted?.availability !== "available") {
      return [];
    }
    const records = accepted.records || [];
    const ranked = records
      .map((track) => ({
        track,
        support: trackUvSequence(track).filter(validPoint).length,
      }))
      .filter((item) => item.support > 0)
      .sort((left, right) => right.support - left.support ||
        String(left.track.tracklet_id).localeCompare(String(right.track.tracklet_id)));
    const selected = [];
    const particles = new Set();
    for (const item of ranked) {
      const particle = item.track.logical_particle_id ?? item.track.tracklet_id;
      if (particles.has(particle)) {
        continue;
      }
      particles.add(particle);
      selected.push(item.track);
      if (selected.length === 3) {
        break;
      }
    }
    return selected;
  }

  function trackUvSequence(track) {
    if (Array.isArray(track.uv_sequence)) {
      return track.uv_sequence;
    }
    if (Array.isArray(track.visual_uv)) {
      return track.visual_uv;
    }
    if (Array.isArray(track.xyz_world)) {
      const maxT = Math.max(-1, ...track.xyz_world.map((item) => Number(item.t ?? -1)));
      const sequence = Array(maxT + 1).fill(null);
      track.xyz_world.forEach((item) => {
        if (Number.isInteger(Number(item.t)) && validPoint(item.uv)) {
          sequence[Number(item.t)] = item.uv;
        }
      });
      return sequence;
    }
    return [];
  }

  function currentRecord(field, frameIndex) {
    if (!field || field.availability !== "available") {
      return null;
    }
    const records = field.records || [];
    const exact = records.find((record) => Number(record.frame_index) === frameIndex);
    if (exact) {
      return exact;
    }
    return records.find((record) => Number(record.t) === frameIndex) || null;
  }

  function drawBbox(context, transform, bbox, color, selected, label) {
    const [x1, y1] = transformPoint([bbox[0], bbox[1]], transform);
    const [x2, y2] = transformPoint([bbox[2], bbox[3]], transform);
    context.save();
    context.strokeStyle = color;
    context.lineWidth = selected ? 2.4 : 1.25;
    context.setLineDash(selected ? [] : [5, 4]);
    context.strokeRect(x1, y1, x2 - x1, y2 - y1);
    context.setLineDash([]);
    if (selected) {
      context.font = "600 10px Segoe UI, sans-serif";
      const width = context.measureText(label).width + 8;
      const top = Math.max(0, y1 - 17);
      context.fillStyle = color;
      context.fillRect(x1, top, width, 16);
      context.fillStyle = "#ffffff";
      context.fillText(label, x1 + 4, top + 11);
    }
    context.restore();
  }

  function drawCuboid(context, transform, corners, color, selected) {
    const projected = corners.map((point) => transformPoint(point, transform));
    context.save();
    context.strokeStyle = color;
    context.lineWidth = selected ? 2.6 : 1.4;
    context.globalAlpha = selected ? 1 : 0.72;
    CUBOID_EDGES.forEach(([start, end]) => {
      context.beginPath();
      context.moveTo(projected[start][0], projected[start][1]);
      context.lineTo(projected[end][0], projected[end][1]);
      context.stroke();
    });
    context.restore();
  }

  function transformPoint(point, transform) {
    return [
      transform.offsetX + Number(point[0]) * transform.scale,
      transform.offsetY + Number(point[1]) * transform.scale,
    ];
  }

  function nearestFrameIndex(frames, time) {
    let best = 0;
    let distance = Infinity;
    frames.forEach((frame, index) => {
      const candidate = Math.abs(Number(frame.timestamp_sec || 0) - time);
      if (candidate < distance) {
        distance = candidate;
        best = index;
      }
    });
    return best;
  }

  function validBbox(value) {
    return Array.isArray(value) && value.length === 4 &&
      value.every((item) => Number.isFinite(Number(item))) &&
      Number(value[2]) > Number(value[0]) && Number(value[3]) > Number(value[1]);
  }

  function validPoint(value) {
    return Array.isArray(value) && value.length >= 2 &&
      Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]));
  }

  function pointInsideBbox(point, bbox) {
    return point[0] >= bbox[0] && point[0] <= bbox[2] &&
      point[1] >= bbox[1] && point[1] <= bbox[3];
  }

  function loadTintedMask(url, color) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        const rgb = hexToRgb(color);
        for (let index = 0; index < pixels.data.length; index += 4) {
          const alpha = pixels.data[index];
          pixels.data[index] = rgb[0];
          pixels.data[index + 1] = rgb[1];
          pixels.data[index + 2] = rgb[2];
          pixels.data[index + 3] = alpha;
        }
        context.putImageData(pixels, 0, 0);
        resolve(canvas);
      };
      image.onerror = reject;
      image.src = url;
    });
  }

  function hexToRgb(value) {
    const raw = value.replace("#", "");
    return [
      parseInt(raw.slice(0, 2), 16),
      parseInt(raw.slice(2, 4), 16),
      parseInt(raw.slice(4, 6), 16),
    ];
  }

  function formatTime(seconds) {
    const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    const minutes = Math.floor(safe / 60);
    const remainder = safe - minutes * 60;
    return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(2).padStart(5, "0")}`;
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

  window.CanonicalViewer = CanonicalViewer;
})();

const PALETTE = ["#2962ff", "#00a58e", "#f14f64", "#ffb000", "#7d4ae8", "#00a7d6"];
const CUBOID_EDGES = [
  [0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3],
  [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7],
];

main().catch((error) => {
  console.error(error);
  document.body.innerHTML = `<main class="error"><h1>Viewer error</h1><pre>${escapeHtml(
    error instanceof Error ? error.message : String(error),
  )}</pre></main>`;
});

async function main() {
  if (document.body.dataset.view === "index") {
    await loadIndex();
    return;
  }
  await loadExample();
}

async function loadIndex() {
  const manifest = await fetchJson("data/manifest.json");
  requiredElement("#count").textContent =
    `${manifest.displayed_count} shown / ${manifest.total_code_count} codes`;
  requiredElement("#gallery").innerHTML = manifest.examples
    .map(
      (example) => `
        <a class="card" href="example.html?code=${encodeURIComponent(example.code_id)}">
          <span class="mode">${escapeHtml(formatMode(example.parse_mode))}</span>
          <h3>${escapeHtml(example.display_title || example.study)}</h3>
          <p>${escapeHtml(example.display_summary || example.sample_id)}</p>
          <p>${example.object_count} objects | confidence ${formatPercent(example.confidence)}</p>
        </a>`,
    )
    .join("");
}

async function loadExample() {
  const codeId = new URLSearchParams(window.location.search).get("code");
  const manifest = await fetchJson("data/manifest.json");
  const manifestRow = manifest.examples.find((item) => item.code_id === codeId);
  if (!manifestRow) {
    throw new Error(`Unknown code ID: ${codeId}`);
  }
  const data = await fetchJson(manifestRow.data);
  if (!Array.isArray(data.objects)) {
    throw new Error("The selected code has an invalid object collection");
  }

  const video = requiredElement("#video");
  const gif = requiredElement("#gif");
  const mediaShell = requiredElement(".media-shell");
  const canvas = requiredElement("#overlay");
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas 2D rendering is unavailable");
  }
  const timeline = requiredElement("#timeline");
  const playButton = requiredElement("#play");
  const observationTab = requiredElement("#observation-tab");
  const reconstructionTab = requiredElement("#reconstruction-tab");
  const observationView = requiredElement("#observation-view");
  const reconstructionView = requiredElement("#reconstruction-view");
  const timestamps = data.timebase.timestamps_sec;
  const lastFrame = data.timebase.frame_count - 1;
  const hasReconstruction =
    data.geometry.reconstruction?.availability?.status === "available" &&
    data.objects.some((object) => object.reconstruction_points_world?.length);
  const state = {
    frame: 0,
    objectId: data.objects[0]?.object_id || null,
    view: "observation",
    reconstructionMode: "prediction",
    upperBound: null,
    gifPlaying: manifestRow.media_kind === "gif",
    gifElapsedSec: 0,
    gifEpochMs: window.performance.now(),
    gifAnimationHandle: null,
    reconstruction: null,
    pendingSeekFrame: null,
  };

  requiredElement("#identity").textContent = manifestRow.display_title
    ? `${data.study} / ${manifestRow.display_title}`
    : `${data.study} / ${data.sample_id}`;
  timeline.max = String(lastFrame);
  requiredElement("#objects").innerHTML = data.objects
    .map(
      (object) =>
        `<button data-object="${escapeHtml(object.object_id)}">${escapeHtml(
          `${object.label} | ${object.object_id}`,
        )}</button>`,
    )
    .join("");
  reconstructionTab.disabled = !hasReconstruction;
  const templateButton = requiredElement('[data-reconstruction-mode="template"]');
  templateButton.disabled = !manifestRow.upper_bound_data;

  if (manifestRow.media_kind === "gif" || manifestRow.media_kind === "image") {
    gif.src = manifestRow.media;
    gif.style.display = "block";
    video.style.display = "none";
    gif.addEventListener("load", resizeObservation);
    if (manifestRow.media_kind === "image") {
      playButton.disabled = true;
      timeline.disabled = true;
    }
  } else {
    video.style.display = "block";
    gif.style.display = "none";
    video.defaultMuted = true;
    video.defaultPlaybackRate = 0.5;
    video.muted = true;
    video.playbackRate = 0.5;
    video.addEventListener("loadedmetadata", () => {
      video.playbackRate = 0.5;
      resizeObservation();
    });
    video.addEventListener("loadeddata", resizeObservation);
    video.addEventListener("timeupdate", syncFrameFromVideo);
    video.addEventListener("seeked", completeVideoSeek);
    video.addEventListener("ended", () => {
      state.frame = lastFrame;
      timeline.value = String(lastFrame);
      render();
    });
    await loadSeekableVideo(video, manifestRow.media);
  }

  requiredElement("#objects").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-object]");
    if (!button) {
      return;
    }
    selectObject(button.dataset.object);
  });
  timeline.addEventListener("input", () => {
    state.frame = Number(timeline.value);
    state.pendingSeekFrame = state.frame;
    seekMedia();
    render();
  });
  playButton.addEventListener("click", () => void togglePlayback());
  observationTab.addEventListener("click", () => setView("observation"));
  reconstructionTab.addEventListener("click", () => void setView("reconstruction"));
  requiredElement("#reconstruction-modes").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-reconstruction-mode]");
    if (!button || button.disabled) {
      return;
    }
    void setReconstructionMode(button.dataset.reconstructionMode);
  });
  window.addEventListener("resize", () => {
    resizeObservation();
    state.reconstruction?.resize();
  });

  resizeObservation();
  render();
  if (manifestRow.media_kind === "gif") {
    state.gifAnimationHandle = window.requestAnimationFrame(syncFrameFromGif);
  }

  function selectObject(objectId) {
    if (!data.objects.some((object) => object.object_id === objectId)) {
      throw new Error(`Unknown object selection: ${objectId}`);
    }
    state.objectId = objectId;
    state.reconstruction?.selectObject(objectId);
    render();
  }

  async function setView(view) {
    if (view === "reconstruction" && !hasReconstruction) {
      return;
    }
    state.view = view;
    observationView.hidden = view !== "observation";
    reconstructionView.hidden = view !== "reconstruction";
    observationTab.setAttribute("aria-selected", String(view === "observation"));
    reconstructionTab.setAttribute("aria-selected", String(view === "reconstruction"));
    if (view === "reconstruction") {
      if (!state.reconstruction) {
        state.reconstruction = await createReconstructionViewer(
          requiredElement("#reconstruction-canvas"),
          data,
          selectObject,
        );
      }
      state.reconstruction.setData("prediction", null);
      state.reconstruction.selectObject(state.objectId);
      state.reconstruction.resize();
    }
    renderCode(data, state);
  }

  async function setReconstructionMode(mode) {
    if (mode !== "prediction" && mode !== "template") {
      throw new Error(`Unknown reconstruction mode: ${mode}`);
    }
    if (mode === "template" && !state.upperBound) {
      state.upperBound = await fetchJson(manifestRow.upper_bound_data);
      if (
        state.upperBound.mode !== "template_assisted_upper_bound" ||
        state.upperBound.code_id !== data.code_id
      ) {
        throw new Error("Template upper bound does not match this prediction");
      }
    }
    state.reconstructionMode = mode;
    document.querySelectorAll("button[data-reconstruction-mode]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.reconstructionMode === mode));
    });
    state.reconstruction.setData(mode, state.upperBound);
    state.reconstruction.selectObject(state.objectId);
    renderCode(data, state);
  }

  async function togglePlayback() {
    if (manifestRow.media_kind === "image") {
      return;
    }
    if (manifestRow.media_kind === "gif") {
      state.gifPlaying = !state.gifPlaying;
      if (state.gifPlaying) {
        state.gifEpochMs = window.performance.now();
        state.gifAnimationHandle = window.requestAnimationFrame(syncFrameFromGif);
      } else if (state.gifAnimationHandle !== null) {
        window.cancelAnimationFrame(state.gifAnimationHandle);
        state.gifAnimationHandle = null;
      }
      return;
    }
    if (!video.paused) {
      video.pause();
      return;
    }
    await video.play();
  }

  function syncFrameFromVideo() {
    if (state.pendingSeekFrame !== null) {
      return;
    }
    const nextFrame = nearestFrame(timestamps, video.currentTime);
    if (nextFrame === state.frame) {
      return;
    }
    state.frame = nextFrame;
    timeline.value = String(nextFrame);
    render();
  }

  function completeVideoSeek() {
    if (state.pendingSeekFrame === null) {
      syncFrameFromVideo();
      return;
    }
    state.frame = state.pendingSeekFrame;
    state.pendingSeekFrame = null;
    timeline.value = String(state.frame);
    render();
  }

  function syncFrameFromGif(nowMs) {
    if (!state.gifPlaying) {
      return;
    }
    const duration = timelineDuration(timestamps);
    const elapsed = state.gifElapsedSec + (nowMs - state.gifEpochMs) / 1000;
    const mediaTime = duration > 0 ? elapsed % duration : 0;
    const nextFrame = nearestFrame(timestamps, mediaTime);
    if (nextFrame !== state.frame) {
      state.frame = nextFrame;
      timeline.value = String(nextFrame);
      render();
    }
    state.gifAnimationHandle = window.requestAnimationFrame(syncFrameFromGif);
  }

  function seekMedia() {
    const time = timestamps[state.frame] || 0;
    if (manifestRow.media_kind === "image") {
      return;
    }
    if (manifestRow.media_kind === "gif") {
      state.gifElapsedSec = time;
      state.gifEpochMs = window.performance.now();
      return;
    }
    video.currentTime = time;
  }

  function resizeObservation() {
    const sourceSize = data.timebase.source_size;
    const width = video.videoWidth || gif.naturalWidth || sourceSize[0];
    const height = video.videoHeight || gif.naturalHeight || sourceSize[1];
    mediaShell.style.aspectRatio = `${width} / ${height}`;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    render();
  }

  function render() {
    drawOverlay(context, canvas, data, state);
    renderCode(data, state);
    document.querySelectorAll("button[data-object]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.object === state.objectId));
    });
    requiredElement("#frame-label").textContent =
      `Frame ${state.frame + 1}/${data.timebase.frame_count}`;
  }
}

function drawOverlay(context, canvas, data, state) {
  context.clearRect(0, 0, canvas.width, canvas.height);
  const scaleX = canvas.width / data.timebase.source_size[0];
  const scaleY = canvas.height / data.timebase.source_size[1];
  data.objects.forEach((object, objectIndex) => {
    const color = PALETTE[objectIndex % PALETTE.length];
    const active = object.object_id === state.objectId;
    const mask = object.masks?.[state.frame];
    if (mask) {
      drawMaskRuns(context, mask, scaleX, scaleY, color, active);
    }
  });
  drawProjectedCuboids(context, data, state, scaleX, scaleY);
}

function drawProjectedCuboids(context, data, state, scaleX, scaleY) {
  const camera = data.geometry.camera?.[state.frame];
  if (!camera?.intrinsics || !camera?.camera_from_world) {
    return;
  }
  const ordered = [...data.objects].sort(
    (left, right) =>
      Number(left.object_id === state.objectId) - Number(right.object_id === state.objectId),
  );
  ordered.forEach((object) => {
    const cuboid = object.computed.bbox_3d?.find(
      (item) => item.frame_offset === state.frame,
    );
    if (!cuboid || !Array.isArray(cuboid.corners_world) || cuboid.corners_world.length !== 8) {
      return;
    }
    const projected = cuboid.corners_world.map((point) => projectWorldPoint(point, camera));
    if (projected.some((point) => point === null)) {
      return;
    }
    const active = object.object_id === state.objectId;
    const objectIndex = data.objects.findIndex((item) => item.object_id === object.object_id);
    context.save();
    context.strokeStyle = hexAlpha(
      PALETTE[objectIndex % PALETTE.length],
      active ? 0.98 : 0.38,
    );
    context.lineWidth = active ? 2.2 : 0.9;
    context.setLineDash(active ? [] : [3, 2]);
    context.beginPath();
    for (const [start, end] of CUBOID_EDGES) {
      const left = projected[start];
      const right = projected[end];
      context.moveTo(left[0] * scaleX, left[1] * scaleY);
      context.lineTo(right[0] * scaleX, right[1] * scaleY);
    }
    context.stroke();
    context.restore();
  });
}

function projectWorldPoint(point, camera) {
  if (!Array.isArray(point) || point.length !== 3) {
    return null;
  }
  const extrinsics = camera.camera_from_world;
  const intrinsics = camera.intrinsics;
  const cameraPoint = [0, 1, 2].map(
    (row) =>
      extrinsics[row][0] * point[0] +
      extrinsics[row][1] * point[1] +
      extrinsics[row][2] * point[2] +
      extrinsics[row][3],
  );
  if (!cameraPoint.every(Number.isFinite) || cameraPoint[2] <= 1e-8) {
    return null;
  }
  const homogeneous = [0, 1, 2].map(
    (row) =>
      intrinsics[row][0] * cameraPoint[0] +
      intrinsics[row][1] * cameraPoint[1] +
      intrinsics[row][2] * cameraPoint[2],
  );
  if (!homogeneous.every(Number.isFinite) || Math.abs(homogeneous[2]) <= 1e-8) {
    return null;
  }
  return [homogeneous[0] / homogeneous[2], homogeneous[1] / homogeneous[2]];
}

function drawMaskRuns(context, mask, scaleX, scaleY, color, active) {
  const width = mask.shape[1];
  context.fillStyle = hexAlpha(color, active ? 0.25 : 0.12);
  for (const [runStart, runLength] of mask.runs) {
    let start = runStart;
    let remaining = runLength;
    while (remaining > 0) {
      const x = start % width;
      const y = Math.floor(start / width);
      const rowLength = Math.min(remaining, width - x);
      context.fillRect(x * scaleX, y * scaleY, rowLength * scaleX, Math.ceil(scaleY));
      start += rowLength;
      remaining -= rowLength;
    }
  }
}

async function createReconstructionViewer(container, data, onSelect) {
  const THREE = await import("./three.module.min.js");
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0c111a);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.001, 1000);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.replaceChildren(renderer.domElement);
  const content = new THREE.Group();
  scene.add(content);
  const raycaster = new THREE.Raycaster();
  raycaster.params.Points.threshold = 0.02;
  raycaster.params.Line.threshold = 0.015;
  const selectable = [];
  let selectedObjectId = data.objects[0].object_id;
  let center = new THREE.Vector3();
  let radius = 1;
  let yaw = 0.8;
  let pitch = 0.45;
  let dragging = false;
  let pointerMoved = false;
  let previousX = 0;
  let previousY = 0;

  renderer.domElement.addEventListener("pointerdown", (event) => {
    dragging = true;
    pointerMoved = false;
    previousX = event.clientX;
    previousY = event.clientY;
    renderer.domElement.setPointerCapture(event.pointerId);
  });
  renderer.domElement.addEventListener("pointermove", (event) => {
    if (!dragging) {
      return;
    }
    pointerMoved ||=
      Math.abs(event.clientX - previousX) > 2 || Math.abs(event.clientY - previousY) > 2;
    yaw -= (event.clientX - previousX) * 0.008;
    pitch = Math.max(-1.35, Math.min(1.35, pitch + (event.clientY - previousY) * 0.008));
    previousX = event.clientX;
    previousY = event.clientY;
    updateCamera();
  });
  renderer.domElement.addEventListener("pointerup", (event) => {
    dragging = false;
    renderer.domElement.releasePointerCapture(event.pointerId);
  });
  renderer.domElement.addEventListener("wheel", (event) => {
    event.preventDefault();
    radius *= Math.exp(event.deltaY * 0.001);
    radius = Math.max(0.02, Math.min(100, radius));
    updateCamera();
  }, { passive: false });
  renderer.domElement.addEventListener("click", (event) => {
    if (pointerMoved) {
      return;
    }
    const bounds = renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(selectable, false)[0];
    if (hit?.object?.userData?.objectId) {
      onSelect(hit.object.userData.objectId);
    }
  });

  function setData(mode, upperBound) {
    clearContent();
    if (mode === "prediction") {
      data.objects.forEach((object, index) => {
        addPredictionObject(object, PALETTE[index % PALETTE.length]);
      });
    } else {
      if (!upperBound || upperBound.mode !== "template_assisted_upper_bound") {
        throw new Error("Template-assisted reconstruction is unavailable");
      }
      upperBound.template_cuboids_prediction_world.forEach((cuboid, index) => {
        addCuboid(
          cuboid.predicted_object_id,
          cuboid.corners_world,
          PALETTE[index % PALETTE.length],
          cuboid.center,
          cuboid.size,
          cuboid.rotation,
          "template",
        );
      });
    }
    fitCamera();
    selectObject(selectedObjectId);
  }

  function addPredictionObject(object, color) {
    const points = object.reconstruction_points_world;
    if (points?.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(points.flat(), 3));
      const material = new THREE.PointsMaterial({
        color,
        size: 0.006,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.78,
      });
      const cloud = new THREE.Points(geometry, material);
      cloud.userData = { objectId: object.object_id, kind: "points", baseColor: color };
      content.add(cloud);
      selectable.push(cloud);
    }
    const cuboid = object.computed.bbox_3d?.[0];
    if (cuboid) {
      addCuboid(
        object.object_id,
        cuboid.corners_world,
        color,
        cuboid.center,
        cuboid.size,
        cuboid.rotation,
        "prediction",
      );
    }
  }

  function addCuboid(objectId, corners, color, boxCenter, size, rotation, kind) {
    const positions = [];
    for (const [left, right] of CUBOID_EDGES) {
      positions.push(...corners[left], ...corners[right]);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: kind === "template" ? 0.9 : 0.45,
    });
    const wire = new THREE.LineSegments(geometry, material);
    wire.userData = { objectId, kind: "wire", baseColor: color };
    content.add(wire);
    selectable.push(wire);

    const hitGeometry = new THREE.BoxGeometry(...size);
    const hitMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 });
    hitMaterial.depthWrite = false;
    const hitBox = new THREE.Mesh(hitGeometry, hitMaterial);
    hitBox.position.fromArray(boxCenter);
    const matrix = new THREE.Matrix4();
    matrix.set(
      rotation[0][0], rotation[0][1], rotation[0][2], 0,
      rotation[1][0], rotation[1][1], rotation[1][2], 0,
      rotation[2][0], rotation[2][1], rotation[2][2], 0,
      0, 0, 0, 1,
    );
    hitBox.quaternion.setFromRotationMatrix(matrix);
    hitBox.userData = { objectId, kind: "hit" };
    content.add(hitBox);
    selectable.push(hitBox);
  }

  function selectObject(objectId) {
    selectedObjectId = objectId;
    content.children.forEach((item) => {
      const active = item.userData.objectId === objectId;
      if (item.userData.kind === "points") {
        item.material.opacity = active ? 1 : 0.24;
        item.material.size = active ? 0.009 : 0.005;
      } else if (item.userData.kind === "wire") {
        item.material.opacity = active ? 1 : 0.16;
      }
    });
  }

  function clearContent() {
    selectable.length = 0;
    while (content.children.length) {
      const item = content.children[content.children.length - 1];
      content.remove(item);
      item.geometry?.dispose();
      item.material?.dispose();
    }
  }

  function fitCamera() {
    const bounds = new THREE.Box3().setFromObject(content);
    if (bounds.isEmpty()) {
      throw new Error("3D reconstruction contains no finite geometry");
    }
    bounds.getCenter(center);
    const size = bounds.getSize(new THREE.Vector3());
    const boundingRadius = 0.5 * size.length();
    const halfVerticalFov = THREE.MathUtils.degToRad(camera.fov * 0.5);
    radius = Math.max((boundingRadius / Math.sin(halfVerticalFov)) * 1.15, 0.05);
    yaw = 0.8;
    pitch = 0.45;
    camera.near = Math.max(radius / 1000, 0.0001);
    camera.far = Math.max(radius * 20, 10);
    camera.updateProjectionMatrix();
    updateCamera();
  }

  function updateCamera() {
    const horizontal = radius * Math.cos(pitch);
    camera.position.set(
      center.x + horizontal * Math.sin(yaw),
      center.y + radius * Math.sin(pitch),
      center.z + horizontal * Math.cos(yaw),
    );
    camera.lookAt(center);
  }

  function resize() {
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function animate() {
    renderer.render(scene, camera);
    window.requestAnimationFrame(animate);
  }

  setData("prediction", null);
  resize();
  animate();
  return { setData, selectObject, resize };
}

function renderCode(data, state) {
  const objects = {};
  for (const object of data.objects) {
    const selected = object.object_id === state.objectId;
    const bbox2d = object.bbox_2d.find((item) => item.frame_offset === state.frame) || null;
    const depth = object.mask_depth?.[state.frame] || null;
    objects[object.object_id] = {
      selected,
      label: object.label,
      role: object.role,
      visible: Boolean(object.masks?.[state.frame] || bbox2d),
      mask_depth:
        depth === null
          ? null
          : {
              valid_point_count: depth.valid_point_count,
              depth_range: depth.depth_range,
              depth_minmax: depth.depth_minmax,
              world_bounds: depth.world_bounds,
              source: depth.source,
              units: depth.units,
            },
      bbox_2d: bbox2d,
      center_2d:
        object.computed.center_2d?.find((item) => item.frame_offset === state.frame) || null,
      center_3d:
        object.computed.center_3d?.find((item) => item.frame_offset === state.frame) || null,
      bbox_3d:
        object.computed.bbox_3d?.find((item) => item.frame_offset === state.frame) || null,
      fused_point_count: object.computed.fused_point_count,
    };
  }
  const slice = {
    code_id: data.code_id,
    parse_mode: data.parse_mode,
    visualization_mode:
      state.view === "observation" ? "prediction_mask_bbox3d" : state.reconstructionMode,
    frame_offset: state.frame,
    timestamp_sec: data.timebase.timestamps_sec[state.frame],
    selected_object: state.objectId,
    objects,
    reconstruction: data.geometry.reconstruction,
    template_assisted_upper_bound:
      state.reconstructionMode === "template" && state.upperBound
        ? {
            label: state.upperBound.label,
            metrics: state.upperBound.metrics,
            alignment: state.upperBound.alignment,
          }
        : null,
    relations: data.relations.filter(
      (item) => item.start_frame_offset <= state.frame && item.end_frame_offset >= state.frame,
    ),
    events: data.events.filter(
      (item) => item.start_frame_offset <= state.frame && item.end_frame_offset >= state.frame,
    ),
    camera: data.geometry.camera[state.frame] || { availability: data.geometry.availability },
    learned_fields: data.learned_fields,
  };
  requiredElement("#code").textContent = JSON.stringify(slice, null, 2);
  requiredElement("#metric-time").textContent = `${slice.timestamp_sec.toFixed(3)} s`;
  requiredElement("#metric-object").textContent = state.objectId || "all";
  requiredElement("#metric-confidence").textContent = formatPercent(data.code_confidence.value);
}

function nearestFrame(timestamps, value) {
  let best = 0;
  for (let index = 1; index < timestamps.length; index += 1) {
    if (Math.abs(timestamps[index] - value) < Math.abs(timestamps[best] - value)) {
      best = index;
    }
  }
  return best;
}

function timelineDuration(timestamps) {
  if (timestamps.length < 2) {
    return 1;
  }
  const finalStep = timestamps[timestamps.length - 1] - timestamps[timestamps.length - 2];
  return Math.max(timestamps[timestamps.length - 1] + finalStep, finalStep);
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Failed to load ${path}: HTTP ${response.status}`);
  }
  return response.json();
}

async function loadSeekableVideo(video, path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Failed to load ${path}: HTTP ${response.status}`);
  }
  const objectUrl = URL.createObjectURL(await response.blob());
  video.src = objectUrl;
  window.addEventListener("pagehide", () => URL.revokeObjectURL(objectUrl), { once: true });
}

function requiredElement(selector) {
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error(`Viewer element is missing: ${selector}`);
  }
  return element;
}

function formatMode(value) {
  return String(value).replaceAll("_", " ").toUpperCase();
}

function formatPercent(value) {
  return `${(100 * Number(value)).toFixed(1)}%`;
}

function hexAlpha(hex, alpha) {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${value >> 16}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
}

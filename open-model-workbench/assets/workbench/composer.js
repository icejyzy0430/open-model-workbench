import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";

const config = window.MODEL_WORKBENCH_CONFIG;
if (!config?.models?.length) throw new Error("Composer configuration is missing models");

document.documentElement.lang = config.language || "zh-CN";
document.title = config.pageTitle || "Model Composition Stage";
window.lucide?.createIcons();

const dom = {
  canvas: document.querySelector("#stageCanvas"),
  stage: document.querySelector("#stage"),
  safeFrame: document.querySelector("#safeFrame"),
  modeStatus: document.querySelector("#modeStatus"),
  selectionStatus: document.querySelector("#selectionStatus"),
  translateMode: document.querySelector("#translateMode"),
  rotateMode: document.querySelector("#rotateMode"),
  objectList: document.querySelector("#objectList"),
  modelCount: document.querySelector("#modelCount"),
  selectedId: document.querySelector("#selectedId"),
  loadingValue: document.querySelector("#loadingValue"),
  errorState: document.querySelector("#errorState"),
  errorMessage: document.querySelector("#errorMessage"),
  retry: document.querySelector("#retry"),
  position: [document.querySelector("#positionX"), document.querySelector("#positionY"), document.querySelector("#positionZ")],
  rotation: [document.querySelector("#rotationX"), document.querySelector("#rotationY"), document.querySelector("#rotationZ")],
  scaleControl: document.querySelector("#scaleControl"),
  scaleValue: document.querySelector("#scaleValue"),
  centerPosition: document.querySelector("#centerPosition"),
  resetRotation: document.querySelector("#resetRotation"),
  backgroundSwatches: document.querySelector("#backgroundSwatches"),
  gridToggle: document.querySelector("#gridToggle"),
  safeFrameToggle: document.querySelector("#safeFrameToggle"),
  capture: document.querySelector("#capture"),
  exportLayout: document.querySelector("#exportLayout"),
  captureDialog: document.querySelector("#captureDialog"),
  capturePreview: document.querySelector("#capturePreview"),
  captureSize: document.querySelector("#captureSize"),
  downloadCapture: document.querySelector("#downloadCapture"),
  closeCapture: document.querySelector("#closeCapture"),
};

const renderer = new THREE.WebGLRenderer({ canvas: dom.canvas, antialias: true, preserveDrawingBuffer: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));

const scene = new THREE.Scene();
let stageColor = config.background;
scene.background = new THREE.Color(stageColor);
const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 100);
camera.position.set(0, 0.4, 7.2);
camera.lookAt(0, 0, 0);

scene.add(new THREE.HemisphereLight(0xf6fbf7, 0x202823, 2.15));
const keyLight = new THREE.DirectionalLight(0xffffff, 3.1);
keyLight.position.set(3.5, 5.2, 5.5);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0x56e7e9, 1.8);
rimLight.position.set(-4, 2.5, -2.5);
scene.add(rimLight);

const grid = new THREE.GridHelper(18, 36, 0x48504b, 0x2a302c);
grid.position.y = -1.75;
grid.material.transparent = true;
grid.material.opacity = 0.55;
scene.add(grid);
grid.visible = config.grid;
dom.gridToggle.checked = config.grid;
dom.safeFrame.hidden = !config.safeFrame;
dom.safeFrameToggle.checked = config.safeFrame;

const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath("./vendor/draco/");
loader.setDRACOLoader(draco);

const transform = new TransformControls(camera, dom.canvas);
transform.setMode("rotate");
transform.setSpace("local");
transform.setSize(0.82);
const transformHelper = transform.getHelper();
scene.add(transformHelper);
transformHelper.visible = false;

const selectionBounds = new THREE.Box3();
const selectionHelper = new THREE.Box3Helper(selectionBounds, 0x53e6e9);
selectionHelper.material.transparent = true;
selectionHelper.material.opacity = 0.82;
scene.add(selectionHelper);
selectionHelper.visible = false;

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const dragPlane = new THREE.Plane();
const dragPoint = new THREE.Vector3();
const dragOffset = new THREE.Vector3();
const cameraDirection = new THREE.Vector3();
const entries = [];
let selected = null;
let mode = "translate";
let translating = false;
let captureUrl = "";
const storageKey = `model-workbench:${config.pageTitle}`;

function radians(degrees) { return THREE.MathUtils.degToRad(degrees); }
function degrees(radiansValue) { return THREE.MathUtils.radToDeg(radiansValue); }
function modelUrl(path) { return `./assets/models/${path.split("/").map(encodeURIComponent).join("/")}`; }
function updatePointer(event) {
  const rect = dom.canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function normalizeModel(modelScene, root) {
  const bounds = new THREE.Box3().setFromObject(modelScene);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z) || 1;
  const normalizedScale = 3.25 / longest;
  modelScene.position.sub(center);
  modelScene.scale.setScalar(normalizedScale);
  root.userData.normalizedScale = normalizedScale;
}

function applySavedState(entry, saved) {
  if (!saved) return;
  if (Array.isArray(saved.position) && saved.position.length === 3) entry.root.position.fromArray(saved.position);
  if (Array.isArray(saved.rotation) && saved.rotation.length === 3) entry.root.rotation.set(...saved.rotation.map(radians));
  if (Number.isFinite(saved.scale)) entry.root.scale.setScalar(THREE.MathUtils.clamp(saved.scale, 0.25, 2.5));
}

function savedState() {
  try {
    if (new URLSearchParams(location.search).has("reset")) localStorage.removeItem(storageKey);
    return JSON.parse(localStorage.getItem(storageKey) || "null");
  } catch { return null; }
}

function serializeLayout() {
  return {
    version: 1,
    background: stageColor,
    models: entries.map((entry) => ({
      id: entry.config.id,
      label: entry.config.label,
      model: entry.config.model,
      position: entry.root.position.toArray().map((value) => Number(value.toFixed(4))),
      rotation: [degrees(entry.root.rotation.x), degrees(entry.root.rotation.y), degrees(entry.root.rotation.z)].map((value) => Number(value.toFixed(3))),
      scale: Number(entry.root.scale.x.toFixed(4)),
    })),
  };
}

function persistLayout() {
  try { localStorage.setItem(storageKey, JSON.stringify(serializeLayout())); } catch {}
}

function downloadText(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderObjectList() {
  const buttons = entries.map((entry, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "object-button";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(entry === selected));
    button.dataset.id = entry.config.id;
    const number = document.createElement("span");
    number.className = "object-index";
    number.textContent = String(index + 1).padStart(2, "0");
    const label = document.createElement("span");
    label.className = "object-name";
    label.textContent = entry.config.label;
    const state = document.createElement("i");
    state.className = "object-state";
    button.append(number, label, state);
    button.addEventListener("click", () => selectEntry(entry));
    return button;
  });
  dom.objectList.replaceChildren(...buttons);
  dom.modelCount.textContent = String(entries.length).padStart(2, "0");
}

function syncInspector() {
  const disabled = !selected;
  [...dom.position, ...dom.rotation, dom.scaleControl].forEach((input) => { input.disabled = disabled; });
  if (!selected) return;
  dom.position.forEach((input, index) => { input.value = selected.root.position.getComponent(index).toFixed(2); });
  dom.rotation[0].value = degrees(selected.root.rotation.x).toFixed(1);
  dom.rotation[1].value = degrees(selected.root.rotation.y).toFixed(1);
  dom.rotation[2].value = degrees(selected.root.rotation.z).toFixed(1);
  dom.scaleControl.value = selected.root.scale.x.toFixed(2);
  dom.scaleValue.value = selected.root.scale.x.toFixed(2);
  dom.selectedId.textContent = selected.config.id.toUpperCase();
  const index = entries.indexOf(selected);
  dom.selectionStatus.textContent = `MODEL ${String(index + 1).padStart(2, "0")} / ${String(entries.length).padStart(2, "0")}`;
}

function selectEntry(entry) {
  selected = entry;
  if (mode === "rotate") {
    transform.attach(entry.root);
    transformHelper.visible = true;
  } else {
    transform.detach();
    transformHelper.visible = false;
  }
  selectionHelper.visible = mode === "translate";
  renderObjectList();
  syncInspector();
}

function setMode(nextMode) {
  mode = nextMode;
  document.body.dataset.mode = mode;
  dom.translateMode.classList.toggle("is-active", mode === "translate");
  dom.rotateMode.classList.toggle("is-active", mode === "rotate");
  dom.translateMode.setAttribute("aria-pressed", String(mode === "translate"));
  dom.rotateMode.setAttribute("aria-pressed", String(mode === "rotate"));
  dom.modeStatus.textContent = mode === "translate" ? "TRANSLATE / SCREEN" : "ROTATE / LOCAL";
  if (selected && mode === "rotate") {
    transform.attach(selected.root);
    transformHelper.visible = true;
  } else {
    transform.detach();
    transformHelper.visible = false;
  }
  selectionHelper.visible = Boolean(selected && mode === "translate");
}

function entryFromIntersection(object) {
  let current = object;
  while (current && !current.userData.composerEntry) current = current.parent;
  return current?.userData.composerEntry || null;
}

function intersections(event) {
  updatePointer(event);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObjects(entries.map((entry) => entry.root), true);
}

function pointerDown(event) {
  if (event.button !== 0 || event.target !== dom.canvas) return;
  if (mode === "rotate" && transform.axis) return;
  const hit = intersections(event)[0];
  if (!hit) return;
  const entry = entryFromIntersection(hit.object);
  if (!entry) return;
  selectEntry(entry);
  if (mode !== "translate") return;
  camera.getWorldDirection(cameraDirection);
  dragPlane.setFromNormalAndCoplanarPoint(cameraDirection, selected.root.position);
  raycaster.ray.intersectPlane(dragPlane, dragPoint);
  dragOffset.copy(selected.root.position).sub(dragPoint);
  translating = true;
  document.body.classList.add("is-dragging");
  dom.canvas.setPointerCapture(event.pointerId);
}

function pointerMove(event) {
  if (!translating || !selected) return;
  updatePointer(event);
  raycaster.setFromCamera(pointer, camera);
  if (raycaster.ray.intersectPlane(dragPlane, dragPoint)) {
    selected.root.position.copy(dragPoint).add(dragOffset);
    syncInspector();
  }
}

function pointerUp(event) {
  if (!translating) return;
  translating = false;
  document.body.classList.remove("is-dragging");
  if (dom.canvas.hasPointerCapture(event.pointerId)) dom.canvas.releasePointerCapture(event.pointerId);
  persistLayout();
}

function centerSelected() {
  if (!selected) return;
  selected.root.position.set(0, 0, 0);
  syncInspector();
  persistLayout();
}

function resetSelectedRotation() {
  if (!selected) return;
  selected.root.quaternion.copy(selected.initialQuaternion);
  syncInspector();
  persistLayout();
}

function setBackground(color) {
  stageColor = color.toUpperCase();
  scene.background.set(stageColor);
  dom.backgroundSwatches.querySelectorAll("button").forEach((button) => button.classList.toggle("is-active", button.dataset.color === stageColor));
  persistLayout();
}

function resize() {
  const width = Math.max(1, dom.stage.clientWidth);
  const height = Math.max(1, dom.stage.clientHeight);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
}

async function captureComposition() {
  const width = config.capture.width;
  const height = config.capture.height;
  const previousPixelRatio = renderer.getPixelRatio();
  const previousBackground = scene.background.clone();
  const previousGrid = grid.visible;
  const previousGizmo = transformHelper.visible;
  const previousSelection = selectionHelper.visible;
  const previousAspect = camera.aspect;
  grid.visible = false;
  transformHelper.visible = false;
  selectionHelper.visible = false;
  scene.background.set(stageColor);
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  const dataUrl = renderer.domElement.toDataURL("image/png");
  renderer.setPixelRatio(previousPixelRatio);
  renderer.setSize(dom.stage.clientWidth, dom.stage.clientHeight, false);
  camera.aspect = previousAspect;
  camera.updateProjectionMatrix();
  scene.background.copy(previousBackground);
  grid.visible = previousGrid;
  transformHelper.visible = previousGizmo;
  selectionHelper.visible = previousSelection;
  captureUrl = dataUrl;
  dom.capturePreview.src = dataUrl;
  dom.captureSize.textContent = `${width} × ${height}`;
  dom.downloadCapture.href = dataUrl;
  dom.downloadCapture.download = `model-composition-${Date.now()}.png`;
  dom.captureDialog.showModal();
}

async function loadEntry(modelConfig, saved) {
  const gltf = await loader.loadAsync(modelUrl(modelConfig.model), (event) => {
    if (event.total) dom.loadingValue.textContent = String(Math.round((event.loaded / event.total) * 100)).padStart(2, "0");
  });
  const root = new THREE.Group();
  root.name = modelConfig.id;
  const modelScene = gltf.scene;
  normalizeModel(modelScene, root);
  root.add(modelScene);
  root.position.fromArray(modelConfig.position);
  root.rotation.set(...modelConfig.rotation.map(radians));
  root.scale.setScalar(modelConfig.scale);
  const entry = { config: modelConfig, root, initialQuaternion: root.quaternion.clone() };
  root.userData.composerEntry = entry;
  root.traverse((object) => { object.userData.composerEntry = entry; });
  applySavedState(entry, saved?.models?.find((item) => item.id === modelConfig.id));
  scene.add(root);
  entries.push(entry);
  return entry;
}

async function loadAll() {
  document.body.dataset.status = "loading";
  dom.errorState.hidden = true;
  const saved = savedState();
  if (saved?.background) stageColor = saved.background;
  scene.background.set(stageColor);
  for (const [index, modelConfig] of config.models.entries()) {
    dom.loadingValue.textContent = String(Math.round((index / config.models.length) * 100)).padStart(2, "0");
    await loadEntry(modelConfig, saved);
  }
  dom.loadingValue.textContent = "100";
  setBackground(stageColor);
  selectEntry(entries[0]);
  setMode("translate");
  document.body.dataset.status = "ready";
}

dom.canvas.addEventListener("pointerdown", pointerDown);
dom.canvas.addEventListener("pointermove", pointerMove);
dom.canvas.addEventListener("pointerup", pointerUp);
dom.canvas.addEventListener("pointercancel", pointerUp);
dom.translateMode.addEventListener("click", () => setMode("translate"));
dom.rotateMode.addEventListener("click", () => setMode("rotate"));
dom.centerPosition.addEventListener("click", centerSelected);
dom.resetRotation.addEventListener("click", resetSelectedRotation);
dom.capture.addEventListener("click", captureComposition);
dom.exportLayout.addEventListener("click", () => downloadText("model-workbench-layout.json", JSON.stringify(serializeLayout(), null, 2), "application/json"));
dom.closeCapture.addEventListener("click", () => dom.captureDialog.close());
dom.retry.addEventListener("click", () => location.reload());
dom.backgroundSwatches.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-color]");
  if (button) setBackground(button.dataset.color);
});
dom.gridToggle.addEventListener("change", () => { grid.visible = dom.gridToggle.checked; });
dom.safeFrameToggle.addEventListener("change", () => { dom.safeFrame.hidden = !dom.safeFrameToggle.checked; });

dom.position.forEach((input, index) => input.addEventListener("change", () => {
  if (!selected || !Number.isFinite(input.valueAsNumber)) return;
  selected.root.position.setComponent(index, input.valueAsNumber);
  syncInspector(); persistLayout();
}));
dom.rotation.forEach((input, index) => input.addEventListener("change", () => {
  if (!selected || !Number.isFinite(input.valueAsNumber)) return;
  const values = [selected.root.rotation.x, selected.root.rotation.y, selected.root.rotation.z];
  values[index] = radians(input.valueAsNumber);
  selected.root.rotation.set(...values);
  syncInspector(); persistLayout();
}));
dom.scaleControl.addEventListener("input", () => {
  if (!selected) return;
  selected.root.scale.setScalar(Number(dom.scaleControl.value));
  dom.scaleValue.value = Number(dom.scaleControl.value).toFixed(2);
});
dom.scaleControl.addEventListener("change", persistLayout);
transform.addEventListener("objectChange", () => { syncInspector(); });
transform.addEventListener("mouseUp", persistLayout);

window.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.repeat || /INPUT|TEXTAREA/.test(document.activeElement?.tagName || "")) return;
  if (event.key.toLowerCase() === "e") { event.preventDefault(); setMode(mode === "translate" ? "rotate" : "translate"); }
  if (event.key.toLowerCase() === "f") { event.preventDefault(); centerSelected(); }
  if (event.key.toLowerCase() === "g") { event.preventDefault(); resetSelectedRotation(); }
});

new ResizeObserver(resize).observe(dom.stage);
resize();

function animate() {
  if (selected) {
    selectionBounds.setFromObject(selected.root);
    selectionHelper.visible = mode === "translate" && !translating;
  }
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();

loadAll().catch((error) => {
  console.error(error);
  document.body.dataset.status = "error";
  dom.errorMessage.textContent = `模型加载失败：${error.message}`;
  dom.errorState.hidden = false;
});

window.__MODEL_WORKBENCH__ = {
  renderer,
  scene,
  camera,
  transform,
  entries,
  get mode() { return mode; },
  get selectedIndex() { return entries.indexOf(selected); },
  select(index) { if (entries[index]) selectEntry(entries[index]); },
  setMode,
  centerSelected,
  resetSelectedRotation,
  captureComposition,
  serializeLayout,
};

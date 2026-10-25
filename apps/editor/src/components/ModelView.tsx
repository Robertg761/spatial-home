import type { Point2 } from '@spatial-home/home-model';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildModel3D, type HomeModel3D } from '../editor/model3d.ts';
import type { EditorAction, EditorState, Selection } from '../editor/state.ts';

/** How thick walls are drawn, in metres. Each room thickens its own walls outwards. */
const WALL_THICKNESS = 0.08;
const DEVICE_RADIUS = 0.08;
/** How far, in pixels, a press can move and still count as a click rather than a turn of the view. */
const CLICK_PIXELS = 4;

interface ModelViewProps {
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  /** Changing this number fits the view to the home. */
  fitRequest: number;
}

interface Palette {
  floor: THREE.Color;
  wall: THREE.Color;
  selected: THREE.Color;
  window: THREE.Color;
  fixture: THREE.Color;
  device: THREE.Color;
  grid: THREE.Color;
  background: THREE.Color;
}

/**
 * The home in 3D: the floor being edited and the floors below it, without ceilings, so you look
 * down into the rooms. Drag to turn it, right-drag or Shift-drag to pan, and scroll to zoom. Click
 * a room or window to select it.
 *
 * The plan's x stays three.js's x, the plan's y runs along three.js's -z, and heights go up its y.
 */
export function ModelView({ state, dispatch, fitRequest }: ModelViewProps) {
  const { layout, floorId, selection } = state;
  const hostRef = useRef<HTMLDivElement>(null);
  const [three, setThree] = useState<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    render: () => void;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [darkScheme, setDarkScheme] = useState(prefersDark);
  const model = useMemo(() => buildModel3D(layout, floorId), [layout, floorId]);

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setDarkScheme(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // The renderer, camera and controls live as long as the view does.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(window.devicePixelRatio);
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-6, 12, 8);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 500);
    camera.position.set(8, 12, 14);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.maxPolarAngle = Math.PI / 2 - 0.02;
    const render = () => renderer.render(scene, camera);
    controls.addEventListener('change', render);

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width === 0 || height === 0) return;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      render();
    });
    observer.observe(host);
    setThree({ renderer, scene, camera, controls, render });
    return () => {
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      setThree(null);
    };
  }, []);

  // Rebuild the meshes whenever the home, the selection or the colour scheme changes.
  const contentRef = useRef<THREE.Group | null>(null);
  useEffect(() => {
    if (!three) return;
    const palette = readPalette();
    three.scene.background = palette.background;
    const content = buildScene(model, selection, palette);
    three.scene.add(content);
    contentRef.current = content;
    three.render();
    return () => {
      three.scene.remove(content);
      disposeTree(content);
      contentRef.current = null;
    };
  }, [three, model, selection, darkScheme]);

  // Fit the view to the home when asked and when the floor changes, but not on every edit, so the
  // camera stays where it was put while the layout is changed.
  const fitKey = `${fitRequest}:${floorId}`;
  const lastFit = useRef('');
  useEffect(() => {
    const content = contentRef.current;
    if (!three || !content || lastFit.current === fitKey) return;
    lastFit.current = fitKey;
    fitCamera(three.camera, three.controls, content);
    three.render();
  }, [three, fitKey, model]);

  // A click selects what's under the pointer; a drag only turns the view.
  const pressedAt = useRef<Point2 | null>(null);
  const onPointerDown = (event: React.PointerEvent) => {
    pressedAt.current = event.button === 0 ? [event.clientX, event.clientY] : null;
  };
  const onPointerUp = (event: React.PointerEvent) => {
    const start = pressedAt.current;
    pressedAt.current = null;
    const content = contentRef.current;
    if (!start || !three || !content) return;
    if (Math.hypot(event.clientX - start[0], event.clientY - start[1]) > CLICK_PIXELS) return;
    const bounds = three.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, three.camera);
    const hit = raycaster
      .intersectObjects(content.children, true)
      .find((intersection) => intersection.object.userData.selection);
    dispatch({
      type: 'select',
      selection: (hit?.object.userData.selection as Selection | undefined) ?? null,
    });
  };

  return (
    <div
      ref={hostRef}
      className="model"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onContextMenu={(event) => event.preventDefault()}
    >
      {failed && (
        <p className="model-unavailable">
          This browser couldn't start 3D graphics (WebGL), so the 3D view can't be shown.
        </p>
      )}
      <div className="plan-hint">Drag to turn, right-drag to pan, scroll to zoom.</div>
    </div>
  );
}

function buildScene(model: HomeModel3D, selection: Selection, palette: Palette): THREE.Group {
  const group = new THREE.Group();
  const selectedRoom = selection?.kind === 'room' ? selection.id : null;
  const selectedOpening = selection?.kind === 'opening' ? selection.id : null;
  const materials = {
    floor: new THREE.MeshStandardMaterial({ color: palette.floor, side: THREE.DoubleSide }),
    floorSelected: new THREE.MeshStandardMaterial({
      color: palette.floor.clone().lerp(palette.selected, 0.35),
      side: THREE.DoubleSide,
    }),
    wall: new THREE.MeshStandardMaterial({ color: palette.wall }),
    wallSelected: new THREE.MeshStandardMaterial({
      color: palette.wall.clone().lerp(palette.selected, 0.45),
    }),
    pane: new THREE.MeshStandardMaterial({
      color: palette.window,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    }),
    paneSelected: new THREE.MeshStandardMaterial({
      color: palette.selected,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
    }),
    fixture: new THREE.MeshStandardMaterial({ color: palette.fixture }),
    device: new THREE.MeshStandardMaterial({ color: palette.device }),
  };

  for (const room of model.rooms) {
    const shape = new THREE.Shape(room.outline.map(([x, y]) => new THREE.Vector2(x, y)));
    const floor = new THREE.Mesh(
      new THREE.ShapeGeometry(shape),
      room.id === selectedRoom ? materials.floorSelected : materials.floor
    );
    // The shape is drawn on x and y; turning it flat puts the plan's y along -z.
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = room.elevation;
    floor.userData.selection = { kind: 'room', id: room.id } satisfies Selection;
    group.add(floor);
  }

  for (const piece of model.walls) {
    const mesh = slab(
      piece.start,
      piece.end,
      piece.normal,
      piece.bottom,
      piece.top,
      WALL_THICKNESS
    );
    mesh.material = piece.roomId === selectedRoom ? materials.wallSelected : materials.wall;
    mesh.userData.selection = { kind: 'room', id: piece.roomId } satisfies Selection;
    group.add(mesh);
  }

  for (const pane of model.panes) {
    const mesh = slab(pane.start, pane.end, pane.normal, pane.bottom, pane.top, 0.02);
    // In the middle of the wall's thickness.
    mesh.position.x += (pane.normal[0] * WALL_THICKNESS) / 2 - pane.normal[0] * 0.01;
    mesh.position.z -= (pane.normal[1] * WALL_THICKNESS) / 2 - pane.normal[1] * 0.01;
    mesh.material = pane.openingId === selectedOpening ? materials.paneSelected : materials.pane;
    mesh.userData.selection = { kind: 'opening', id: pane.openingId } satisfies Selection;
    group.add(mesh);
  }

  for (const fixture of model.fixtures) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(fixture.width, fixture.height, fixture.depth),
      materials.fixture
    );
    const [x, y, z] = fixture.base;
    mesh.position.set(x, z + fixture.height / 2, -y);
    // Clockwise on the plan is clockwise looking down, which is a negative turn about three.js's y.
    mesh.rotation.y = -THREE.MathUtils.degToRad(fixture.rotation);
    mesh.userData.selection = { kind: 'room', id: fixture.roomId } satisfies Selection;
    group.add(mesh);
  }

  const deviceGeometry = new THREE.SphereGeometry(DEVICE_RADIUS, 16, 12);
  for (const device of model.devices) {
    const mesh = new THREE.Mesh(deviceGeometry, materials.device);
    const [x, y, z] = device.position;
    mesh.position.set(x, z, -y);
    mesh.userData.selection = { kind: 'room', id: device.roomId } satisfies Selection;
    group.add(mesh);
  }
  if (model.devices.length === 0) deviceGeometry.dispose();

  // A metre grid on the ground, under the rooms, for scale.
  const box = new THREE.Box3().setFromObject(group);
  if (!box.isEmpty()) {
    const center = box.getCenter(new THREE.Vector3());
    const size = Math.ceil(Math.max(box.max.x - box.min.x, box.max.z - box.min.z) + 4);
    const grid = new THREE.GridHelper(size, size, palette.grid, palette.grid);
    grid.position.set(Math.round(center.x), box.min.y - 0.002, Math.round(center.z));
    group.add(grid);
  }
  return group;
}

/**
 * A wall-like box between two plan points, from `bottom` to `top`, standing on the line between
 * them and thickened along `normal`.
 */
function slab(
  start: Point2,
  end: Point2,
  normal: Point2,
  bottom: number,
  top: number,
  thickness: number
): THREE.Mesh {
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(length, top - bottom, thickness));
  const x = (start[0] + end[0]) / 2 + (normal[0] * thickness) / 2;
  const y = (start[1] + end[1]) / 2 + (normal[1] * thickness) / 2;
  mesh.position.set(x, (bottom + top) / 2, -y);
  mesh.rotation.y = Math.atan2(end[1] - start[1], end[0] - start[0]);
  return mesh;
}

/** Points the camera at the home from the south-east and above, far enough back to see all of it. */
function fitCamera(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  content: THREE.Object3D
) {
  const box = new THREE.Box3().setFromObject(content);
  if (box.isEmpty()) return;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const fit = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * camera.aspect));
  const distance = Math.max(sphere.radius, 1) / Math.sin(fit / 2);
  const direction = new THREE.Vector3(0.45, 0.8, 0.75).normalize();
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).addScaledVector(direction, distance);
  camera.near = distance / 100;
  camera.far = distance * 10;
  camera.updateProjectionMatrix();
  controls.update();
}

function disposeTree(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
      geometries.add(object.geometry);
      for (const material of [object.material].flat()) materials.add(material);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}

function prefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** The scene's colours, from the stylesheet so they follow light and dark mode. */
function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const color = (name: string) => new THREE.Color(style.getPropertyValue(name).trim() || '#888');
  return {
    floor: color('--room-fill'),
    wall: color('--wall'),
    selected: color('--accent'),
    window: color('--window'),
    fixture: color('--fixture'),
    device: color('--device'),
    grid: color('--grid-major'),
    background: color('--bg'),
  };
}

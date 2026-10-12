/**
 * A small wrapper around @jscad/regl-renderer: fills a host element with an orbitable
 * 3D view of a list of geometries.
 *
 * Camera and control state live outside the WebGL lifecycle so the context can be
 * released when the viewer scrolls off screen and restored, framed as the reader left
 * it, when it scrolls back. Browsers only allow a handful of live WebGL contexts, and
 * a documentation page may hold many viewers.
 */

import {
  cameras,
  commands,
  controls,
  entitiesFromSolids,
  prepareRender,
  type DrawCommandFactory,
} from '@jscad/regl-renderer';

const perspectiveCamera = cameras.perspective;
const orbitControls = controls.orbit;

/** How far one wheel notch moves the camera. */
const ZOOM_PER_STEP = 1.15;

const AXIS_COLORS = {
  xColor: [1, 0, 0, 1],
  yColor: [0, 0.6, 0, 1],
  zColor: [0, 0, 1, 1],
};

export type ViewerTheme = {
  background: [number, number, number, number];
  meshColor: [number, number, number, number];
  gridColor: [number, number, number, number];
  gridSubColor: [number, number, number, number];
};

/** Persists across WebGL teardown, so the reader keeps their viewpoint. */
export type ViewerState = {
  camera: Record<string, unknown>;
  controls: Record<string, unknown>;
  /** Cleared once the geometries have been framed, so framing happens only once. */
  needsZoomToFit: boolean;
};

const defaultControls = () => ({
  ...orbitControls.defaults,
  // Frame the model a little more tightly than the renderer's default, so examples
  // fill the modest space a documentation page can spare.
  zoomToFit: {...orbitControls.defaults.zoomToFit, tightness: 1.1},
});

export const createViewerState = (): ViewerState => ({
  camera: {...perspectiveCamera.defaults},
  controls: defaultControls(),
  needsZoomToFit: true,
});

/** Rounds up to the nearest 1, 2 or 5 times a power of ten — the steps a ruler uses. */
const niceStep = (raw: number) => {
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const step = normalized < 1.5 ? 1 : normalized < 3.5 ? 2 : normalized < 7.5 ? 5 : 10;
  return step * magnitude;
};

/**
 * A grid scaled to the model, so the reader gets a usable sense of size whether the
 * shape is 2 units across or 200. Aims for roughly four major cells across the model.
 */
const gridForDiameter = (diameter: number) => {
  const major = niceStep(Math.max(diameter, 1e-6) / 4);
  // Kept close to the model: a wide grid turns into a haze of converging lines under
  // perspective, which reads as noise rather than as scale.
  const extent = Math.max(major * 6, diameter * 1.8);
  return {size: [extent, extent], ticks: [major, major / 5]};
};

const diameterOf = (bounds: number[][]) =>
  Math.hypot(
    bounds[1][0] - bounds[0][0],
    bounds[1][1] - bounds[0][1],
    bounds[1][2] - bounds[0][2],
  );

export type Viewer = {
  setGeometries: (geometries: object[], bounds: number[][]) => void;
  resize: () => void;
  resetView: () => void;
  dispose: () => void;
  /** Orbit by the given angles, in radians. */
  rotate: (dx: number, dy: number) => void;
  /** Pan by the given pointer movement, in CSS pixels. */
  pan: (dx: number, dy: number) => void;
  /** Zoom by wheel notches: positive away from the model, negative towards it. */
  zoom: (steps: number) => void;
};

export type ViewerOptions = {
  /**
   * Called when the browser drops the context on its own — a GPU reset, or one viewer too
   * many on a long page. The caller is expected to throw this viewer away and build a
   * fresh one; a lost context can never be revived in place.
   */
  onContextLost?: () => void;
  /** Reports a failure from inside the animation frame, where nothing else can catch it. */
  onError?: (message: string) => void;
};

/**
 * Builds each draw command once per entity instead of once per frame.
 *
 * The renderer has its own cache, but it misses forever on its first entry: it keys
 * entries by the cache's size and then tests that key for truthiness, so id 0 always
 * reads as a miss. Entity 0 is the grid, which therefore had its shaders recompiled and
 * its buffers reallocated on every frame — and since the grid picks `polygonOffset.units`
 * with `Math.random()` at build time, its depth bias flickered along with it.
 *
 * Keyed on the entity rather than on its `visuals.cacheId`: `setGeometries` builds fresh
 * entities whenever the geometry changes, so changed geometry still gets a fresh command.
 * A WeakMap, so the commands for replaced entities become collectable.
 */
const memoizePerEntity = (make: DrawCommandFactory): DrawCommandFactory => {
  const cache = new WeakMap<object, unknown>();
  return (regl, entity) => {
    if (!cache.has(entity)) cache.set(entity, make(regl, entity));
    return cache.get(entity);
  };
};

export const createViewer = (
  host: HTMLElement,
  state: ViewerState,
  theme: ViewerTheme,
  {onContextLost, onError}: ViewerOptions = {},
): Viewer => {
  // The viewer owns its canvas so that the element's lifetime matches the context's.
  // Reusing an element is not an option: a canvas may only ever hand out one WebGL
  // context, and `getContext` keeps returning that same object after it has been lost.
  const canvas = document.createElement('canvas');
  host.append(canvas);

  const gl = canvas.getContext('webgl', {
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: false,
  });
  if (!gl || gl.isContextLost()) {
    canvas.remove();
    throw new Error('WebGL is not available in this browser.');
  }

  let entities: unknown[] = [];
  /** Just the model, without the grid and axis helpers, which carry no geometry. */
  let solidEntities: unknown[] = [];
  let frame = 0;
  let disposed = false;

  const renderOptions = {
    glOptions: {gl},
    camera: state.camera,
    // Memoized per viewer, never at module scope: every command bakes in buffers and a
    // compiled program belonging to this one regl instance, so none of them may be shared
    // with another viewer.
    drawCommands: {
      drawAxis: memoizePerEntity(commands.drawAxis),
      drawGrid: memoizePerEntity(commands.drawGrid),
      drawLines: memoizePerEntity(commands.drawLines),
      drawMesh: memoizePerEntity(commands.drawMesh),
    },
    rendering: {
      background: theme.background,
      meshColor: theme.meshColor,
    },
    entities,
  };

  const render = prepareRender(renderOptions);

  const resize = () => {
    const ratio = Math.min(globalThis.devicePixelRatio ?? 1, 2);
    const width = Math.max(Math.round(canvas.clientWidth * ratio), 1);
    const height = Math.max(Math.round(canvas.clientHeight * ratio), 1);

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    perspectiveCamera.setProjection(state.camera, state.camera, {width, height});
    requestFrame();
  };

  /**
   * Draws one frame, then keeps drawing while the camera is still settling —
   * the orbit controls decay rotation over several frames after a drag ends.
   */
  const drawFrame = () => {
    frame = 0;
    if (disposed) return;

    const updated = orbitControls.update({
      controls: state.controls,
      camera: state.camera,
    });
    Object.assign(state.controls, updated.controls);
    Object.assign(state.camera, updated.camera);
    perspectiveCamera.update(state.camera, state.camera);

    renderOptions.camera = state.camera;
    renderOptions.entities = entities;
    // Nothing else can catch a throw from here: an animation frame runs outside every
    // call stack the element owns, so without this the view just stops drawing and
    // leaves an empty box behind its own controls.
    try {
      render(renderOptions);
    } catch (cause) {
      onError?.(cause instanceof Error ? cause.message : String(cause));
      return;
    }

    if (updated.controls.changed) requestFrame();
  };

  function requestFrame() {
    if (frame || disposed) return;
    frame = requestAnimationFrame(drawFrame);
  }

  const zoomToFit = () => {
    if (solidEntities.length === 0) return;

    // Only the model gets framed: zoomToFit reads `entity.geometry`, which the grid
    // and axis helpers do not have.
    const fitted = orbitControls.zoomToFit({
      controls: state.controls,
      camera: state.camera,
      entities: solidEntities,
    });
    Object.assign(state.controls, fitted.controls);
    Object.assign(state.camera, fitted.camera);
    requestFrame();
  };

  const setGeometries = (geometries: object[], bounds: number[][]) => {
    const diameter = diameterOf(bounds);
    const grid = gridForDiameter(diameter);
    const isFlat = bounds[1][2] - bounds[0][2] < diameter * 0.01;
    solidEntities = entitiesFromSolids({color: theme.meshColor}, geometries);
    entities = [
      {
        visuals: {drawCmd: 'drawGrid', show: true},
        size: grid.size,
        ticks: grid.ticks,
        color: theme.gridColor,
        subColor: theme.gridSubColor,
      },
      {
        visuals: {drawCmd: 'drawAxis', show: true},
        // A modest gizmo rather than three lines shooting past the model. Axes are
        // depth-tested so the model occludes them instead of being drawn over.
        size: Math.max(diameter * 0.6, 1e-6),
        alwaysVisible: false,
        ...AXIS_COLORS,
      },
      ...solidEntities,
    ];

    if (state.needsZoomToFit) {
      state.needsZoomToFit = false;
      // 2D examples read as a drawing, not as a solid, so look down at them rather
      // than from the default three-quarter angle. Not straight down: with a Z-up
      // camera that is degenerate for lookAt, and the view lands at an arbitrary
      // rotation. A shallow tilt keeps X horizontal and Y vertical on screen.
      if (isFlat) state.camera.position = [0, -300, 950];
      zoomToFit();
    }
    requestFrame();
  };

  const resetView = () => {
    Object.assign(state.camera, perspectiveCamera.defaults);
    // defaultControls(), not orbitControls.defaults, or resetting would silently
    // restore the renderer's looser framing.
    Object.assign(state.controls, defaultControls());
    resize();
    zoomToFit();
  };

  // A context the browser drops on its own cannot be revived here, so ask to be rebuilt
  // from scratch. Guarded by `disposed` because our own teardown fires this event too.
  canvas.addEventListener('webglcontextlost', (event) => {
    // Without preventDefault the browser will never offer to restore the context.
    event.preventDefault();
    if (!disposed) onContextLost?.();
  });

  const dispose = () => {
    disposed = true;
    if (frame) cancelAnimationFrame(frame);
    // regl offers no teardown here, so drop the context explicitly to stay well
    // under the browser's limit on simultaneous WebGL contexts.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    // Taking the element with it: a canvas can never hand out a second context, so
    // leaving this one behind would poison the next viewer built in its place.
    canvas.remove();
  };

  const applyControlUpdate = (updated: {
    controls?: Record<string, unknown>;
    camera?: Record<string, unknown>;
  }) => {
    if (updated.controls) Object.assign(state.controls, updated.controls);
    if (updated.camera) Object.assign(state.camera, updated.camera);
    requestFrame();
  };

  return {
    setGeometries,
    resize,
    resetView,
    dispose,
    // Exposed for the pointer handlers in the element.
    rotate: (dx: number, dy: number) =>
      applyControlUpdate(
        orbitControls.rotate(
          {controls: state.controls, camera: state.camera, speed: 1},
          [dx, dy],
        ),
      ),
    pan: (dx: number, dy: number) =>
      applyControlUpdate(
        orbitControls.pan(
          {controls: state.controls, camera: state.camera, speed: 1},
          [dx, dy],
        ),
      ),
    /**
     * Zoom by `steps` notches — positive away from the model, negative towards it.
     *
     * This sets the controls' scale directly rather than calling
     * `orbitControls.zoom()`, which is unusable: it normalises the delta with
     * `zoomDelta / zoomDelta`, so every notch is ±1. That doubles the distance when
     * zooming out, and when zooming in it computes a target distance of zero, fails
     * its own minimum-distance check, and does nothing at all.
     *
     * `update()` multiplies the camera distance by `scale` and then resets it to 1,
     * so accumulating multiplicatively keeps several notches within one frame smooth.
     */
    zoom: (steps: number) => {
      const scale = (state.controls.scale as number) ?? 1;
      state.controls.scale = scale * ZOOM_PER_STEP ** steps;
      requestFrame();
    },
  };
};

import styles from './styles.css?inline';
import type {Viewer, ViewerState, ViewerTheme} from './viewer';

export type JscadViewerThemeName = 'light' | 'dark';

const THEMES: Record<JscadViewerThemeName, ViewerTheme> = {
  light: {
    background: [0.98, 0.98, 0.99, 1],
    meshColor: [0, 0.6, 1, 1],
    gridColor: [0.66, 0.69, 0.74, 1],
    gridSubColor: [0.88, 0.89, 0.91, 1],
  },
  dark: {
    background: [0.11, 0.12, 0.14, 1],
    meshColor: [0.16, 0.68, 1, 1],
    gridColor: [0.33, 0.36, 0.41, 1],
    gridSubColor: [0.18, 0.2, 0.23, 1],
  },
};

/** Radians of orbit per pixel dragged. */
const ROTATE_PER_PIXEL = 0.01;

/**
 * Wheel notches for one event. Browsers report deltas in pixels, lines or pages
 * depending on the device, so normalise to pixels first — otherwise a mouse wheel and
 * a trackpad zoom at wildly different rates. Clamped so one flick cannot fly the
 * camera off into the distance.
 */
const wheelSteps = (event: WheelEvent) => {
  const PIXELS_PER_LINE = 16;
  const PIXELS_PER_PAGE = 400;
  const pixels =
    event.deltaMode === 1
      ? event.deltaY * PIXELS_PER_LINE
      : event.deltaMode === 2
        ? event.deltaY * PIXELS_PER_PAGE
        : event.deltaY;

  return Math.max(-3, Math.min(3, pixels / 100));
};

const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * The renderer and the modeling library are loaded on first use rather than on import.
 * That keeps the entry tiny, puts the heavy code in its own chunk, and means a page
 * that only server-renders the tag never touches WebGL code at all.
 */
type Runtime = {
  viewer: typeof import('./viewer');
  evaluate: typeof import('./evaluate');
};

let runtime: Promise<Runtime> | undefined;

const loadRuntime = (): Promise<Runtime> => {
  runtime ??= Promise.all([import('./viewer'), import('./evaluate')]).then(
    ([viewer, evaluate]) => ({viewer, evaluate}),
  );
  return runtime;
};

const TEMPLATE = `
  <div class="viewport" part="viewport">
    <div class="canvas-host"></div>
    <p class="hint" part="hint" aria-hidden="true">Drag to rotate</p>
    <button type="button" class="reset" part="reset">Reset view</button>
    <div class="error" part="error" role="alert" hidden>
      <strong>This example could not be rendered</strong>
      <pre></pre>
    </div>
  </div>
`;

/** Detail of the `jscad-render` event, fired each time a design has been evaluated. */
export type JscadRenderEventDetail = {geometries: object[]; bounds: number[][]};

/** Detail of the `jscad-error` event. */
export type JscadErrorEventDetail = {
  /** `design` when the source failed to compile or run, `viewer` when WebGL failed. */
  kind: 'design' | 'viewer';
  message: string;
};

// Lets the module be imported where there is no DOM, such as during server-side
// rendering. The class is only ever instantiated by a browser, which has the real one.
const Base = (globalThis.HTMLElement ?? class {}) as typeof HTMLElement;

/**
 * `<jscad-viewer>` evaluates a JSCAD design in the reader's browser and shows the
 * model it produces in an orbitable 3D view.
 *
 * The design is an ES module that imports from '@jscad/modeling' and exports `main`.
 * It is read from the `code` property, else the `code` attribute, else the text of a
 * child `<script type="text/jscad">`.
 */
export class JscadViewerElement extends Base {
  static observedAttributes = ['code', 'theme'];

  #codeProperty: string | null = null;

  readonly #viewport: HTMLDivElement;
  readonly #host: HTMLDivElement;
  readonly #hint: HTMLParagraphElement;
  readonly #reset: HTMLButtonElement;
  readonly #error: HTMLDivElement;
  readonly #errorMessage: HTMLPreElement;

  #viewer: Viewer | null = null;
  /** Camera and controls, kept across WebGL teardown so the reader keeps their viewpoint. */
  #state: ViewerState | null = null;
  /** The most recent successful evaluation, replayed whenever the context is recreated. */
  #model: JscadRenderEventDetail | null = null;

  // Kept apart because they heal differently: a design that does not compile stays broken
  // until its source changes, while a failed context is fixed by the next one that works.
  // Sharing one slot would mean either a stale error over a working view, or a blank view
  // where the reader's actual mistake should be.
  #designError: string | null = null;
  #viewerError: string | null = null;

  #connected = false;
  #visible = false;
  #engaged = false;

  /** The source last handed to evaluation, so unchanged code is not run twice. */
  #evaluatedSource: string | null = null;
  /** Bumped per evaluation; a result whose token is stale is dropped. */
  #evaluation = 0;
  /** Bumped per viewer build or teardown; a build that resolves late is dropped. */
  #build = 0;

  #intersectionObserver: IntersectionObserver | null = null;
  #resizeObserver: ResizeObserver | null = null;
  #colorScheme: MediaQueryList | null = null;

  constructor() {
    super();

    const root = this.attachShadow({mode: 'open'});
    root.innerHTML = `<style>${styles}</style>${TEMPLATE}`;

    this.#viewport = root.querySelector('.viewport')!;
    this.#host = root.querySelector('.canvas-host')!;
    this.#hint = root.querySelector('.hint')!;
    this.#reset = root.querySelector('.reset')!;
    this.#error = root.querySelector('.error')!;
    this.#errorMessage = root.querySelector('.error pre')!;

    this.#viewport.addEventListener('pointerdown', this.#onPointerDown);
    this.#viewport.addEventListener('pointerleave', () => this.#setEngaged(false));
    this.#reset.addEventListener('click', () => this.resetView());
  }

  /** The JSCAD design source. */
  get code(): string {
    return (
      this.#codeProperty ??
      this.getAttribute('code') ??
      this.querySelector('script[type="text/jscad"]')?.textContent ??
      ''
    );
  }

  set code(value: string | null | undefined) {
    this.#codeProperty = value ?? null;
    this.#evaluate();
  }

  /** `light`, `dark`, or `null` to follow the reader's colour-scheme preference. */
  get theme(): JscadViewerThemeName | null {
    const theme = this.getAttribute('theme');
    return theme === 'light' || theme === 'dark' ? theme : null;
  }

  set theme(value: JscadViewerThemeName | null | undefined) {
    if (value) this.setAttribute('theme', value);
    else this.removeAttribute('theme');
  }

  /** Returns the camera to its starting position, framed on the model. */
  resetView(): void {
    this.#viewer?.resetView();
  }

  connectedCallback(): void {
    // A framework may have set these before the element was defined, which shadows the
    // accessors with plain instance properties. Re-apply them through the accessors.
    for (const name of ['code', 'theme'] as const) {
      if (Object.hasOwn(this, name)) {
        const value = this[name];
        delete (this as Partial<this>)[name];
        (this as Record<typeof name, unknown>)[name] = value;
      }
    }

    this.#connected = true;

    // Only hold a WebGL context while the viewer is near the viewport.
    this.#intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        this.#visible = entry.isIntersecting;
        this.#sync();
      },
      {rootMargin: '300px'},
    );
    this.#intersectionObserver.observe(this);

    this.#colorScheme = globalThis.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
    this.#colorScheme?.addEventListener('change', this.#onColorSchemeChange);

    this.#render();
  }

  disconnectedCallback(): void {
    this.#connected = false;
    this.#visible = false;

    this.#intersectionObserver?.disconnect();
    this.#intersectionObserver = null;
    this.#colorScheme?.removeEventListener('change', this.#onColorSchemeChange);
    this.#colorScheme = null;

    this.#setEngaged(false);
    this.#teardownViewer();
  }

  attributeChangedCallback(name: string, previous: string | null, next: string | null): void {
    if (previous === next) return;
    if (name === 'code' && this.#codeProperty === null) this.#evaluate();
    if (name === 'theme') this.#rebuildViewer();
  }

  get #resolvedTheme(): JscadViewerThemeName {
    return this.theme ?? (this.#colorScheme?.matches ? 'dark' : 'light');
  }

  #onColorSchemeChange = () => {
    if (!this.theme) this.#rebuildViewer();
  };

  /** Brings the viewer and the evaluation in line with whether the element is in view. */
  #sync() {
    if (this.#connected && this.#visible) {
      this.#evaluate();
      if (!this.#viewer) this.#buildViewer();
    } else {
      this.#teardownViewer();
    }
  }

  /**
   * Builds a viewer into the host. Each build makes a brand new canvas, because a disposed
   * viewer leaves a permanently lost context behind on the one it was using.
   */
  async #buildViewer() {
    const build = ++this.#build;
    const {viewer: viewerModule} = await loadRuntime();
    if (build !== this.#build || !this.#connected || !this.#visible) return;

    this.#state ??= viewerModule.createViewerState();

    let viewer: Viewer;
    try {
      viewer = viewerModule.createViewer(
        this.#host,
        this.#state,
        THEMES[this.#resolvedTheme],
        {
          // Rebuilt once this event has been handled: the context is still being lost
          // while the callback runs.
          onContextLost: () => queueMicrotask(() => this.#rebuildViewer()),
          onError: (message) => this.#setViewerError(message),
        },
      );
    } catch (cause) {
      this.#setViewerError(messageOf(cause));
      return;
    }

    this.#viewer = viewer;
    this.#setViewerError(null);
    viewer.resize();

    if (this.#model) viewer.setGeometries(this.#model.geometries, this.#model.bounds);

    this.#resizeObserver = new ResizeObserver(() => viewer.resize());
    this.#resizeObserver.observe(this.#host);
  }

  #teardownViewer() {
    this.#build++;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#viewer?.dispose();
    this.#viewer = null;
  }

  #rebuildViewer() {
    this.#teardownViewer();
    this.#sync();
  }

  /**
   * Evaluates the design once it is near the viewport, and hands the result to the viewer
   * whenever one exists. Runs once per source, not once per scroll: the result is kept in
   * #model and replayed every time a viewer is built.
   */
  async #evaluate() {
    if (!this.#connected || !this.#visible) return;

    const source = this.code.replace(/\n+$/, '');
    if (source === this.#evaluatedSource) return;
    this.#evaluatedSource = source;
    const evaluation = ++this.#evaluation;

    if (!source.trim()) {
      this.#model = null;
      this.#designError = null;
      this.#render();
      // The renderer cannot be emptied in place, so start over with a blank one.
      if (this.#viewer) this.#rebuildViewer();
      return;
    }

    try {
      const {evaluate} = await loadRuntime();
      const geometries = await evaluate.evaluateDesign(source);
      const bounds = await evaluate.measureBounds(geometries);
      if (evaluation !== this.#evaluation) return;

      this.#model = {geometries, bounds};
      this.#designError = null;
      this.#render();
      this.#viewer?.setGeometries(geometries, bounds);
      this.#emit<JscadRenderEventDetail>('jscad-render', {geometries, bounds});
    } catch (cause) {
      if (evaluation !== this.#evaluation) return;

      this.#designError = messageOf(cause);
      this.#render();
      this.#emit<JscadErrorEventDetail>('jscad-error', {
        kind: 'design',
        message: this.#designError,
      });
    }
  }

  #setViewerError(message: string | null) {
    if (message === this.#viewerError) return;
    this.#viewerError = message;
    this.#render();
    if (message) {
      this.#emit<JscadErrorEventDetail>('jscad-error', {kind: 'viewer', message});
    }
  }

  #emit<T>(type: string, detail: T) {
    this.dispatchEvent(new CustomEvent(type, {detail, bubbles: true, composed: true}));
  }

  #render() {
    const error = this.#designError ?? this.#viewerError;

    this.#error.hidden = !error;
    this.#errorMessage.textContent = error ?? '';
    this.#hint.hidden = Boolean(error);
    this.#reset.hidden = Boolean(error);
    this.#hint.textContent = this.#engaged
      ? 'Scroll to zoom · Shift-drag to pan'
      : 'Drag to rotate';
  }

  #onPointerDown = (event: PointerEvent) => {
    const viewer = this.#viewer;
    if (!viewer) return;
    // The overlay controls are inside the viewport, and this handler is on the viewport
    // rather than on the canvas. Capturing the pointer for a drag would retarget the
    // click away from the button that was pressed, so leave those presses alone.
    if ((event.target as Element).closest('button')) return;

    this.#setEngaged(true);
    this.#viewport.setPointerCapture(event.pointerId);

    const panning = event.shiftKey || event.button === 1;
    let lastX = event.clientX;
    let lastY = event.clientY;

    const handleMove = (move: PointerEvent) => {
      const dx = move.clientX - lastX;
      const dy = move.clientY - lastY;
      lastX = move.clientX;
      lastY = move.clientY;

      // The Y drag is negated: the controls measure the camera's angle down from
      // +Z, so passing the raw delta sends the camera the opposite way from the
      // pointer. Dragging down should tip the model towards you, showing its top.
      if (panning) viewer.pan(dx, dy);
      else viewer.rotate(dx * ROTATE_PER_PIXEL, -dy * ROTATE_PER_PIXEL);
    };

    const handleUp = () => {
      globalThis.removeEventListener('pointermove', handleMove);
      globalThis.removeEventListener('pointerup', handleUp);
    };

    globalThis.addEventListener('pointermove', handleMove);
    globalThis.addEventListener('pointerup', handleUp);
  };

  /**
   * Scrolling only zooms once the reader has grabbed the model, so that scrolling past
   * the viewer never hijacks the page. Registered as non-passive so it may
   * preventDefault.
   */
  #setEngaged(engaged: boolean) {
    if (engaged === this.#engaged) return;
    this.#engaged = engaged;

    if (engaged) {
      this.#viewport.addEventListener('wheel', this.#onWheel, {passive: false});
    } else {
      this.#viewport.removeEventListener('wheel', this.#onWheel);
    }
    this.#render();
  }

  #onWheel = (event: WheelEvent) => {
    event.preventDefault();
    this.#viewer?.zoom(wheelSteps(event));
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'jscad-viewer': JscadViewerElement;
  }

  interface HTMLElementEventMap {
    'jscad-render': CustomEvent<JscadRenderEventDetail>;
    'jscad-error': CustomEvent<JscadErrorEventDetail>;
  }
}

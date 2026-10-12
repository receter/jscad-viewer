import {JscadViewerElement} from './element';

export {JscadViewerElement};
export type {
  JscadErrorEventDetail,
  JscadRenderEventDetail,
  JscadViewerThemeName,
} from './element';

// Guarded so that importing the package where there is no DOM (server-side rendering)
// is harmless, and so that two copies of the package on one page do not collide.
if (globalThis.customElements && !customElements.get('jscad-viewer')) {
  customElements.define('jscad-viewer', JscadViewerElement);
}

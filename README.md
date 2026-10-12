# @receter/jscad-viewer

A `<jscad-viewer>` web component. It evaluates a [JSCAD](https://openjscad.xyz/) design in the browser and shows the resulting model in an orbitable 3D view.

The design is a plain ES module that imports from `@jscad/modeling` and exports `main`, so the code you show is the code that runs.

- **Lightweight on load.** The renderer and modeling library load only when the first viewer scrolls near the viewport.
- **Few WebGL contexts.** A viewer holds a WebGL context only while it is on screen, so a page can carry many examples. The camera is kept when a viewer scrolls away and back.
- **Unobtrusive controls.**
  - Drag to rotate.
  - Shift-drag or middle-drag to pan.
  - Scroll to zoom, only after the reader has grabbed the model, so the page scrolls normally past it.
- **Parameters.** Designs that export `getParameterDefinitions()` render with their default values.
- **SSR-safe import.** The element only registers when `customElements` exists.

## Install

```sh
npm install @receter/jscad-viewer
```

`@jscad/modeling` and `@jscad/regl-renderer` are installed with it. They are imported as bare specifiers, so use a bundler (Vite, webpack, Rspack, …) or an import map.

## Usage

```js
import '@receter/jscad-viewer';
```

### HTML

Put the design in a child `<script type="text/jscad">`, so the browser neither runs nor parses it as HTML:

```html
<jscad-viewer>
  <script type="text/jscad">
    import { cuboid } from '@jscad/modeling'

    export const main = () => cuboid({ size: [10, 20, 5] })
  </script>
</jscad-viewer>
```

### JavaScript

```js
const viewer = document.createElement('jscad-viewer');
viewer.code = `
import { sphere } from '@jscad/modeling'
export const main = () => sphere({ radius: 5 })
`;
document.body.append(viewer);
```

### React 19

React 19 passes props to custom elements as properties:

```tsx
import '@receter/jscad-viewer';

<jscad-viewer code={source} theme={colorMode} style={{height: 400}} />;
```

For TypeScript, declare the element once in your project:

```ts
import type {JscadViewerElement} from '@receter/jscad-viewer';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'jscad-viewer': React.DetailedHTMLProps<
        React.HTMLAttributes<JscadViewerElement>,
        JscadViewerElement
      > & {code?: string; theme?: 'light' | 'dark'};
    }
  }
}
```

## API

### Attributes and properties

| Name | Type | Description |
| --- | --- | --- |
| `code` | `string` | The design source. The property takes precedence over the attribute. Both take precedence over a child `<script type="text/jscad">`. |
| `theme` | `'light' \| 'dark' \| null` | Colour scheme of the 3D view and its overlay. When it is absent, the viewer follows `prefers-color-scheme`. |

### Methods

| Name | Description |
| --- | --- |
| `resetView()` | Returns the camera to its starting position, framed on the model. |

### Events

Both events bubble and cross shadow boundaries.

| Name | `detail` | Fired when |
| --- | --- | --- |
| `jscad-render` | `{geometries, bounds}` | A design has been evaluated. |
| `jscad-error` | `{kind: 'design' \| 'viewer', message}` | A design fails to compile or run (`design`), or WebGL fails (`viewer`). |

### Styling

The element is `display: block` and 320px tall by default; set `height` to change that. Colours can be overridden with custom properties:

| Property | Used for |
| --- | --- |
| `--jscad-viewer-border` | Border of the viewport and the reset button |
| `--jscad-viewer-radius` | Corner radius |
| `--jscad-viewer-surface` | Viewport and error background |
| `--jscad-viewer-background` | Reset button background |
| `--jscad-viewer-muted` | Hint and button text |
| `--jscad-viewer-danger` | Error heading |
| `--jscad-viewer-code-background` | Error message background |
| `--jscad-viewer-text` | Error message text |

The 3D canvas colours follow `theme`. For anything else, the shadow DOM exposes these parts: `viewport`, `hint`, `reset` and `error`.

```css
jscad-viewer {
  height: 400px;
  --jscad-viewer-radius: 0;
}

jscad-viewer::part(viewport) {
  border: none;
}
```

## Browser support

The build targets browsers released since October 2025. That is roughly Chrome/Edge 141+, Firefox 144+ and Safari 26.1+. WebGL is required. The target comes from the `browserslist` field in `package.json`.

## Development

```sh
npm install
npm run dev     # demo page at index.html
npm run build   # dist/ with ES modules and type declarations
```

## License

MIT

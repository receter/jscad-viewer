import browserslistToEsbuild from 'browserslist-to-esbuild';
import {defineConfig} from 'vite';

export default defineConfig({
  build: {
    // Taken from the "browserslist" field in package.json: browsers released in the
    // last year or so.
    target: browserslistToEsbuild(),
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'jscad-viewer',
    },
    rolldownOptions: {
      // Left for the consumer's bundler to resolve, so a page that also uses the JSCAD
      // packages itself does not ship them twice.
      external: [/^@jscad\//],
    },
    // Unminified: the consumer's bundler minifies anyway, and the blob import in
    // evaluate.ts relies on its `webpackIgnore` comment surviving into the output.
    minify: false,
  },
});

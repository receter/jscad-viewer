/**
 * Evaluates a JSCAD design, written exactly as a user would write it, in the browser.
 *
 * Designs are real ES modules: they `import` from '@jscad/modeling' and `export` a
 * `main` function. To run one we build a Blob module and let the browser's own module
 * loader handle it, so the code shown on the page is the code that actually runs.
 *
 * The bare specifier '@jscad/modeling' has no meaning to the browser, so it is
 * rewritten to point at a generated shim module that re-exports the bundled library.
 */

const NAMESPACE_KEY = '__jscadModeling__';
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Matches the module specifier in `from '@jscad/modeling'`, `import('@jscad/modeling')`
// and the '@jscad/modeling/...' subpaths, capturing the quote style.
const MODELING_SPECIFIER = /(['"])@jscad\/modeling(?:\/[^'"]*)?\1/g;

let shimUrl: Promise<string> | undefined;

/**
 * Builds (once per page load) a module that re-exports every member of the bundled
 * modeling library, and returns its blob URL.
 */
const getModelingShimUrl = (): Promise<string> => {
  shimUrl ??= import('@jscad/modeling').then((modeling) => {
    globalThis[NAMESPACE_KEY] = modeling;

    const names = Object.keys(modeling).filter(
      (name) => name !== 'default' && IDENTIFIER.test(name),
    );
    const source = [
      `const m = globalThis[${JSON.stringify(NAMESPACE_KEY)}];`,
      ...names.map((name) => `export const ${name} = m[${JSON.stringify(name)}];`),
      'export default m;',
    ].join('\n');

    return URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
  });
  return shimUrl;
};

export type ParameterDefinition = {
  name: string;
  type: string;
  initial?: unknown;
  default?: unknown;
  checked?: boolean;
  values?: unknown[];
};

/**
 * Resolves the values a design would receive on first load, so that examples using
 * `getParameterDefinitions()` render with the same defaults the JSCAD apps would show.
 */
const resolveDefaultParameters = (
  definitions: ParameterDefinition[],
): Record<string, unknown> => {
  const params: Record<string, unknown> = {};
  for (const definition of definitions ?? []) {
    if (!definition?.name || definition.type === 'group') continue;

    if (definition.type === 'checkbox') {
      params[definition.name] = definition.checked
        ? (definition.initial ?? true)
        : false;
      continue;
    }

    const initial = definition.initial ?? definition.default;
    params[definition.name] = initial ?? definition.values?.[0];
  }
  return params;
};

/** A JSCAD design returns a geometry, or arbitrarily nested arrays of them. */
const collectGeometries = (result: unknown): object[] =>
  [result]
    .flat(Infinity)
    .filter((item): item is object => typeof item === 'object' && item !== null);

/**
 * Runs the given design source and returns the geometries it produced.
 * Throws with the design's own error message if the code does not compile or run.
 */
export const evaluateDesign = async (code: string): Promise<object[]> => {
  const source = code.replace(
    MODELING_SPECIFIER,
    JSON.stringify(await getModelingShimUrl()),
  );
  const url = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));

  try {
    const design = await import(/* @vite-ignore */ /* webpackIgnore: true */ url);

    const main = design.main ?? design.default;
    if (typeof main !== 'function') {
      throw new Error("The design must export a 'main' function.");
    }

    const params =
      typeof design.getParameterDefinitions === 'function'
        ? resolveDefaultParameters(design.getParameterDefinitions())
        : {};

    const geometries = collectGeometries(await main(params));
    if (geometries.length === 0) {
      throw new Error("'main' did not return any geometry.");
    }
    return geometries;
  } finally {
    URL.revokeObjectURL(url);
  }
};

/** The combined bounding box of the given geometries, as [[minX, minY, minZ], [maxX, maxY, maxZ]]. */
export const measureBounds = async (geometries: object[]): Promise<number[][]> => {
  const {measureAggregateBoundingBox} = await import('@jscad/modeling');
  return measureAggregateBoundingBox(geometries);
};

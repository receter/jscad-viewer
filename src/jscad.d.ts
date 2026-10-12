/**
 * Ambient types for the JSCAD v3 alpha packages, covering only what this package uses.
 *
 * Both packages set a package.json "exports" map with no "types" condition, so
 * TypeScript cannot see their shipped declarations at all. In @jscad/modeling's case
 * that is just as well: as of 3.0.7-alpha.0 its index.d.ts still describes the v2
 * namespaced API (`primitives.cuboid`) rather than the flattened v3 exports.
 *
 * This file must stay script-style — no top-level import or export — or the ambient
 * module declarations below stop being ambient.
 */

/** Where the modeling namespace is parked so generated Blob modules can reach it. */
declare var __jscadModeling__: unknown;

declare module '@jscad/modeling' {
  /** Combined bounding box of the given geometries: [[minX, minY, minZ], [maxX, maxY, maxZ]]. */
  export const measureAggregateBoundingBox: (geometries: unknown) => number[][];
}

declare module '@jscad/regl-renderer' {
  export const cameras: {
    perspective: {
      defaults: Record<string, unknown>;
      setProjection: (
        output: unknown,
        camera: unknown,
        input: {width: number; height: number},
      ) => Record<string, unknown>;
      update: (output: unknown, camera?: unknown) => Record<string, unknown>;
    };
    orthographic: Record<string, unknown>;
    camera: Record<string, unknown>;
  };

  /**
   * Builds a regl draw command for one entity. Geometry, shaders and buffers are all
   * baked in at build time, so the result belongs to both that entity and the regl
   * instance it was built with, and may be reused for neither another.
   */
  export type DrawCommandFactory = (regl: unknown, entity: object) => unknown;

  export const commands: {
    drawAxis: DrawCommandFactory;
    drawGrid: DrawCommandFactory;
    drawLines: DrawCommandFactory;
    drawMesh: DrawCommandFactory;
  };

  export const controls: {
    orbit: {
      defaults: Record<string, unknown> & {
        /** `tightness` is how closely the camera frames the model; lower is closer. */
        zoomToFit: {auto: boolean; targets: string; tightness: number};
      };
      update: (input: {controls: unknown; camera: unknown}) => {
        controls: Record<string, unknown> & {changed?: boolean};
        camera: Record<string, unknown>;
      };
      rotate: (
        input: {controls: unknown; camera: unknown; speed?: number},
        angle: [number, number],
      ) => {controls: Record<string, unknown>; camera: Record<string, unknown>};
      pan: (
        input: {controls: unknown; camera: unknown; speed?: number},
        delta: [number, number],
      ) => {controls: Record<string, unknown>; camera: Record<string, unknown>};
      zoom: (
        input: {controls: unknown; camera: unknown; speed?: number},
        delta: number,
      ) => {controls: Record<string, unknown>; camera: Record<string, unknown>};
      zoomToFit: (input: {
        controls: unknown;
        camera: unknown;
        entities: unknown[];
      }) => {controls: Record<string, unknown>; camera: Record<string, unknown>};
      reset: (
        input: {controls: unknown; camera: unknown},
        desiredState?: unknown,
      ) => {controls: Record<string, unknown>; camera: Record<string, unknown>};
    };
  };

  export const entitiesFromSolids: (
    options: {color?: number[]; smoothNormals?: boolean},
    ...solids: unknown[]
  ) => unknown[];

  export const prepareRender: (params: {
    glOptions: Record<string, unknown>;
  }) => (data: unknown) => void;
}

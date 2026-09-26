import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// ---------------------------------------------------------------------------
// Static geometry batching.
//
// Structures built from many primitives (the launch tower is ~110 beams) cost
// one draw call per piece, and another per piece for every shadow pass. When
// the pieces never move and share a material, they can be baked into a single
// mesh with no visual difference at all.
// ---------------------------------------------------------------------------

/**
 * Bakes each mesh's local transform into a copy of its geometry and merges
 * them all into one mesh. The source meshes' geometries are disposed.
 *
 * @param {THREE.Mesh[]} meshes siblings, positioned relative to one parent,
 *   all using `material`
 * @param {THREE.Material} material
 * @returns {THREE.Mesh}
 */
export function mergeMeshes(meshes, material) {
  const parts = [];
  for (const mesh of meshes) {
    mesh.updateMatrix();
    // Primitives differ in which attributes they carry; keep only the ones
    // every lit material needs, so they can all merge together.
    const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    for (const name of Object.keys(g.attributes)) {
      if (name !== "position" && name !== "normal" && name !== "uv") g.deleteAttribute(name);
    }
    g.applyMatrix4(mesh.matrix);
    parts.push(g);
    mesh.geometry.dispose();
  }

  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  if (!merged) throw new Error("mergeMeshes: incompatible geometries");
  merged.computeBoundingSphere();
  return new THREE.Mesh(merged, material);
}

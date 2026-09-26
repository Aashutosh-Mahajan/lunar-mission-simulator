import * as THREE from "three";

// ---------------------------------------------------------------------------
// Lunar photometry for regolith materials.
//
// Three.js shades diffuse surfaces as Lambertian: brightness proportional to
// cos(incidence). Regolith is not Lambertian. It is closer to a
// Lommel-Seeliger scatterer, the standard first-order photometric law for the
// Moon:
//
//     I  ∝  μ0 / (μ0 + μ)      μ0 = cos(incidence), μ = cos(emission)
//
// which is why the full Moon is almost evenly bright out to its limb instead of
// darkening like a Lambertian ball. It matters enormously at the 5–15 degree
// sun elevations these landing sites use: under Lambert the whole foreground
// fell to near-black, while real surface photography at those angles shows
// bright, readable ground with deep, crisp shadows.
//
// We blend Lommel-Seeliger with Lambert rather than using it outright. Pure
// L-S flattens topography (that is its point — the limb does not darken), and
// relief is what lets a pilot judge height. The blend keeps slopes readable
// while lifting the low-sun surface out of the murk.
// ---------------------------------------------------------------------------

const LAMBERT_LINE = "vec3 irradiance = dotNL * directLight.color;";

function lunarChunk(strength) {
  const chunk = THREE.ShaderChunk.lights_physical_pars_fragment;
  if (!chunk.includes(LAMBERT_LINE)) {
    // A future Three.js changed the chunk; fall back to stock shading rather
    // than failing to compile.
    return null;
  }
  return chunk.replace(
    LAMBERT_LINE,
    `// Lommel-Seeliger / Lambert blend (see materials/photometry.js).
	float lsMu = saturate( dot( geometryNormal, geometryViewDir ) );
	// Normalised by 2 so it equals Lambert at normal incidence and emission.
	float lsTerm = min( 2.0 * dotNL / ( dotNL + lsMu + 1e-3 ), 1.5 );
	vec3 irradiance = mix( dotNL, lsTerm, ${strength.toFixed(3)} ) * directLight.color;`
  );
}

/**
 * Patches a MeshStandardMaterial to shade as lunar regolith.
 * @param {THREE.MeshStandardMaterial} material
 * @param {number} strength 0 = Lambert, 1 = pure Lommel-Seeliger
 */
export function applyLunarPhotometry(material, strength = 0.6) {
  const chunk = lunarChunk(strength);
  if (!chunk) return material;
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <lights_physical_pars_fragment>",
      chunk
    );
  };
  // Distinct program cache key, or Three would reuse a stock program.
  material.customProgramCacheKey = () => `lunar-ls-${strength}`;
  material.needsUpdate = true;
  return material;
}

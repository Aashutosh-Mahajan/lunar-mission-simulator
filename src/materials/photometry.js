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

// Linear backscatter slope of the phase law (see below and
// environmentMaps.js, which uses the same law for bounced light).
export const PHASE_SLOPE = 0.62;

// The direct specular term. Regolith has almost none: it is a powder of
// fragments and glass beads with no coherent surface to mirror the sun. Left
// at the stock dielectric value — and fed the photometric irradiance below,
// which is boosted at grazing angles — Fresnel turned every distant slope
// seen toward the sun into a bright sheen.
const SPECULAR_LINE =
  "reflectedLight.directSpecular += irradiance * BRDF_GGX_Multiscatter( directLight.direction, geometryViewDir, geometryNormal, material );";
const REGOLITH_SPECULAR = 0.1;

function lunarChunk(strength) {
  const chunk = THREE.ShaderChunk.lights_physical_pars_fragment;
  if (!chunk.includes(LAMBERT_LINE) || !chunk.includes(SPECULAR_LINE)) {
    // A future Three.js changed the chunk; fall back to stock shading rather
    // than failing to compile.
    return null;
  }
  return chunk.replace(
    SPECULAR_LINE,
    `reflectedLight.directSpecular += dotNL * directLight.color * BRDF_GGX_Multiscatter( directLight.direction, geometryViewDir, geometryNormal, material ) * ${REGOLITH_SPECULAR.toFixed(3)};`
  ).replace(
    LAMBERT_LINE,
    `// Lommel-Seeliger / Lambert blend (see materials/photometry.js).
	// Floored: where the normal map tips a pixel away from the camera the raw
	// ratio blows up, which scattered bright sparkles across the ground.
	float lsMu = max( saturate( dot( geometryNormal, geometryViewDir ) ), 0.3 );
	// Normalised by 2 so it equals Lambert at normal incidence and emission.
	float lsTerm = min( 2.0 * dotNL / ( dotNL + lsMu + 1e-3 ), 1.5 );
	// Phase function: regolith backscatters. Looking down-sun it is bright,
	// with a narrow opposition surge around the antisolar point (the halo
	// round the vehicle's own shadow in Apollo photographs); looking up-sun
	// it is markedly darker. Without this the distant ground toward the sun
	// glowed like haze — the opposite of what the crews saw.
	float cosPhase = dot( directLight.direction, geometryViewDir );
	float phaseLaw = 1.0 + ${PHASE_SLOPE.toFixed(3)} * cosPhase + 0.35 * pow( max( cosPhase, 0.0 ), 48.0 );
	// Applied to the whole term: at a distance the normal map's mips average
	// away the sub-pixel shadows that make up most of the darkening, so the
	// phase law has to stand in for them on both halves of the blend.
	vec3 irradiance = mix( dotNL, lsTerm, ${strength.toFixed(3)} ) * phaseLaw * directLight.color;`
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

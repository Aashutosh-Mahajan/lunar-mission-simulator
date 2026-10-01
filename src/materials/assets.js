import * as THREE from "three";
import { applyLunarPhotometry } from "./photometry.js";
import { applyRegolithDetail } from "./regolithShader.js";
import { REGOLITH_ALBEDO } from "../constants.js";
import * as CANNON from "cannon-es";
import {
  buildRegolithMaps,
  buildFoilMaps,
  buildPanelMaps,
  buildConcreteMaps,
  buildCapeGroundMap,
  buildEarthMaps,
  buildGlowSprite,
  buildDustSprite,
} from "./textures.js";

// ---------------------------------------------------------------------------
// Shared, procedurally baked materials. Built once at start-up (the loading
// screen exists because this is a few hundred milliseconds of canvas work)
// and reused by every level, so switching sites is instant.
// ---------------------------------------------------------------------------

/** Lets the browser paint the loading bar between expensive bakes. */
const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0));

export async function buildAssets(onProgress = () => {}) {
  const assets = {};

  onProgress(0.05, "Baking regolith surface maps…");
  await yieldToBrowser();
  assets.regolith = buildRegolithMaps(1337, 512);

  onProgress(0.35, "Weathering thermal insulation…");
  await yieldToBrowser();
  assets.foil = buildFoilMaps(4242, 256, [1.0, 0.72, 0.26]);
  assets.foilDark = buildFoilMaps(8181, 256, [0.34, 0.3, 0.27]);

  onProgress(0.58, "Finishing spacecraft panels…");
  await yieldToBrowser();
  assets.panel = buildPanelMaps(909, 256);
  assets.concrete = buildConcreteMaps(3900, 256);
  assets.capeGround = buildCapeGroundMap(1969, 1024, 26000);

  onProgress(0.68, "Painting Earth…");
  await yieldToBrowser();
  // Baked once here and shared by the launch sky (Phase 2) and the cislunar
  // scene (Phase 3), where Earth is the hero object and needs the resolution.
  assets.earth = buildEarthMaps(20240, 1024);

  onProgress(0.8, "Preparing particle sprites…");
  await yieldToBrowser();
  assets.glowSprite = buildGlowSprite(128, 0.3);
  assets.dustSprite = buildDustSprite(64, 5);

  onProgress(0.86, "Assembling materials…");
  await yieldToBrowser();

  // --- Terrain ---------------------------------------------------------
  // Regolith is a very dark, almost perfectly diffuse powder. Its apparent
  // brightness comes from unfiltered sunlight, not from a bright albedo, so
  // the base colour stays dark and the lighting does the work.
  // No roughness map: powder at roughness ~0.95 has no visible specular
  // structure, and on the most-drawn surface in the game every fetch counts.
  const regolithMaps = {
    map: assets.regolith.map.clone(),
    normalMap: assets.regolith.normalMap.clone(),
  };
  for (const tex of Object.values(regolithMaps)) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, 1); // terrain supplies pre-scaled UVs
    // The detail maps tile many times across a kilometre of ground, so they
    // are viewed at extremely oblique angles. High anisotropy plus mipmaps is
    // what stops that reading as moiré out toward the horizon.
    tex.anisotropy = 16;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.needsUpdate = true;
  }
  regolithMaps.map.colorSpace = THREE.SRGBColorSpace;

  // Scale the map so the soil averages a real lunar albedo. Terrain vertex
  // colours carry only relative variation (mean 1) and baked shadow.
  const soilGain = REGOLITH_ALBEDO / assets.regolith.meanAlbedo;
  assets.regolithTint = new THREE.Color(soilGain, soilGain * 0.975, soilGain * 0.93);

  assets.regolithMaterial = new THREE.MeshStandardMaterial({
    ...regolithMaps,
    color: assets.regolithTint,
    vertexColors: true,
    roughness: 1,
    metalness: 0,
    normalScale: new THREE.Vector2(0.85, 0.85),
    dithering: true,
  });
  // Regolith scatters like regolith, not like matte paint — see photometry.js.
  applyLunarPhotometry(assets.regolithMaterial);
  // Break up the 12 m tile and resolve the ground on final approach.
  // Shared by the other regolith surfaces (pad deck, far field) so they match
  // the terrain they sit on.
  assets.regolithDetail = { mapMean: assets.regolith.meanAlbedo, environment: false };
  applyRegolithDetail(assets.regolithMaterial, assets.regolithDetail);

  assets.boulderMaterial = new THREE.MeshStandardMaterial({
    map: assets.regolith.map,
    normalMap: assets.regolith.normalMap,
    // Exposed rock is a little brighter than the gardened soil around it.
    color: assets.regolithTint.clone().multiplyScalar(1.25),
    roughness: 0.95,
    metalness: 0,
    flatShading: true,
  });
  // Weaker on boulders: their faceting is what makes them read as rock.
  applyLunarPhotometry(assets.boulderMaterial, 0.4);

  // --- Spacecraft ------------------------------------------------------
  // Multi-layer insulation is crinkled Kapton, not a mirror — it scatters
  // strongly. Keeping roughness up matters here because unfiltered sunlight
  // on a near-mirror metal produces specular hotspots that blow out.
  assets.foilMaterial = new THREE.MeshStandardMaterial({
    map: assets.foil.map,
    normalMap: assets.foil.normalMap,
    roughnessMap: assets.foil.roughnessMap,
    color: 0xdcb478,
    metalness: 0.5,
    roughness: 0.64,
    // A strong normal map on a semi-metal under a hard sun turns every crease
    // into a sub-pixel specular spike, so at any distance the foil glittered
    // like sequins. At 0.9 the crinkle still reads and the sparkle is gone.
    normalScale: new THREE.Vector2(0.9, 0.9),
  });

  assets.foilDarkMaterial = new THREE.MeshStandardMaterial({
    map: assets.foilDark.map,
    normalMap: assets.foilDark.normalMap,
    roughnessMap: assets.foilDark.roughnessMap,
    // Black Kapton / thermal paint, which covered much of the ascent stage.
    color: 0x34322f,
    metalness: 0.35,
    roughness: 0.62,
    normalScale: new THREE.Vector2(0.8, 0.8),
  });

  // Anodised aluminium skin panels: satin, faintly metallic, seamed.
  assets.panelMaterial = new THREE.MeshStandardMaterial({
    map: assets.panel.map,
    normalMap: assets.panel.normalMap,
    roughnessMap: assets.panel.roughnessMap,
    color: 0xbfc2c4,
    metalness: 0.45,
    roughness: 0.5,
    normalScale: new THREE.Vector2(0.6, 0.6),
  });

  assets.metalMaterial = new THREE.MeshStandardMaterial({
    color: 0xb9bfc4,
    metalness: 0.7,
    roughness: 0.46,
  });

  // Engine bell: heat-tinted, sooted niobium alloy.
  assets.engineMaterial = new THREE.MeshStandardMaterial({
    color: 0x4a4038,
    metalness: 0.75,
    roughness: 0.48,
    side: THREE.DoubleSide,
  });

  // Footpads were gold-foil-wrapped dishes, scuffed by the regolith.
  assets.footpadMaterial = new THREE.MeshStandardMaterial({
    map: assets.foil.map,
    normalMap: assets.foil.normalMap,
    color: 0xc9b184,
    metalness: 0.6,
    roughness: 0.55,
  });

  assets.probeMaterial = new THREE.MeshStandardMaterial({
    color: 0x9a9a96,
    metalness: 0.7,
    roughness: 0.45,
  });

  // Window panes: dark, slightly reflective, with only a hint of cabin light.
  // Real LM windows read as near-black voids in surface photography.
  assets.glassMaterial = new THREE.MeshStandardMaterial({
    color: 0x080d12,
    // Low metalness and a matt-ish finish: the LM's panes carried an
    // anti-reflective coating, and a glossy metal here mirrors the sun into
    // two blazing white panels instead of reading as windows.
    metalness: 0.15,
    roughness: 0.38,
    emissive: 0x0c1a22,
    emissiveIntensity: 0.35,
    side: THREE.DoubleSide,
  });

  assets.dishMaterial = new THREE.MeshStandardMaterial({
    color: 0xe6e6e2,
    metalness: 0.35,
    roughness: 0.42,
    side: THREE.DoubleSide,
  });

  // --- Physics materials (tags only; the lander is never solver-driven) ---
  assets.groundPhysMaterial = new CANNON.Material("ground");
  assets.landerPhysMaterial = new CANNON.Material("lander");
  assets.contactMaterial = new CANNON.ContactMaterial(
    assets.groundPhysMaterial,
    assets.landerPhysMaterial,
    { friction: 0.9, restitution: 0.0 }
  );

  onProgress(1, "Ready");
  return assets;
}

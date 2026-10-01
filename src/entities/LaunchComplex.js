import * as THREE from "three";
import { mergeMeshes } from "../core/mergeStatic.js";
import { makeRng } from "../materials/noise.js";

// ---------------------------------------------------------------------------
// Launch Complex 39A: the mobile launcher platform, the umbilical tower with
// its swing arms, the flame trench and deflector, and the surrounding coastal
// terrain.
//
// This exists for the first few kilometres of flight — it is what gives the
// liftoff a sense of scale — and is faded out once the vehicle is high enough
// that it would be a couple of pixels.
// ---------------------------------------------------------------------------

const TOWER_HEIGHT = 120;
const PLATFORM_SIZE = 49;

export default class LaunchComplex {
  constructor(scene, assets, mission) {
    this.scene = scene;
    this.assets = assets;
    this.mission = mission;
    this.rng = makeRng(39061969);

    this.group = new THREE.Group();
    this.group.name = "launchComplex";
    scene.add(this.group);

    this._buildMaterials();
    this._buildGround();
    this._buildPlatform();
    this._buildTower();
    this._buildFlameTrench();
    this._buildSupport();

    this.group.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
  }

  _buildMaterials() {
    const a = this.assets;
    this.steel = new THREE.MeshStandardMaterial({
      color: 0x8a8f94,
      metalness: 0.78,
      roughness: 0.46,
      map: a.panel.map,
      normalMap: a.panel.normalMap,
      roughnessMap: a.panel.roughnessMap,
    });
    this.paintedSteel = new THREE.MeshStandardMaterial({
      color: 0x9d3f2c, // the tower's oxide-red structural paint
      metalness: 0.35,
      roughness: 0.66,
      map: a.panel.map,
      normalMap: a.panel.normalMap,
    });
    // Pale hardstand concrete. This used to borrow the lunar regolith maps,
    // which put craters on the ground at Kennedy.
    a.concrete.map.repeat.set(32, 32);
    a.concrete.normalMap.repeat.set(32, 32);
    this.concrete = new THREE.MeshStandardMaterial({
      color: 0xd9d6cf,
      metalness: 0,
      roughness: 0.9,
      map: a.concrete.map,
      normalMap: a.concrete.normalMap,
      normalScale: new THREE.Vector2(0.6, 0.6),
    });
    this.darkSteel = new THREE.MeshStandardMaterial({
      color: 0x3c4045,
      metalness: 0.6,
      roughness: 0.6,
    });
  }

  /**
   * The pad's local ground: a concrete apron ringed by Florida scrub and
   * water, out to the point where the sky scene's Earth takes over.
   */
  _buildGround() {
    // Concrete apron.
    const apron = new THREE.Mesh(
      new THREE.CircleGeometry(260, 48),
      this.concrete
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = 0.05;
    apron.receiveShadow = true;
    this.group.add(apron);

    // Surrounding land and sea out to the horizon, from a baked map of the
    // Cape: scrub and marsh, the beach and the Atlantic to the east (the
    // reason launches fly out over water), and the crawlerway to the west.
    //
    // This was a 64-segment circle carrying per-vertex colours — which, with
    // one vertex at the centre and 64 on the rim, blended to a single flat
    // green: the ocean and the scrub never appeared.
    const GROUND_EXTENT = 26000;
    const groundGeo = new THREE.PlaneGeometry(GROUND_EXTENT, GROUND_EXTENT, 1, 1);
    groundGeo.rotateX(-Math.PI / 2);
    // Lit and hazed by the same atmosphere model as the sky (EarthScene
    // feeds `groundLight` and `hazeColor` every frame), so where this plane
    // ends and the sky shader's planet begins there is nothing to see.
    this.groundMaterial = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: this.assets.capeGround },
        hazeColor: { value: new THREE.Color(0.3, 0.4, 0.55) },
        groundLight: { value: new THREE.Color(2, 2, 2) },
        viewHeight: { value: 0 },
        opacity: { value: 1 },
        halfExtent: { value: GROUND_EXTENT / 2 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vWorld;
        void main() {
          vUv = uv;
          // World position, not distance: the plane has only four vertices,
          // so a per-vertex distance would be ~18 km everywhere. Position
          // interpolates exactly across a flat triangle; distance does not.
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        uniform vec3 hazeColor;
        uniform vec3 groundLight;
        uniform float viewHeight;   // m
        uniform float opacity;
        uniform float halfExtent;
        varying vec2 vUv;
        varying vec3 vWorld;
        void main() {
          // Lambertian ground under sun plus skylight.
          vec3 albedo = texture2D(map, vUv).rgb;
          vec3 col = albedo * groundLight / 3.14159265;

          // Aerial perspective through an exponential atmosphere: optical
          // depth along the path at its mean height, Rayleigh plus haze.
          float dKm = length(vWorld - cameraPosition) / 1000.0;
          float hKm = max((viewHeight + vWorld.y) * 0.5, 0.0) / 1000.0;
          vec3 beta = vec3(5.802e-3, 13.558e-3, 33.1e-3) * exp(-hKm / 8.0)
                    + vec3(4.44e-3) * exp(-hKm / 1.2);
          vec3 T = exp(-beta * dKm);
          col = col * T + hazeColor * (1.0 - T);

          // Feather the far edge so the sky shader's planet takes over.
          float r = max(abs(vWorld.x), abs(vWorld.z)) / halfExtent;
          float edge = 1.0 - smoothstep(0.75, 1.0, r);
          gl_FragColor = vec4(col, opacity * edge);
        }
      `,
      transparent: true,
      depthWrite: false,
    });
    this.ground = new THREE.Mesh(groundGeo, this.groundMaterial);
    this.ground.position.y = -0.4;
    this.group.add(this.ground);
  }

  /** Mobile launcher platform: the two-storey steel base with its exhaust hole. */
  _buildPlatform() {
    const platform = new THREE.Group();
    platform.position.y = 0;

    // Deck with a square hole for the exhaust, built as four slabs.
    const holeHalf = 9;
    const half = PLATFORM_SIZE / 2;
    const deckThickness = 7.6;
    const slabs = [
      [(-half - -holeHalf) / 2 - holeHalf / 2 - (half - holeHalf) / 2, PLATFORM_SIZE],
    ];
    void slabs;

    const makeSlab = (w, d, x, z) => {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(w, deckThickness, d), this.steel);
      slab.position.set(x, deckThickness / 2, z);
      platform.add(slab);
    };
    const side = (half - holeHalf) / 2;
    makeSlab(PLATFORM_SIZE, side * 2, 0, holeHalf + side);
    makeSlab(PLATFORM_SIZE, side * 2, 0, -holeHalf - side);
    makeSlab(side * 2, holeHalf * 2, holeHalf + side, 0);
    makeSlab(side * 2, holeHalf * 2, -holeHalf - side, 0);

    // Hold-down arms around the exhaust hole.
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(2.2, 5.4, 2.2), this.darkSteel);
      arm.position.set(Math.cos(ang) * 7.4, deckThickness + 2.7, Math.sin(ang) * 7.4);
      platform.add(arm);
    }

    // Support pedestals lifting the platform above the trench.
    for (const [px, pz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
      const ped = new THREE.Mesh(
        new THREE.BoxGeometry(6, 6.2, 6),
        this.concrete
      );
      ped.position.set(px * (half - 5), -3.1, pz * (half - 5));
      platform.add(ped);
    }

    this.group.add(platform);
    this.platform = platform;
    this.deckHeight = deckThickness;
  }

  /** Launch umbilical tower with swing arms and the hammerhead crane. */
  _buildTower() {
    const tower = new THREE.Group();
    tower.position.set(-30, 0, 0);

    const legOffset = 5.2;
    const legRadius = 0.55;
    // The static lattice is collected here and baked into one mesh at the
    // end — see core/mergeStatic.js. Only the swing arms and strobes animate.
    const lattice = [];

    // Four corner columns.
    for (const [sx, sz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
      const leg = new THREE.Mesh(
        new THREE.CylinderGeometry(legRadius, legRadius, TOWER_HEIGHT, 10),
        this.paintedSteel
      );
      leg.position.set(sx * legOffset, TOWER_HEIGHT / 2 + this.deckHeight, sz * legOffset);
      lattice.push(leg);
    }

    // Horizontal bracing every few metres, with diagonals — the open lattice
    // is what makes the tower read as a tower rather than a slab.
    const levels = 18;
    for (let i = 1; i <= levels; i++) {
      const y = this.deckHeight + (i / levels) * TOWER_HEIGHT;
      for (const axis of ["x", "z"]) {
        for (const s of [-1, 1]) {
          const beam = new THREE.Mesh(
            new THREE.BoxGeometry(
              axis === "x" ? legOffset * 2 : 0.34,
              0.34,
              axis === "x" ? 0.34 : legOffset * 2
            ),
            this.paintedSteel
          );
          beam.position.set(
            axis === "x" ? 0 : s * legOffset,
            y,
            axis === "x" ? s * legOffset : 0
          );
          lattice.push(beam);
        }
      }
      // Diagonals on two faces.
      if (i < levels) {
        const h = TOWER_HEIGHT / levels;
        const diagLen = Math.hypot(legOffset * 2, h);
        for (const s of [-1, 1]) {
          const diag = new THREE.Mesh(
            new THREE.BoxGeometry(0.26, diagLen, 0.26),
            this.paintedSteel
          );
          diag.position.set(0, y + h / 2, s * legOffset);
          diag.rotation.z = Math.atan2(legOffset * 2, h) * (i % 2 === 0 ? 1 : -1);
          lattice.push(diag);
        }
      }
    }

    // Swing arms reaching across to the vehicle.
    this.swingArms = [];
    const armHeights = [26, 44, 62, 80, 96, 108];
    for (const h of armHeights) {
      const arm = new THREE.Group();
      const boom = new THREE.Mesh(new THREE.BoxGeometry(24, 1.6, 2.6), this.paintedSteel);
      boom.position.set(12, 0, 0);
      arm.add(boom);
      const head = new THREE.Mesh(new THREE.BoxGeometry(3.4, 3.0, 3.4), this.darkSteel);
      head.position.set(23, 0, 0);
      arm.add(head);
      arm.position.set(legOffset, this.deckHeight + h, 0);
      tower.add(arm);
      this.swingArms.push(arm);
    }

    // Hammerhead crane on top.
    const crane = new THREE.Mesh(new THREE.BoxGeometry(34, 1.8, 2.2), this.paintedSteel);
    crane.position.set(8, this.deckHeight + TOWER_HEIGHT + 3, 0);
    lattice.push(crane);
    const mast = new THREE.Mesh(new THREE.BoxGeometry(2.2, 7, 2.2), this.paintedSteel);
    mast.position.set(0, this.deckHeight + TOWER_HEIGHT + 3.5, 0);
    lattice.push(mast);

    // ~115 primitives, one draw call (two with the shadow pass) instead of
    // ~230.
    tower.add(mergeMeshes(lattice, this.paintedSteel));

    // Warning strobes up the tower.
    this.strobes = [];
    for (const h of [40, 75, 110, 124]) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0xff3020,
        emissiveIntensity: 2,
        roughness: 0.4,
      });
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 8), mat);
      lamp.position.set(0, this.deckHeight + h, legOffset + 0.8);
      tower.add(lamp);
      this.strobes.push(mat);
    }

    this.group.add(tower);
    this.tower = tower;
  }

  /** Flame trench and the wedge deflector that splits the exhaust. */
  _buildFlameTrench() {
    const trench = new THREE.Group();
    trench.position.y = -0.1;

    // Trench walls.
    for (const s of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(150, 12, 3), this.concrete);
      wall.position.set(0, -6, s * 14);
      trench.add(wall);
    }
    const floor = new THREE.Mesh(new THREE.BoxGeometry(150, 1.5, 28), this.concrete);
    floor.position.set(0, -12, 0);
    trench.add(floor);

    // The deflector: a steel-clad wedge under the exhaust hole that throws
    // the plume out both ends of the trench.
    const wedgeShape = new THREE.Shape();
    wedgeShape.moveTo(-13, -11);
    wedgeShape.lineTo(13, -11);
    wedgeShape.lineTo(0, 0);
    wedgeShape.closePath();
    const wedge = new THREE.Mesh(
      new THREE.ExtrudeGeometry(wedgeShape, { depth: 26, bevelEnabled: false }),
      this.darkSteel
    );
    wedge.rotation.y = Math.PI / 2;
    wedge.position.set(13, 0, -13);
    trench.add(wedge);

    this.group.add(trench);
    this.trench = trench;
  }

  /** Lightning masts, water towers and the surrounding pad furniture. */
  _buildSupport() {
    // Lightning mast on top of the tower is modelled as a tall spire.
    const spire = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.4, 26, 8),
      this.steel
    );
    spire.position.set(-30, this.deckHeight + TOWER_HEIGHT + 19, 0);
    this.group.add(spire);

    // Water tower for the sound-suppression system.
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 14, 20), this.steel);
    tank.position.set(72, 28, -58);
    this.group.add(tank);
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 22, 8), this.steel);
      leg.position.set(72 + Math.cos(ang) * 4.5, 11, -58 + Math.sin(ang) * 4.5);
      this.group.add(leg);
    }

    // Perimeter floodlight masts.
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2;
      const x = Math.cos(ang) * 120;
      const z = Math.sin(ang) * 120;
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 24, 8), this.steel);
      mast.position.set(x, 12, z);
      this.group.add(mast);
    }
  }

  /**
   * The pad only matters for the first few kilometres. Fading it out (rather
   * than popping it) keeps the transition to the high-altitude view smooth.
   */
  /**
   * Haze and light from the sky model, and the height the scene is seen
   * from. Called by EarthScene every frame.
   */
  setView(cameraHeight, hazeColor, groundLight) {
    this._viewHeight = cameraHeight;
    const u = this.groundMaterial.uniforms;
    u.viewHeight.value = cameraHeight;
    u.hazeColor.value.copy(hazeColor);
    u.groundLight.value.copy(groundLight);
  }

  update(dt, altitude, elapsed) {
    // Faded on the *camera's* height: the pad camera stays on the ground
    // while the vehicle climbs, and must keep its ground under it.
    const h = this._viewHeight ?? altitude;
    const fade = 1 - THREE.MathUtils.clamp((h - 4000) / 6000, 0, 1);
    this.group.visible = fade > 0.01;
    if (!this.group.visible) return;

    this.groundMaterial.uniforms.opacity.value = fade;

    // Strobes flash asynchronously, as real obstruction lights do.
    this.strobes.forEach((mat, i) => {
      const phase = (elapsed * 1.1 + i * 0.37) % 1;
      mat.emissiveIntensity = phase < 0.09 ? 9 : 0.6;
    });
  }

  /** Swings the umbilical arms clear at liftoff. */
  releaseArms() {
    this._armsReleasing = true;
  }

  updateArms(dt) {
    if (!this._armsReleasing) return;
    let done = true;
    for (const arm of this.swingArms) {
      const target = -Math.PI * 0.62;
      arm.rotation.y = THREE.MathUtils.lerp(arm.rotation.y, target, 1 - Math.exp(-2.2 * dt));
      if (Math.abs(arm.rotation.y - target) > 0.02) done = false;
    }
    if (done) this._armsReleasing = false;
  }

  dispose() {
    this.scene.remove(this.group);
    // Materials were created here, so they are ours to free too — previously
    // only geometry was, and every launch left its materials and their GPU
    // programs behind.
    const materials = new Set();
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) materials.add(o.material);
    });
    for (const m of materials) m.dispose();
  }
}

// The world view: a story's painting, given depth by Atlas and extended all the way around.
//
// A world is a set of "posed RGBD" views: each is a picture, a depth map and the camera it was
// seen from. Every view is drawn twice:
//   - as a far panel, the picture projected to the horizon, so there is never a hole to see through;
//   - as a relief, the picture pushed out to its true depth, so near things move against far things.
// Where views overlap, the one facing most nearly the way the reader is looking wins. That keeps the
// original painting pristine straight ahead and lets Atlas's views take over as the reader turns.
import * as THREE from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';

const FAR = 6000;
const RAD = Math.PI / 180;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const damp = (current, target, rate, dt) => current + (target - current) * (1 - Math.exp(-rate * dt));

const PROJECT = /* glsl */`
  uniform vec4 uK;            // fx, fy, cx, cy in pixels
  uniform vec2 uSize;         // picture size in pixels
  uniform mat4 uPose;         // camera-to-world, looking down -Z with +Y up
  uniform float uBias;
  vec4 place(vec2 uv, float z) {
    vec2 px = vec2(uv.x, 1.0 - uv.y) * uSize;
    vec3 inCamera = vec3((px.x - uK.z) / uK.x * z, -(px.y - uK.w) / uK.y * z, -z);
    vec4 inView = viewMatrix * (uPose * vec4(inCamera, 1.0));
    inView.xyz *= 1.0 + uBias;   // slide along the reader's line of sight: same pixel, lower priority
    return projectionMatrix * inView;
  }
`;
const DITHER = /* glsl */`
  float grain(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
  float edge(vec2 uv, float width) {
    vec2 e = min(uv, 1.0 - uv);
    return smoothstep(0.0, width, min(e.x, e.y));
  }
`;

function reliefMaterial(view, grid) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: view.map }, uDepth: { value: view.depth }, uK: { value: view.k }, uSize: { value: view.size },
      uPose: { value: view.pose }, uBias: { value: 0 }, uReveal: { value: 0 },
      uStep: { value: new THREE.Vector2(1 / grid[0], 1 / grid[1]) }, uFar: { value: FAR },
    },
    vertexShader: /* glsl */`
      uniform sampler2D uDepth; uniform vec2 uStep; uniform float uFar;
      varying vec2 vUv; varying float vCut;
      ${PROJECT}
      float nearness(vec2 uv) { float z = texture2D(uDepth, uv).r; return z > 0.0 ? 1.0 / z : 0.0; }
      void main() {
        vUv = uv;
        float d = nearness(uv);
        // A flat surface is a straight line in 1/depth, however steeply it is seen. A bend in that
        // line is the edge of one thing in front of another: cut there instead of smearing across.
        float h = abs(nearness(uv - vec2(uStep.x, 0.0)) + nearness(uv + vec2(uStep.x, 0.0)) - 2.0 * d);
        float v = abs(nearness(uv - vec2(0.0, uStep.y)) + nearness(uv + vec2(0.0, uStep.y)) - 2.0 * d);
        vCut = d > 0.0 ? smoothstep(0.10, 0.22, max(h, v) / d) : 1.0;
        gl_Position = place(uv, d > 0.0 ? 1.0 / d : uFar);
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uMap; uniform float uReveal;
      varying vec2 vUv; varying float vCut;
      ${DITHER}
      void main() {
        if (vCut > 0.5) discard;
        float keep = edge(vUv, 0.06) * uReveal;
        if (keep < 0.999 && keep <= grain(gl_FragCoord.xy)) discard;
        gl_FragColor = texture2D(uMap, vUv);
        #include <colorspace_fragment>
      }`,
  });
}

function panelMaterial(view) {
  return new THREE.ShaderMaterial({
    transparent: true, depthTest: false, depthWrite: false,
    uniforms: { uMap: { value: view.map }, uK: { value: view.k }, uSize: { value: view.size }, uPose: { value: view.pose }, uBias: { value: 0 }, uReveal: { value: 0 }, uFar: { value: FAR }, uFeather: { value: 0.1 } },
    vertexShader: /* glsl */`
      uniform float uFar; varying vec2 vUv;
      ${PROJECT}
      void main() { vUv = uv; gl_Position = place(uv, uFar); }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uMap; uniform float uReveal; uniform float uFeather; varying vec2 vUv;
      ${DITHER}
      void main() {
        gl_FragColor = vec4(texture2D(uMap, vUv).rgb, edge(vUv, uFeather) * uReveal);
        #include <colorspace_fragment>
      }`,
  });
}

export class WorldView {
  constructor(renderer, { quality = 'full' } = {}) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.03, FAR * 4);
    this.grid = quality === 'economy' ? [200, 112] : quality === 'balanced' ? [288, 162] : [400, 225];
    this.reliefGeometry = new THREE.PlaneGeometry(1, 1, this.grid[0], this.grid[1]);
    this.panelGeometry = new THREE.PlaneGeometry(1, 1, 1, 1);
    this.views = [];
    this.generation = 0;
    this.images = new THREE.TextureLoader();
    this.depths = new EXRLoader().setDataType(THREE.FloatType);
    this.look = { yaw: 0, pitch: 0, yawTo: 0, pitchTo: 0, fov: 50, fovTo: 50, lean: new THREE.Vector2(), leanTo: new THREE.Vector2(), walk: new THREE.Vector3(), walkTo: new THREE.Vector3() };
    this.cover = null;
    this.home = { position: new THREE.Vector3(), heading: 0, pitch: 0 };
    this.reach = 0.2;                               // how far the reader may lean, in scene units
    this.keys = new Set();
    this.elapsed = 0;
    this.arrival = 1;
    this.motes = this.#makeMotes();
    this.scene.add(this.motes);
    this.backdrop = this.#makeBackdrop();
    this.scene.add(this.backdrop);
    this.splat = null;
  }

  #makeMotes() {
    const count = 260, positions = new Float32Array(count * 3), seeds = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      positions.set([Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1], i * 3);
      seeds[i] = Math.random();
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    const material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uSpan: { value: 4 }, uColour: { value: new THREE.Color('#ffe9c4') }, uScale: { value: 1 }, uAmount: { value: 0 } },
      vertexShader: /* glsl */`
        attribute float aSeed; uniform float uTime, uSpan, uScale; varying float vGlow;
        void main() {
          vec3 drift = position + vec3(0.013, 0.021, 0.008) * uTime * (0.4 + aSeed) + 0.06 * vec3(sin(uTime * 0.3 + aSeed * 40.0), cos(uTime * 0.23 + aSeed * 31.0), 0.0);
          vec3 cell = (fract(drift * 0.5 + 0.5) * 2.0 - 1.0) * uSpan;      // wrap around the reader
          vec4 inView = viewMatrix * vec4(cameraPosition + cell, 1.0);
          float distance = max(0.2, -inView.z);
          vGlow = smoothstep(uSpan, uSpan * 0.35, length(cell)) * smoothstep(0.15, 0.6, distance / uSpan) * (0.45 + 0.55 * sin(uTime * (0.6 + aSeed) + aSeed * 60.0));
          gl_PointSize = uScale * (1.5 + 3.0 * aSeed) * uSpan / distance;
          gl_Position = projectionMatrix * inView;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColour; uniform float uAmount; varying float vGlow;
        void main() {
          float fall = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5));
          gl_FragColor = vec4(uColour, fall * fall * vGlow * uAmount);
        }`,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = 10;
    return points;
  }

  // Behind everything: the painting's own sky over its own ground, so that wherever no view reaches
  // the reader sees haze in the colours of the place and not a hole.
  #makeBackdrop() {
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthTest: false, depthWrite: false,
      uniforms: { uSky: { value: new THREE.Color('#1b1a22') }, uMid: { value: new THREE.Color('#141318') }, uGround: { value: new THREE.Color('#0c0b0e') } },
      vertexShader: /* glsl */`
        varying vec3 vDirection;
        void main() {
          vDirection = position;
          gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * position * 100.0, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uSky, uMid, uGround; varying vec3 vDirection;
        void main() {
          float height = normalize(vDirection).y;
          vec3 colour = height > 0.0 ? mix(uMid, uSky, smoothstep(0.0, 0.45, height)) : mix(uMid, uGround, smoothstep(0.0, -0.4, height));
          gl_FragColor = vec4(colour, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), material);
    mesh.frustumCulled = false; mesh.renderOrder = -1000;
    return mesh;
  }

  resize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.motes.material.uniforms.uScale.value = height / 900 * this.renderer.getPixelRatio();
  }

  setPalette({ sky = '#1b1a22', ground = '#0c0b0e', light = '#ffe9c4' } = {}) {
    const top = new THREE.Color(sky), bottom = new THREE.Color(ground);
    const uniforms = this.backdrop.material.uniforms;
    uniforms.uSky.value.copy(top).multiplyScalar(0.82);
    uniforms.uGround.value.copy(bottom).multiplyScalar(0.7);
    uniforms.uMid.value.copy(top).lerp(bottom, 0.5).multiplyScalar(0.78);
    this.background = uniforms.uMid.value.clone();
    this.motes.material.uniforms.uColour.value.set(light).lerp(new THREE.Color('#ffffff'), 0.35);
  }

  clear() {
    this.generation += 1;
    this.worldKey = '';
    for (const view of this.views) this.#drop(view);
    this.views = [];
    this.#dropSplat();
  }

  #drop(view) {
    this.scene.remove(view.relief, view.panel);
    view.relief?.material.dispose(); view.panel.material.dispose();
    view.map.dispose(); view.depth?.dispose();
  }

  #view(map, depth, camera, extra) {
    const { intrinsics: k, extrinsics: e } = camera;
    const view = {
      map, depth, ...extra,
      k: new THREE.Vector4(k.fx, k.fy, k.cx, k.cy), size: new THREE.Vector2(k.width, k.height),
      pose: new THREE.Matrix4().compose(new THREE.Vector3(...e.position), new THREE.Quaternion(...e.quaternion), new THREE.Vector3(1, 1, 1)),
      reveal: 0, revealTo: 1, delay: extra.delay ?? 0,
    };
    view.forward = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(...e.quaternion));
    view.panel = new THREE.Mesh(this.panelGeometry, panelMaterial(view));
    view.panel.frustumCulled = false;
    this.scene.add(view.panel);
    if (depth) {
      view.relief = new THREE.Mesh(this.reliefGeometry, reliefMaterial(view, this.grid));
      view.relief.frustumCulled = false;
      this.scene.add(view.relief);
    }
    return view;
  }

  async #loadDepth(url) {
    const texture = await this.depths.loadAsync(url);
    const { width, height, data } = texture.image;
    const channels = Math.round(data.length / (width * height));
    const clean = new Float32Array(width * height), sample = [];
    for (let i = 0; i < clean.length; i += 1) {
      const z = data[i * channels];
      clean[i] = Number.isFinite(z) && z > 0 ? z : 0;          // no surface here: the far panel shows through
      if (clean[i] && i % 97 === 0) sample.push(clean[i]);
    }
    texture.dispose();
    const depth = new THREE.DataTexture(clean, width, height, THREE.RedFormat, THREE.FloatType);
    depth.minFilter = depth.magFilter = THREE.NearestFilter;
    depth.needsUpdate = true;
    sample.sort((a, b) => a - b);
    return { depth, near: sample[Math.floor(sample.length * 0.03)] ?? 2, middle: sample[Math.floor(sample.length * 0.5)] ?? 10 };
  }

  async #loadImage(url) {
    const map = await this.images.loadAsync(url);
    map.colorSpace = THREE.SRGBColorSpace;
    map.minFilter = THREE.LinearFilter;               // no mipmaps: the picture is seen near 1:1
    map.generateMipmaps = false;
    return map;
  }

  /** The bare painting, before any world exists: hung at the horizon, no depth. */
  async showPainting(scene) {
    const generation = (this.clear(), this.generation);
    const map = await this.#loadImage(scene.src);
    if (generation !== this.generation) return map.dispose();
    const width = map.image.width, height = map.image.height, hfov = 68 * RAD;
    const fx = width / (2 * Math.tan(hfov / 2));
    const camera = { intrinsics: { fx, fy: fx, cx: width / 2, cy: height / 2, width, height }, extrinsics: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] } };
    const view = this.#view(map, null, camera, { label: 'painting' });
    view.panel.material.uniforms.uFeather.value = 0.02;
    this.views = [view];
    this.home = { position: new THREE.Vector3(), heading: 0, pitch: 0 };
    this.reach = 0;
    const vfov = 2 * Math.atan(height / (2 * fx));
    this.#settle();
    this.#frame({ hfov, vfov, full: false, sweep: 0, tilt: 0 });
  }

  /**
   * A generated world. Views appear as they load: the painting first, then its surroundings
   * unfurling outward from it.
   */
  async showWorld(world, { fresh = false } = {}) {
    const key = `${world.slug}/${world.scene}`;
    const [first, ...rest] = world.frames;
    let generation;
    if (this.worldKey === key && this.views.length === 1 && this.views[0].origin) {
      generation = this.generation;                    // depth is already up: only add the surroundings
    } else {
      generation = (this.clear(), this.generation);
      const origin = await this.#loadFrame(first, 0);
      if (generation !== this.generation) return this.#drop(origin);
      this.views = [origin];
      this.worldKey = key;
      this.home = { position: new THREE.Vector3(...world.home.position), heading: world.home.heading, pitch: world.home.pitch };
      this.reach = clamp(origin.near * 0.07, 0.04, 0.45);
      this.motes.material.uniforms.uSpan.value = clamp(origin.near * 1.6, 1.5, 14);
      this.#settle();
    }
    const sweep = Math.max(0, ...rest.map(f => Math.abs(f.yaw))), tilt = Math.max(0, ...rest.map(f => Math.abs(f.pitch)));
    this.#frame({ hfov: world.home.hfov, vfov: world.home.vfov, full: sweep >= 150, sweep, tilt });
    await Promise.all(rest.map(async frame => {
      const order = Math.abs(frame.yaw) / 180 + Math.abs(frame.pitch) / 90;       // nearest the painting first
      const view = await this.#loadFrame(frame, fresh ? 0.4 + order * 2.4 : 0.1 + order * 0.5).catch(() => null);
      if (!view) return;
      if (generation !== this.generation) return this.#drop(view);
      this.views.push(view);
    }));
  }

  async #loadFrame(frame, delay) {
    const [map, loaded] = await Promise.all([this.#loadImage(frame.image), this.#loadDepth(frame.depth)]);
    const view = this.#view(map, loaded.depth, frame.camera, { label: frame.label, delay, origin: frame.label === 'origin' });
    view.near = loaded.near;
    return view;
  }

  #frame({ hfov, vfov, full, sweep, tilt }) {
    // How far the reader may turn before running out of picture.
    this.cover = { hfov, vfov, full, sweep: sweep * RAD, tilt: tilt * RAD };
    this.baseFov = sweep ? 52 : clamp(vfov / RAD * 0.86, 28, 46);
    this.look.fovTo = this.baseFov;
    this.#bound();
  }

  #settle() {
    Object.assign(this.look, { yaw: 0, yawTo: 0, pitch: 0, pitchTo: 0, fov: this.look.fovTo + 7 });
    this.look.lean.set(0, 0); this.look.leanTo.set(0, 0); this.look.walk.set(0, 0, 0); this.look.walkTo.set(0, 0, 0);
  }

  // ---------------------------------------------------------------- optional Gaussian splat

  async showSplat(src) {
    const { SparkRenderer, SplatMesh } = await import('@sparkjsdev/spark');
    this.#dropSplat();
    const spark = new SparkRenderer({ renderer: this.renderer });
    const mesh = new SplatMesh({ url: src });
    this.scene.add(spark, mesh);
    this.splat = { spark, mesh };
    for (const view of this.views) { view.revealTo = 0; }
    this.reach = Math.max(this.reach, 0.6) * 2.5;
  }

  #dropSplat() {
    if (!this.splat) return;
    this.scene.remove(this.splat.spark, this.splat.mesh);
    this.splat.mesh.dispose?.();
    this.splat = null;
  }

  hideSplat() { this.#dropSplat(); for (const view of this.views) view.revealTo = 1; }

  // ---------------------------------------------------------------- input

  drag(dx, dy) {
    const perPixel = this.look.fov * RAD / this.renderer.domElement.clientHeight;
    this.look.yawTo -= dx * perPixel * 1.15;
    this.look.pitchTo += dy * perPixel * 1.15;
    this.#bound();
  }

  point(x, y) { this.look.leanTo.set(x, y); }            // pointer position, -1..1: a slight lean
  zoom(delta) { this.look.fovTo = clamp(this.look.fovTo + delta * 0.03, this.baseFov * 0.55, this.baseFov * 1.12); this.#bound(); }
  key(code, down) { down ? this.keys.add(code) : this.keys.delete(code); }
  recentre() { this.look.yawTo = Math.round(this.look.yaw / (2 * Math.PI)) * 2 * Math.PI; this.look.pitchTo = 0; this.look.walkTo.set(0, 0, 0); this.look.fovTo = this.baseFov; }

  #bound() {
    const c = this.cover, look = this.look;
    if (!c) return;
    const viewV = look.fovTo * RAD, viewH = 2 * Math.atan(Math.tan(viewV / 2) * this.camera.aspect);
    // Tilted views reach (tilt + half a frame) from level; stay a few degrees inside that.
    const reachV = c.tilt ? c.tilt + c.vfov / 2 - 5 * RAD : c.vfov / 2;
    const pitch = Math.max(0, reachV - viewV / 2);
    if (!c.full) {
      const yaw = Math.max(0, c.sweep + c.hfov / 2 - viewH / 2 - (c.sweep ? 4 * RAD : 0));
      look.yawTo = clamp(look.yawTo, -yaw, yaw);
    }
    look.pitchTo = clamp(look.pitchTo, -pitch, pitch);
  }

  // ---------------------------------------------------------------- frame

  update(dt, { still = false } = {}) {
    this.elapsed += dt;
    const look = this.look, reach = this.reach;
    const turn = (this.keys.has('ArrowRight') || this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('ArrowLeft') || this.keys.has('KeyA') ? 1 : 0);
    const push = (this.keys.has('ArrowUp') || this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('ArrowDown') || this.keys.has('KeyS') ? 1 : 0);
    if (turn) { look.yawTo += turn * dt * 0.9; this.#bound(); }
    if (push) look.walkTo.z = clamp(look.walkTo.z + push * dt * reach * 2.2, -reach * 1.5, reach * 2.5);

    look.yaw = damp(look.yaw, look.yawTo, 7, dt);
    look.pitch = damp(look.pitch, look.pitchTo, 7, dt);
    look.fov = damp(look.fov, look.fovTo, 3, dt);
    look.lean.x = damp(look.lean.x, look.leanTo.x, 2.5, dt);
    look.lean.y = damp(look.lean.y, look.leanTo.y, 2.5, dt);
    look.walk.lerp(look.walkTo, 1 - Math.exp(-3 * dt));

    const sway = still ? 0 : 1, t = this.elapsed;
    const heading = this.home.heading - look.yaw;
    const forward = new THREE.Vector3(-Math.sin(heading), 0, -Math.cos(heading));
    const right = new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading));
    this.camera.position.copy(this.home.position)
      .addScaledVector(right, reach * (look.lean.x * 1.0 + sway * 0.22 * Math.sin(t * 0.21)))
      .addScaledVector(forward, look.walk.z + reach * sway * 0.18 * Math.sin(t * 0.13 + 1.3))
      .add(new THREE.Vector3(0, reach * (-look.lean.y * 0.45 + sway * 0.1 * Math.sin(t * 0.17 + 0.6)), 0));
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.home.pitch * 0.5 + look.pitch, heading, 0, 'YXZ'));
    if (Math.abs(this.camera.fov - look.fov) > 0.01) { this.camera.fov = look.fov; this.camera.updateProjectionMatrix(); }

    // Priority: the view that faces the way the reader is looking is drawn in front.
    const gaze = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const ranked = this.views.map(view => ({ view, away: Math.acos(clamp(gaze.dot(view.forward), -1, 1)) - (view.origin ? 0.2 : 0) }))
      .sort((a, b) => b.away - a.away);
    ranked.forEach(({ view, away }, index) => {
      view.delay = Math.max(0, view.delay - dt);
      if (view.delay === 0) view.reveal = damp(view.reveal, view.revealTo, view.origin ? 6 : 1.6, dt);
      const bias = Math.max(-0.01, away) * 0.045;
      view.panel.renderOrder = -100 + index;
      view.panel.visible = view.reveal > 0.002;
      view.panel.material.uniforms.uReveal.value = view.reveal;
      view.panel.material.uniforms.uBias.value = bias;
      if (view.relief) {
        view.relief.visible = view.reveal > 0.002;
        view.relief.material.uniforms.uReveal.value = view.reveal;
        view.relief.material.uniforms.uBias.value = bias;
      }
    });
    const motes = this.motes.material.uniforms;
    motes.uTime.value = t;
    motes.uAmount.value = damp(motes.uAmount.value, this.reach > 0 && !still ? 0.55 : 0, 1, dt);
  }

  render() {
    this.renderer.setClearColor(this.background ?? 0x08080a, 1);
    this.renderer.render(this.scene, this.camera);
  }
}

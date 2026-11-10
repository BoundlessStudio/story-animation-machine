// Camera rig for Atlas view generation.
// Atlas cameras are camera-to-world poses. In "rub" the camera looks along local -Z with +Y up,
// which is the Three.js convention, in a gravity-levelled Y-up world. Quaternions are XYZW.

const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qAxis = (axis, rad) => { const s = Math.sin(rad / 2); return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(rad / 2)]; };
const qNorm = q => { const n = Math.hypot(...q) || 1; return q.map(v => v / n); };
const qRotate = (q, v) => {
  const [x, y, z, w] = q, [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
};
const rad = deg => deg * Math.PI / 180;

/**
 * Describe the context camera: where it stands, its compass heading and how far it is tilted.
 */
export function describeCamera(camera) {
  const e = camera.extrinsics;
  if ((e.coordinateSystem ?? 'rub') !== 'rub') throw new Error('Expected a rub camera from images2PosedRGBD');
  const f = qRotate(e.quaternion, [0, 0, -1]);
  const horizontal = Math.hypot(f[0], f[2]) || 1e-6;
  return {
    position: e.position,
    forward: [f[0] / horizontal, 0, f[2] / horizontal],        // level heading
    right: [-f[2] / horizontal, 0, f[0] / horizontal],
    heading: Math.atan2(-f[0], -f[2]),                          // rotation about +Y; 0 looks down -Z
    pitch: Math.atan2(f[1], horizontal),
    hfov: 2 * Math.atan(camera.intrinsics.width / (2 * camera.intrinsics.fx)),
    vfov: 2 * Math.atan(camera.intrinsics.height / (2 * camera.intrinsics.fy)),
  };
}

/**
 * Views that let a reader stand where the painter stood and look around.
 *
 * The only space known to be empty is what the painting shows in front of the painter, out to the
 * nearest thing in it. So the cameras stand on a small ring just ahead of the painter's eye, each
 * facing outward: the view straight behind is taken from the eye itself and none of them backs
 * into a wall the painting never showed. The ring gives every view a baseline against its
 * neighbours (Atlas needs translation to recover depth, and parallax is what makes the result feel
 * like a place). Neighbouring views share about half their frame.
 *
 * `near` is the distance to the nearest surfaces in the painting; `sweep` is how far to either
 * side the ring reaches, and 180 closes the circle.
 *
 * @returns {{ label: string, yaw: number, pitch: number, camera: object }[]}
 */
export function planRig(contextCamera, { near = 2, sweep = 180, down = true, up = true, steps = true } = {}) {
  const c = describeCamera(contextCamera);
  const deg = v => v * 180 / Math.PI;
  const full = sweep >= 180;
  const ringRadius = Math.max(0.04, Math.min(0.4, near * 0.2));
  const ideal = Math.max(30, Math.min(45, deg(c.hfov) * 0.52));
  const stepDeg = full ? 360 / Math.round(360 / ideal) : ideal;
  const yaws = [];
  for (let a = stepDeg; a <= (full ? 180 : sweep) + 0.01; a += stepDeg) {
    yaws.push(-a);
    if (!(full && Math.abs(a - 180) < 0.01)) yaws.push(a);      // straight behind is one view, not two
  }

  const centre = [0, 1, 2].map(i => c.position[i] + ringRadius * c.forward[i]);
  const pose = (yawDeg, pitchDeg, { lift = 0, slide = 0 } = {}) => {
    const yaw = rad(yawDeg);
    // Outward-facing: the camera looking back (yaw 180) sits at the painter's eye.
    const position = [0, 1, 2].map(i =>
      centre[i] - ringRadius * (Math.cos(yaw) * c.forward[i] + Math.sin(yaw) * c.right[i]) * (Math.abs(yawDeg) > 90 ? 1 : -1) + slide * c.right[i]);
    position[1] += lift;
    // Turning right is a negative rotation about +Y; pitch is applied in the camera's own frame.
    const q = qNorm(qMul(qAxis([0, 1, 0], c.heading - yaw), qAxis([1, 0, 0], c.pitch + rad(pitchDeg))));
    return { extrinsics: { position, quaternion: q, coordinateSystem: 'rub' }, intrinsics: { ...contextCamera.intrinsics } };
  };
  const name = (prefix, yaw) => `${prefix}${yaw >= 0 ? '+' : ''}${Math.round(yaw)}`;

  const views = yaws.map(yaw => ({ label: name('yaw', yaw), yaw, pitch: 0, camera: pose(yaw, 0) }));
  const tilt = Math.min(40, deg(c.vfov) * 0.75);
  // The tilted rows close the picture above and below the level ring. Their views must overlap
  // each other as well as the ring, or the reader sees through the gaps: eight to a row, starting
  // with the way the painter faced.
  const perRow = Math.max(8, Math.ceil(360 / (deg(c.hfov) * 0.8)));
  const row = full
    ? Array.from({ length: perRow }, (_, i) => { const yaw = i * 360 / perRow; return yaw > 180 ? yaw - 360 : yaw; })
    : [0, -sweep * 0.5, sweep * 0.5, -sweep, sweep];
  if (down) {
    for (const yaw of row) {
      views.push({ label: name('down', yaw), yaw, pitch: -tilt, camera: pose(yaw, -tilt, { lift: ringRadius * 0.3 }) });
    }
  }
  if (up) {
    for (const yaw of row) {
      views.push({ label: name('up', yaw), yaw, pitch: tilt, camera: pose(yaw, tilt, { lift: -ringRadius * 0.2 }) });
    }
  }
  if (steps) {
    views.push({ label: 'step-left', yaw: 0, pitch: 0, camera: pose(0, 0, { slide: -ringRadius * 1.4 }) });
    views.push({ label: 'step-right', yaw: 0, pitch: 0, camera: pose(0, 0, { slide: ringRadius * 1.4 }) });
  }
  return views;
}

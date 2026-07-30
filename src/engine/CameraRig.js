/**
 * @file CameraRig.js
 * @description The stereoscopic camera system.
 *
 * The rig is a three-level hierarchy, and that structure is what makes real
 * stereo possible without ever duplicating the world:
 *
 * ```
 *   rig    — world position and base heading, driven by the story
 *    └ head — head orientation, driven by sensors or pointer
 *       ├ eyeLeft   (−IPD/2)
 *       ├ eyeRight  (+IPD/2)
 *       └ mono      (centre, used for flat preview and WebXR)
 * ```
 *
 * The two eye cameras are genuine, independent `PerspectiveCamera` objects with
 * their own world matrices and their own projection matrices. Stereo depth is
 * produced by **parallel cameras with asymmetric frusta**, not by toeing the
 * cameras inward. Toe-in is the common shortcut and it is wrong: converging the
 * optical axes introduces vertical parallax toward the frame corners, which the
 * visual system cannot fuse and which is a major cause of eye strain in
 * home-made VR demos. An asymmetric frustum shifts the projection horizontally
 * instead, so corresponding points differ only in horizontal disparity — which
 * is exactly what human stereopsis expects.
 */

import { Group, MathUtils, PerspectiveCamera, Quaternion, Raycaster, Vector3 } from 'three';
import { clamp, damp, dampAngle, noise1D } from './Utils.js';

const _forward = new Vector3();
const _worldPos = new Vector3();
const _q = new Quaternion();

/**
 * Stereoscopic camera rig with adjustable interpupillary distance and
 * convergence.
 * @class
 */
export class CameraRig {
  /**
   * @param {object} [options] Configuration.
   * @param {number} [options.ipd] Interpupillary distance in metres. The human
   *   average is 0.064 m; the practical range is roughly 0.055–0.072 m.
   * @param {number} [options.convergence] Distance in metres at which the eyes'
   *   frusta converge — the plane that appears at the screen's depth.
   * @param {number} [options.fov] Vertical field of view in degrees.
   * @param {number} [options.near] Near clipping plane.
   * @param {number} [options.far] Far clipping plane.
   */
  constructor(options = {}) {
    const {
      ipd = 0.064,
      convergence = 4.5,
      fov = 62,
      near = 0.08,
      far = 260,
    } = options;

    /** @type {Group} World-space carrier: position and base heading. */
    this.rig = new Group();
    this.rig.name = 'CameraRig';

    /** @type {Group} Head node: receives tracked orientation. */
    this.head = new Group();
    this.head.name = 'Head';
    this.rig.add(this.head);

    /** @type {number} Interpupillary distance in metres. */
    this.ipd = ipd;
    /** @type {number} Convergence distance in metres. */
    this.convergence = convergence;
    /** @type {number} Vertical field of view in degrees. */
    this.fov = fov;
    /** @type {number} */
    this.near = near;
    /** @type {number} */
    this.far = far;
    /** @type {number} Aspect ratio of a single eye viewport. */
    this.aspect = 1;

    /** @type {PerspectiveCamera} Left eye. */
    this.eyeLeft = new PerspectiveCamera(fov, 1, near, far);
    this.eyeLeft.name = 'EyeLeft';
    /** @type {PerspectiveCamera} Right eye. */
    this.eyeRight = new PerspectiveCamera(fov, 1, near, far);
    this.eyeRight.name = 'EyeRight';
    /** @type {PerspectiveCamera} Centre camera for flat preview and WebXR. */
    this.mono = new PerspectiveCamera(fov, 1, near, far);
    this.mono.name = 'CameraMono';

    this.head.add(this.eyeLeft, this.eyeRight, this.mono);
    this.#layoutEyes();

    /** @type {Vector3} Position the rig eases toward. */
    this.targetPosition = new Vector3(0, 1.68, 9);
    /** @type {number} Base heading the rig eases toward, in radians. */
    this.targetYaw = 0;
    this.rig.position.copy(this.targetPosition);

    /** @type {number} Positional convergence rate. */
    this.moveLambda = 1.6;
    /** @type {number} Heading convergence rate. */
    this.turnLambda = 1.9;

    /**
     * Subtle idle motion applied to the rig. Enabled for the flat preview,
     * where it reads as a hand-held cinematic camera, and **always disabled**
     * in stereo: unrequested head motion is one of the fastest ways to make a
     * viewer ill.
     * @type {number}
     */
    this.bobAmount = 0;
    /** @type {number} Internal clock for idle motion. */
    this._bobTime = Math.random() * 100;

    /** @type {Raycaster} Shared ray used for gaze picking. */
    this.raycaster = new Raycaster();
    this.raycaster.far = 40;
  }

  /**
   * Places the eyes symmetrically about the head origin.
   * @private
   */
  #layoutEyes() {
    const half = this.ipd * 0.5;
    this.eyeLeft.position.set(-half, 0, 0);
    this.eyeRight.position.set(half, 0, 0);
    this.mono.position.set(0, 0, 0);
  }

  /**
   * Sets the interpupillary distance and rebuilds the eye layout.
   * @param {number} metres Distance between pupils, clamped to a safe range.
   */
  setIPD(metres) {
    this.ipd = clamp(metres, 0.045, 0.085);
    this.#layoutEyes();
    this.updateProjection();
  }

  /**
   * Sets the convergence (focus) distance.
   *
   * Objects at this distance have zero disparity and appear at the depth of the
   * viewer's screen. Nearer objects pop toward the viewer, farther objects
   * recede. Setting it near the subject — here, the engine — keeps the most
   * important content comfortable to fuse.
   * @param {number} metres Convergence distance.
   */
  setConvergence(metres) {
    this.convergence = clamp(metres, 0.5, 100);
    this.updateProjection();
  }

  /**
   * Sets the vertical field of view. Viewer optics want a wide field (75–90°);
   * the flat preview looks more cinematic narrower (50–65°).
   * @param {number} degrees Vertical FOV.
   */
  setFov(degrees) {
    this.fov = clamp(degrees, 30, 110);
    this.updateProjection();
  }

  /**
   * Recomputes projection matrices for both eyes and the mono camera.
   *
   * The asymmetric frustum is built from the standard symmetric one by shifting
   * the horizontal extents by `±(ipd/2) · near / convergence` — the projection
   * of half the eye separation onto the near plane at the convergence distance.
   *
   * @param {number} [aspect] Aspect ratio of a **single eye** viewport.
   */
  updateProjection(aspect = this.aspect) {
    this.aspect = aspect;

    for (const cam of [this.eyeLeft, this.eyeRight, this.mono]) {
      cam.fov = this.fov;
      cam.near = this.near;
      cam.far = this.far;
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
    }

    const near = this.near;
    const top = near * Math.tan(MathUtils.DEG2RAD * this.fov * 0.5);
    const bottom = -top;
    const halfWidth = top * aspect;
    const shift = (this.ipd * 0.5) * near / this.convergence;

    // Left eye: frustum shifted right, so its optical axis stays parallel to
    // the right eye's while both converge on the focus plane.
    this.#applyFrustum(this.eyeLeft, -halfWidth + shift, halfWidth + shift, top, bottom);
    this.#applyFrustum(this.eyeRight, -halfWidth - shift, halfWidth - shift, top, bottom);
  }

  /**
   * Writes an off-axis perspective projection into a camera.
   * @param {PerspectiveCamera} camera Target camera.
   * @param {number} left Left frustum extent at the near plane.
   * @param {number} right Right frustum extent at the near plane.
   * @param {number} top Top frustum extent at the near plane.
   * @param {number} bottom Bottom frustum extent at the near plane.
   * @private
   */
  #applyFrustum(camera, left, right, top, bottom) {
    camera.projectionMatrix.makePerspective(
      left, right, top, bottom, this.near, this.far,
      camera.coordinateSystem,
    );
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }

  /**
   * Sets the rig's target position; the rig eases toward it.
   * @param {number} x World X.
   * @param {number} y World Y — eye height, typically 1.6–1.75 m.
   * @param {number} z World Z.
   */
  moveTo(x, y, z) {
    this.targetPosition.set(x, y, z);
  }

  /**
   * Sets the rig's base heading. Head tracking is applied on top of this, so
   * the story can reorient the world without stealing the viewer's control.
   * @param {number} radians Target heading.
   */
  faceTo(radians) {
    this.targetYaw = radians;
  }

  /**
   * Teleports the rig, skipping easing. Used at scene cuts, where a smooth
   * translation would read as drifting rather than editing.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} [yaw] Heading.
   */
  snapTo(x, y, z, yaw = this.targetYaw) {
    this.targetPosition.set(x, y, z);
    this.targetYaw = yaw;
    this.rig.position.set(x, y, z);
    this.rig.rotation.y = yaw;
  }

  /**
   * Applies a tracked head orientation.
   * @param {Quaternion} quaternion World-space head orientation.
   */
  setHeadOrientation(quaternion) {
    this.head.quaternion.copy(quaternion);
  }

  /**
   * Advances rig easing and idle motion.
   * @param {number} dt Delta time in seconds.
   */
  update(dt) {
    const p = this.rig.position;
    p.x = damp(p.x, this.targetPosition.x, this.moveLambda, dt);
    p.y = damp(p.y, this.targetPosition.y, this.moveLambda, dt);
    p.z = damp(p.z, this.targetPosition.z, this.moveLambda, dt);
    this.rig.rotation.y = dampAngle(this.rig.rotation.y, this.targetYaw, this.turnLambda, dt);

    if (this.bobAmount > 0) {
      this._bobTime += dt;
      const t = this._bobTime;
      this.head.position.set(
        noise1D(t * 0.31) * 0.012 * this.bobAmount,
        noise1D(t * 0.27 + 40) * 0.010 * this.bobAmount,
        noise1D(t * 0.19 + 80) * 0.008 * this.bobAmount,
      );
    } else if (this.head.position.lengthSq() > 0) {
      this.head.position.set(0, 0, 0);
    }

    this.rig.updateMatrixWorld(true);
  }

  /**
   * The world-space forward direction of the viewer's gaze.
   * @param {Vector3} [target] Optional vector to write into.
   * @returns {Vector3}
   */
  getGazeDirection(target = _forward) {
    this.head.getWorldQuaternion(_q);
    return target.set(0, 0, -1).applyQuaternion(_q).normalize();
  }

  /**
   * The world-space position of the viewer's eyes (their midpoint).
   * @param {Vector3} [target] Optional vector to write into.
   * @returns {Vector3}
   */
  getEyePosition(target = _worldPos) {
    return this.mono.getWorldPosition(target);
  }

  /**
   * Configures the shared raycaster to shoot straight down the gaze axis and
   * returns it, ready for intersection tests.
   * @returns {Raycaster}
   */
  getGazeRay() {
    this.getEyePosition(_worldPos);
    this.getGazeDirection(_forward);
    this.raycaster.set(_worldPos, _forward);
    return this.raycaster;
  }

  /**
   * Applies a preset appropriate to the active presentation mode.
   * @param {'stereo'|'flat'|'xr'} mode Presentation mode.
   */
  applyModeDefaults(mode) {
    if (mode === 'stereo') {
      // Wide field to fill viewer optics, no idle motion, gentler easing.
      this.setFov(78);
      this.bobAmount = 0;
      this.moveLambda = 1.15;
      this.turnLambda = 1.3;
    } else if (mode === 'xr') {
      // The XR runtime owns projection entirely; only easing matters here.
      this.bobAmount = 0;
      this.moveLambda = 1.15;
      this.turnLambda = 1.3;
    } else {
      this.setFov(58);
      this.bobAmount = 1;
      this.moveLambda = 1.7;
      this.turnLambda = 2.0;
    }
  }
}

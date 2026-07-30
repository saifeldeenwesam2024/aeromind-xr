/**
 * @file vendor.mjs
 * @description Re-vendors the Three.js runtime into `vendor/three/`.
 *
 * The experience must run with no network connection, so it does not import
 * Three.js from a CDN or from `node_modules` at run time. Instead, exactly the
 * modules it uses are copied into `vendor/`, which is the directory the import
 * map in `index.html` points at. `node_modules` is a build-time convenience
 * only and can be deleted without affecting the deployed application.
 *
 * Run after changing the Three.js version:
 *
 *     npm install
 *     npm run vendor
 *
 * Usage: `node tools/vendor.mjs`
 */

import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'node_modules', 'three');
const TARGET = join(ROOT, 'vendor', 'three');

/**
 * Files copied from the Three.js package, as paths relative to it. Every entry
 * is imported — directly or transitively — by `src/`. Keeping the list explicit
 * rather than copying the whole package is what holds the vendored payload to
 * about 3 MB instead of 40 MB.
 * @type {Array<[string, string]>} Pairs of [source, destination].
 */
const FILES = [
  ['build/three.module.js', 'three.module.js'],

  ['examples/jsm/controls/OrbitControls.js', 'addons/controls/OrbitControls.js'],

  ['examples/jsm/loaders/GLTFLoader.js', 'addons/loaders/GLTFLoader.js'],
  ['examples/jsm/loaders/DRACOLoader.js', 'addons/loaders/DRACOLoader.js'],
  ['examples/jsm/loaders/RGBELoader.js', 'addons/loaders/RGBELoader.js'],

  ['examples/jsm/postprocessing/EffectComposer.js', 'addons/postprocessing/EffectComposer.js'],
  ['examples/jsm/postprocessing/Pass.js', 'addons/postprocessing/Pass.js'],
  ['examples/jsm/postprocessing/MaskPass.js', 'addons/postprocessing/MaskPass.js'],
  ['examples/jsm/postprocessing/RenderPass.js', 'addons/postprocessing/RenderPass.js'],
  ['examples/jsm/postprocessing/ShaderPass.js', 'addons/postprocessing/ShaderPass.js'],
  ['examples/jsm/postprocessing/UnrealBloomPass.js', 'addons/postprocessing/UnrealBloomPass.js'],
  ['examples/jsm/postprocessing/OutputPass.js', 'addons/postprocessing/OutputPass.js'],

  ['examples/jsm/shaders/CopyShader.js', 'addons/shaders/CopyShader.js'],
  ['examples/jsm/shaders/LuminosityHighPassShader.js', 'addons/shaders/LuminosityHighPassShader.js'],
  ['examples/jsm/shaders/OutputShader.js', 'addons/shaders/OutputShader.js'],

  ['examples/jsm/utils/BufferGeometryUtils.js', 'addons/utils/BufferGeometryUtils.js'],
  ['examples/jsm/environments/RoomEnvironment.js', 'addons/environments/RoomEnvironment.js'],

  // Draco decoder, used only when an optional compressed glTF model is present.
  ['examples/jsm/libs/draco/gltf/draco_decoder.js', 'addons/libs/draco/gltf/draco_decoder.js'],
  ['examples/jsm/libs/draco/gltf/draco_decoder.wasm', 'addons/libs/draco/gltf/draco_decoder.wasm'],
  ['examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js', 'addons/libs/draco/gltf/draco_wasm_wrapper.js'],
];

/**
 * Verifies that the Three.js package is installed.
 * @returns {Promise<string>} The installed version.
 */
async function readVersion() {
  try {
    const pkg = JSON.parse(await readFile(join(SOURCE, 'package.json'), 'utf8'));
    return pkg.version;
  } catch {
    throw new Error(
      'three is not installed. Run `npm install` before `npm run vendor`.',
    );
  }
}

/**
 * Copies the file list into `vendor/three/`.
 * @returns {Promise<void>}
 */
async function main() {
  const version = await readVersion();

  await rm(TARGET, { recursive: true, force: true });

  let bytes = 0;
  for (const [from, to] of FILES) {
    const source = join(SOURCE, from);
    const destination = join(TARGET, to);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination);
    bytes += (await stat(destination)).size;
  }

  const megabytes = (bytes / 1024 / 1024).toFixed(2);
  console.log(`Vendored three@${version} → vendor/three/`);
  console.log(`${FILES.length} files, ${megabytes} MB.`);
}

main().catch((error) => {
  console.error(`[vendor] ${error.message}`);
  process.exitCode = 1;
});

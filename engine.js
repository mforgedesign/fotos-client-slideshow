import createGLTransition from "./vendor/gl-transition-motion.mjs";
import { CONFIG, EFFECTS, PHOTOS } from "./runtime-data.mjs";
import {
  createEffectSequence,
  createMotionPlans,
  durationForMode,
  timelineStateAt,
  transitionCountForMode,
} from "./timeline.mjs";

const motionUniforms = {
  _fromMotion: "vec4",
  _toMotion: "vec4",
  _fromMotionProgress: "float",
  _toMotionProgress: "float",
  _fromSize: "vec2",
  _toSize: "vec2",
};

export async function createSlideshowEngine({
  root,
  canvas,
  mode = CONFIG.mode,
  width = CONFIG.canvas.width,
  height = CONFIG.canvas.height,
  lazyPhotos = false,
  imageCacheSize = 4,
} = {}) {
  if (!root || !canvas) throw new TypeError("root and canvas elements are required");
  if (mode !== "finite" && mode !== "loop") throw new RangeError(`Unknown timeline mode: ${mode}`);
  if (!Number.isInteger(width) || width < 2 || !Number.isInteger(height) || height < 2) {
    throw new RangeError("canvas dimensions must be positive integers");
  }
  if (!Number.isInteger(imageCacheSize) || imageCacheSize < 2) {
    throw new RangeError("imageCacheSize must be an integer of at least two");
  }
  if (PHOTOS.length < 1) throw new Error("The photo manifest must contain at least one photo");
  if (EFFECTS.length !== 11) throw new Error(`Expected 11 bundled GL transitions, found ${EFFECTS.length}`);

  let renderWidth = width;
  let renderHeight = height;
  canvas.width = renderWidth;
  canvas.height = renderHeight;
  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    powerPreference: "low-power",
  });
  if (!gl) throw new Error("WebGL is unavailable in this browser");

  const images = lazyPhotos ? null : await preloadLocalPhotos(PHOTOS);
  const imageCache = lazyPhotos ? new Map() : null;
  const pendingImages = lazyPhotos ? new Map() : null;
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 4, 4, -1]), gl.STATIC_DRAW);

  const transitions = new Map();
  try {
    for (const effect of EFFECTS) {
      const runtimeEffect = {
        ...effect,
        paramsTypes: { ...(effect.paramsTypes ?? {}), ...motionUniforms },
        defaultParams: {
          ...(effect.defaultParams ?? {}),
          _fromMotion: [1, 1, 0, 0],
          _toMotion: [1, 1, 0, 0],
          _fromMotionProgress: 0,
          _toMotionProgress: 0,
          _fromSize: [1, 1],
          _toSize: [1, 1],
        },
      };
      transitions.set(effect.name, createGLTransition(gl, runtimeEffect, { resizeMode: "contain" }));
    }
  } catch (error) {
    for (const transition of transitions.values()) transition.dispose();
    gl.deleteBuffer(quad);
    throw new Error(`Could not compile the bundled GL transition set: ${error.message}`, { cause: error });
  }

  const effectNames = EFFECTS.map((effect) => effect.name);
  const transitionCount = transitionCountForMode(PHOTOS.length, mode);
  const effectSequence = createEffectSequence(effectNames, transitionCount, CONFIG.seeds.effects);
  let motionPlans = createMotionPlans(PHOTOS, {
    width: renderWidth,
    height: renderHeight,
    seed: CONFIG.seeds.motion,
    maxZoom: CONFIG.motion.maxZoom,
    panRoomFactor: CONFIG.motion.panRoomFactor,
  });
  const duration = durationForMode(
    PHOTOS.length,
    CONFIG.timing.holdSeconds,
    CONFIG.timing.transitionSeconds,
    mode,
  );
  const textureCache = new Map();
  const textureLimit = 4;
  const packageOrigin = new URL(import.meta.url).origin;

  function textureForPhoto(index) {
    const cached = textureCache.get(index);
    if (cached) {
      textureCache.delete(index);
      textureCache.set(index, cached);
      return cached;
    }

    const photo = PHOTOS[index];
    const image = lazyPhotos ? imageCache.get(index) : images[index];
    if (!image) {
      throw new Error(`Photo ${index} is not ready; await engine.prepareAt(time) before rendering`);
    }
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    const wrapped = {
      shape: [photo.width, photo.height],
      bind(unit) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        return unit;
      },
      dispose() {
        gl.deleteTexture(texture);
      },
    };
    textureCache.set(index, wrapped);
    if (textureCache.size > textureLimit) {
      const oldestIndex = textureCache.keys().next().value;
      textureCache.get(oldestIndex).dispose();
      textureCache.delete(oldestIndex);
    }
    return wrapped;
  }

  function stateAt(time) {
    const state = timelineStateAt({
      time,
      mode,
      photoCount: PHOTOS.length,
      holdSeconds: CONFIG.timing.holdSeconds,
      transitionSeconds: CONFIG.timing.transitionSeconds,
    });
    const effectName = state.effectIndex === null
      ? effectNames[0]
      : effectSequence[state.effectIndex];
    return {
      ...state,
      effectName,
      fromMotion: motionPlans[state.fromIndex],
      toMotion: motionPlans[state.toIndex],
    };
  }

  async function ensurePhotoImage(index) {
    if (imageCache.has(index)) {
      const image = imageCache.get(index);
      imageCache.delete(index);
      imageCache.set(index, image);
      return image;
    }
    if (pendingImages.has(index)) return pendingImages.get(index);

    const pending = preloadLocalPhoto(PHOTOS[index]).then((image) => {
      imageCache.set(index, image);
      while (imageCache.size > imageCacheSize) {
        imageCache.delete(imageCache.keys().next().value);
      }
      return image;
    }).finally(() => pendingImages.delete(index));
    pendingImages.set(index, pending);
    return pending;
  }

  async function prepareAt(time) {
    const state = stateAt(time);
    const indexes = [...new Set([state.fromIndex, state.toIndex])];
    if (lazyPhotos) await Promise.all(indexes.map(ensurePhotoImage));
    return { time: state.time, photoIndexes: indexes };
  }

  function renderAt(time) {
    const state = stateAt(time);
    const transition = transitions.get(state.effectName);
    if (!transition) throw new Error(`No compiled transition named ${state.effectName}`);

    gl.viewport(0, 0, renderWidth, renderHeight);
    gl.clearColor(0.035, 0.043, 0.039, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    transition.draw(
      state.progress,
      textureForPhoto(state.fromIndex),
      textureForPhoto(state.toIndex),
      renderWidth,
      renderHeight,
      {
        _fromMotion: state.fromMotion.values,
        _toMotion: state.toMotion.values,
        _fromMotionProgress: state.fromMotionProgress,
        _toMotionProgress: state.toMotionProgress,
        _fromSize: [PHOTOS[state.fromIndex].width, PHOTOS[state.fromIndex].height],
        _toSize: [PHOTOS[state.toIndex].width, PHOTOS[state.toIndex].height],
      },
    );
    return state;
  }

  function verifySeekOrder(times) {
    if (!Array.isArray(times) || times.length < 2) {
      throw new TypeError("times must contain at least two seek timestamps");
    }
    const hashesByTime = new Map();
    const observations = [];
    const pixels = new Uint8Array(renderWidth * renderHeight * 4);
    for (const time of times) {
      const state = renderAt(time);
      gl.finish();
      gl.readPixels(0, 0, renderWidth, renderHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const hash = hashPixels(pixels);
      const timeKey = Number(time).toPrecision(15);
      const priorHash = hashesByTime.get(timeKey);
      if (priorHash !== undefined && priorHash !== hash) {
        throw new Error(`Seek-order pixel mismatch at ${timeKey}s: ${priorHash} != ${hash}`);
      }
      hashesByTime.set(timeKey, hash);
      observations.push({ time: state.time, effect: state.effectName, pixelHash: hash });
    }
    renderAt(0);
    return { uniqueTimestamps: hashesByTime.size, observations };
  }

  function dispose() {
    for (const texture of textureCache.values()) texture.dispose();
    textureCache.clear();
    for (const transition of transitions.values()) transition.dispose();
    transitions.clear();
    imageCache?.clear();
    pendingImages?.clear();
    gl.deleteBuffer(quad);
  }

  function resize(nextWidth, nextHeight) {
    if (!Number.isInteger(nextWidth) || nextWidth < 2 || !Number.isInteger(nextHeight) || nextHeight < 2) {
      throw new RangeError("canvas dimensions must be positive integers");
    }
    renderWidth = nextWidth;
    renderHeight = nextHeight;
    canvas.width = renderWidth;
    canvas.height = renderHeight;
    motionPlans = createMotionPlans(PHOTOS, {
      width: renderWidth,
      height: renderHeight,
      seed: CONFIG.seeds.motion,
      maxZoom: CONFIG.motion.maxZoom,
      panRoomFactor: CONFIG.motion.panRoomFactor,
    });
  }

  return {
    mode,
    get width() { return renderWidth; },
    get height() { return renderHeight; },
    duration,
    fps: CONFIG.fps,
    photoCount: PHOTOS.length,
    effectNames,
    effectSequence,
    get motionPlans() { return motionPlans; },
    stateAt,
    prepareAt,
    renderAt,
    verifySeekOrder,
    resize,
    dispose,
    assetOrigin: packageOrigin,
  };
}

async function preloadLocalPhotos(photos) {
  return Promise.all(photos.map(preloadLocalPhoto));
}

async function preloadLocalPhoto(photo) {
  const packageOrigin = new URL(import.meta.url).origin;
  const source = new URL(photo.file, import.meta.url);
  if (source.origin !== packageOrigin) {
    throw new Error(`Photo ${photo.file} is outside the local slideshow package`);
  }
  const image = new Image();
  image.decoding = "async";
  image.src = source.href;
  await image.decode();
  if (image.naturalWidth !== photo.width || image.naturalHeight !== photo.height) {
    throw new Error(`Photo dimensions differ from the manifest for ${photo.file}`);
  }
  return image;
}

function hashPixels(pixels) {
  let hash = 2166136261;
  for (let index = 0; index < pixels.length; index += 1) {
    hash ^= pixels[index];
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

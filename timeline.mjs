const UINT32_RANGE = 0x100000000;

export function toUint32Seed(seed) {
  if (Number.isInteger(seed)) return seed >>> 0;
  const text = String(seed);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function createSeededUint32(seed) {
  let state = toUint32Seed(seed) || 0x6d2b79f5;
  return function nextUint32() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

export function createUniformPicker(seed) {
  const nextUint32 = createSeededUint32(seed);
  return function pickIndex(count) {
    if (!Number.isInteger(count) || count < 1) {
      throw new RangeError("count must be a positive integer");
    }
    const limit = UINT32_RANGE - (UINT32_RANGE % count);
    let value;
    do {
      value = nextUint32();
    } while (value >= limit);
    return value % count;
  };
}

export function createEffectSequence(effectNames, transitionCount, seed) {
  if (!Array.isArray(effectNames) || effectNames.length === 0) {
    throw new TypeError("effectNames must contain at least one effect");
  }
  if (!Number.isInteger(transitionCount) || transitionCount < 0) {
    throw new RangeError("transitionCount must be a non-negative integer");
  }
  const pickIndex = createUniformPicker(seed);
  return Array.from({ length: transitionCount }, () => effectNames[pickIndex(effectNames.length)]);
}

export function createMotionPlans(photos, {
  width,
  height,
  seed,
  maxZoom = 1.14,
  panRoomFactor = 0.88,
}) {
  if (!Array.isArray(photos) || photos.length === 0) {
    throw new TypeError("photos must contain at least one photo");
  }
  if (!(width > 0) || !(height > 0)) {
    throw new RangeError("motion canvas dimensions must be positive");
  }
  const pickIndex = createUniformPicker(seed);
  const stageRatio = width / height;
  let previousType = null;

  return photos.map((photo, index) => {
    const imageRatio = photo.width / photo.height;
    const fitWidth = Math.min(imageRatio / stageRatio, 1);
    const portraitWithRoom = photo.height > photo.width && fitWidth < 0.92;
    const choices = portraitWithRoom
      ? ["zoom-in", "zoom-out", "pan-right"]
      : ["zoom-in", "zoom-out"];
    const available = choices.filter((choice) => choice !== previousType);
    const type = (available.length ? available : choices)[pickIndex((available.length ? available : choices).length)];
    previousType = type;

    if (type === "zoom-out") {
      return { index, type, values: [maxZoom, 1, 0, 0] };
    }
    if (type === "pan-right") {
      const room = Math.max(0, (1 - fitWidth) / 2) * panRoomFactor;
      return { index, type, values: [1, 1, -room, room] };
    }
    return { index, type, values: [1, maxZoom, 0, 0] };
  });
}

export function durationForMode(photoCount, holdSeconds, transitionSeconds, mode) {
  assertTiming(photoCount, holdSeconds, transitionSeconds, mode);
  const cycles = mode === "loop" ? photoCount : Math.max(0, photoCount - 1);
  const duration = photoCount * holdSeconds + cycles * transitionSeconds;
  return Math.round(duration * 1e6) / 1e6;
}

export function transitionCountForMode(photoCount, mode) {
  if (!Number.isInteger(photoCount) || photoCount < 1) {
    throw new RangeError("photoCount must be a positive integer");
  }
  if (mode === "finite") return Math.max(0, photoCount - 1);
  if (mode === "loop") return photoCount;
  throw new RangeError(`Unknown timeline mode: ${mode}`);
}

export function smoothstep01(value) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

export function timelineStateAt({
  time,
  mode,
  photoCount,
  holdSeconds,
  transitionSeconds,
}) {
  assertTiming(photoCount, holdSeconds, transitionSeconds, mode);
  const cycleSeconds = holdSeconds + transitionSeconds;
  const duration = durationForMode(photoCount, holdSeconds, transitionSeconds, mode);
  let sampleTime;
  if (mode === "loop") {
    sampleTime = ((Number(time) % duration) + duration) % duration;
  } else {
    sampleTime = Math.max(0, Math.min(duration, Number(time)));
  }

  const cycleIndex = Math.floor(sampleTime / cycleSeconds);
  const photoIndex = mode === "loop"
    ? cycleIndex % photoCount
    : Math.min(photoCount - 1, cycleIndex);
  const cycleStart = cycleIndex * cycleSeconds;
  const offset = sampleTime - cycleStart;
  const hasNextPhoto = mode === "loop" || photoIndex < photoCount - 1;
  const transitioning = hasNextPhoto && offset >= holdSeconds;
  const fromIndex = photoIndex;
  const toIndex = transitioning ? (photoIndex + 1) % photoCount : photoIndex;
  const progress = transitioning
    ? Math.max(0, Math.min(1, (offset - holdSeconds) / transitionSeconds))
    : 0;
  const fromMotionStart = mode === "loop" && photoIndex === 0
    ? -transitionSeconds
    : (photoIndex === 0 ? 0 : photoIndex * cycleSeconds - transitionSeconds);
  const fromMotionProgress = smoothstep01((sampleTime - fromMotionStart) / cycleSeconds);
  const toMotionProgress = transitioning
    ? smoothstep01((sampleTime - (cycleStart + holdSeconds)) / cycleSeconds)
    : fromMotionProgress;
  const effectIndex = hasNextPhoto ? photoIndex : null;

  return {
    mode,
    duration,
    time: sampleTime,
    photoIndex,
    fromIndex,
    toIndex,
    transitioning,
    transitionIndex: transitioning ? photoIndex : null,
    effectIndex,
    progress,
    fromMotionProgress,
    toMotionProgress,
  };
}

function assertTiming(photoCount, holdSeconds, transitionSeconds, mode) {
  if (!Number.isInteger(photoCount) || photoCount < 1) {
    throw new RangeError("photoCount must be a positive integer");
  }
  if (!(holdSeconds > 0) || !(transitionSeconds > 0)) {
    throw new RangeError("hold and transition durations must be positive");
  }
  if (mode !== "finite" && mode !== "loop") {
    throw new RangeError(`Unknown timeline mode: ${mode}`);
  }
}

// ====== Simple i18n dictionary ======
const i18n = {
  en: {
    open: "Open…",
    save: "Save",
    signals: "Signals",
    annotations: "Annotations",
    file: "File ▼",
    layout: "Layout ▼",
    clickToLoad: "Click to load"
  },
  ru: {
    open: "Открыть…",
    save: "Сохранить",
    signals: "Сигналы",
    annotations: "Аннотации",
    file: "Файл ▼",
    layout: "Вид ▼",
    clickToLoad: "Нажмите, чтобы загрузить"
  }
};

let state = {
  lang: "en",
  project: null,
  files: {},
  play: false,
  edf: null,
  signalData: [],
  pxPerSec: 38, // ~1 cm at 96dpi
  currentTimeSec: 0,
  lastTs: null,
  labelColors: {}, // { annotationIndex: { label: color } }
  yScale: 1,
  awaitingEdfFile: null
};

// ====== UI Helpers ======
function t(key) {
  return i18n[state.lang][key] || key;
}
function applyTranslations() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.dataset.i18n;
    el.textContent = t(key);
  });
}

// ====== Menu handling ======
document.querySelectorAll(".menu-btn").forEach(btn => {
  btn.addEventListener("click", e => {
    const menuId = "menu-" + e.target.dataset.menu;
    document.querySelectorAll(".dropdown").forEach(dd => dd.style.display = "none");
    const dd = document.getElementById(menuId);
    dd.style.display = "block";
  });
});
document.body.addEventListener("click", e => {
  if (!e.target.closest(".menu")) {
    document.querySelectorAll(".dropdown").forEach(dd => dd.style.display = "none");
  }
});

// ====== Language switch ======
document.querySelectorAll('input[name="lang"]').forEach(radio => {
  radio.addEventListener("change", e => {
    state.lang = e.target.value;
    applyTranslations();
    drawSignals();
  });
});

// ====== Y scale tuning ======
document.getElementById("yScaleBox").addEventListener("change", e => {
  let v = parseFloat(e.target.value);
  if (isNaN(v) || v <= 0) v = 1;
  state.yScale = v;
  drawSignals();
});
document.getElementById("yScaleMinus").addEventListener("click", () => {
  state.yScale = Math.max(0.1, state.yScale - 0.1);
  document.getElementById("yScaleBox").value = state.yScale.toFixed(2);
  drawSignals();
});
document.getElementById("yScalePlus").addEventListener("click", () => {
  state.yScale = Math.min(10, state.yScale + 0.1);
  document.getElementById("yScaleBox").value = state.yScale.toFixed(2);
  drawSignals();
});

// ====== Open project ======
document.getElementById("fileInput").addEventListener("change", async e => {
  const files = e.target.files;
  state.files = {};
  for (let f of files) state.files[f.name] = f;

  const projFile = [...files].find(f => f.name.endsWith(".vembproj.json"));
  if (!projFile) return alert("No project file found.");

  const projText = await projFile.text();
  state.project = JSON.parse(projText);

  // Generate colors per annotation label
  state.labelColors = {};
  (state.project.annotations || []).forEach((ann, idx) => {
    const uniqueLabels = [...new Set(ann.events.map(ev => ev.label))];
    const colorMap = {};
    uniqueLabels.forEach((label, i) => {
      colorMap[label] = randomColor(i);
    });
    state.labelColors[idx] = colorMap;
  });

  populateLayoutMenus();
  state.signalData = [];
  state.awaitingEdfFile = state.project.signals?.[0]?.edfFile || null;
  drawSignals();

  const timelineSlider = document.getElementById("timelineSlider");
  timelineSlider.addEventListener("input", e => {
    if (!state.edf) return;
    const duration = state.edf.nRecords * state.edf.duration;
    state.currentTimeSec = parseFloat(e.target.value) * duration;
    drawSignals();
  });
});

// ====== Random color generator ======
function randomColor(seed) {
  const hue = (seed * 137.508) % 360; // golden angle approximation
  return `hsl(${hue}, 70%, 50%)`;
}

// ====== Populate layout menu ======
function populateLayoutMenus() {
  const signalsList = document.getElementById("signalsList");
  const annotationsList = document.getElementById("annotationsList");
  signalsList.innerHTML = "";
  annotationsList.innerHTML = "";

  (state.project.signals || []).forEach(sig => {
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" ${sig.visible ? "checked" : ""}> ${sig.signalName}`;
    signalsList.appendChild(label);
  });
  (state.project.annotations || []).forEach(ann => {
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" ${ann.visible ? "checked" : ""}> ${ann.name}`;
    annotationsList.appendChild(label);
  });
}

// ====== Save project ======
document.getElementById("saveProject").addEventListener("click", () => {
  if (!state.project) return;
  state.project.currentTime = state.currentTimeSec;
  const blob = new Blob([JSON.stringify(state.project, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = state.project.projectName + ".vembproj.json";
  a.click();
});

// ====== Play/pause ======
document.getElementById("playPauseBtn").addEventListener("click", () => {
  state.play = !state.play;
  document.getElementById("playPauseBtn").textContent = state.play ? "⏸" : "▶";
  if (state.play) requestAnimationFrame(tick);
});

// ====== EDF parsing via edfdecoder ======
async function parseEDF(file) {
  // Read the File into an ArrayBuffer
  const buff = await file.arrayBuffer();

  // Decode using edfdecoder (works in browser)
  const decoder = new edfdecoder.EdfDecoder();
  decoder.setInput(buff);

  try {
    decoder.decode();
  } catch (err) {
    // edfdecoder does NOT support EDF+; surface a useful error
    throw new Error(
      "Failed to decode EDF. " +
      "Note: edfdecoder supports classic EDF, not EDF+ (" + err.message + ")"
    );
  }

  const edf = decoder.getOutput();

  // Number of signals (channels) and records
  const ns = edf.getNumberOfSignals();
  const nRecords = edf.getNumberOfRecords();
  
  // Record duration (seconds). Different builds expose one of these names.
  const recordDuration =
    (typeof edf.getRecordDuration === "function" && edf.getRecordDuration()) ||
    (typeof edf.getDurationOfRecords === "function" && edf.getDurationOfRecords()) ||
    1; // fallback

  // Collect labels as best as the API allows (some builds have an array getter)
  let labels = [];
  if (typeof edf.getSignalLabels === "function") {
    const arr = edf.getSignalLabels();
    labels = Array.from({ length: ns }, (_, i) => arr[i] || `Ch ${i + 1}`);
  } else if (typeof edf.getSignalLabel === "function") {
    labels = Array.from({ length: ns }, (_, i) => edf.getSignalLabel(i) || `Ch ${i + 1}`);
  } else {
    labels = Array.from({ length: ns }, (_, i) => `Ch ${i + 1}`);
  }

  // Build samplesPerRecord and a concatenated Float32Array per channel
  const samplesPerRecord = [];
  const signals = [];

  for (let ch = 0; ch < ns; ch++) {
    const nSampPerRec = edf.getPhysicalSignal(ch, 0).length;
    samplesPerRecord.push(nSampPerRec);

    const samples = edf.getPhysicalSignalConcatRecords(ch, 0, nRecords);
    const floatSamples = new Float32Array(samples);

    // Precompute max absolute value for scaling
    let maxVal = 0;
    for (let v of floatSamples) {
      const absV = Math.abs(v);
      if (absV > maxVal) maxVal = absV;
    }
    if (maxVal === 0) maxVal = 1;

    signals.push({ label: labels[ch], samples: floatSamples, maxVal });
  }

  return {
    labels,
    ns,
    duration: recordDuration, // seconds per record
    nRecords,
    signals,                  // [{ label, samples: Float32Array }]
    samplesPerRecord          // per-channel samples per record
  };
}

function drawAnnotationStrips() {
  const strips = document.getElementById("annotationStrips");
  strips.innerHTML = "";
  if (!state.project?.annotations || !state.edf) return;

  const duration = state.edf.nRecords * state.edf.duration;
  state.project.annotations.forEach((ann, idx) => {
    if (!ann.visible) return;
    const strip = document.createElement("div");
    strip.className = "annotation-strip";

    // Label
    const label = document.createElement("div");
    label.className = "annotation-strip-label";
    label.textContent = ann.name || `Track ${idx+1}`;
    strip.appendChild(label);

    // Track
    const track = document.createElement("div");
    track.className = "annotation-strip-track";

    ann.events.forEach(ev => {
      // Clamp to visible duration
      const left = Math.max(0, (ev.startSec / duration) * 100);
      const right = Math.min(100, (ev.endSec / duration) * 100);
      if (right <= 0 || left >= 100) return;

      const evDiv = document.createElement("div");
      evDiv.className = "annotation-strip-event";
      evDiv.style.left = left + "%";
      evDiv.style.width = (right - left) + "%";
      evDiv.style.background = state.labelColors?.[idx]?.[ev.label] || "#ff0000";
      evDiv.title = ev.label;
      evDiv.textContent = ev.label;
      track.appendChild(evDiv);
    });

    strip.appendChild(track);
    strips.appendChild(strip);
  });
}

// Update slider position after drawing
function updateTimelineSlider() {
  if (!state.edf) {
    timelineSlider.value = 0;
    timelineSlider.disabled = true;
    return;
  }
  timelineSlider.disabled = false;
  const duration = state.edf.nRecords * state.edf.duration;
  timelineSlider.value = Math.max(0, Math.min(1, state.currentTimeSec / duration));
}

// ====== Drawing ======
function drawSignals() {
  const canvas = document.getElementById("signalCanvas");
  const ctx = canvas.getContext("2d");
  const gutter = document.getElementById("leftGutter");
  gutter.innerHTML = ""; // clear channel names

  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // === Lazy EDF load case ===
  if (!state.signalData.length) {
    ctx.fillStyle = "#ccc";
    if (state.awaitingEdfFile) {
      ctx.fillText(`${t("clickToLoad")} ${state.awaitingEdfFile}`, 20, 30);
      canvas.onclick = () => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = ".edf";
        inp.onchange = async ev => {
          const edfFile = ev.target.files[0];
          if (!edfFile || edfFile.name !== state.awaitingEdfFile) {
            alert(`Please select ${state.awaitingEdfFile}`);
            return;
          }
          state.edf = await parseEDF(edfFile);
          state.signalData = state.edf.signals; // all channels
          state.awaitingEdfFile = null;
          canvas.onclick = null; // remove click handler once loaded
          drawSignals();
        };
        inp.click();
      };
    } else {
      ctx.fillText("No signal loaded", 20, 30);
    }
    return;
  }

  canvas.onclick = null; // remove EDF-load click handler if data is loaded

  const totalChannels = state.signalData.length;
  const chHeight = canvas.height / totalChannels;
  const visibleDuration = canvas.width / state.pxPerSec;
  const startSec = state.currentTimeSec;
  const endSec = startSec + visibleDuration;
  const sps = state.edf.samplesPerRecord[0] / state.edf.duration;

  // === Draw annotations (background) ===
  (state.project.annotations || []).forEach((ann, idx) => {
    if (!ann.visible) return;
    ctx.globalAlpha = ann.opacity ?? 0.2;

    ann.events.forEach(ev => {
      // Skip if event is completely outside visible range
      if (ev.endSec < startSec || ev.startSec > endSec) return;

      const x1 = (ev.startSec - startSec) * state.pxPerSec;
      const x2 = (ev.endSec - startSec) * state.pxPerSec;

      ctx.fillStyle = state.labelColors?.[idx]?.[ev.label] || "#ff0000";
      ctx.fillRect(x1, 0, x2 - x1, canvas.height);
    });

    ctx.globalAlpha = 1.0;
  });

  // Draw vertical grid lines
  ctx.strokeStyle = "#ddd";
  ctx.beginPath();
  for (let sec = Math.floor(startSec); sec < endSec; sec++) {
    const x = (sec - startSec) * state.pxPerSec;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
  }
  ctx.stroke();

  // Draw time labels
  ctx.fillStyle = "#000";
  for (let sec = Math.floor(startSec); sec < endSec; sec++) {
    const x = (sec - startSec) * state.pxPerSec;
    ctx.fillText(sec + "s", x + 2, canvas.height - 5);
  }

  // Draw each channel waveform + label
  state.signalData.forEach((sig, ch) => {
    const midY = chHeight * (ch + 0.5);
    const amp = chHeight * 0.4 * state.yScale;
    const startSample = Math.floor(startSec * sps);
    const endSample = Math.min(sig.samples.length, Math.floor(endSec * sps));

    ctx.strokeStyle = "#0066cc";
    ctx.beginPath();
    for (let i = startSample; i < endSample; i++) {
      const x = ((i / sps) - startSec) * state.pxPerSec;
      const y = midY - sig.samples[i] * amp / sig.maxVal;
      if (i === startSample) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Channel name in left gutter
    const chLabel = document.createElement("div");
    chLabel.style.height = chHeight + "px";
    chLabel.style.display = "flex";
    chLabel.style.alignItems = "center";
    chLabel.style.justifyContent = "flex-end";
    chLabel.style.paddingRight = "5px";
    chLabel.style.fontSize = "12px";
    chLabel.textContent = sig.label;
    gutter.appendChild(chLabel);
  });

  // // Signal name vertically centered in gutter
  // if (state.project?.signals?.[0]?.signalName) {
  //   const sigNameDiv = document.createElement("div");
  //   sigNameDiv.style.position = "absolute";
  //   sigNameDiv.style.top = "50%";
  //   sigNameDiv.style.left = "0";
  //   sigNameDiv.style.transform = "translateY(-50%) rotate(-90deg)";
  //   sigNameDiv.style.transformOrigin = "center";
  //   sigNameDiv.style.whiteSpace = "nowrap";
  //   sigNameDiv.style.fontWeight = "bold";
  //   sigNameDiv.textContent = state.project.signals[0].signalName;
  //   gutter.appendChild(sigNameDiv);
  // }
  drawAnnotationStrips();
  updateTimelineSlider();
}


// ====== Play loop ======
function tick(ts) {
  if (!state.lastTs) state.lastTs = ts;
  const dt = (ts - state.lastTs) / 1000;
  state.lastTs = ts;

  state.currentTimeSec += dt;
  drawSignals();

  if (state.play) requestAnimationFrame(tick);
  updateTimelineSlider();
}

// ====== Init ======
applyTranslations();
drawSignals();

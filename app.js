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

// ====== Open project ======
document.getElementById("fileInput").addEventListener("change", async e => {
  const files = e.target.files;
  state.files = {};
  for (let f of files) state.files[f.name] = f;

  const projFile = [...files].find(f => f.name.endsWith(".veembproj.json"));
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
  a.download = state.project.projectName + ".veembproj.json";
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
    // Determine samples-per-record from the first record
    const first = edf.getPhysicalSignal(ch, 0);           // Float32Array
    const nSampPerRec = first.length;
    samplesPerRecord.push(nSampPerRec);

    // Concatenate all records for this channel
    const concatenated = edf.getPhysicalSignalConcatRecords(ch, 0, nRecords);
    const samples = concatenated instanceof Float32Array
      ? concatenated
      : new Float32Array(concatenated);

    signals.push({ label: labels[ch], samples });
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

// ====== Drawing ======
function drawSignals() {
  const canvas = document.getElementById("signalCanvas");
  const ctx = canvas.getContext("2d");
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

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
          state.signalData = state.edf.signals[0].samples;
          state.awaitingEdfFile = null;
          drawSignals();
        };
        inp.click();
      };
    } else {
      ctx.fillText("No signal loaded", 20, 30);
    }
    return;
  }

  const samples = state.signalData;
  const totalDuration = samples.length / state.edf.samplesPerRecord[0] * state.edf.duration;
  const visibleDuration = canvas.width / state.pxPerSec;
  const startSec = state.currentTimeSec;
  const endSec = startSec + visibleDuration;
  const sps = state.edf.samplesPerRecord[0] / state.edf.duration;

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

  // Draw signal waveform
  ctx.strokeStyle = "#0066cc";
  ctx.beginPath();
  const midY = canvas.height / 2;
  const amp = canvas.height / 4;
  const startSample = Math.floor(startSec * sps);
  const endSample = Math.min(samples.length, Math.floor(endSec * sps));

  // Compute scaling factor without spreading huge arrays
  let maxVal = 1;
  if (samples.length > 0) {
    maxVal = samples.reduce((m, v) => (v > m ? v : m), -Infinity);
    if (maxVal === 0) maxVal = 1; // avoid divide-by-zero
  }

  for (let i = startSample; i < endSample; i++) {
    const x = ((i / sps) - startSec) * state.pxPerSec;
    const y = midY - samples[i] * amp / maxVal;
    if (i === startSample) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// ====== Play loop ======
function tick(ts) {
  if (!state.lastTs) state.lastTs = ts;
  const dt = (ts - state.lastTs) / 1000;
  state.lastTs = ts;

  state.currentTimeSec += dt;
  drawSignals();

  if (state.play) requestAnimationFrame(tick);
}

// ====== Init ======
applyTranslations();
drawSignals();

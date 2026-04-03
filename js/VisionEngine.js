const COCO_CLASSES = [
    'person','bicycle','car','motorcycle','airplane','bus','train','truck','boat',
    'traffic light','fire hydrant','stop sign','parking meter','bench','bird','cat',
    'dog','horse','sheep','cow','elephant','bear','zebra','giraffe','backpack',
    'umbrella','handbag','tie','suitcase','frisbee','skis','snowboard','sports ball',
    'kite','baseball bat','baseball glove','skateboard','surfboard','tennis racket',
    'bottle','wine glass','cup','fork','knife','spoon','bowl','banana','apple',
    'sandwich','orange','broccoli','carrot','hot dog','pizza','donut','cake','chair',
    'couch','potted plant','bed','dining table','toilet','tv','laptop','mouse',
    'remote','keyboard','cell phone','microwave','oven','toaster','sink',
    'refrigerator','book','clock','vase','scissors','teddy bear','hair drier',
    'toothbrush'
];

let visionSession = null;
let modelLoaded = false;
let isInferring = false;
let isModalOpen = false;
let detectPaused = false;
let streamActive = false;
let eventSource = null;
let latestImageBitmap = null;
let activeBackend = 'none';

let targetFPS = 5;
let inferenceDelayMs = 200;

// Default ultrasonic mock reading if actual hardware data isn't exposed properly
const getCurrentUltrasonicReading = typeof window.getUltrasonicDist === 'function' 
    ? window.getUltrasonicDist 
    : () => null;

async function initVisionModel() {
    if (modelLoaded) return;
    try {
        const statusEl = document.getElementById('vision-status');
        const metricsEl = document.getElementById('vision-metrics');
        
        statusEl.innerText = "Loading vision model...";
        // Attempt WebGPU first
        visionSession = await ort.InferenceSession.create('/models/yolo11s.onnx', {
            executionProviders: ['webgpu', 'wasm']
        });
        
        activeBackend = 'wasm'; // or read from session if ort exposes it
        modelLoaded = true;
        statusEl.innerText = "Vision model ready";
        metricsEl.innerText = `FPS: -- | Backend: WebGPU/WASM`;
        checkBatterySafeguard();
    } catch (e) {
        console.warn("Vision model load failed", e);
    }
}

async function checkBatterySafeguard() {
    if ('getBattery' in navigator) {
        try {
            const battery = await navigator.getBattery();
            if (battery.level <= 0.20) {
                targetFPS = 1;
                console.log("Battery low, reducing to 1 FPS");
            }
            battery.addEventListener('levelchange', () => {
                targetFPS = battery.level <= 0.20 ? 1 : 5;
            });
        } catch(e) {}
    }
}

function startStream() {
    if (eventSource) eventSource.close();
    eventSource = new EventSource('/api/vision/stream');
    eventSource.onmessage = async (e) => {
        const offlineText = document.getElementById('camera-offline-text');
        const videoCanvas = document.getElementById('vision-video-canvas');
        if (!offlineText || !videoCanvas) return;
        
        if (e.data === 'offline') {
            offlineText.style.display = 'flex';
            latestImageBitmap = null;
            return;
        }
        offlineText.style.display = 'none';
        try {
            const res = await fetch(`data:image/jpeg;base64,${e.data}`);
            const blob = await res.blob();
            latestImageBitmap = await createImageBitmap(blob);
            
            // Draw to Live Preview Canvas map 
            const ctx = videoCanvas.getContext('2d');
            ctx.drawImage(latestImageBitmap, 0, 0, videoCanvas.width, videoCanvas.height);
        } catch (err) {
            console.error("Frame decode error", err);
        }
    };
}

function stopStream() {
    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }
    const offText = document.getElementById('camera-offline-text');
    if (offText) offText.style.display = 'none';
}

async function runDetection(imageBmp) {
    if (!visionSession) return [];

    const startTime = performance.now();
    const metricsEl = document.getElementById('vision-metrics');
    
    // 1. Preprocess: 640x640, float32, normalize, CHW, RGB
    const offCanvas = new OffscreenCanvas(640, 640);
    const offCtx = offCanvas.getContext('2d', { willReadFrequently: true });
    offCtx.drawImage(imageBmp, 0, 0, 640, 640);
    const imgData = offCtx.getImageData(0, 0, 640, 640);
    const pixels = imgData.data;
    
    const inputFloat32Array = new Float32Array(1 * 3 * 640 * 640);
    for (let i = 0; i < 640 * 640; i++) {
        inputFloat32Array[i] = pixels[i * 4] / 255.0;                      // R
        inputFloat32Array[640 * 640 + i] = pixels[i * 4 + 1] / 255.0;      // G
        inputFloat32Array[2 * 640 * 640 + i] = pixels[i * 4 + 2] / 255.0;  // B
    }

    const tensor = new ort.Tensor('float32', inputFloat32Array, [1, 3, 640, 640]);
    
    // 2. Inference
    const results = await visionSession.run({ images: tensor });
    const output = results[Object.keys(results)[0]].data; // [1, 84, 8400] flat
    
    // 3. Post-process
    let detections = [];
    for (let i = 0; i < 8400; i++) {
        let maxScore = 0;
        let classId = -1;
        
        for (let c = 0; c < 80; c++) {
            const score = output[4 * 8400 + c * 8400 + i]; // Offset by 4 coords layers
            if (score > maxScore) {
                maxScore = score;
                classId = c;
            }
        }
        
        if (maxScore > 0.45) {
            const cx = output[0 * 8400 + i];
            const cy = output[1 * 8400 + i];
            const w = output[2 * 8400 + i];
            const h = output[3 * 8400 + i];
            
            const x1 = cx - w / 2;
            const y1 = cy - h / 2;
            const x2 = cx + w / 2;
            const y2 = cy + h / 2;
            
            detections.push({
                label: COCO_CLASSES[classId],
                confidence: maxScore,
                box: [x1, y1, x2, y2],
                classId
            });
        }
    }
    
    // Quick NMS
    detections = nms(detections, 0.5);
    
    const execTime = performance.now() - startTime;
    if (execTime > 500) {
        targetFPS = Math.min(targetFPS, 2); // Safeguard
    }
    
    if (metricsEl) metricsEl.innerText = `FPS: ${targetFPS} (${Math.round(execTime)}ms) | Backend: WebGPU/WASM`;
    return detections;
}

function nms(boxes, iouThreshold) {
    if (boxes.length === 0) return [];
    boxes.sort((a, b) => b.confidence - a.confidence);
    const result = [];
    while (boxes.length > 0) {
        const current = boxes.shift();
        result.push(current);
        boxes = boxes.filter(box => calculateIoU(current.box, box.box) < iouThreshold);
    }
    return result;
}

function calculateIoU(box1, box2) {
    const xLeft = Math.max(box1[0], box2[0]);
    const yTop = Math.max(box1[1], box2[1]);
    const xRight = Math.min(box1[2], box2[2]);
    const yBottom = Math.min(box1[3], box2[3]);

    if (xRight < xLeft || yBottom < yTop) return 0.0;

    const intersectionArea = (xRight - xLeft) * (yBottom - yTop);
    const box1Area = (box1[2] - box1[0]) * (box1[3] - box1[1]);
    const box2Area = (box2[2] - box2[0]) * (box2[3] - box2[1]);

    return intersectionArea / (box1Area + box2Area - intersectionArea);
}

function fuseWithSensor(detections, ultrasonicCm) {
    if (!ultrasonicCm || ultrasonicCm > 400) return detections;
    
    const centerX = 320, centerY = 320;
    let closestDet = null;
    let minDist = Infinity;
    
    for (const det of detections) {
        const boxCenterX = (det.box[0] + det.box[2]) / 2;
        const boxCenterY = (det.box[1] + det.box[3]) / 2;
        const dist = Math.hypot(boxCenterX - centerX, boxCenterY - centerY);
        if (dist < minDist) {
            minDist = dist;
            closestDet = det;
        }
    }
    
    if (closestDet) {
        closestDet.realDistanceCm = ultrasonicCm;
        closestDet.sensorConfirmed = true;
    }
    return detections;
}

function getCategoryColor(label) {
    const vehicles = ['bicycle','car','motorcycle','airplane','bus','train','truck','boat'];
    const animals = ['bird','cat','dog','horse','sheep','cow','elephant','bear','zebra','giraffe'];
    const furniture = ['bench','chair','couch','bed','dining table','toilet'];
    
    if (label === 'person') return '#FF4444';
    if (vehicles.includes(label)) return '#FF8800';
    if (animals.includes(label)) return '#FFCC00';
    if (furniture.includes(label)) return '#4488FF';
    return '#FFFFFF';
}

function drawBoundingBoxes(detections) {
    const overlayCanvas = document.getElementById('vision-overlay-canvas');
    const videoCanvas = document.getElementById('vision-video-canvas');
    if (!overlayCanvas || !videoCanvas) return;
    
    // Match dimensions to display logic
    overlayCanvas.width = videoCanvas.clientWidth;
    overlayCanvas.height = videoCanvas.clientHeight;
    videoCanvas.width = videoCanvas.clientWidth;
    videoCanvas.height = videoCanvas.clientHeight;

    const ctx = overlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    
    const scaleX = overlayCanvas.width / 640;
    const scaleY = overlayCanvas.height / 640;
    
    for (const det of detections) {
        const [x1, y1, x2, y2] = det.box;
        const color = getCategoryColor(det.label);
        
        const scaledX = x1 * scaleX;
        const scaledY = y1 * scaleY;
        const width = (x2 - x1) * scaleX;
        const height = (y2 - y1) * scaleY;
        
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.strokeRect(scaledX, scaledY, width, height);
        
        ctx.fillStyle = color + '26'; // 0.15 opacity hex
        ctx.fillRect(scaledX, scaledY, width, height);
        
        ctx.fillStyle = color;
        ctx.font = 'bold 14px Arial';
        ctx.fillText(`${det.label} ${(det.confidence*100).toFixed(0)}%`, scaledX, scaledY > 20 ? scaledY - 5 : scaledY + 15);
    }
}

function updateDetectionLog(detections) {
    const logList = document.getElementById('detection-log-list');
    if (!logList) return;
    
    const topDets = [...detections].sort((a,b) => b.confidence - a.confidence).slice(0, 5);
    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0];
    
    if (topDets.length === 0) {
        logList.innerHTML = `<li class="log-entry fade-in" style="padding: 4px 0; border-bottom: 1px solid #333;">[${timeStr}] Nothing detected</li>` + logList.innerHTML;
        trimLog(logList);
        return;
    }

    let htmlBlock = '';
    for (const det of topDets) {
        let distStr = '—';
        let confirmedMarker = '';
        if (det.sensorConfirmed && det.realDistanceCm) {
            distStr = (det.realDistanceCm / 100).toFixed(2);
            confirmedMarker = '<span style="color: #00ffcc; font-size: 1.2em; vertical-align: middle;">●</span> ';
        }
        
        htmlBlock += `<li class="log-entry fade-in" style="padding: 4px 0; border-bottom: 1px solid #333; animation: fadeInLog 0.5s;">
            <span style="color: #888;">[${timeStr}]</span> ${confirmedMarker}${det.label} detected — ${distStr}m — ${(det.confidence*100).toFixed(0)}%
        </li>`;
    }
    
    logList.innerHTML = htmlBlock + logList.innerHTML;
    trimLog(logList);
}

function trimLog(logList) {
    const items = logList.getElementsByTagName('li');
    while (items.length > 20) {
        // Remove oldest entries
        logList.removeChild(items[items.length - 1]);
    }
}

async function detectionLoop() {
    if (!isModalOpen || !modelLoaded || detectPaused) {
        setTimeout(detectionLoop, inferenceDelayMs);
        return;
    }
    
    if (latestImageBitmap && !isInferring) {
        isInferring = true;
        try {
            let detections = await runDetection(latestImageBitmap);
            
            const currentDist = getCurrentUltrasonicReading(); // Fusion point
            detections = fuseWithSensor(detections, currentDist);
            
            drawBoundingBoxes(detections);
            updateDetectionLog(detections);
        } catch (e) {
            console.error("Detection exec error", e);
        }
        isInferring = false;
    }
    
    inferenceDelayMs = 1000 / targetFPS;
    setTimeout(detectionLoop, inferenceDelayMs);
}

// Hook into existing Modal Open/Close Logic
window.onVisionModalOpen = function() {
    isModalOpen = true;
    detectPaused = true;
    streamActive = false;
    
    const logList = document.getElementById('detection-log-list');
    if (logList) logList.innerHTML = `<li class="log-entry" style="padding: 4px 0; border-bottom: 1px solid #333; color: #aaa;">Camera inactive. Start engine to begin.</li>`;
    
    const statusEl = document.getElementById('vision-status');
    if (statusEl) statusEl.innerText = "Ready to start";

    const toggleBtn = document.getElementById('toggle-vision-btn');
    if (toggleBtn) {
        // Clone to remove old event listeners
        const newBtn = toggleBtn.cloneNode(true);
        toggleBtn.parentNode.replaceChild(newBtn, toggleBtn);
        newBtn.innerText = "Start Engine";
        
        newBtn.addEventListener('click', () => {
            if (!streamActive) {
                const confirmStart = confirm("Start Smart Vision Engine?\nThis will activate the camera stream and run AI detection, which may put load on your ESP32-CAM.");
                if (!confirmStart) return;
                
                streamActive = true;
                detectPaused = false;
                newBtn.innerText = "Pause Engine";
                if (logList) logList.innerHTML = '';
                
                initVisionModel();
                startStream();
                detectionLoop();
            } else {
                detectPaused = !detectPaused;
                newBtn.innerText = detectPaused ? "Resume Engine" : "Pause Engine";
                if (detectPaused) {
                    stopStream();
                } else {
                    startStream();
                }
            }
        });
    }
};

window.onVisionModalClose = function() {
    isModalOpen = false;
    detectPaused = true;
    streamActive = false;
    stopStream();
};

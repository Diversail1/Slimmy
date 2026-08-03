function initializeDevMode() {
    document.body.classList.toggle('dev-mode', DEV_MODE);

    document.querySelectorAll('.dev-only').forEach(el => {
        el.style.display = DEV_MODE ? 'block' : 'none';
    });

    const debugMarkers = document.getElementById('debugMarkers');

    if (debugMarkers) {
        debugMarkers.checked = DEV_MODE;
    }
}
function initializeLibraries() {
    OpenCvReady = typeof cv !== "undefined" && typeof cv.Mat === "function" && typeof cv.imread === "function";
    TracerReady = typeof ImageTracer !== "undefined" && typeof ImageTracer.imagedataToSVG === "function";

    console.log("OpenCV:", OpenCvReady);
    console.log("ImageTracer:", TracerReady);
}

// Set this to true when troubleshooting marker detection or threshold output.
const DEV_MODE = false;

let OpenCvReady = false;
let TracerReady = false;

initializeLibraries();
initializeDevMode();

let sigGray = null;
let blurred = null;
let finalThresh = null;
let Reshow = true;

let isPdf = 1;

const outWidth = 2200;
const outHeight = 500;
const finwidth = 220;
const finheight = 50;
const minmarkarea = 300;

const blurSize = 5;

const OldSig = false;
const Kernel = true;
	
const ImageProcessingVersion = document.getElementById("ImageProcessingVersion");
const upload = document.getElementById('upload');
const inputCanvas = document.getElementById('inputCanvas');
const outputCanvas = document.getElementById('outputCanvas');
const inputCtx = inputCanvas.getContext('2d',{ willReadFrequently: true });
	
const thresholdSlider = document.getElementById('threshold');
const thresholdValue = document.getElementById('thresholdValue');
const edgeCleanup = document.getElementById('edgeCleanup');
const downloadBtnp = document.getElementById('downloadBtnp');

const ThresholdCanvasO = document.getElementById('ThresholdCanvasO');
const ThresholdCanvasP = document.getElementById('ThresholdCanvasP');
const processedCtx = ThresholdCanvasP.getContext('2d',{ willReadFrequently: true });

processedCtx.imageSmoothingEnabled = true;
processedCtx.imageSmoothingQuality = 'high';

let thresholdDebounceTimer = null;

let uploaded = 0;
// 0 = none
// 1 = uploaded
// 2 = processed

//Morpboxing and adaptiveboxing are for the recognition of the squares only
let morphboxing = true;
let adaptiveboxing = true;

let GlobalImageData = null;

// The original upload is kept on an off-screen canvas so developer overlays do
// not affect signature selection or subsequent processing.
const sourceImageCanvas = document.createElement('canvas');
const sourceImageCtx = sourceImageCanvas.getContext('2d', { willReadFrequently: true });

let signatureCandidates = [];
let selectedSignatureIndex = -1;

const PDF_JS_VERSION = '3.11.174';
const PDF_JS_URL = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDF_JS_VERSION}/pdf.min.js`;
const PDF_WORKER_URL = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDF_JS_VERSION}/pdf.worker.min.js`;
const MAX_SOURCE_WIDTH = 1800;

initializeSignatureSelector();
upload.accept = 'image/*,application/pdf,.pdf';
downloadBtnp.disabled = true;



//All the event listeners

upload.addEventListener('change', async e => {

    const file = e.target.files[0];
    if (!file) return;

	Reshow = true;
	GlobalImageData = null;
    signatureCandidates = [];
    selectedSignatureIndex = -1;
    uploaded = 0;
    downloadBtnp.disabled = true;
    if (sigGray) {
        sigGray.delete();
        sigGray = null;
    }
    resetSignatureSelector();
    clearCanvas(outputCanvas);
    clearCanvas(ThresholdCanvasO);
    clearCanvas(ThresholdCanvasP);

    try {
        setSignatureSelectorStatus('Loading the signature sheet...');
        await drawUploadedFile(file);

        uploaded = 1;

        const downloadBtn = document.getElementById("downloadBtn");
        if (downloadBtn) {
            downloadBtn.disabled = !DEV_MODE;
        }

        processUploadedImageWhenReady();
    } catch (err) {
        console.error(err);
        resetSignatureSelector();
        alert(err.message || 'The selected file could not be opened.');
    } finally {
        // Allow the same file to be selected again after an edit or rescan.
        e.target.value = '';
    }
});

thresholdSlider.addEventListener('input', () => {
    thresholdValue.textContent = thresholdSlider.value;

    if (uploaded<2) return;

    clearTimeout(thresholdDebounceTimer);

    thresholdDebounceTimer = setTimeout(() => {
        Recalculate();
    }, 200);
});

edgeCleanup.addEventListener('change', () => {
    if (uploaded===2) {
        ProcessThreshold();
    }
});

ImageProcessingVersion.addEventListener('change', () => {
	updateUI();
    if (uploaded===2) {
        Recalculate();
    }
});

downloadBtnp.addEventListener('click', () => {
	if (uploaded===2) {
		const svg = ImageTracer.imagedataToSVG(GlobalImageData);
		downloadPngFromSvg(svg)
		//downloadSvg(svg)
		//uploadPngFromSvg(svg)
		//downloadNewFinalCanvas() //Doesn't work well yet
    }
});

//Greys out the Threshold if not using ThinStrokes
function updateUI() {
    thresholdSlider.disabled = ImageProcessingVersion.checked;
};

function processUploadedImageWhenReady(attempt = 0) {
    if (uploaded<1) return;

    // Refresh these checks because OpenCV can finish initializing after this
    // script first runs.
    initializeLibraries();
	console.log(OpenCvReady)
	console.log(TracerReady)
    if (!OpenCvReady || !TracerReady) {
        if (attempt < 40) {
            setTimeout(() => processUploadedImageWhenReady(attempt + 1), 100);
            return;
        }

        resetSignatureSelector();
        alert("OpenCV or Tracer failed to load");
        return;
    }
	if (!isPdf) {
		processSingleSignatureLegacy();
	}
	else {
    processImage();
	}
};

function initializeSignatureSelector() {
    const uploadLabel = document.querySelector('label[for="upload"]');
    if (uploadLabel) {
        uploadLabel.textContent = 'Select Signature Sheet or Image';
    }

    const firstCard = upload.closest('.card');
    if (!firstCard || document.getElementById('signatureSelectorSection')) return;

    const uploadInstructions = firstCard.querySelector('.subtle');
    if (uploadInstructions) {
        uploadInstructions.textContent = 'Upload one signature box or a full sheet. Images and PDFs are supported.';
    }

    const cleanupHeading = downloadBtnp.closest('.card')?.querySelector('h2');
    if (cleanupHeading) cleanupHeading.textContent = '3. Signature cleanup';

    const style = document.createElement('style');
    style.textContent = `
        #signatureSelectorSection[hidden] { display: none; }
        #signatureSelectorGrid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
            gap: 14px;
        }
        .signature-choice {
            display: flex;
            flex-direction: column;
            align-items: stretch;
            min-height: 0;
            padding: 12px;
            color: #172033;
            background: #fff;
            border: 2px solid #d7e2f0;
            border-radius: 14px;
            box-shadow: 0 8px 22px rgba(15, 47, 87, 0.08);
            text-align: left;
        }
        .signature-choice:hover {
            border-color: #2f8df4;
            transform: translateY(-1px);
        }
        .signature-choice.is-selected {
            border-color: #0f66c2;
            box-shadow: 0 0 0 3px rgba(47, 141, 244, 0.18);
        }
        .signature-choice img {
            display: block;
            width: 100%;
            aspect-ratio: 4.4 / 1;
            object-fit: contain;
            background: #fff;
            border: 1px solid #d7e2f0;
            border-radius: 9px;
        }
        .signature-choice-title {
            display: flex;
            justify-content: space-between;
            gap: 8px;
            margin-top: 9px;
            color: #0f2f57;
            font-weight: 750;
        }
        .signature-choice-note {
            color: #6b778b;
            font-size: 0.78rem;
            font-weight: 650;
        }
        #signatureSelectorStatus {
            margin: 0 0 14px;
            color: #4b5b73;
            line-height: 1.45;
        }
    `;
    document.head.appendChild(style);

    const section = document.createElement('section');
    section.id = 'signatureSelectorSection';
    section.className = 'card';
    section.hidden = true;
    section.innerHTML = `
        <div class="card-header">
            <div>
                <h2>2. Choose a signature</h2>
                <p class="subtle">Select the box you want to send to signature cleanup.</p>
            </div>
        </div>
        <p id="signatureSelectorStatus"></p>
        <div id="signatureSelectorGrid"></div>
    `;

    firstCard.insertAdjacentElement('afterend', section);
}

function resetSignatureSelector() {
    const section = document.getElementById('signatureSelectorSection');
    const grid = document.getElementById('signatureSelectorGrid');

    if (grid) grid.replaceChildren();
    if (section) section.hidden = true;
}

function setSignatureSelectorStatus(message) {
    const section = document.getElementById('signatureSelectorSection');
    const status = document.getElementById('signatureSelectorStatus');

    if (section) section.hidden = false;
    if (status) status.textContent = message;
}

function clearCanvas(canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function copyCanvasToSource(canvas) {
    let width = canvas.width;
    let height = canvas.height;

    if (width > MAX_SOURCE_WIDTH) {
        const scale = MAX_SOURCE_WIDTH / width;
        width = Math.round(width * scale);
        height = Math.round(height * scale);
    }

    sourceImageCanvas.width = width;
    sourceImageCanvas.height = height;
    sourceImageCtx.clearRect(0, 0, width, height);
    sourceImageCtx.drawImage(canvas, 0, 0, width, height);

    inputCanvas.width = width;
    inputCanvas.height = height;
    inputCtx.clearRect(0, 0, width, height);
    inputCtx.drawImage(sourceImageCanvas, 0, 0);
}

async function drawUploadedFile(file) {
    isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

    if (isPdf) {
        await drawPdfFile(file);
        return;
    }

    if (file.type && !file.type.startsWith('image/')) {
        throw new Error('Please select an image or PDF signature sheet.');
    }

    await drawImageFile(file);
}

function drawImageFile(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();

        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth || img.width;
                canvas.height = img.naturalHeight || img.height;
                canvas.getContext('2d').drawImage(img, 0, 0);
                copyCanvasToSource(canvas);
                resolve();
            } finally {
                URL.revokeObjectURL(url);
            }
        };

        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('The selected image could not be decoded.'));
        };

        img.src = url;
    });
}

function ensurePdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);

    return new Promise((resolve, reject) => {
        const existing = document.querySelector('script[data-signature-pdfjs]');

        if (existing) {
            existing.addEventListener('load', () => resolve(window.pdfjsLib), { once: true });
            existing.addEventListener('error', () => reject(new Error('PDF support could not be loaded.')), { once: true });
            return;
        }

        const script = document.createElement('script');
        script.src = PDF_JS_URL;
        script.async = true;
        script.dataset.signaturePdfjs = 'true';
        script.onload = () => resolve(window.pdfjsLib);
        script.onerror = () => reject(new Error('PDF support could not be loaded. Check the internet connection or upload a PNG/JPG scan instead.'));
        document.head.appendChild(script);
    });
}

async function drawPdfFile(file) {
    const pdfjsLib = await ensurePdfJs();
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;

    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const page = await pdf.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.max(1.5, Math.min(3, MAX_SOURCE_WIDTH / baseViewport.width));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });

    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport }).promise;
    copyCanvasToSource(canvas);

    if (pdf.numPages > 1) {
        console.info(`The PDF contains ${pdf.numPages} pages; only page 1 was processed.`);
    }
}


//Download Functions

//Upload Logic
async function uploadSignatureBlob(blob, filename) {
    const formData = new FormData();

    formData.append("signature", blob, filename);

    const response = await fetch("/api/signatures", {
        method: "POST",
        body: formData
    });

    if (!response.ok) {
        throw new Error("Failed to upload signature.");
    }

    return await response.json();
}

//Uploadfunction
function uploadPngFromSvg(svg) {
    svg = svg.replace(
        'stroke-width="1"',
        'stroke-width="5"'
    );

    const blob = new Blob(
        [svg],
        { type: "image/svg+xml" }
    );

    const url = URL.createObjectURL(blob);

    const img = new Image();

    img.onload = function () {
        const canvas = document.createElement("canvas");

        canvas.width = finwidth;
        canvas.height = finheight;

        const ctx = canvas.getContext("2d");

        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, finwidth, finheight);

        ctx.drawImage(img, 0, 0, finwidth, finheight);

        URL.revokeObjectURL(url);
		
		const now = new Date();

        const fileName =
            `${now.getFullYear()}-${
				String(now.getMonth() + 1).padStart(2,'0')
			}-${
				String(now.getDate()).padStart(2,'0')
			}_${
				String(now.getHours()).padStart(2,'0')
			}-${
				String(now.getMinutes()).padStart(2,'0')
			}-${
				String(now.getSeconds()).padStart(2,'0')
            }_newsig.png`;

        canvas.toBlob(async function (pngBlob) {
            try {
                const result = await uploadSignatureBlob(
                    pngBlob,
                    fileName
                );

                console.log("Uploaded:", result);
                alert("Signature uploaded successfully.");
            } catch (err) {
                console.error(err);
                alert("Upload failed.");
            }
        }, "image/png");
    };

    img.src = url;
}

//Downloads the black and white canvas - FOR FUN!!
function downloadCanvas() {
	
	inputCanvas.toBlob(blob => {
        const url = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = url;
        a.download = "canvas-image.png";
        a.click();

        URL.revokeObjectURL(url);
    }, "image/png");
}

function downloadSvg(svg) {

    const blob = new Blob(
        [svg],
        { type: 'image/svg+xml' }
    );

    const url =
        URL.createObjectURL(blob);

    const a =
        document.createElement('a');

    a.href = url;
    a.download = 'signature.svg';

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    URL.revokeObjectURL(url);
}

function downloadPngFromSvg(svg) {

	svg = svg.replace(
		'stroke-width="1"',
		'stroke-width="5"'
	);

    const blob = new Blob(
        [svg],
        { type: 'image/svg+xml' }
    );

    const url =
        URL.createObjectURL(blob);

    const img =
        new Image();

    img.onload = function() {

        const canvas =
            document.createElement('canvas');

        canvas.width = finwidth;
        canvas.height = finheight;

        const ctx =
            canvas.getContext('2d');

        ctx.fillStyle = 'white';
        ctx.fillRect(
            0,
            0,
            finwidth,
            finheight
        );

        ctx.drawImage(
            img,
            0,
            0,
            finwidth,
            finheight
        );

        URL.revokeObjectURL(url);

        canvas.toBlob(
            function(blob) {

                const pngUrl =
                    URL.createObjectURL(blob);

                const a =
                    document.createElement('a');

                a.href = pngUrl;
                a.download =
                    'signature.png';

                a.click();

                URL.revokeObjectURL(
                    pngUrl
                );
            },
            'image/png'
        );
    };

    img.src = url;
}

function uploadOldSignature() {

    outputCanvas.toBlob(async function (blob) {
		const now = new Date();

        const fileName =
            `${now.getFullYear()}-${
				String(now.getMonth() + 1).padStart(2,'0')
			}-${
				String(now.getDate()).padStart(2,'0')
			}_${
				String(now.getHours()).padStart(2,'0')
			}-${
				String(now.getMinutes()).padStart(2,'0')
			}-${
				String(now.getSeconds()).padStart(2,'0')
            }_oldsig.png`;
		try {
			const result = await uploadSignatureBlob(
				blob,
				fileName
			);

			console.log("Uploaded:", result);
		} catch (err) {
			console.error(err);
			alert("Upload failed.");
            }
    }, "image/png");
};

//This downloads the old processed signature, not the cleaned one.
function downloadOldSignature() {

    outputCanvas.toBlob(blob => {
        const url = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = url;
        a.download = "signature.png";
        a.click();

        URL.revokeObjectURL(url);
    }, "image/png");
};

//This downloads the new processed signature without preconverting to SVG
function downloadNewFinalCanvas() {
	
	let resized =
		new cv.Mat();

	cv.resize(
		finalThresh,
		resized,
		new cv.Size(finwidth,finheight),
		0,
		0,
		cv.INTER_AREA
	);

	// -----------------------------
	// SHOW RESULT
	// -----------------------------

	ThresholdCanvasP.width = finwidth;
	ThresholdCanvasP.height = finheight;

	cv.imshow(
		ThresholdCanvasP,
		resized
	);

    ThresholdCanvasP.toBlob(blob => {
        const url = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = url;
        a.download = "signature.png";
        a.click();

        URL.revokeObjectURL(url);
    }, "image/png");
};

//

function ProcessThreshold() {
    if (!finalThresh) return;

    const width = finalThresh.cols;
    const height = finalThresh.rows;

    ThresholdCanvasP.width = width;
    ThresholdCanvasP.height = height;
	
	cv.imshow(ThresholdCanvasP, finalThresh);
	
    const imageData =
        processedCtx.getImageData(0, 0, width, height);
	

    if (edgeCleanup.checked) {
        removeEdgeArtifacts(imageData.data, width, height);
        processedCtx.putImageData(imageData, 0, 0);
    }
	
	
	GlobalImageData = imageData;
	
	if (document.getElementById("autoDownload").checked){
		//downloadSvg(svg);
		//downloadPngFromSvg(svg);
	}
	
}

function removeEdgeArtifacts(data, width, height) {

    const visited = new Uint8Array(width * height);

    const stack = [];

    function isBlack(x, y) {

    const idx = (y * width + x) * 4;

    return data[idx] === 0;
	}

    function clearPixel(x, y) {
        const idx = (y * width + x) * 4;
        data[idx] = 255;
		data[idx + 1] = 255;
		data[idx + 2] = 255;
		data[idx + 3] = 255;
    }

    function floodFill(startX, startY) {

        stack.push([startX, startY]);

        while (stack.length > 0) {

            const [x, y] = stack.pop();

            if (
                x < 0 ||
                y < 0 ||
                x >= width ||
                y >= height
            ) continue;

            const pos = y * width + x;

            if (visited[pos]) continue;
            visited[pos] = 1;

            if (!isBlack(x, y)) continue;

            clearPixel(x, y);

            stack.push([x + 1, y]);
            stack.push([x - 1, y]);
            stack.push([x, y + 1]);
            stack.push([x, y - 1]);
        }
    }

    // Top + bottom edges
    for (let x = 0; x < width; x++) {
        floodFill(x, 0);
        floodFill(x, height - 1);
    }

    // Left + right edges
    for (let y = 0; y < height; y++) {
        floodFill(0, y);
        floodFill(width - 1, y);
    }
}

//Creates the Mats and reuses them cheaply
function initializeProcessingBuffers() {

    if (!blurred)
        blurred = new cv.Mat();

    if (!finalThresh)
        finalThresh = new cv.Mat();
}


//This calculates the Threshold value and re-gives it to the ProcessThreshold() function
function Recalculate() {
	if (!sigGray) return;

	initializeProcessingBuffers()
	
	//need to figure out how to incorporate edge stuff here instead of after
	
	const threshold = parseInt(thresholdSlider.value);
	cv.GaussianBlur(
		sigGray,
		blurred,
		new cv.Size(blurSize,blurSize),
		0
	);
	if (ImageProcessingVersion.checked) {
		cv.threshold(
			blurred,
			finalThresh,
			threshold,          // ignored when using Otsu
			255,
			cv.THRESH_BINARY_INV + cv.THRESH_OTSU
		);
	} else {
		cv.adaptiveThreshold(
			blurred,
			finalThresh,
			255,
			cv.ADAPTIVE_THRESH_GAUSSIAN_C,
			cv.THRESH_BINARY_INV,
			threshold+2,
			15
		);
	};
	
	cv.bitwise_not(finalThresh, finalThresh);
	
	if (Reshow && DEV_MODE){
		cv.imshow(
			ThresholdCanvasO,
			finalThresh
		)
		Reshow = false;
	}	
	uploaded = 2;
	downloadBtnp.disabled = false;
	
	ProcessThreshold()
	
}

//End of Threshold Function




//Initial Corner Finding Logic


//This needs to actually calculate based upon the other squares, instead of the closest point to the center.
function getInnerCorner(marker,centerX,centerY) {

    let closestPoint = null;

    let closestDistance =
        Infinity;

    for (let p of marker.points) {

        let dx =
            p.x - centerX;

        let dy =
            p.y - centerY;

        let dist =
            (dx * dx) +
            (dy * dy);

        if (dist < closestDistance) {

            closestDistance = dist;
            closestPoint = p;
        }
    }

    return closestPoint;
}


//Calculates distance
function distance(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;

    return dx * dx + dy * dy; // squared distance
}

//Initial processing of the image,
function processSingleSignatureLegacy() {

    if (uploaded===0) {

        alert("Upload image first");
        return;
    }

    if (typeof cv === 'undefined') {

        alert("OpenCV not loaded");
        return;
    }

    // -----------------------------
    // READ IMAGE
    // -----------------------------

    let src =
        cv.imread(inputCanvas);

    let gray =
        new cv.Mat();

    cv.cvtColor(
        src,
        gray,
        cv.COLOR_RGBA2GRAY
    );

    // -----------------------------
    // BLUR
    // ----------------------------	

    cv.GaussianBlur(
        gray,
        gray,
        new cv.Size(blurSize,blurSize),
        0
    );

    //Inverts the colors to try to find the 4 squares

    let thresh =
        new cv.Mat();

	if (adaptiveboxing) {
	    cv.adaptiveThreshold(
			gray,
			thresh,
			255,
			cv.ADAPTIVE_THRESH_GAUSSIAN_C,
			cv.THRESH_BINARY_INV,
			31,
			10
		);
	} else {
	    cv.threshold(
        gray,
        thresh,
        120,
        255,
        cv.THRESH_BINARY_INV
    );
	}
	
	
	//closes gaps to get a better picture of the squares
	if (morphboxing) {
		let kernel = cv.getStructuringElement(
		cv.MORPH_RECT,
		new cv.Size(3,3)
		);


		cv.morphologyEx(
			thresh,
			thresh,
			cv.MORPH_CLOSE,
			kernel
		);
		//cv.dilate(
		//	thresh,
		//	thresh,
		//	kernel
		//)
		kernel.delete();
	};
	


    // -----------------------------
    // TRY TO FIND 4 Squares
    // -----------------------------

    let contours =
        new cv.MatVector();

    let hierarchy =
        new cv.Mat();

    cv.findContours(
        thresh,
        contours,
        hierarchy,
        cv.RETR_EXTERNAL,
        cv.CHAIN_APPROX_SIMPLE
    );

    let markers = [];

    // -----------------------------
    // FIND LARGE SQUARES
    // -----------------------------

    for (let i = 0; i < contours.size(); i++) {

        let cnt =
            contours.get(i);

        let area =
            cv.contourArea(cnt);

        // Ignore tiny stuff
        if (area < minmarkarea)
            continue;

        let peri =
            cv.arcLength(cnt, true);

        let approx =
            new cv.Mat();

        cv.approxPolyDP(
            cnt,
            approx,
            0.02 * peri,
            true
        );

        // Must have 4-7 corners
        if (approx.rows >= 4 && approx.rows <= 6) {

            let rect =
                cv.boundingRect(approx);
				
			let rectArea =
				rect.width * rect.height;

			let fillRatio =
				area / rectArea;

            let aspect =
                rect.width / rect.height;
				
			let extent =
				area /
				(rect.width * rect.height);

            // Roughly square
			let points = [];

			for (let j = 0; j < 4; j++) {

				points.push({

					x: approx.data32S[j * 2],
					y: approx.data32S[(j * 2) + 1]

				});
			}
            if ( //aspect 70% a square. Fillratio of over 60% black
                aspect > 0.7 && aspect < 1.3
				//&& fillRatio > 0.6 && extent > 0.4
            ) {

                markers.push({
                    x: rect.x,
                    y: rect.y,
                    w: rect.width,
                    h: rect.height,
                    area: area,
					points: points
                });
            }
        }
        approx.delete();
		cnt.delete();
    }
	
	//Debug Information
	if (DEV_MODE && document.getElementById("debugMarkers").checked) {
		cv.imshow(
        inputCanvas,
        thresh
		);
		for (let marker of markers) {

			inputCtx.strokeStyle = "lime";
			inputCtx.lineWidth = 3;

			inputCtx.beginPath();

			inputCtx.moveTo(
				marker.points[0].x,
				marker.points[0].y
			);

			for (let j = 1; j < 4; j++) {

				inputCtx.lineTo(
					marker.points[j].x,
					marker.points[j].y
				);
			}

			inputCtx.closePath();
			inputCtx.stroke();
		}
	}
	
	

    // -----------------------------
    // NEED 4 MARKERS
    // -----------------------------
	if (markers.length < 4) {

        alert(
            `Signature Bounding Squares not found. Please make sure your image is taken at a straight angle and all 4 squares are visible.\n\nOnly detected ${markers.length} of 4 bounding squares.`
        );
    }
	else {

		// -----------------------------
		// KEEP 4 LARGEST
		// -----------------------------

		markers.sort(
			(a,b) => b.area - a.area
		);		

		markers = markers.slice(0,4);
		
		//This is a safety precaution to make sure the 2nd marker is consistent.
		const d1 = distance(markers[0], markers[1]);
		const d2 = distance(markers[0], markers[2]);

		if (d2 > d1) {
			
			// swap markers 1 and 2
			alert("Swapping markers");
			[markers[1], markers[2]] = [markers[2], markers[1]];
		}
		
		//Debug Info
		if (DEV_MODE && document.getElementById("debugMarkers").checked) {
			for (let marker of markers) {

			inputCtx.strokeStyle = "blue";
			inputCtx.lineWidth = 3;

			inputCtx.beginPath();

			inputCtx.moveTo(
				marker.points[0].x,
				marker.points[0].y
			);

			for (let j = 1; j < 4; j++) {

				inputCtx.lineTo(
					marker.points[j].x,
					marker.points[j].y
				);
			}

			inputCtx.closePath();
			inputCtx.stroke();
		}
		for(let i=0;i<markers.length;i++) {

			let m = markers[i];

			inputCtx.fillStyle = "red";
			inputCtx.font = "24px Arial";

			inputCtx.fillText(
				i,
				m.x,
				m.y
			);
		}
		};

		// -----------------------------
		// SORT INTO CORNERS
		// -----------------------------

		const tl = markers[0];
		const tr = markers[1];
		const bl = markers[2];
		const br = markers[3];
		
		//get dead center
		
		const centerX = (markers[0].x+markers[0].w+markers[1].x+markers[2].x+markers[2].w+markers[3].x)/4
		const centerY = (markers[0].y+markers[0].h+markers[1].y+markers[1].h+markers[2].y+markers[3].y)/4
			
		const tlInner = getInnerCorner(tl,centerX,centerY);
		const trInner = getInnerCorner(tr,centerX,centerY);
		const brInner = getInnerCorner(br,centerX,centerY);
		const blInner = getInnerCorner(bl,centerX,centerY);

		// -----------------------------
		// SOURCE POINTS
		// -----------------------------

		let srcPts =
		cv.matFromArray(
			4,
			1,
			cv.CV_32FC2,
			[

				tlInner.x,
				tlInner.y,

				trInner.x,
				trInner.y,

				brInner.x,
				brInner.y,

				blInner.x,
				blInner.y
			]
		);

		// -----------------------------
		// OUTPUT SIZE
		// -----------------------------


		let dstPts =
			cv.matFromArray(
				4,
				1,
				cv.CV_32FC2,
				[
					0,0,
					outWidth,0,
					outWidth,outHeight,
					0,outHeight
				]
			);

		// -----------------------------
		// PERSPECTIVE TRANSFORM
		// -----------------------------

		let M =
			cv.getPerspectiveTransform(
				srcPts,
				dstPts
			);

		let warped =
			new cv.Mat();

		cv.warpPerspective(
			src,
			warped,
			M,
			new cv.Size(
				outWidth,
				outHeight
			)
		);

		// ----------------------------- // CROP ENTIRE INTERIOR // ----------------------------- // Small inward margin 
		const marginPercent = 0.015; // Shrink inward slightly
		const marginX = Math.floor(outWidth * marginPercent); const marginY = Math.floor(outHeight * marginPercent); // Full interior crop 
		const sigRect = new cv.Rect( marginX, marginY, outWidth - (marginX * 2), outHeight - (marginY * 2) );
		let signature = warped.roi(sigRect);
		
		
		// -----------------------------
		// GRAYSCALE
		// -----------------------------
		sigGray =
			new cv.Mat();

		cv.cvtColor(
			signature,
			sigGray,
			cv.COLOR_RGBA2GRAY
		);

		// -----------------------------
		// RESIZE
		// -----------------------------

		let resized =
			new cv.Mat();

		cv.resize(
			sigGray,
			resized,
			new cv.Size(finwidth,finheight),
			0,
			0,
			cv.INTER_AREA
		);

		// -----------------------------
		// SHOW RESULT
		// -----------------------------

		outputCanvas.width = finwidth;
		outputCanvas.height = finheight;

		cv.imshow(
			outputCanvas,
			resized
		);

		Recalculate();

		if (document.getElementById("autoDownload").checked && OldSig && DEV_MODE) {
		//uploadOldSignature()
		//downloadOldSignature()
		}		

		cleanup();

		// -----------------------------
		// CLEANUP
		// -----------------------------

		function cleanup() {

			src.delete();
			gray.delete();

			thresh.delete();

			contours.delete();
			hierarchy.delete();

			srcPts.delete();
			dstPts.delete();

			M.delete();
			warped.delete();

			signature.delete();
			//sigGray.delete();
			
			resized.delete();
		}
	}
}

// Detect every four-marker signature box on a full sheet. This replaces the
// legacy behavior that kept only the four largest markers on the page.
function processImage() {
    if (uploaded === 0) {
        alert('Upload an image first');
        return;
    }

    if (typeof cv === 'undefined') {
        alert('OpenCV not loaded');
        return;
    }

    setSignatureSelectorStatus('Finding signature boxes...');

    let src = null;
    let gray = null;
    let thresh = null;
    let contours = null;
    let hierarchy = null;

    try {
        src = cv.imread(sourceImageCanvas);
        gray = new cv.Mat();
        thresh = new cv.Mat();
        contours = new cv.MatVector();
        hierarchy = new cv.Mat();

        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        cv.GaussianBlur(gray, gray, new cv.Size(blurSize, blurSize), 0);

        if (adaptiveboxing) {
            cv.adaptiveThreshold(
                gray,
                thresh,
                255,
                cv.ADAPTIVE_THRESH_GAUSSIAN_C,
                cv.THRESH_BINARY_INV,
                31,
                10
            );
        } else {
            cv.threshold(gray, thresh, 120, 255, cv.THRESH_BINARY_INV);
        }

        if (morphboxing) {
            // The template lines touch or nearly touch the black markers. A
            // close operation joins them into long rectangular contours. A
            // scale-aware opening removes the thin lines while preserving the
            // solid marker squares.
            const kernelSize = Math.max(
                5,
                Math.round(Math.min(src.cols, src.rows) / 250) | 1
            );
            const kernel = cv.getStructuringElement(
                cv.MORPH_RECT,
                new cv.Size(kernelSize, kernelSize)
            );
            cv.morphologyEx(thresh, thresh, cv.MORPH_OPEN, kernel);
            kernel.delete();
        }

        cv.findContours(
            thresh,
            contours,
            hierarchy,
            cv.RETR_EXTERNAL,
            cv.CHAIN_APPROX_SIMPLE
        );

        const markers = findSignatureMarkers(contours, src.cols, src.rows);

        if (DEV_MODE && document.getElementById('debugMarkers').checked) {
            drawDetectedMarkers(thresh, markers);
        }

        const orientation = findBestSignatureOrientation(markers, src.cols, src.rows);
        let regions = orientation.regions;

        if (regions.length > 0 && Math.abs(orientation.angle) >= 1) {
            console.info(`Signature sheet orientation normalized by ${orientation.angle} degrees.`);
        }

        // Retain compatibility with a tightly cropped, single-signature image
        // if row grouping cannot be established.
        if (regions.length === 0 && markers.length >= 4 && markers.length <= 8) {
            const fallback = buildSingleRegionFallback(markers);
            if (fallback) regions = [fallback];
        }

        if (regions.length === 0) {
            resetSignatureSelector();
            alert(
                `No complete signature boxes were found. ${markers.length} square marker${markers.length === 1 ? '' : 's'} ` +
                'were detected. Make sure the sheet is straight and all four corner squares for each signature are visible.'
            );
            return;
        }

        signatureCandidates = regions.map((region, index) => {
            const preview = createSignaturePreview(src, region);
            return {
                index,
                region,
                previewUrl: preview.url,
                inkScore: preview.inkScore,
                likelyBlank: preview.inkScore < 0.004
            };
        });

        if (signatureCandidates.length === 1) {
            resetSignatureSelector();
            selectSignatureCandidate(0, true);
        } else {
            renderSignatureSelector();
        }
    } catch (err) {
        console.error(err);
        resetSignatureSelector();
        alert('The signature sheet could not be analyzed. ' + (err.message || ''));
    } finally {
        if (src) src.delete();
        if (gray) gray.delete();
        if (thresh) thresh.delete();
        if (contours) contours.delete();
        if (hierarchy) hierarchy.delete();
    }
}

function findSignatureMarkers(contours, imageWidth, imageHeight) {
    const markers = [];
    const dynamicMinArea = Math.max(minmarkarea, imageWidth * imageHeight * 0.00006);
    const maxMarkerSize = Math.min(imageWidth, imageHeight) * 0.11;

    for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const area = cv.contourArea(cnt);

        if (area < dynamicMinArea) {
            cnt.delete();
            continue;
        }

        const perimeter = cv.arcLength(cnt, true);
        const approx = new cv.Mat();
        cv.approxPolyDP(cnt, approx, 0.02 * perimeter, true);

        if (approx.rows >= 4 && approx.rows <= 8) {
            const rect = cv.boundingRect(approx);
            const rectArea = rect.width * rect.height;
            const aspect = rect.width / rect.height;
            const fillRatio = rectArea > 0 ? area / rectArea : 0;

            if (
                rect.width >= 12 &&
                rect.height >= 12 &&
                rect.width <= maxMarkerSize &&
                rect.height <= maxMarkerSize &&
                aspect > 0.62 &&
                aspect < 1.45 &&
                fillRatio > 0.45
            ) {
                const points = [];

                for (let j = 0; j < approx.rows; j++) {
                    points.push({
                        x: approx.data32S[j * 2],
                        y: approx.data32S[(j * 2) + 1]
                    });
                }

                markers.push({
                    x: rect.x,
                    y: rect.y,
                    w: rect.width,
                    h: rect.height,
                    centerX: rect.x + (rect.width / 2),
                    centerY: rect.y + (rect.height / 2),
                    area,
                    points
                });
            }
        }

        approx.delete();
        cnt.delete();
    }

    return removeDuplicateMarkers(markers);
}

function removeDuplicateMarkers(markers) {
    const sorted = [...markers].sort((a, b) => b.area - a.area);
    const result = [];

    for (const marker of sorted) {
        const duplicate = result.some(existing => {
            const dx = marker.centerX - existing.centerX;
            const dy = marker.centerY - existing.centerY;
            const tolerance = Math.max(4, Math.min(marker.w, marker.h, existing.w, existing.h) * 0.4);
            return (dx * dx) + (dy * dy) <= tolerance * tolerance;
        });

        if (!duplicate) result.push(marker);
    }

    return result;
}

function drawDetectedMarkers(thresh, markers) {
    cv.imshow(inputCanvas, thresh);
    inputCtx.strokeStyle = 'lime';
    inputCtx.lineWidth = 3;

    for (const marker of markers) {
        inputCtx.strokeRect(marker.x, marker.y, marker.w, marker.h);
    }
}

function median(values) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function rotateMarkersForGrouping(markers, angle, imageWidth, imageHeight) {
    const radians = angle * Math.PI / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const pageCenterX = imageWidth / 2;
    const pageCenterY = imageHeight / 2;

    return markers.map(marker => {
        const sourceCenterX = marker.sourceCenterX ?? marker.centerX;
        const sourceCenterY = marker.sourceCenterY ?? marker.centerY;
        const offsetX = sourceCenterX - pageCenterX;
        const offsetY = sourceCenterY - pageCenterY;

        return {
            ...marker,
            sourceCenterX,
            sourceCenterY,
            centerX: (offsetX * cosine) - (offsetY * sine),
            centerY: (offsetX * sine) + (offsetY * cosine)
        };
    });
}

function getRotatedPageYRange(angle, imageWidth, imageHeight) {
    const radians = angle * Math.PI / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const halfWidth = imageWidth / 2;
    const halfHeight = imageHeight / 2;
    const corners = [
        [-halfWidth, -halfHeight],
        [halfWidth, -halfHeight],
        [halfWidth, halfHeight],
        [-halfWidth, halfHeight]
    ];
    const yValues = corners.map(([x, y]) => (x * sine) + (y * cosine));

    return {
        minY: Math.min(...yValues),
        maxY: Math.max(...yValues)
    };
}

function scoreSignatureOrientation(regions, normalizedMarkers, angle, imageWidth, imageHeight) {
    if (regions.length === 0) return -Infinity;

    const typicalMarkerSize = Math.max(
        1,
        median(normalizedMarkers.map(marker => (marker.w + marker.h) / 2))
    );
    let alignmentError = 0;
    let topAreaBias = 0;

    for (const region of regions) {
        alignmentError += Math.abs(region.tl.centerY - region.tr.centerY);
        alignmentError += Math.abs(region.bl.centerY - region.br.centerY);
        alignmentError += Math.abs(region.tl.centerX - region.bl.centerX);
        alignmentError += Math.abs(region.tr.centerX - region.br.centerX);

        const topArea = region.tl.area + region.tr.area;
        const bottomArea = region.bl.area + region.br.area;
        const averageArea = Math.max(1, (topArea + bottomArea) / 2);
        topAreaBias += (topArea - bottomArea) / averageArea;
    }

    const pageRange = getRotatedPageYRange(angle, imageWidth, imageHeight);
    const markerMinY = Math.min(...normalizedMarkers.map(marker => marker.centerY));
    const markerMaxY = Math.max(...normalizedMarkers.map(marker => marker.centerY));
    const pageHeight = Math.max(1, pageRange.maxY - pageRange.minY);
    const topMargin = markerMinY - pageRange.minY;
    const bottomMargin = pageRange.maxY - markerMaxY;
    const marginBias = (topMargin - bottomMargin) / pageHeight;
    const normalizedAlignmentError = alignmentError / (regions.length * typicalMarkerSize);

    // Alignment chooses the precise deskew angle. The template's larger top
    // markers and larger instruction margin distinguish upright from 180°.
    return (-normalizedAlignmentError * 4) + (topAreaBias / regions.length) + marginBias;
}

function findBestSignatureOrientation(markers, imageWidth, imageHeight) {
    if (markers.length < 4) {
        return { angle: 0, regions: [] };
    }

    let best = {
        angle: 0,
        regions: [],
        quality: -Infinity
    };

    // One-degree steps are fine enough for row grouping; the four original
    // contour corners still perform the exact perspective correction.
    for (let angle = -180; angle < 180; angle++) {
        const normalizedMarkers = rotateMarkersForGrouping(
            markers,
            angle,
            imageWidth,
            imageHeight
        );
        const regions = buildSignatureRegions(normalizedMarkers, imageWidth, imageHeight);
        const quality = scoreSignatureOrientation(
            regions,
            normalizedMarkers,
            angle,
            imageWidth,
            imageHeight
        );

        if (
            regions.length > best.regions.length ||
            (regions.length === best.regions.length && quality > best.quality)
        ) {
            best = { angle, regions, quality };
        }
    }

    return best;
}

function buildSignatureRegions(markers, imageWidth, imageHeight) {
    if (markers.length < 4) return [];

    const typicalMarkerSize = median(markers.map(marker => (marker.w + marker.h) / 2));
    const rowTolerance = Math.max(12, typicalMarkerSize * 1.65);
    const rows = [];

    for (const marker of [...markers].sort((a, b) => a.centerY - b.centerY)) {
        let bestRow = null;
        let bestDistance = Infinity;

        for (const row of rows) {
            const distanceFromRow = Math.abs(marker.centerY - row.centerY);
            if (distanceFromRow <= rowTolerance && distanceFromRow < bestDistance) {
                bestRow = row;
                bestDistance = distanceFromRow;
            }
        }

        if (!bestRow) {
            bestRow = { markers: [], centerY: marker.centerY };
            rows.push(bestRow);
        }

        bestRow.markers.push(marker);
        bestRow.centerY = bestRow.markers.reduce((sum, item) => sum + item.centerY, 0) / bestRow.markers.length;
    }

    const pairedRows = rows
        .map(row => ({
            centerY: row.centerY,
            pairs: findHorizontalMarkerPairs(row.markers, typicalMarkerSize, imageWidth)
        }))
        .filter(row => row.pairs.length > 0)
        .sort((a, b) => a.centerY - b.centerY);

    if (pairedRows.length < 2) return [];

    const offsetZero = pairMarkerRows(pairedRows, 0, typicalMarkerSize, imageHeight);
    const offsetOne = pairMarkerRows(pairedRows, 1, typicalMarkerSize, imageHeight);
    const regions = offsetOne.length > offsetZero.length ? offsetOne : offsetZero;

    return regions
        .sort((a, b) => {
            const yDifference = a.centerY - b.centerY;
            return Math.abs(yDifference) > rowTolerance ? yDifference : a.centerX - b.centerX;
        })
        .map((region, index) => ({ ...region, sheetIndex: index + 1 }));
}

function findHorizontalMarkerPairs(markers, typicalMarkerSize, imageWidth) {
    const sorted = [...markers].sort((a, b) => a.centerX - b.centerX);
    const pairs = [];

    for (let i = 0; i < sorted.length - 1;) {
        const left = sorted[i];
        const right = sorted[i + 1];
        const gap = right.centerX - left.centerX;
        const minimumGap = typicalMarkerSize * 4.5;
        const maximumGap = imageWidth * 0.9;

        if (gap >= minimumGap && gap <= maximumGap) {
            pairs.push({
                left,
                right,
                centerX: (left.centerX + right.centerX) / 2,
                width: gap
            });
            i += 2;
        } else {
            i += 1;
        }
    }

    return pairs;
}

function pairMarkerRows(rows, offset, typicalMarkerSize, imageHeight) {
    const regions = [];

    for (let i = offset; i + 1 < rows.length; i += 2) {
        const topRow = rows[i];
        const bottomRow = rows[i + 1];
        const verticalGap = bottomRow.centerY - topRow.centerY;

        if (verticalGap < typicalMarkerSize * 1.5 || verticalGap > imageHeight * 0.35) continue;

        const unusedBottomPairs = new Set(bottomRow.pairs);

        for (const topPair of topRow.pairs) {
            let bestBottomPair = null;
            let bestScore = Infinity;

            for (const bottomPair of unusedBottomPairs) {
                const widthRatio = bottomPair.width / topPair.width;
                const centerDifference = Math.abs(bottomPair.centerX - topPair.centerX);
                const averageWidth = (bottomPair.width + topPair.width) / 2;
                const boxAspect = averageWidth / verticalGap;

                if (widthRatio < 0.65 || widthRatio > 1.5) continue;
                if (centerDifference > averageWidth * 0.2) continue;
                if (boxAspect < 1.8 || boxAspect > 8) continue;

                const score = (centerDifference / averageWidth) + Math.abs(1 - widthRatio);
                if (score < bestScore) {
                    bestScore = score;
                    bestBottomPair = bottomPair;
                }
            }

            if (bestBottomPair) {
                unusedBottomPairs.delete(bestBottomPair);
                regions.push({
                    tl: topPair.left,
                    tr: topPair.right,
                    bl: bestBottomPair.left,
                    br: bestBottomPair.right,
                    centerX: (topPair.centerX + bestBottomPair.centerX) / 2,
                    centerY: (topRow.centerY + bottomRow.centerY) / 2
                });
            }
        }
    }

    return regions;
}

function buildSingleRegionFallback(markers) {
    const four = [...markers]
        .sort((a, b) => b.area - a.area)
        .slice(0, 4)
        .sort((a, b) => a.centerY - b.centerY);

    if (four.length < 4) return null;

    const top = four.slice(0, 2).sort((a, b) => a.centerX - b.centerX);
    const bottom = four.slice(2, 4).sort((a, b) => a.centerX - b.centerX);

    return {
        tl: top[0],
        tr: top[1],
        bl: bottom[0],
        br: bottom[1],
        centerX: (top[0].centerX + top[1].centerX + bottom[0].centerX + bottom[1].centerX) / 4,
        centerY: (top[0].centerY + top[1].centerY + bottom[0].centerY + bottom[1].centerY) / 4,
        sheetIndex: 1
    };
}

function getRegionInnerCorners(region) {
    const getSourceX = marker => marker.sourceCenterX ?? marker.centerX;
    const getSourceY = marker => marker.sourceCenterY ?? marker.centerY;
    const centerX = (
        getSourceX(region.tl) +
        getSourceX(region.tr) +
        getSourceX(region.bl) +
        getSourceX(region.br)
    ) / 4;
    const centerY = (
        getSourceY(region.tl) +
        getSourceY(region.tr) +
        getSourceY(region.bl) +
        getSourceY(region.br)
    ) / 4;

    return {
        tl: getInnerCorner(region.tl, centerX, centerY),
        tr: getInnerCorner(region.tr, centerX, centerY),
        br: getInnerCorner(region.br, centerX, centerY),
        bl: getInnerCorner(region.bl, centerX, centerY)
    };
}

function warpSignatureRegion(src, region, width, height) {
    const corners = getRegionInnerCorners(region);
    const srcPts = cv.matFromArray(
        4,
        1,
        cv.CV_32FC2,
        [
            corners.tl.x, corners.tl.y,
            corners.tr.x, corners.tr.y,
            corners.br.x, corners.br.y,
            corners.bl.x, corners.bl.y
        ]
    );
    const dstPts = cv.matFromArray(
        4,
        1,
        cv.CV_32FC2,
        [0, 0, width - 1, 0, width - 1, height - 1, 0, height - 1]
    );
    const transform = cv.getPerspectiveTransform(srcPts, dstPts);
    const warped = new cv.Mat();

    cv.warpPerspective(
        src,
        warped,
        transform,
        new cv.Size(width, height),
        cv.INTER_LINEAR,
        cv.BORDER_CONSTANT,
        new cv.Scalar(255, 255, 255, 255)
    );

    srcPts.delete();
    dstPts.delete();
    transform.delete();

    return warped;
}

function createSignaturePreview(src, region) {
    const width = 440;
    const height = 100;
    const warped = warpSignatureRegion(src, region, width, height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    cv.imshow(canvas, warped);
    warped.delete();

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const imageData = ctx.getImageData(0, 0, width, height).data;
    let darkPixels = 0;
    let inspectedPixels = 0;
    const startY = Math.floor(height * 0.16);
    const endY = Math.ceil(height * 0.84);

    for (let y = startY; y < endY; y++) {
        for (let x = 3; x < width - 3; x++) {
            const index = (y * width + x) * 4;
            const luminance = (imageData[index] * 0.299) + (imageData[index + 1] * 0.587) + (imageData[index + 2] * 0.114);
            if (luminance < 165) darkPixels++;
            inspectedPixels++;
        }
    }

    return {
        url: canvas.toDataURL('image/png'),
        inkScore: inspectedPixels ? darkPixels / inspectedPixels : 0
    };
}

function renderSignatureSelector() {
    const grid = document.getElementById('signatureSelectorGrid');
    if (!grid) return;

    grid.replaceChildren();
    const nonBlankCount = signatureCandidates.filter(candidate => !candidate.likelyBlank).length;
    setSignatureSelectorStatus(
        `Found ${signatureCandidates.length} signature boxes` +
        (nonBlankCount ? ` (${nonBlankCount} appear to contain writing).` : '.') +
        ' Select one to continue.'
    );

    signatureCandidates.forEach((candidate, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'signature-choice';
        button.dataset.signatureIndex = String(index);
        button.setAttribute('aria-pressed', 'false');

        const image = document.createElement('img');
        image.src = candidate.previewUrl;
        image.alt = `Preview of signature box ${index + 1}`;

        const title = document.createElement('span');
        title.className = 'signature-choice-title';

        const name = document.createElement('span');
        name.textContent = `Signature ${index + 1}`;
        title.appendChild(name);

        if (candidate.likelyBlank) {
            const note = document.createElement('span');
            note.className = 'signature-choice-note';
            note.textContent = 'Appears blank';
            title.appendChild(note);
        }

        button.appendChild(image);
        button.appendChild(title);
        button.addEventListener('click', () => selectSignatureCandidate(index));
        grid.appendChild(button);
    });
}

function selectSignatureCandidate(index, singleCandidate = false) {
    const candidate = signatureCandidates[index];
    if (!candidate) return;

    try {
        applySignatureRegion(candidate.region);
        selectedSignatureIndex = index;

        document.querySelectorAll('.signature-choice').forEach(button => {
            const isSelected = Number(button.dataset.signatureIndex) === index;
            button.classList.toggle('is-selected', isSelected);
            button.setAttribute('aria-pressed', String(isSelected));
        });

        if (!singleCandidate) {
            setSignatureSelectorStatus(`Signature ${index + 1} selected. You can choose another box at any time.`);
        }
    } catch (err) {
        console.error(err);
        alert('That signature could not be prepared. ' + (err.message || ''));
    }
}

function applySignatureRegion(region) {
    let src = null;
    let warped = null;
    let signature = null;
    let resized = null;

    try {
        src = cv.imread(sourceImageCanvas);
        warped = warpSignatureRegion(src, region, outWidth, outHeight);

        const marginX = Math.floor(outWidth * 0.005);
        const marginY = Math.floor(outHeight * 0.005);
        const sigRect = new cv.Rect(
            marginX,
            marginY,
            outWidth - (marginX * 2),
            outHeight - (marginY * 2)
        );
        signature = warped.roi(sigRect);

        const nextSigGray = new cv.Mat();
        cv.cvtColor(signature, nextSigGray, cv.COLOR_RGBA2GRAY);

        if (sigGray) sigGray.delete();
        sigGray = nextSigGray;

        resized = new cv.Mat();
        cv.resize(sigGray, resized, new cv.Size(finwidth, finheight), 0, 0, cv.INTER_AREA);

        outputCanvas.width = finwidth;
        outputCanvas.height = finheight;
        cv.imshow(outputCanvas, resized);

        Reshow = true;
        GlobalImageData = null;
        uploaded = 1;
        Recalculate();
        downloadBtnp.disabled = false;
    } finally {
        if (src) src.delete();
        if (warped) warped.delete();
        if (signature) signature.delete();
        if (resized) resized.delete();
    }
}

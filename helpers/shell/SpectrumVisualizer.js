import Clutter from "gi://Clutter";
import GObject from "gi://GObject";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import St from "gi://St";
import Cairo from "gi://cairo";

import { debugLog } from "../../utils/common.js";

// ─── Constants ───────────────────────────────────────────────────────────────
const NUM_BARS = 16;
const BAR_GAP = 3;
const BAR_RADIUS = 2;
const VISUALIZER_HEIGHT = 30;
const ANIMATION_INTERVAL_MS = 33; // ~30 FPS

// ─── WinAmp Peak Cap Physics ────────────────────────────────────────────────
const PEAK_HOLD_FRAMES = 7;        // frames peak cap holds at peak top (~230ms)
const PEAK_GRAVITY = 0.007;        // gravity acceleration per frame

// ─── WinAmp Bar Dynamics ────────────────────────────────────────────────────
const BAR_RISE_SPEED = 0.65;       // Fast attack (65% lerp to real FFT target per frame)
const BAR_FALL_SPEED = 0.08;       // Smooth linear decay per frame

/**
 * Attempt to get the foreground color from the theme.
 * Returns an array [r, g, b] with values in 0–1 range.
 * Falls back to a soft white.
 * @param {St.Widget} widget
 * @returns {[number, number, number]}
 */
function getThemeForegroundColor(widget) {
    try {
        const themeNode = widget.get_theme_node();
        if (themeNode) {
            const color = themeNode.get_foreground_color();
            return [color.red / 255, color.green / 255, color.blue / 255];
        }
    } catch (_e) {
        // ignore
    }
    return [0.85, 0.85, 0.9];
}

/** @extends St.DrawingArea */
class SpectrumVisualizer extends St.DrawingArea {
    /** @private @type {number[]} - Current bar heights (0–1) */
    _barHeights;
    /** @private @type {number[]} - Real FFT target heights */
    _barTargets;
    /** @private @type {number[]} - Peak cap position (0–1) */
    _peakHeights;
    /** @private @type {number[]} - Peak cap velocity */
    _peakVelocity;
    /** @private @type {number[]} - Frames remaining in peak hold */
    _peakHoldCounter;
    /** @private @type {boolean} */
    _isAnimating;
    /** @private @type {boolean} */
    _isPlaying;
    /** @private @type {number | null} */
    _animSourceId;
    /** @private @type {Gio.Subprocess | null} */
    _helperProc;
    /** @private @type {Gio.DataInputStream | null} */
    _dataInputStream;
    /** @private @type {number} */
    _spectrumWidth;

    /**
     * @param {number} [width=200]
     */
    constructor(width = 200) {
        super({
            styleClass: "popup-menu-spectrum",
            xExpand: false,
            yExpand: false,
            xAlign: Clutter.ActorAlign.CENTER,
            width: width,
            height: VISUALIZER_HEIGHT,
            reactive: false,
        });

        this._spectrumWidth = width;
        this._barHeights = new Array(NUM_BARS).fill(0);
        this._barTargets = new Array(NUM_BARS).fill(0);
        this._peakHeights = new Array(NUM_BARS).fill(0);
        this._peakVelocity = new Array(NUM_BARS).fill(0);
        this._peakHoldCounter = new Array(NUM_BARS).fill(0);
        this._isAnimating = false;
        this._isPlaying = false;
        this._animSourceId = null;
        this._helperProc = null;
        this._dataInputStream = null;

        this.connect("repaint", this._onRepaint.bind(this));
        this.connect("destroy", this._onDestroy.bind(this));
    }

    /**
     * Update width to match defined album art / menu label width
     * @public
     * @param {number} width
     */
    setSpectrumWidth(width) {
        if (width && width > 0 && this._spectrumWidth !== width) {
            this._spectrumWidth = width;
            this.width = width;
            this.queue_relayout();
            this.queue_repaint();
        }
    }

    /**
     * Required by St layout manager to allocate height
     * @param {number} _forWidth
     * @returns {[number, number]}
     */
    vfunc_get_preferred_height(_forWidth) {
        return [VISUALIZER_HEIGHT, VISUALIZER_HEIGHT];
    }

    /**
     * Required by St layout manager to allocate width
     * @param {number} _forHeight
     * @returns {[number, number]}
     */
    vfunc_get_preferred_width(_forHeight) {
        const w = this._spectrumWidth || 200;
        return [w, w];
    }

    /**
     * Start animating & launch real-time PipeWire FFT process
     * @public
     */
    start() {
        this._isPlaying = true;
        this._startHelperProcess();
        this._startAnimation();
    }

    /**
     * Pause animation & stop helper process
     * @public
     */
    pause() {
        this._isPlaying = false;
        this._stopHelperProcess();
        for (let i = 0; i < NUM_BARS; i++) {
            this._barTargets[i] = 0;
        }
        this._startAnimation();
    }

    /**
     * Stop animation & kill helper process
     * @public
     */
    stop() {
        this._isPlaying = false;
        this._stopHelperProcess();
        for (let i = 0; i < NUM_BARS; i++) {
            this._barTargets[i] = 0;
        }
        this._startAnimation();
    }

    // ─── PipeWire Real FFT Subprocess Integration ───────────────────────

    /**
     * Launch Python PipeWire FFT helper subprocess
     * @private
     */
    _startHelperProcess() {
        if (this._helperProc != null) return;

        try {
            const scriptPath = GLib.build_filenamev([
                GLib.get_user_data_dir(),
                "gnome-shell",
                "extensions",
                "mediacontrols@cliffniff.github.com",
                "helpers",
                "shell",
                "spectrum_fft_helper.py"
            ]);

            this._helperProc = new Gio.Subprocess({
                argv: ["/usr/bin/python3", scriptPath],
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
            });

            this._helperProc.init(null);

            const stdoutStream = this._helperProc.get_stdout_pipe();
            this._dataInputStream = new Gio.DataInputStream({
                base_stream: stdoutStream,
            });

            this._readNextFFTLine();
        } catch (e) {
            debugLog(`Failed to start PipeWire spectrum helper: ${e}`);
            this._stopHelperProcess();
        }
    }

    /**
     * Asynchronously read next line of real FFT numbers from stdout
     * @private
     */
    _readNextFFTLine() {
        if (!this._dataInputStream || !this._isPlaying) return;

        this._dataInputStream.read_line_async(
            GLib.PRIORITY_DEFAULT,
            null,
            (stream, res) => {
                try {
                    const [line] = stream.read_line_finish_utf8(res);
                    if (line !== null && line.length > 0) {
                        const parts = line.split(",");
                        if (parts.length >= NUM_BARS) {
                            for (let i = 0; i < NUM_BARS; i++) {
                                const val = parseFloat(parts[i]);
                                if (!isNaN(val)) {
                                    this._barTargets[i] = Math.max(0, Math.min(1.0, val));
                                }
                            }
                        }
                    }

                    if (this._isPlaying && this._dataInputStream) {
                        this._readNextFFTLine();
                    }
                } catch (_e) {
                    // stream closed or error
                }
            }
        );
    }

    /**
     * Terminate PipeWire FFT helper process
     * @private
     */
    _stopHelperProcess() {
        if (this._dataInputStream) {
            try {
                this._dataInputStream.close(null);
            } catch (_e) {}
            this._dataInputStream = null;
        }

        if (this._helperProc) {
            try {
                this._helperProc.force_exit();
            } catch (_e) {}
            this._helperProc = null;
        }
    }

    // ─── Animation Frame Loop ───────────────────────────────────────────

    /**
     * Start the animation frame loop (~30 FPS)
     * @private
     */
    _startAnimation() {
        if (this._isAnimating) return;
        this._isAnimating = true;

        this._animSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            ANIMATION_INTERVAL_MS,
            () => {
                if (!this._isAnimating) {
                    this._animSourceId = null;
                    return GLib.SOURCE_REMOVE;
                }

                let allSettled = true;

                for (let i = 0; i < NUM_BARS; i++) {
                    const target = this._barTargets[i];
                    const current = this._barHeights[i];

                    // ─── Snappy WinAmp Bar Motion ───────────────
                    if (target > current) {
                        // FAST ATTACK: Bar snaps up quickly to real FFT target
                        this._barHeights[i] += (target - current) * BAR_RISE_SPEED;
                    } else {
                        // DECAY: Smooth linear drop
                        this._barHeights[i] -= BAR_FALL_SPEED;
                        if (this._barHeights[i] < target) {
                            this._barHeights[i] = target;
                        }
                    }

                    this._barHeights[i] = Math.max(0, Math.min(1, this._barHeights[i]));

                    // ─── WinAmp Floating Peak Cap Physics ───────────
                    if (this._barHeights[i] >= this._peakHeights[i]) {
                        // Snap peak cap to bar top & reset hold timer
                        this._peakHeights[i] = this._barHeights[i];
                        this._peakVelocity[i] = 0;
                        this._peakHoldCounter[i] = PEAK_HOLD_FRAMES;
                    } else if (this._peakHoldCounter[i] > 0) {
                        // Hold peak cap in mid-air
                        this._peakHoldCounter[i]--;
                    } else {
                        // Gravity acceleration pulls peak cap down
                        this._peakVelocity[i] += PEAK_GRAVITY;
                        this._peakHeights[i] -= this._peakVelocity[i];
                        if (this._peakHeights[i] < this._barHeights[i]) {
                            this._peakHeights[i] = this._barHeights[i];
                            this._peakVelocity[i] = 0;
                        }
                    }

                    this._peakHeights[i] = Math.max(0, Math.min(1, this._peakHeights[i]));

                    if (Math.abs(this._barHeights[i] - target) > 0.005 ||
                        this._peakHeights[i] > target + 0.01) {
                        allSettled = false;
                    }
                }

                this.queue_repaint();

                if (!this._isPlaying && allSettled) {
                    this._isAnimating = false;
                    this._animSourceId = null;
                    return GLib.SOURCE_REMOVE;
                }

                return GLib.SOURCE_CONTINUE;
            },
        );
    }

    /**
     * Stop the animation frame loop
     * @private
     */
    _stopAnimation() {
        this._isAnimating = false;
        if (this._animSourceId != null) {
            GLib.source_remove(this._animSourceId);
            this._animSourceId = null;
        }
    }

    // ─── Cairo Rendering ────────────────────────────────────────────────

    /**
     * Cairo repaint callback — draws the Stacked Pill / Dot Matrix LED VU meter
     * with WinAmp-style floating peak caps driven by Real FFT data.
     * @private
     * @param {St.DrawingArea} area
     */
    _onRepaint(area) {
        const cr = area.get_context();
        const [areaWidth, areaHeight] = area.get_surface_size();

        if (areaWidth <= 0 || areaHeight <= 0) return;

        const [r, g, b] = getThemeForegroundColor(this);

        const totalGaps = (NUM_BARS - 1) * BAR_GAP;
        const barWidth = Math.max(1, (areaWidth - totalGaps) / NUM_BARS);

        const DOTS_PER_COL = 6;
        const DOT_GAP = 1.5;
        const totalDotGaps = (DOTS_PER_COL - 1) * DOT_GAP;
        const dotHeight = (areaHeight - totalDotGaps) / DOTS_PER_COL;

        for (let col = 0; col < NUM_BARS; col++) {
            const activeRatio = this._barHeights[col]; // 0.0 to 1.0
            const activeDots = Math.round(activeRatio * DOTS_PER_COL);
            const peakRatio = this._peakHeights[col];
            const peakDot = Math.round(peakRatio * DOTS_PER_COL) - 1;

            const x = col * (barWidth + BAR_GAP);

            for (let dot = 0; dot < DOTS_PER_COL; dot++) {
                const y = areaHeight - (dot + 1) * dotHeight - dot * DOT_GAP;

                this._drawPill(cr, x, y, barWidth, dotHeight, Math.min(BAR_RADIUS, dotHeight / 2));

                const isLit = dot < activeDots || (dot === 0 && activeRatio > 0.02);
                const isPeakCap = (dot === peakDot) && peakRatio > 0.08 && dot >= activeDots;

                if (isPeakCap) {
                    // WinAmp Floating Peak Cap (Bright highlighted top dot)
                    cr.setSourceRGBA(r, g, b, 0.95);
                } else if (isLit) {
                    // Lit LED Dot (Graduated VU brightness)
                    const dotLevel = (dot + 1) / DOTS_PER_COL;
                    const alpha = 0.50 + dotLevel * 0.45; // 0.50 → 0.95
                    cr.setSourceRGBA(r, g, b, alpha);
                } else {
                    // Unlit LED Matrix Dot
                    cr.setSourceRGBA(r, g, b, 0.06);
                }
                cr.fill();
            }
        }

        cr.$dispose();
    }

    /**
     * Draw a rounded pill shape
     * @private
     * @param {Cairo.Context} cr
     * @param {number} x
     * @param {number} y
     * @param {number} w
     * @param {number} h
     * @param {number} radius
     */
    _drawPill(cr, x, y, w, h, radius) {
        if (h < radius * 2) radius = h / 2;
        if (w < radius * 2) radius = w / 2;

        cr.newPath();
        cr.arc(x + radius, y + radius, radius, Math.PI, 1.5 * Math.PI);
        cr.arc(x + w - radius, y + radius, radius, 1.5 * Math.PI, 2 * Math.PI);
        cr.arc(x + w - radius, y + h - radius, radius, 0, 0.5 * Math.PI);
        cr.arc(x + radius, y + h - radius, radius, 0.5 * Math.PI, Math.PI);
        cr.closePath();
    }

    /**
     * Cleanup on destroy
     * @private
     */
    _onDestroy() {
        this._stopAnimation();
        this._stopHelperProcess();
        this._barHeights = null;
        this._barTargets = null;
        this._peakHeights = null;
        this._peakVelocity = null;
        this._peakHoldCounter = null;
    }
}

const GSpectrumVisualizer = GObject.registerClass(
    {
        GTypeName: "SpectrumVisualizer",
    },
    SpectrumVisualizer,
);

export default GSpectrumVisualizer;

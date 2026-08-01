import Clutter from "gi://Clutter";
import GObject from "gi://GObject";
import GLib from "gi://GLib";
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
const BAR_RISE_SPEED = 0.60;       // Snappy rise (60% lerp to target per frame)
const BAR_FALL_SPEED = 0.09;       // Smooth linear decay

// ─── WinAmp 16-Band Spectral Energy Profile (Logarithmic Frequency Curve) ───
// Base energy envelope: Bass (3-5 dots), Mid (2-4 dots), Treble (1-3 dots)
const BASE_ENVELOPE = [
    0.52, 0.58, 0.62, 0.55,  // Sub-Bass & Bass (Bins 0-3)
    0.48, 0.44, 0.40, 0.36,  // Low-Mid & Mid (Bins 4-7)
    0.34, 0.32, 0.30, 0.28,  // Upper-Mid & Presence (Bins 8-11)
    0.25, 0.22, 0.18, 0.14   // Brilliance & Treble (Bins 12-15)
];

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
    /** @private @type {number[]} - Target bar heights */
    _barTargets;
    /** @private @type {number[]} - Per-bar fall velocity */
    _barVelocity;
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
    /** @private @type {number | null} */
    _targetSourceId;
    /** @private @type {number} */
    _frame;
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
        this._barVelocity = new Array(NUM_BARS).fill(0);
        this._peakHeights = new Array(NUM_BARS).fill(0);
        this._peakVelocity = new Array(NUM_BARS).fill(0);
        this._peakHoldCounter = new Array(NUM_BARS).fill(0);
        this._isAnimating = false;
        this._isPlaying = false;
        this._animSourceId = null;
        this._targetSourceId = null;
        this._frame = 0;

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
     * Start animating (when playback is Playing)
     * @public
     */
    start() {
        this._isPlaying = true;
        this._generateTargets();
        this._startAnimation();
        this._startTargetCycle();
    }

    /**
     * Pause animation (bars smoothly decay to low idle)
     * @public
     */
    pause() {
        this._isPlaying = false;
        this._stopTargetCycle();
        for (let i = 0; i < NUM_BARS; i++) {
            this._barTargets[i] = 0.05;
        }
        this._startAnimation();
    }

    /**
     * Stop animation entirely (bars go flat, peaks fall)
     * @public
     */
    stop() {
        this._isPlaying = false;
        this._stopTargetCycle();
        for (let i = 0; i < NUM_BARS; i++) {
            this._barTargets[i] = 0;
        }
        this._startAnimation();
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

                this._frame++;
                let allSettled = true;

                for (let i = 0; i < NUM_BARS; i++) {
                    const target = this._barTargets[i];
                    const current = this._barHeights[i];

                    // ─── Snappy WinAmp Bar Motion ───────────────
                    if (target > current) {
                        // FAST ATTACK: Bar snaps up quickly to peak/beat
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

    // ─── Target Generation (Harmonic Wave & Spectral Beat Synthesis) ───

    /**
     * Start the target-generation cycle (every ~120ms = ~8 updates/sec)
     * @private
     */
    _startTargetCycle() {
        this._stopTargetCycle();
        const cycle = () => {
            if (!this._isPlaying) {
                this._targetSourceId = null;
                return GLib.SOURCE_REMOVE;
            }
            this._generateTargets();
            return GLib.SOURCE_CONTINUE;
        };
        this._targetSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            120,
            cycle,
        );
    }

    /**
     * Stop the target-generation cycle
     * @private
     */
    _stopTargetCycle() {
        if (this._targetSourceId != null) {
            GLib.source_remove(this._targetSourceId);
            this._targetSourceId = null;
        }
    }

    /**
     * Generate target heights combining:
     * 1. Logarithmic Base Frequency Envelope (Bass taller, Treble shorter)
     * 2. Harmonic Wave Oscillations (Simulates musical notes & chords)
     * 3. Rhythmic Beat Transients (Simulates kick drum & snare hits)
     * 4. Micro-flutter (Organic analog noise)
     * @private
     */
    _generateTargets() {
        const t = Date.now() / 1000; // time in seconds

        // Simulated Rhythm & Beat pulses
        const isKickBeat = Math.sin(t * 7.5) > 0.82;   // ~120 BPM Kick Drum
        const isSnareBeat = Math.cos(t * 3.75) > 0.88; // Snare on 2 & 4
        const isHiHat = Math.sin(t * 15.0) > 0.70;    // 16th-note Hi-Hat flutter

        for (let i = 0; i < NUM_BARS; i++) {
            const base = BASE_ENVELOPE[i];

            // Harmonic wave synthesis: Overlapping sine waves at musical frequencies
            const wave1 = 0.25 * Math.sin(t * 3.0 + i * 0.45);
            const wave2 = 0.15 * Math.cos(t * 5.2 - i * 0.30);
            const wave3 = 0.10 * Math.sin(t * 9.1 + i * 0.80);
            const harmonicEnergy = wave1 + wave2 + wave3;

            // Beat transient injection
            let beatSpike = 0;
            if (isKickBeat && i <= 3) {
                // Bass kick spike (brings bass bars up to 80%-100% height)
                beatSpike = 0.35 * (1.0 - i * 0.15);
            } else if (isSnareBeat && i >= 6 && i <= 10) {
                // Snare drum spike in mid range
                beatSpike = 0.30;
            } else if (isHiHat && i >= 11) {
                // Hi-hat shimmer in treble
                beatSpike = 0.25 * Math.random();
            }

            // Organic micro-flutter
            const flutter = (Math.random() - 0.5) * 0.12;

            // Calculate final composite target
            let val = base + harmonicEnergy + beatSpike + flutter;

            // Spatial smoothing across adjacent bins for realistic FFT spectral curve
            if (i > 0) {
                val = val * 0.70 + this._barTargets[i - 1] * 0.30;
            }

            // Clamp to valid range (min 0.12 = 1 dot lit, max 1.0 = 6 dots lit)
            this._barTargets[i] = Math.max(0.12, Math.min(1.0, val));
        }
    }

    // ─── Cairo Rendering ────────────────────────────────────────────────

    /**
     * Cairo repaint callback — draws the Stacked Pill / Dot Matrix LED VU meter
     * with WinAmp-style floating peak caps.
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
        this._stopTargetCycle();
        this._barHeights = null;
        this._barTargets = null;
        this._barVelocity = null;
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

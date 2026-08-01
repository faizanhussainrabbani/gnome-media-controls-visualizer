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
const MIN_BAR_FRAC = 0.03; // minimum visible fraction when playing

// ─── WinAmp Peak Cap Physics ────────────────────────────────────────────────
const PEAK_HOLD_FRAMES = 8;        // frames the peak cap stays frozen at the top
const PEAK_GRAVITY = 0.006;        // gravity acceleration per frame (WinAmp feel)
const PEAK_CAP_HEIGHT = 2;         // pixel height of the floating peak cap

// ─── Bar Rise / Fall Dynamics (WinAmp-accurate) ─────────────────────────────
const BAR_RISE_SPEED = 0.55;       // fast attack (instant spike on beat)
const BAR_FALL_SPEED = 0.08;       // slow decay (bars slide down smoothly)
const BAR_FALL_ACCEL = 0.003;      // slight acceleration as bar falls

// ─── Logarithmic Musical Frequency Band Profiles ────────────────────────────
// Each band maps to a musical frequency center (Hz) on a logarithmic scale.
// WinAmp used ~20Hz to ~16kHz spread across its bars logarithmically.
// Profile: [centerFreqHz, baseEnergy, variance, transientSensitivity]
//   baseEnergy:     how energetic this band typically is (0.0–1.0)
//   variance:       how much random variation this band has
//   transientSens:  how reactive to sudden beat/drum spikes (0.0–1.0)
const BAND_PROFILES = [
    /* 0: Sub Bass    ~25Hz  */ { base: 0.55, variance: 0.30, transient: 0.90 },
    /* 1: Sub Bass    ~40Hz  */ { base: 0.65, variance: 0.35, transient: 0.95 },
    /* 2: Bass        ~63Hz  */ { base: 0.75, variance: 0.35, transient: 0.95 },
    /* 3: Bass       ~100Hz  */ { base: 0.80, variance: 0.30, transient: 0.85 },
    /* 4: Low Mid    ~160Hz  */ { base: 0.70, variance: 0.30, transient: 0.70 },
    /* 5: Low Mid    ~250Hz  */ { base: 0.60, variance: 0.35, transient: 0.60 },
    /* 6: Mid        ~400Hz  */ { base: 0.55, variance: 0.35, transient: 0.55 },
    /* 7: Mid        ~630Hz  */ { base: 0.50, variance: 0.40, transient: 0.50 },
    /* 8: Upper Mid   ~1kHz  */ { base: 0.48, variance: 0.40, transient: 0.50 },
    /* 9: Upper Mid  ~1.6kHz */ { base: 0.45, variance: 0.40, transient: 0.55 },
    /*10: Presence   ~2.5kHz */ { base: 0.50, variance: 0.35, transient: 0.65 },
    /*11: Presence     ~4kHz */ { base: 0.45, variance: 0.30, transient: 0.60 },
    /*12: Brilliance ~6.3kHz */ { base: 0.38, variance: 0.30, transient: 0.50 },
    /*13: Brilliance  ~10kHz */ { base: 0.30, variance: 0.25, transient: 0.40 },
    /*14: Air        ~12.5kHz*/ { base: 0.22, variance: 0.20, transient: 0.30 },
    /*15: Air         ~16kHz */ { base: 0.15, variance: 0.15, transient: 0.25 },
];

// ─── Beat / Transient Simulation ────────────────────────────────────────────
const BEAT_PROBABILITY = 0.12;      // chance of a "beat hit" per target cycle
const BEAT_BOOST = 0.35;            // extra energy injected on a beat hit
const BEAT_BASS_BIAS = 0.7;         // probability beat targets bass bands
const TARGET_CYCLE_MS = 150;        // new targets every 150ms (WinAmp ~6-7 Hz)

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

/**
 * Apply dB-like logarithmic scaling to a linear amplitude (0–1).
 * This makes quiet sounds more visible and loud sounds hit hard without
 * clipping, matching WinAmp's perceptual loudness curve.
 * @param {number} linear - Linear amplitude in 0–1 range.
 * @returns {number} Perceptually scaled value in 0–1 range.
 */
function dBScale(linear) {
    if (linear <= 0) return 0;
    // Map to a ~40dB range: 20*log10(linear) mapped to 0–1
    // Using a softer curve: pow(linear, 0.55) approximates dB perception well
    // for visualization without needing actual FFT amplitudes.
    return Math.pow(linear, 0.55);
}

/** @extends St.DrawingArea */
class SpectrumVisualizer extends St.DrawingArea {
    /** @private @type {number[]} - Current bar heights (0–1) */
    _barHeights;
    /** @private @type {number[]} - Target bar heights */
    _barTargets;
    /** @private @type {number[]} - Per-bar fall velocity for smooth decay */
    _barVelocity;
    /** @private @type {number[]} - Peak cap position (0–1) */
    _peakHeights;
    /** @private @type {number[]} - Peak cap velocity (falling speed) */
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
    /** @private @type {number} - Global energy momentum for inter-beat coherence */
    _globalEnergy;

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
        this._globalEnergy = 0.5;

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
        this._globalEnergy = 0.5;
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
        // Set targets to near-zero so bars and peaks decay smoothly
        for (let i = 0; i < NUM_BARS; i++) {
            this._barTargets[i] = MIN_BAR_FRAC + Math.random() * 0.02;
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

                    // ─── WinAmp Bar Rise/Fall Physics ───────────────
                    if (target > current) {
                        // RISE: Fast attack — bar snaps up toward target
                        this._barHeights[i] += (target - current) * BAR_RISE_SPEED;
                        this._barVelocity[i] = 0; // reset fall velocity on rise
                    } else {
                        // FALL: Slow smooth decay with slight acceleration
                        this._barVelocity[i] += BAR_FALL_ACCEL;
                        this._barHeights[i] -= this._barVelocity[i] + BAR_FALL_SPEED * (current - target);
                        if (this._barHeights[i] < target) {
                            this._barHeights[i] = target;
                            this._barVelocity[i] = 0;
                        }
                    }

                    // Clamp
                    this._barHeights[i] = Math.max(0, Math.min(1, this._barHeights[i]));

                    // ─── WinAmp Floating Peak Cap Physics ───────────
                    // If bar rises above peak, snap peak to bar top & reset hold
                    if (this._barHeights[i] > this._peakHeights[i]) {
                        this._peakHeights[i] = this._barHeights[i];
                        this._peakVelocity[i] = 0;
                        this._peakHoldCounter[i] = PEAK_HOLD_FRAMES;
                    } else if (this._peakHoldCounter[i] > 0) {
                        // Hold: peak cap stays frozen at top
                        this._peakHoldCounter[i]--;
                    } else {
                        // Fall: gravity pulls peak cap down
                        this._peakVelocity[i] += PEAK_GRAVITY;
                        this._peakHeights[i] -= this._peakVelocity[i];
                        if (this._peakHeights[i] < this._barHeights[i]) {
                            this._peakHeights[i] = this._barHeights[i];
                            this._peakVelocity[i] = 0;
                        }
                    }

                    // Clamp peak
                    this._peakHeights[i] = Math.max(0, Math.min(1, this._peakHeights[i]));

                    // Check if settled
                    if (Math.abs(this._barHeights[i] - target) > 0.002 ||
                        this._peakHeights[i] > target + 0.01) {
                        allSettled = false;
                    }
                }

                this.queue_repaint();

                // If not playing and everything settled, stop animation loop
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

    // ─── Target Generation (Simulated Frequency Analysis) ───────────────

    /**
     * Start the target-generation cycle that gives bars new random goals
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
            TARGET_CYCLE_MS,
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
     * Generate new target heights using logarithmic musical frequency banding,
     * dB-like perceptual scaling, and transient beat/drum spike simulation.
     *
     * This models WinAmp's spectrum analyzer behavior:
     * - Bass bands (0-3) react strongly to kick drums
     * - Mid bands (4-9) carry vocals and instruments
     * - Treble bands (10-15) show hi-hats and cymbal shimmer
     * - Random "beat hits" inject energy spikes into bass/snare bands
     * - Global energy momentum provides inter-beat coherence
     * @private
     */
    _generateTargets() {
        // ─── Global Energy Drift ────────────────────────────────────
        // Slowly wander between 0.3 and 0.9 to simulate song dynamics
        // (verse = quieter, chorus = louder)
        this._globalEnergy += (Math.random() - 0.5) * 0.08;
        this._globalEnergy = Math.max(0.30, Math.min(0.90, this._globalEnergy));

        // ─── Beat / Transient Detection Simulation ──────────────────
        const isBeat = Math.random() < BEAT_PROBABILITY;
        // Determine which band range gets the beat emphasis
        const beatIsBass = Math.random() < BEAT_BASS_BIAS; // kick drum vs snare

        for (let i = 0; i < NUM_BARS; i++) {
            const profile = BAND_PROFILES[i];

            // Base energy for this band, modulated by global energy
            let energy = profile.base * this._globalEnergy;

            // Add random variance
            energy += (Math.random() - 0.3) * profile.variance;

            // ─── Transient Beat Spike ───────────────────────────────
            if (isBeat) {
                if (beatIsBass && i <= 3) {
                    // Kick drum: massive spike on sub-bass / bass bands
                    energy += BEAT_BOOST * profile.transient * (1.0 + Math.random() * 0.3);
                } else if (!beatIsBass && i >= 9 && i <= 12) {
                    // Snare / hi-hat: spike on upper-mid / presence bands
                    energy += BEAT_BOOST * profile.transient * (0.7 + Math.random() * 0.3);
                } else {
                    // Sympathetic energy from beat bleeds into neighboring bands
                    energy += BEAT_BOOST * profile.transient * 0.15;
                }
            }

            // ─── Neighbor Smoothing (Adjacent Band Correlation) ─────
            // Real FFT output has correlated neighboring bins.
            // Blend slightly with previous bar's target for natural flow.
            if (i > 0) {
                energy = energy * 0.75 + this._barTargets[i - 1] * 0.25;
            }

            // ─── dB Logarithmic Perceptual Scaling ──────────────────
            energy = dBScale(Math.max(0, Math.min(1, energy)));

            // Clamp to valid range
            this._barTargets[i] = Math.max(MIN_BAR_FRAC, Math.min(1.0, energy));
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
            const peakDot = Math.round(peakRatio * DOTS_PER_COL) - 1; // 0-indexed dot for peak

            const x = col * (barWidth + BAR_GAP);

            for (let dot = 0; dot < DOTS_PER_COL; dot++) {
                // dot 0 is bottom, dot DOTS_PER_COL - 1 is top
                const y = areaHeight - (dot + 1) * dotHeight - dot * DOT_GAP;

                this._drawPill(cr, x, y, barWidth, dotHeight, Math.min(BAR_RADIUS, dotHeight / 2));

                const isLit = dot < activeDots || (dot === 0 && activeRatio > 0.02);
                const isPeakCap = (dot === peakDot) && peakRatio > 0.05 && dot >= activeDots;

                if (isPeakCap) {
                    // ─── WinAmp Floating Peak Cap ───────────────────
                    // Bright, distinct peak indicator dot
                    cr.setSourceRGBA(r, g, b, 0.95);
                } else if (isLit) {
                    // ─── Lit LED Dot (VU meter gradient) ────────────
                    const dotLevel = (dot + 1) / DOTS_PER_COL;
                    const alpha = 0.45 + dotLevel * 0.50; // 0.45 → 0.95
                    cr.setSourceRGBA(r, g, b, alpha);
                } else {
                    // ─── Unlit LED Matrix Dot ───────────────────────
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

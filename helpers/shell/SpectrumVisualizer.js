import Clutter from "gi://Clutter";
import GObject from "gi://GObject";
import GLib from "gi://GLib";
import St from "gi://St";
import Cairo from "gi://cairo";

import { debugLog } from "../../utils/common.js";

const NUM_BARS = 16;
const BAR_GAP = 3;
const BAR_RADIUS = 2;
const VISUALIZER_HEIGHT = 30;
const ANIMATION_INTERVAL_MS = 33; // ~30fps
const LERP_SPEED_ACTIVE = 0.18;
const LERP_SPEED_DECAY = 0.08;
const MIN_BAR_HEIGHT = 1.5;

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
    /**
     * Current bar heights (0–1 range)
     * @private
     * @type {number[]}
     */
    _barHeights;

    /**
     * Target bar heights for interpolation
     * @private
     * @type {number[]}
     */
    _barTargets;

    /**
     * Whether animation is running
     * @private
     * @type {boolean}
     */
    _isAnimating;

    /**
     * Whether playback is active (playing)
     * @private
     * @type {boolean}
     */
    _isPlaying;

    /**
     * Timer source ID for animation loop
     * @private
     * @type {number | null}
     */
    _animSourceId;

    /**
     * Timer source ID for picking new targets
     * @private
     * @type {number | null}
     */
    _targetSourceId;

    /**
     * Frame counter for organic feel
     * @private
     * @type {number}
     */
    _frame;

    /**
     * @private
     * @type {number}
     */
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
     * Pause animation (bars smoothly decay to low)
     * @public
     */
    pause() {
        this._isPlaying = false;
        this._stopTargetCycle();
        // Set targets to small values so bars decay smoothly
        for (let i = 0; i < NUM_BARS; i++) {
            this._barTargets[i] = MIN_BAR_HEIGHT / VISUALIZER_HEIGHT + Math.random() * 0.04;
        }
        // Keep animation running so we can see the decay
        this._startAnimation();
    }

    /**
     * Stop animation entirely (bars go flat)
     * @public
     */
    stop() {
        this._isPlaying = false;
        this._stopTargetCycle();
        for (let i = 0; i < NUM_BARS; i++) {
            this._barTargets[i] = 0;
        }
        // Keep animation running briefly to animate to zero
        this._startAnimation();
    }

    /**
     * Start the animation frame loop
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
                const lerpSpeed = this._isPlaying ? LERP_SPEED_ACTIVE : LERP_SPEED_DECAY;
                let allSettled = true;

                for (let i = 0; i < NUM_BARS; i++) {
                    const diff = this._barTargets[i] - this._barHeights[i];
                    if (Math.abs(diff) > 0.002) {
                        this._barHeights[i] += diff * lerpSpeed;
                        allSettled = false;
                    } else {
                        this._barHeights[i] = this._barTargets[i];
                    }
                }

                this.queue_repaint();

                // If not playing and all bars settled, stop animation
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

    /**
     * Start the target-generation cycle that gives bars new random goals
     * @private
     */
    _startTargetCycle() {
        this._stopTargetCycle();
        // Generate new targets every 180–300ms for organic feel
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
            200,
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
     * Generate new random target heights with an organic frequency-like distribution.
     * Low and mid frequencies are taller, high frequencies taper off.
     * @private
     */
    _generateTargets() {
        for (let i = 0; i < NUM_BARS; i++) {
            // Create a frequency-like curve: bass and mid are taller
            const normalizedPos = i / (NUM_BARS - 1);
            // Envelope: peaks around 20-40% of the spectrum, tapers at edges
            const envelope =
                0.3 +
                0.7 * Math.sin(normalizedPos * Math.PI) *
                (1.0 - normalizedPos * 0.3);
            // Random component
            const randomness = 0.3 + Math.random() * 0.7;
            this._barTargets[i] = Math.max(
                MIN_BAR_HEIGHT / VISUALIZER_HEIGHT,
                envelope * randomness * 0.85,
            );
        }
    }

    /**
     * Cairo repaint callback — draws the Stacked Pill / Dot Matrix LED VU meter
     * @private
     * @param {St.DrawingArea} area
     */
    _onRepaint(area) {
        const cr = area.get_context();
        const [areaWidth, areaHeight] = area.get_surface_size();

        if (areaWidth <= 0 || areaHeight <= 0) return;

        // Get theme foreground for bar color
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

            const x = col * (barWidth + BAR_GAP);

            for (let dot = 0; dot < DOTS_PER_COL; dot++) {
                // dot 0 is bottom, dot DOTS_PER_COL - 1 is top
                const y = areaHeight - (dot + 1) * dotHeight - dot * DOT_GAP;
                const isLit = dot < activeDots || (dot === 0 && activeRatio > 0.02);

                this._drawPill(cr, x, y, barWidth, dotHeight, Math.min(BAR_RADIUS, dotHeight / 2));

                if (isLit) {
                    // Lit LED dot — bottom is soft, top dots glow brighter (VU meter style)
                    const dotLevel = (dot + 1) / DOTS_PER_COL;
                    const alpha = 0.5 + dotLevel * 0.45; // 0.50 to 0.95 opacity
                    cr.setSourceRGBA(r, g, b, alpha);
                } else {
                    // Unlit LED matrix dot outline
                    cr.setSourceRGBA(r, g, b, 0.08);
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
    }
}

const GSpectrumVisualizer = GObject.registerClass(
    {
        GTypeName: "SpectrumVisualizer",
    },
    SpectrumVisualizer,
);

export default GSpectrumVisualizer;

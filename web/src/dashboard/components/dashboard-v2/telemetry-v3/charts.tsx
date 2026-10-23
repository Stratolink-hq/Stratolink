import { useEffect, useMemo, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCaretDown, faCaretUp, faMinus } from '@fortawesome/free-solid-svg-icons';
import type { FlightSeries } from '@/lib/telemetry/flightSeries';
import { stamp, tlmFmt, type StatusLevel } from '@/lib/telemetry/telemetryV3Format';

export type WarpedAxis = {
    /** Chosen original sample indices (per-run downsampled). */
    pts: { src: number }[];
    /** pts-index groups split at gaps — draw each as its own subpath. */
    segments: number[][];
    /** Pixel x for a pts index. */
    X: (i: number) => number;
    /** Pixel x for an arbitrary raw time. */
    warpX: (t: number) => number;
    /** Pixel x of each compressed-gap center (for break markers). */
    gapMarks: number[];
    /** Raw time at a pixel x — continuous within a run, snapped to the nearer
     *  side of a compressed gap (no time is drawn inside one). */
    timeAtX: (x: number) => number;
};

/**
 * Shared time axis for all timeline charts: positions samples by REAL time, but
 * detects transmission gaps (coalescing those split only by a brief check-in),
 * compresses each to a uniform width, and breaks the series across them. Every
 * run is downsampled with its endpoints preserved so each gap renders at exactly
 * the same width.
 */
export function buildWarpedAxis(times: number[], W: number, budget = 90): WarpedAxis {
    const N = times.length;
    const dts: number[] = [];
    for (let i = 1; i < N; i++) dts.push(times[i] - times[i - 1]);
    const sorted = [...dts].sort((a, b) => a - b);
    const medianDt = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    const gapThresh = medianDt > 0 ? medianDt * 8 : Infinity;
    const gapWidth = medianDt > 0 ? medianDt * 2 : 0;

    const gaps: { start: number; end: number }[] = [];
    for (let i = 1; i < N; i++) {
        if (times[i] - times[i - 1] <= gapThresh) continue;
        const prev = gaps[gaps.length - 1];
        if (prev && times[i - 1] - prev.end < gapThresh) prev.end = times[i];   /* coalesce */
        else gaps.push({ start: times[i - 1], end: times[i] });
    }
    const inGap = (t: number) => gaps.some((g) => t > g.start && t < g.end);

    /* Runs of kept samples, bounded by gaps. */
    const kept: number[] = [];
    for (let i = 0; i < N; i++) if (!inGap(times[i])) kept.push(i);
    const runs: number[][] = [];
    if (kept.length) {
        let cur: number[] = [kept[0]];
        for (let k = 1; k < kept.length; k++) {
            const across = gaps.some((g) => g.start >= times[kept[k - 1]] && g.end <= times[kept[k]]);
            if (across) { runs.push(cur); cur = [kept[k]]; } else cur.push(kept[k]);
        }
        runs.push(cur);
    }
    const keptTotal = kept.length || 1;
    const dsRun = (run: number[], n: number) => {
        if (run.length <= n) return run;
        const out: number[] = [];
        for (let i = 0; i < n; i++) out.push(run[Math.round((i / (n - 1)) * (run.length - 1))]);
        return out;
    };
    const pts: { src: number }[] = [];
    const brokeBefore: boolean[] = [];
    for (const run of runs) {
        const b = Math.max(2, Math.round(budget * (run.length / keptTotal)));
        dsRun(run, Math.min(run.length, b)).forEach((src, k) => {
            brokeBefore.push(pts.length > 0 && k === 0);
            pts.push({ src });
        });
    }

    const warp = (t: number): number => {
        let w = t - (times[0] ?? 0);
        for (const g of gaps) {
            if (t >= g.end) w -= (g.end - g.start) - gapWidth;
            else if (t > g.start) w -= t - g.start;
        }
        return w;
    };
    const wStart = pts.length ? warp(times[pts[0].src]) : 0;
    const wSpan = (pts.length ? warp(times[pts[pts.length - 1].src]) - wStart : 0) || 1;
    const warpX = (t: number) => ((warp(t) - wStart) / wSpan) * W;
    const X = (i: number) => warpX(times[pts[i].src]);

    const segments: number[][] = [];
    {
        let seg: number[] = [0];
        for (let i = 1; i < pts.length; i++) {
            if (brokeBefore[i]) { segments.push(seg); seg = [i]; } else seg.push(i);
        }
        segments.push(seg);
    }
    const gapMarks = gaps.map((g) => warpX(g.start) + ((gapWidth / wSpan) * W) / 2);

    const timeAtX = (x: number): number => {
        if (!pts.length) return times[0] ?? 0;
        if (x <= X(0)) return times[pts[0].src];
        for (let i = 1; i < pts.length; i++) {
            const x1 = X(i);
            if (x > x1) continue;
            const x0 = X(i - 1);
            const t0 = times[pts[i - 1].src];
            const t1 = times[pts[i].src];
            if (brokeBefore[i]) return x - x0 < x1 - x ? t0 : t1;
            return x1 > x0 ? t0 + ((x - x0) / (x1 - x0)) * (t1 - t0) : t1;
        }
        return times[pts[pts.length - 1].src];
    };

    return { pts, segments, X, warpX, gapMarks, timeAtX };
}

/** pts index whose source time is closest to the scrub time (null if no scrub). */
export function scrubIndex(pts: { src: number }[], times: number[], scrubT: number | null | undefined): number | null {
    if (scrubT == null || !pts.length) return null;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
        const d = Math.abs(times[pts[i].src] - scrubT);
        if (d < bestD) { bestD = d; best = i; }
    }
    return best;
}

/** pts index whose plotted x is nearest a pointer's clientX. */
function nearestIdxAt(clientX: number, rect: DOMRect, n: number, X: (i: number) => number, W: number): number {
    const targetX = ((clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
        const d = Math.abs(X(i) - targetX);
        if (d < bestD) { bestD = d; best = i; }
    }
    return best;
}

/** Sideways travel (px) that turns a touch into a chart scrub; a touch that
 * moves vertically first is left to scroll the page/drawer. */
const TOUCH_SLOP_PX = 6;


function Tip({ xFrac, lines }: { xFrac: number; lines: React.ReactNode }) {
    const flip = xFrac > 0.6;
    return (
        <div
            style={{
                position: 'absolute',
                top: -6,
                left: `${(xFrac * 100).toFixed(1)}%`,
                transform: `translate(${flip ? '-100%' : '0'}, -100%)`,
                marginLeft: flip ? -6 : 6,
                pointerEvents: 'none',
                zIndex: 6,
                background: 'var(--t-tooltip-bg)',
                color: 'var(--t-tooltip-fg)',
                borderRadius: 3,
                padding: '5px 8px',
                whiteSpace: 'nowrap',
                boxShadow: '0 4px 16px rgba(0,0,0,0.28)',
            }}
        >
            {lines}
        </div>
    );
}

function boundLbl(pos: 'top' | 'bottom', text: string) {
    return {
        position: 'absolute' as const,
        right: 3,
        [pos]: 1,
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        letterSpacing: '0.04em',
        color: 'var(--t-text-4)',
        fontVariantNumeric: 'tabular-nums' as const,
        pointerEvents: 'none' as const,
        lineHeight: 1,
    };
}

/**
 * A position dot rendered as an HTML overlay (not an SVG <circle>), so it stays
 * a true circle — the charts' SVGs use preserveAspectRatio="none" and stretch
 * to full width, which would squash any in-SVG circle into an ellipse.
 * x/y are fractions (0..1) of the chart's width/height.
 */
function OverlayDot({ x, y, size = 7, ring = true }: { x: number; y: number; size?: number; ring?: boolean }) {
    return (
        <div
            style={{
                position: 'absolute',
                /* Clamped inside the chart: at the flight's ends a centered dot
                 * would hang past the edge and make the panel scroll sideways. */
                left: `clamp(${size / 2}px, ${(x * 100).toFixed(2)}%, calc(100% - ${size / 2}px))`,
                top: `${(y * 100).toFixed(2)}%`,
                width: size,
                height: size,
                borderRadius: '50%',
                background: 'var(--t-accent)',
                border: ring ? '1.5px solid var(--t-panel)' : 'none',
                transform: 'translate(-50%, -50%)',
                pointerEvents: 'none',
            }}
        />
    );
}

export function LineTrend({
    series,
    times,
    band,
    fmtFn,
    unit,
    height = 52,
    emphasis = 'normal',
    scrubT = null,
    onPickTime,
    onScrubbingChange,
}: {
    series: (number | null)[];
    times: number[];
    band?: [number, number] | null;
    status: StatusLevel;
    fmtFn: (v: number) => string;
    unit: string;
    height?: number;
    emphasis?: 'normal' | 'low';
    /** When set, a marker sits at this scrub time on the line. */
    scrubT?: number | null;
    /** When set, clicking or dragging along the chart scrubs to that time. */
    onPickTime?: (t: number) => void;
    /** True while a drag on the chart is driving the scrub time. */
    onScrubbingChange?: (active: boolean) => void;
}) {
    /** Hover cursor x, in viewBox units. */
    const [hover, setHover] = useState<number | null>(null);
    /* While a drag scrubs, the scrub marker itself follows the pointer and
     * the hover cursor stands down — one marker, not two. */
    const [scrubbing, setScrubbing] = useState(false);
    /* The pointer pressed on the chart. A mouse scrubs from the press; a touch
     * stays inactive until it moves sideways, so a vertical swipe still scrolls. */
    const dragRef = useRef<{ id: number; x0: number; y0: number; active: boolean } | null>(null);
    /* State, not a ref: the SVG mounts only once there are enough samples. */
    const [svgEl, setSvgEl] = useState<SVGSVGElement | null>(null);
    useEffect(() => {
        if (!svgEl) return;
        /* Once a touch scrub is under way, claim the touch. Otherwise iOS hands a
         * finger that rests before lifting to its own long-press handling: the
         * touch never ends for the page, and the next tap is swallowed. Native and
         * non-passive, since React's touch listeners can't preventDefault. */
        const claim = (e: TouchEvent) => {
            if (dragRef.current?.active && e.cancelable) e.preventDefault();
        };
        svgEl.addEventListener('touchmove', claim, { passive: false });
        return () => svgEl.removeEventListener('touchmove', claim);
    }, [svgEl]);
    const numeric = series.map((v) => (v == null ? NaN : v)).filter((v) => !Number.isNaN(v));
    const W = 300;
    const H = height;

    /* Time-warped axis (gaps detected, compressed, broken) — shared with the
     * other timeline charts. */
    const { pts, segments, X, warpX, gapMarks, timeAtX } = useMemo(() => buildWarpedAxis(times, W, 90), [times]);
    const segmentStarts = useMemo(() => new Set(segments.map((seg) => seg[0])), [segments]);

    /* Below all hooks: the sample count can cross 2 as telemetry streams in,
     * and an earlier return would change the hook count between renders. */
    if (numeric.length < 2) {
        return (
            <div className="mono" style={{ fontSize: 10, color: 'var(--t-text-3)', padding: '8px 0' }}>
                Not enough samples
            </div>
        );
    }
    const filled = series.map((v, i) => (v == null ? (numeric[0] ?? 0) : v)) as number[];
    const dataMin = Math.min(...numeric);
    const dataMax = Math.max(...numeric);
    let lo = dataMin;
    let hi = dataMax;
    if (band) {
        lo = Math.min(lo, band[0]);
        hi = Math.max(hi, band[1]);
    }
    const pad = (hi - lo) * 0.1 || 1;
    lo -= pad;
    hi += pad;
    const span = hi - lo || 1;

    const valAt = (i: number) => filled[pts[i].src];
    const Y = (v: number) => H - ((v - lo) / span) * H;
    const line = segments
        .map((seg) => seg.map((idx, k) => `${k === 0 ? 'M' : 'L'}${X(idx).toFixed(1)} ${Y(valAt(idx)).toFixed(1)}`).join(' '))
        .join(' ');
    const area = segments
        .map((seg) => {
            const top = seg.map((idx) => `L${X(idx).toFixed(1)} ${Y(valAt(idx)).toFixed(1)}`).join(' ');
            return `M${X(seg[0]).toFixed(1)} ${H} ${top} L${X(seg[seg.length - 1]).toFixed(1)} ${H} Z`;
        })
        .join(' ');

    const faint = emphasis === 'low';
    const lineCol = faint ? 'var(--t-text-4)' : 'var(--t-text-3)';

    const last = pts.length - 1;
    /* Height of the drawn line at viewBox x: interpolated along a segment,
     * snapped to the nearer end across a gap (where no line is drawn). */
    const lineYAt = (x: number) => {
        let i = 1;
        while (i < last && X(i) < x) i++;
        const x0 = X(i - 1);
        const x1 = X(i);
        const f = x1 > x0 ? Math.max(0, Math.min(1, (x - x0) / (x1 - x0))) : 1;
        if (segmentStarts.has(i)) return Y(valAt(f < 0.5 ? i - 1 : i));
        return Y(valAt(i - 1) + (valAt(i) - valAt(i - 1)) * f);
    };
    /* Plotted sample nearest viewBox x — what the tooltip reads out. */
    const idxNear = (x: number) => {
        let best = 0;
        for (let i = 1; i <= last; i++) if (Math.abs(X(i) - x) < Math.abs(X(best) - x)) best = i;
        return best;
    };
    /* The scrub marker sits at the scrub time itself, not snapped to a sample
     * or packet, so a drag moves it exactly with the pointer. */
    const markerX = scrubT != null ? Math.max(X(0), Math.min(X(last), warpX(scrubT))) : null;
    /* While scrubbing, the readout rides the marker; otherwise the hover cursor. */
    const tipX = scrubbing ? markerX : hover;
    const tipIdx = tipX != null ? idxNear(tipX) : null;

    const xOf = (clientX: number, el: Element) => {
        const rect = el.getBoundingClientRect();
        return Math.max(0, Math.min(W, ((clientX - rect.left) / rect.width) * W));
    };
    /* Scrub to the time under the pointer — continuous between samples. */
    const scrubTo = (clientX: number, el: Element) => {
        const t = timeAtX(xOf(clientX, el));
        if (Number.isFinite(t)) onPickTime?.(t);
    };
    const beginScrub = (e: React.PointerEvent<SVGSVGElement>) => {
        if (!dragRef.current) return;
        dragRef.current.active = true;
        /* Keep the drag once the pointer strays off the chart. */
        e.currentTarget.setPointerCapture(e.pointerId);
        setScrubbing(true);
        setHover(null);
        onScrubbingChange?.(true);
        scrubTo(e.clientX, e.currentTarget);
    };
    const endScrub = (pointerId: number) => {
        const drag = dragRef.current;
        if (drag?.id !== pointerId) return null;
        dragRef.current = null;
        if (drag.active) {
            setScrubbing(false);
            onScrubbingChange?.(false);
        }
        return drag;
    };

    return (
        <div className="t-chart" style={{ position: 'relative', width: '100%' }}>
            <svg
                ref={setSvgEl}
                viewBox={`0 0 ${W} ${H}`}
                preserveAspectRatio="none"
                style={{
                    width: '100%', height: H, display: 'block',
                    cursor: onPickTime ? 'crosshair' : undefined,
                    /* Vertical swipes scroll; sideways drags reach us at once. */
                    touchAction: onPickTime ? 'pan-y' : undefined,
                }}
                onPointerDown={onPickTime ? (e) => {
                    if (e.pointerType === 'mouse' && e.button !== 0) return;
                    dragRef.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, active: false };
                    if (e.pointerType === 'mouse') beginScrub(e);
                } : undefined}
                onPointerMove={(e) => {
                    const drag = dragRef.current;
                    if (drag?.id === e.pointerId) {
                        if (drag.active) scrubTo(e.clientX, e.currentTarget);
                        else {
                            const dx = Math.abs(e.clientX - drag.x0);
                            if (dx > TOUCH_SLOP_PX && dx > Math.abs(e.clientY - drag.y0)) beginScrub(e);
                        }
                        return;
                    }
                    if (e.pointerType === 'mouse') setHover(xOf(e.clientX, e.currentTarget));
                }}
                onPointerUp={(e) => {
                    const drag = endScrub(e.pointerId);
                    /* A tap (no drag) jumps to the time under the finger. */
                    if (drag && !drag.active) scrubTo(e.clientX, e.currentTarget);
                    if (e.pointerType !== 'mouse') setHover(null);
                }}
                onPointerCancel={(e) => {
                    endScrub(e.pointerId);
                    setHover(null);
                }}
                onPointerLeave={() => {
                    if (!dragRef.current) setHover(null);
                }}
            >
                {band &&
                    (() => {
                        const yT = Y(band[1]);
                        const yB = Y(band[0]);
                        return (
                            <g>
                                <rect x={0} y={Math.max(0, yT)} width={W} height={Math.max(1, yB - yT)} fill="var(--t-band)" />
                                <line x1={0} y1={yT} x2={W} y2={yT} stroke="var(--t-accent)" strokeWidth="0.75" strokeDasharray="3 3" opacity="0.35" />
                                <line x1={0} y1={yB} x2={W} y2={yB} stroke="var(--t-accent)" strokeWidth="0.75" strokeDasharray="3 3" opacity="0.35" />
                            </g>
                        );
                    })()}
                {gapMarks.map((x, k) => (
                    <line key={`gap-${k}`} x1={x} y1={0} x2={x} y2={H} stroke="var(--t-text-4)" strokeWidth="1" strokeDasharray="2 3" opacity="0.45" />
                ))}
                <path d={area} fill={lineCol} opacity={faint ? 0.05 : 0.08} />
                <path
                    d={line}
                    fill="none"
                    stroke={lineCol}
                    strokeWidth={faint ? 1 : 1.4}
                    opacity={faint ? 0.7 : 0.95}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                />
                {markerX != null && (
                    <line x1={markerX} y1={0} x2={markerX} y2={H} stroke="var(--t-accent)" strokeWidth="0.75" opacity={scrubbing ? 0.6 : 0.4} />
                )}
                {hover != null && <line x1={hover} y1={0} x2={hover} y2={H} stroke="var(--t-accent)" strokeWidth="0.75" opacity="0.5" />}
            </svg>
            {markerX != null && <OverlayDot x={markerX / W} y={lineYAt(markerX) / H} />}
            {hover != null && <OverlayDot x={hover / W} y={lineYAt(hover) / H} size={5} ring={false} />}
            <div style={boundLbl('top', fmtFn(dataMax))}>{fmtFn(dataMax)}</div>
            <div style={boundLbl('bottom', fmtFn(dataMin))}>{fmtFn(dataMin)}</div>
            {tipX != null && tipIdx != null && (
                <Tip
                    xFrac={tipX / W}
                    lines={
                        <>
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                                {fmtFn(valAt(tipIdx))}
                                <span style={{ opacity: 0.6, marginLeft: 3 }}>{unit}</span>
                            </div>
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.08em', opacity: 0.6, marginTop: 1 }}>
                                {stamp(times[pts[tipIdx].src])}
                            </div>
                        </>
                    }
                />
            )}
        </div>
    );
}

export function PowerOverlay({ flight, height = 104, showBand = true, scrubT = null }: { flight: FlightSeries; height?: number; showBand?: boolean; scrubT?: number | null }) {
    const [hover, setHover] = useState<number | null>(null);
    const W = 300;
    const H = height;
    const { pts, segments, X, gapMarks } = useMemo(() => buildWarpedAxis(flight.times, W, 90), [flight.times]);
    const scrubIdx = scrubIndex(pts, flight.times, scrubT);
    const solarAt = (i: number) => flight.solar[pts[i].src] ?? 0;
    const battAt = (i: number) => flight.batt[pts[i].src] ?? 3.3;
    const sunAt = (i: number) => flight.sun[pts[i].src] ?? 0;
    /* Data-driven axes — fixed bounds (esp. battery 2.9–4.25 V) clipped real
     * readings off the chart. Solar runs 0→max; battery fits its own range. */
    const battNumeric = flight.batt.filter((v): v is number => v != null);
    const solNumeric = flight.solar.filter((v): v is number => v != null);
    const bMin = battNumeric.length ? Math.min(...battNumeric) : 3.0;
    const bMax = battNumeric.length ? Math.max(...battNumeric) : 4.2;
    const bPad = (bMax - bMin) * 0.12 || 0.1;
    const bLo = bMin - bPad;
    const bHi = bMax + bPad;
    const sMax = (solNumeric.length ? Math.max(...solNumeric) : 6) * 1.08 || 1;
    const sY = (v: number) => H - Math.min(1, Math.max(0, v / sMax)) * H;
    const bY = (v: number) => H - ((v - bLo) / (bHi - bLo)) * H;
    const segPath = (yf: (i: number) => number) =>
        segments.map((seg) => seg.map((idx, k) => `${k === 0 ? 'M' : 'L'}${X(idx).toFixed(1)} ${yf(idx).toFixed(1)}`).join(' ')).join(' ');
    const sLine = segPath((i) => sY(solarAt(i)));
    const bLine = segPath((i) => bY(battAt(i)));
    const sArea = segments
        .map((seg) => {
            const top = seg.map((idx) => `L${X(idx).toFixed(1)} ${sY(solarAt(idx)).toFixed(1)}`).join(' ');
            return `M${X(seg[0]).toFixed(1)} ${H} ${top} L${X(seg[seg.length - 1]).toFixed(1)} ${H} Z`;
        })
        .join(' ');
    /* Night shading: one cell per dark sample, spanning midpoint→midpoint so it
     * follows the warped (gap-compressed) time spacing. */
    const nightCells = pts
        .map((_, i) => {
            if (sunAt(i) >= 0.04) return null;
            const x0 = i === 0 ? X(0) : (X(i - 1) + X(i)) / 2;
            const x1 = i === pts.length - 1 ? X(i) : (X(i) + X(i + 1)) / 2;
            return { x: x0, w: Math.max(0.5, x1 - x0) };
        })
        .filter((c): c is { x: number; w: number } => c !== null);

    return (
        <div className="t-chart" style={{ position: 'relative', width: '100%' }}>
            <svg
                viewBox={`0 0 ${W} ${H}`}
                preserveAspectRatio="none"
                style={{ width: '100%', height: H, display: 'block' }}
                onMouseLeave={() => setHover(null)}
                onMouseMove={(e) => {
                    setHover(nearestIdxAt(e.clientX, e.currentTarget.getBoundingClientRect(), pts.length, X, W));
                }}
            >
                {nightCells.map((c, i) => (
                    <rect key={`n${i}`} x={c.x} y={0} width={c.w} height={H} fill="var(--t-night)" />
                ))}
                {showBand && <rect x={0} y={bY(4.2)} width={W} height={Math.max(1, bY(3.6) - bY(4.2))} fill="var(--t-band)" />}
                {gapMarks.map((x, k) => (
                    <line key={`gap-${k}`} x1={x} y1={0} x2={x} y2={H} stroke="var(--t-text-4)" strokeWidth="1" strokeDasharray="2 3" opacity="0.45" />
                ))}
                <path d={sArea} fill="var(--t-accent)" opacity="0.13" />
                <path d={sLine} fill="none" stroke="var(--t-accent)" strokeWidth="1.1" opacity={0.7} strokeLinejoin="round" />
                <path d={bLine} fill="none" stroke="var(--t-text-2)" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
                {scrubIdx != null && (
                    <line x1={X(scrubIdx)} y1={0} x2={X(scrubIdx)} y2={H} stroke="var(--t-accent)" strokeWidth="0.75" opacity="0.4" />
                )}
                {hover != null && <line x1={X(hover)} y1={0} x2={X(hover)} y2={H} stroke="var(--t-accent)" strokeWidth="0.75" opacity="0.5" />}
            </svg>
            {scrubIdx != null && <OverlayDot x={X(scrubIdx) / W} y={bY(battAt(scrubIdx)) / H} />}
            {hover != null && <OverlayDot x={X(hover) / W} y={bY(battAt(hover)) / H} size={5} ring={false} />}
            {hover != null && pts[hover] && (
                <Tip
                    xFrac={X(hover) / W}
                    lines={
                        <>
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontVariantNumeric: 'tabular-nums', display: 'flex', gap: 10 }}>
                                <span>
                                    <span style={{ opacity: 0.55 }}>SOL </span>
                                    {solarAt(hover).toFixed(2)}V
                                </span>
                                <span>
                                    <span style={{ opacity: 0.55 }}>BAT </span>
                                    {battAt(hover).toFixed(2)}V
                                </span>
                            </div>
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.08em', opacity: 0.6, marginTop: 2 }}>
                                {sunAt(hover) < 0.04 ? 'NIGHT - ' : 'DAYLIGHT - '}
                                {stamp(flight.times[pts[hover].src])}
                            </div>
                        </>
                    }
                />
            )}
        </div>
    );
}

export function StateStrip({ sats, times, height = 50, scrubT = null }: { sats: (number | null)[]; times: number[]; height?: number; scrubT?: number | null }) {
    const [hover, setHover] = useState<number | null>(null);
    const W = 300;
    const H = height;
    const { pts, segments, X, gapMarks } = useMemo(() => buildWarpedAxis(times, W, 76), [times]);
    const scrubIdx = scrubIndex(pts, times, scrubT);
    const valAt = (i: number) => sats[pts[i].src] ?? 0;
    const stateOf = (v: number) => (v <= 0 ? 'critical' : v < 4 ? 'warn' : 'lock');
    const colOf = (s: string) => (s === 'critical' ? 'var(--t-critical)' : s === 'warn' ? 'var(--t-warn)' : 'var(--t-muted)');
    const maxS = 12;
    const yOf = (v: number) => H - Math.min(1, v / maxS) * (H - 6) - 3;
    /* Per-sample cell, midpoint→midpoint, so cells follow warped time spacing. */
    const cellOf = (i: number) => {
        const x0 = i === 0 ? X(0) : (X(i - 1) + X(i)) / 2;
        const x1 = i === pts.length - 1 ? X(i) : (X(i) + X(i + 1)) / 2;
        return { x: x0, w: Math.max(0.5, x1 - x0) };
    };

    return (
        <div className="t-chart" style={{ position: 'relative', width: '100%' }}>
            <svg
                viewBox={`0 0 ${W} ${H}`}
                preserveAspectRatio="none"
                style={{ width: '100%', height: H, display: 'block' }}
                onMouseLeave={() => setHover(null)}
                onMouseMove={(e) => {
                    setHover(nearestIdxAt(e.clientX, e.currentTarget.getBoundingClientRect(), pts.length, X, W));
                }}
            >
                {pts.map((_, i) => {
                    const s = stateOf(valAt(i));
                    const c = cellOf(i);
                    return (
                        <rect key={i} x={c.x} y={0} width={c.w} height={H} fill={colOf(s)} opacity={s === 'critical' ? 0.5 : s === 'warn' ? 0.42 : 0.22} />
                    );
                })}
                {segments.flatMap((seg) =>
                    seg.slice(0, -1).map((idx, k) => {
                        const b = seg[k + 1];
                        const va = valAt(idx);
                        const vb = valAt(b);
                        const segState = stateOf(Math.min(va, vb));
                        const segCol = segState === 'critical' ? 'var(--t-critical)' : segState === 'warn' ? 'var(--t-warn)' : 'var(--t-nominal)';
                        return (
                            <line
                                key={`l${idx}`}
                                x1={X(idx).toFixed(1)}
                                y1={yOf(va).toFixed(1)}
                                x2={X(b).toFixed(1)}
                                y2={yOf(vb).toFixed(1)}
                                stroke={segCol}
                                strokeWidth="1.6"
                                opacity={segState === 'lock' ? 0.85 : 0.95}
                                strokeLinecap="round"
                            />
                        );
                    }),
                )}
                {(() => {
                    const li = pts.findIndex((_, i) => valAt(i) <= 0);
                    if (li <= 0) return null;
                    return <line x1={X(li)} y1={0} x2={X(li)} y2={H} stroke="var(--t-critical)" strokeWidth="1" strokeDasharray="2 2" opacity="0.6" />;
                })()}
                {gapMarks.map((x, k) => (
                    <line key={`gap-${k}`} x1={x} y1={0} x2={x} y2={H} stroke="var(--t-text-4)" strokeWidth="1" strokeDasharray="2 3" opacity="0.45" />
                ))}
                <line
                    x1={0}
                    y1={yOf(4)}
                    x2={W}
                    y2={yOf(4)}
                    stroke="var(--t-text-4)"
                    strokeWidth="0.75"
                    strokeDasharray="2 3"
                />
                {scrubIdx != null && <line x1={X(scrubIdx)} y1={0} x2={X(scrubIdx)} y2={H} stroke="var(--t-accent)" strokeWidth="1.25" opacity="0.85" />}
                {hover != null && <line x1={X(hover)} y1={0} x2={X(hover)} y2={H} stroke="var(--t-accent)" strokeWidth="0.75" opacity="0.6" />}
            </svg>
            <div style={{ position: 'absolute', left: 4, top: 3, fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '0.12em', color: 'var(--t-text-4)', pointerEvents: 'none' }}>
                LOCK ≥4
            </div>
            {hover != null &&
                pts[hover] &&
                (() => {
                    const s = stateOf(valAt(hover));
                    const lbl = s === 'critical' ? 'NO FIX' : s === 'warn' ? 'MARGINAL' : 'LOCK';
                    return (
                        <Tip
                            xFrac={X(hover) / W}
                            lines={
                                <>
                                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600 }}>
                                        {valAt(hover)} sats <span style={{ opacity: 0.6, marginLeft: 2 }}>- {lbl}</span>
                                    </div>
                                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.08em', opacity: 0.6, marginTop: 1 }}>
                                        {stamp(times[pts[hover].src])}
                                    </div>
                                </>
                            }
                        />
                    );
                })()}
        </div>
    );
}

function TrendArrow({ dir, color }: { dir: 'flat' | 'up' | 'down'; color: string }) {
    return (
        <FontAwesomeIcon icon={dir === 'flat' ? faMinus : dir === 'up' ? faCaretUp : faCaretDown} style={{ width: 9, height: 9, color }} aria-hidden />
    );
}

export function SignalTrendRow({
    label,
    unit,
    value,
    series,
    times,
    target,
    dir,
    fmtFn,
    scrubT = null,
    recent = 30,
}: {
    label: string;
    unit: string;
    value: string;
    series: (number | null)[];
    times: number[];
    target: number;
    dir: 'high' | 'low';
    fmtFn: (v: number) => string;
    scrubT?: number | null;
    recent?: number;
}) {
    const W = 300;
    const H = 40;
    const [hover, setHover] = useState<number | null>(null);
    const numeric = useMemo(() => series.filter((v): v is number => v != null), [series]);
    const tail = useMemo(() => numeric.slice(-recent), [numeric, recent]);
    const { pts, segments, X, gapMarks } = useMemo(() => buildWarpedAxis(times, W, 90), [times]);
    const scrubIdx = scrubIndex(pts, times, scrubT);
    if (numeric.length < 2 || pts.length < 2) {
        return <div className="mono" style={{ fontSize: 10, color: 'var(--t-text-3)', padding: '8px 0' }}>-</div>;
    }
    const filled = series.map((v) => (v == null ? numeric[0] : v)) as number[];
    const valAt = (i: number) => filled[pts[i].src];
    const dataLo = Math.min(...numeric);
    const dataHi = Math.max(...numeric);
    let a = Math.min(dataLo, target);
    let b = Math.max(dataHi, target);
    const pad = (b - a) * 0.18 || 1;
    a -= pad;
    b += pad;
    const span = b - a || 1;
    const Y = (v: number) => H - ((v - a) / span) * H;
    const line = segments
        .map((seg) => seg.map((idx, k) => `${k === 0 ? 'M' : 'L'}${X(idx).toFixed(1)} ${Y(valAt(idx)).toFixed(1)}`).join(' '))
        .join(' ');
    /* Trend badge from the recent tail. */
    const slope = tail.length >= 2 ? tail[tail.length - 1] - tail[0] : 0;
    const flat = Math.abs(slope) < span * 0.1;
    const improving = dir === 'high' ? slope > 0 : slope < 0;
    const tDir = flat ? 'flat' : improving ? 'up' : 'down';
    const tWord = flat ? 'Holding' : improving ? 'Improving' : 'Worsening';
    const tCol = flat ? 'var(--t-text-3)' : improving ? 'var(--t-nominal)' : 'var(--t-warn)';
    const yT = Y(target);
    const goodTop = dir === 'high' ? 0 : yT;
    const goodH = dir === 'high' ? yT : H - yT;

    return (
        <div style={{ padding: '13px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, whiteSpace: 'nowrap', minWidth: 0 }}>
                    <span className="eyebrow" style={{ color: 'var(--t-text-2)' }}>
                        {label}
                    </span>
                    <span className="eyebrow" style={{ color: 'var(--t-text-4)', fontSize: 9 }}>
                        {unit}
                    </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexShrink: 0 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <TrendArrow dir={tDir} color={tCol} />
                        <span className="eyebrow" style={{ fontSize: 9, color: tCol, fontWeight: 600 }}>
                            {tWord}
                        </span>
                    </span>
                    <span className="mono" style={{ fontSize: 14, fontWeight: 600, color: 'var(--t-text-2)', fontVariantNumeric: 'tabular-nums' }}>
                        {value}
                    </span>
                </div>
            </div>
            <div className="t-chart" style={{ position: 'relative', width: '100%' }}>
                <svg
                    viewBox={`0 0 ${W} ${H}`}
                    preserveAspectRatio="none"
                    style={{ width: '100%', height: H, display: 'block' }}
                    onMouseLeave={() => setHover(null)}
                    onMouseMove={(e) => {
                        setHover(nearestIdxAt(e.clientX, e.currentTarget.getBoundingClientRect(), pts.length, X, W));
                    }}
                >
                    <rect x={0} y={goodTop} width={W} height={Math.max(0, goodH)} fill="var(--t-nominal-soft)" opacity="0.5" />
                    <line x1={0} y1={yT} x2={W} y2={yT} stroke="var(--t-nominal)" strokeWidth="0.75" strokeDasharray="3 3" opacity="0.55" />
                    {gapMarks.map((x, k) => (
                        <line key={`gap-${k}`} x1={x} y1={0} x2={x} y2={H} stroke="var(--t-text-4)" strokeWidth="1" strokeDasharray="2 3" opacity="0.45" />
                    ))}
                    <path d={line} fill="none" stroke="var(--t-text-3)" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
                    {scrubIdx != null && (
                        <line x1={X(scrubIdx)} y1={0} x2={X(scrubIdx)} y2={H} stroke="var(--t-accent)" strokeWidth="0.75" opacity="0.4" />
                    )}
                    {hover != null && <line x1={X(hover)} y1={0} x2={X(hover)} y2={H} stroke="var(--t-accent)" strokeWidth="0.75" opacity="0.5" />}
                </svg>
                {scrubIdx != null && <OverlayDot x={X(scrubIdx) / W} y={Y(valAt(scrubIdx)) / H} />}
                {hover != null && <OverlayDot x={X(hover) / W} y={Y(valAt(hover)) / H} size={5} ring={false} />}
                <div
                    style={{
                        position: 'absolute',
                        right: 3,
                        top: Math.max(0, yT - 12),
                        fontFamily: 'var(--font-mono)',
                        fontSize: 8.5,
                        color: 'var(--t-nominal)',
                        opacity: 0.85,
                        pointerEvents: 'none',
                        background: 'var(--t-panel)',
                        padding: '0 2px',
                    }}
                >
                    target {fmtFn(target)}
                </div>
            </div>
        </div>
    );
}

export { tlmFmt };

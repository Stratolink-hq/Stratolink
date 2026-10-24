export type TimelineHistories = readonly (readonly { t: number }[])[];

/** Histories are individually sorted. The fleet does not need a merged copy. */
export function historyRange(histories: TimelineHistories): { start: number; end: number } | null {
    let start = Infinity, end = -Infinity;
    for (const rows of histories) {
        if (!rows.length) continue;
        start = Math.min(start, rows[0].t);
        end = Math.max(end, rows[rows.length - 1].t);
    }
    return start === Infinity ? null : { start, end };
}

/** Strictly previous/next packet time across independently sorted histories. */
export function adjacentPacketTime(histories: TimelineHistories, time: number, direction: 'previous' | 'next'): number | null {
    let result: number | null = null;
    for (const rows of histories) {
        let low = 0, high = rows.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (direction === 'previous' ? rows[mid].t < time : rows[mid].t <= time) low = mid + 1;
            else high = mid;
        }
        const candidate = rows[direction === 'previous' ? low - 1 : low]?.t;
        if (candidate !== undefined) result = result === null ? candidate
            : direction === 'previous' ? Math.max(result, candidate) : Math.min(result, candidate);
    }
    return result;
}

export interface TimeSpan { start: number; end: number }

/** Sorted and merged; spans no more than `joinMs` apart become one. */
export function mergeSpans(spans: readonly TimeSpan[], joinMs = 0): TimeSpan[] {
    const merged: TimeSpan[] = [];
    for (const span of [...spans].filter(span => span.end >= span.start).sort((a, b) => a.start - b.start)) {
        const last = merged[merged.length - 1];
        if (last && span.start - last.end <= joinMs) last.end = Math.max(last.end, span.end);
        else merged.push({ ...span });
    }
    return merged;
}

/** Flights closer together than this read as one stretch of the timeline. */
const FLIGHT_JOIN_MS = 12 * 3_600_000;

/** When any balloon was flying: each from its launch (null = never left the
 *  ground, so bench soak doesn't count) to its last packet, or on to
 *  `liveUntil` for a GPS-dark balloon carried along its forecast. */
export function flightSpans(flights: ReadonlyArray<{ launchT: number | null; rows: readonly { t: number }[]; liveUntil?: number | null }>): TimeSpan[] {
    return mergeSpans(flights.flatMap(({ launchT, rows, liveUntil }) => launchT === null || !rows.length ? []
        : [{ start: launchT, end: Math.max(rows[rows.length - 1].t, liveUntil ?? -Infinity) }]), FLIGHT_JOIN_MS);
}

/** Space left between two spans on the rail, as a fraction of its width. */
const BREAK_FRAC = 0.015;
/** No span gets less of the rail than this, so a short flight beside a long one stays seekable. */
const MIN_SPAN_SHARE = 0.15;

/** A span and where it sits on the rail (fractions of its width). */
export interface RailSpan extends TimeSpan { from: number; to: number }

export interface Rail {
    spans: RailSpan[];
    /** 0..1 along the rail. A time between spans sits at the next span's start. */
    toFrac(time: number): number;
    /** A point in a break resolves to the nearer span's edge. */
    toTime(frac: number): number;
    /** A time between spans moves to the edge of the span in `direction`. */
    snap(time: number, direction: 'previous' | 'next'): number;
}

/** Maps time onto a scrubber that covers only `spans` (sorted, disjoint, at
 *  least one), with a short break between each. Time runs linearly within a
 *  span; each span's share of the rail follows its duration, with a floor. */
export function createRail(spans: readonly TimeSpan[]): Rail {
    const usable = 1 - (spans.length - 1) * BREAK_FRAC;
    /* Shares by duration; any below the floor are pinned to it and the rest re-split. */
    const floor = Math.min(MIN_SPAN_SHARE, 1 / spans.length);
    const pinned = new Set<number>();
    let shares: number[] = [];
    for (;;) {
        const free = spans.reduce((sum, span, i) => pinned.has(i) ? sum : sum + span.end - span.start, 0);
        const freeCount = spans.length - pinned.size;
        shares = spans.map((span, i) => pinned.has(i) ? floor
            : (1 - floor * pinned.size) * (free > 0 ? (span.end - span.start) / free : 1 / freeCount));
        const short = shares.findIndex((share, i) => !pinned.has(i) && share < floor);
        if (short < 0) break;
        pinned.add(short);
    }
    let x = 0;
    const railSpans: RailSpan[] = spans.map((span, i) => {
        const from = x;
        x += shares[i] * usable;
        const railSpan = { ...span, from, to: x };
        x += BREAK_FRAC;
        return railSpan;
    });
    railSpans[railSpans.length - 1].to = 1;

    return {
        spans: railSpans,
        toFrac(time) {
            for (const span of railSpans) {
                if (time > span.end) continue;
                if (time <= span.start) return span.from;
                return span.from + (span.to - span.from) * (time - span.start) / (span.end - span.start);
            }
            return 1;
        },
        toTime(frac) {
            for (let i = 0; i < railSpans.length; i++) {
                const span = railSpans[i];
                if (frac > span.to) continue;
                if (frac < span.from) {
                    const previous = railSpans[i - 1];
                    return previous && frac - previous.to < span.from - frac ? previous.end : span.start;
                }
                return span.start + (span.end - span.start) * (frac - span.from) / ((span.to - span.from) || 1);
            }
            return railSpans[railSpans.length - 1].end;
        },
        snap(time, direction) {
            for (let i = 0; i < railSpans.length; i++) {
                const span = railSpans[i];
                if (time < span.start) return direction === 'next' || i === 0 ? span.start : railSpans[i - 1].end;
                if (time <= span.end) return time;
            }
            return railSpans[railSpans.length - 1].end;
        },
    };
}

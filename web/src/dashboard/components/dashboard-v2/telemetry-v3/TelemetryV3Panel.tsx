import { balloonColor } from '../FleetOverview';
import BalloonActions from '../BalloonActions';
import { useEffect, useMemo, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
    faArrowUp,
    faBolt,
    faCircle,
    faMoon,
    faSolarPanel,
    faSun,
} from '@fortawesome/free-solid-svg-icons';
import { fmt, type TelemetryRow } from '@/components/dashboard-v2/atoms';
import type { DeviceSummary } from '@/components/dashboard-v2/useTelemetry';
import {
    buildFlightSeries,
    computePayloadAttitude,
} from '@/lib/telemetry/flightSeries';
import { relTime, stamp, tlmFmt, type StatusLevel } from '@/lib/telemetry/telemetryV3Format';
import { useGatewayPoints } from '@/lib/gateways/data';
import { haversineKm } from '@/lib/gateways/range';
import { LineTrend } from './charts';
import { Divider, DOT, Group } from './primitives';
import { OfficialBadge, BalloonOwner } from '../BalloonIdentity';
import { balloonName } from '@/lib/telemetry/fleetPlayback';
import { useUnits } from '../dashboard-units';

type FlightSummary = { durationMs: number | null; distanceKm: number };

export type TelemetryV3PanelProps = {
    device: DeviceSummary | null;
    devices: DeviceSummary[];
    onSelect: (id: string) => void;
    scrubRow: TelemetryRow | null;
    /** The scrub time itself (scrubRow is the packet at or before it) — the
     *  chart markers sit here so a drag moves them with the pointer. */
    scrubT?: number | null;
    summary: FlightSummary;
    rows: TelemetryRow[];
    /** True when there's no live reading at the cursor — out in the forecast,
     *  or sitting in a transmission gap. Point-in-time readings are blanked. */
    isFuture?: boolean;
    /** Recorded data that must not be presented as an active transmission. */
    recordedHistory?: boolean;
    /** Controls which slices of the panel render. 'full' (default, desktop)
     *  shows everything. On mobile the panel is split: 'summary' is the
     *  always-visible top block (brand, device, top-level metrics, link
     *  status) and 'charts' is the pull-up drawer (chart sections + footer,
     *  no header). */
    variant?: 'full' | 'summary' | 'charts';
    /** When set, clicking a time-series chart scrubs to that time. */
    onPickTime?: (t: number) => void;
    /** True while a chart drag is driving the scrub time. */
    onScrubbingChange?: (active: boolean) => void;
};

/** Live-updating "time since last contact", value only (for a key metric). */
function LastContactValue({ lastContactT }: { lastContactT: number | null }) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 3000);
        return () => clearInterval(id);
    }, []);
    if (lastContactT == null) return <>-</>;
    return <>{relTime(Math.max(0, now - lastContactT))}</>;
}

/** Header status — a quiet dot + label, not a button/chip. */
function HeaderStatus({ color, label }: { color: string; label: string }) {
    return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <FontAwesomeIcon icon={faCircle} style={{ width: 5, height: 5, color, flexShrink: 0 }} aria-hidden />
            <span className="eyebrow" style={{ color: 'var(--t-text-2)', fontSize: 9.5 }}>{label}</span>
        </span>
    );
}

/* Four readings per row. Columns size to their content and share the spare
 * width between them, so a wide value (e.g. "53,474 lux") claims room from
 * narrow neighbours instead of spilling into the next column. */
const METRIC_ROW: React.CSSProperties = {
    display: 'grid', gridTemplateColumns: 'repeat(4, auto)', justifyContent: 'space-between', columnGap: 8, padding: '10px 0',
};

/** "1,626" below 10k lux, "53.5k" / "112k" above — full sun needs no finer
 * grain, and the short form keeps the four-up row from overflowing. */
function fmtLux(lux: number): string {
    if (lux < 10_000) return Math.round(lux).toLocaleString('en-US');
    return `${(lux / 1000).toFixed(lux < 100_000 ? 1 : 0)}k`;
}

/** A single key metric, shown plainly (no box): small label over a big value,
 * optionally preceded by a small icon. With `onSelect` it is a toggle that
 * charts the metric's history in the panel's trend slot. */
function Metric({ label, value, unit, icon, active = false, onSelect }: {
    label: string; value: React.ReactNode; unit?: string; icon?: React.ReactNode;
    active?: boolean; onSelect?: () => void;
}) {
    const Tag = onSelect ? 'button' : 'div';
    return (
        <Tag
            {...(onSelect ? { type: 'button' as const, className: 'tlm-metric', 'aria-pressed': active, onClick: onSelect } : {})}
            style={{ minWidth: 0 }}
        >
            <div className="eyebrow" style={{ color: active ? 'var(--t-accent)' : 'var(--t-text-3)', marginBottom: 5, fontSize: 9, whiteSpace: 'nowrap' }}>
                {label}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {icon}
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                    <span className="disp mono" style={{ fontSize: 19, fontWeight: 600, color: 'var(--t-text)', letterSpacing: '-0.01em', lineHeight: 1, whiteSpace: 'nowrap' }}>
                        {value}
                    </span>
                    {unit && <span className="mono" style={{ fontSize: 11, color: 'var(--t-text-3)' }}>{unit}</span>}
                </div>
            </div>
        </Tag>
    );
}

/** Readings the trend slot can chart; temperature is the default. */
type ChartKey = 'temp' | 'pres' | 'spd' | 'hdg' | 'batt' | 'solar' | 'lux' | 'tilt' | 'gw' | 'sats' | 'rssi' | 'snr';
const CHART_TITLES: Record<ChartKey, string> = {
    temp: 'Temperature', pres: 'Pressure', spd: 'Ground speed', hdg: 'Heading',
    batt: 'Storage', solar: 'Solar', lux: 'Ambient', tilt: 'Orientation',
    gw: 'Gateways', sats: 'GPS sats', rssi: 'RSSI', snr: 'SNR',
};

/** Sun (warming with brightness) by day, moon at night — relates lux to phase. */
function DaylightIcon({ lux }: { lux: number }) {
    if (lux < 10) {
        return (
            <FontAwesomeIcon icon={faMoon} style={{ width: 14, height: 14, color: 'var(--t-text-3)', flexShrink: 0 }} aria-hidden />
        );
    }
    const col = lux < 200 ? '#5C6B7A' : lux < 5000 ? '#9A7B3C' : lux < 25000 ? '#C9922E' : '#E8B020';
    return (
        <FontAwesomeIcon icon={faSun} style={{ width: 14, height: 14, color: col, flexShrink: 0 }} aria-hidden />
    );
}

/** Small solar-panel glyph — amber when the array is generating. */
function SolarIcon({ color }: { color: string }) {
    return (
        <FontAwesomeIcon icon={faSolarPanel} style={{ width: 15, height: 13, color, flexShrink: 0 }} aria-hidden />
    );
}

/** Tiny payload-tilt indicator: a mast leaning from vertical by `deg`. */
function TiltIcon({ deg, color }: { deg: number; color: string }) {
    const d = Math.max(-80, Math.min(80, deg));
    return (
        <FontAwesomeIcon icon={faArrowUp} style={{ width: 14, height: 14, color, flexShrink: 0, transform: `rotate(${d}deg)` }} aria-hidden />
    );
}

export default function TelemetryV3Panel({ device, devices, onSelect, scrubRow, scrubT = null, summary, rows, isFuture = false, variant = 'full', onPickTime, onScrubbingChange }: TelemetryV3PanelProps) {
    const showHeader = variant !== 'charts';
    const showBody = variant !== 'summary';
    /* The mobile summary header is tightened vertically — it's the only thing
     * visible above the map, so it earns its space. */
    const compact = variant === 'summary';
    const flight = useMemo(() => buildFlightSeries(rows), [rows]);
    const u = useUnits();

    /* Point-in-time readings: blanked when scrubbed past the last transmission
     * (there's no telemetry out in the forecast). */
    const row = isFuture ? null : scrubRow;
    const altVal = row?.presAlt;
    const batt = row?.batt;
    const solar = row?.sol;
    const lux = row?.lux ?? null;
    const rssi = row?.rssi;
    const snr = row?.snr;
    const gwNow = row?.gateways?.length ?? null;
    /* GPS speed arrives in m/s; the panel (and `flight.speed`) show km/h. */
    const speedKmh = row?.spd != null ? row.spd * 3.6 : null;

    /* How many known gateways are within a fixed 150 km radius of the balloon's
     * current position (matches the 150 km coverage rings on the map). */
    const gatewayPoints = useGatewayPoints();
    const gwVisible = useMemo(() => {
        const la = row?.lat ?? null;
        const lo = row?.lon ?? null;
        if (la == null || lo == null || !gatewayPoints.length) return null;
        let n = 0;
        for (const g of gatewayPoints) if (haversineKm(la, lo, g.lat, g.lon) <= 150) n++;
        return n;
    }, [row, gatewayPoints]);

    const payloadAttitude = useMemo(
        () => (row ? computePayloadAttitude(row.ax, row.ay, row.az) : null),
        [row],
    );
    const tilt = payloadAttitude?.tiltDeg ?? null;
    const tiltReliable = payloadAttitude?.reliable ?? false;
    const tiltCol = tilt == null || !tiltReliable ? 'var(--t-text-3)' : tilt < 15 ? 'var(--t-nominal)' : tilt < 35 ? 'var(--t-warn)' : 'var(--t-critical)';

    /* Tapping a reading charts its history in the trend slot below altitude;
     * the lit tile is the one being charted. Tapping it again returns to
     * temperature, which has a tile of its own so it is never hidden. */
    const [chartKey, setChartKey] = useState<ChartKey>('temp');
    const toggleChart = (key: ChartKey) => setChartKey(current => (current === key ? 'temp' : key));
    const tiltSeries = useMemo(() => rows.map(r => computePayloadAttitude(r.ax, r.ay, r.az)?.tiltDeg ?? null), [rows]);
    const chart = ({
        temp: { series: flight.temp, value: row?.temp ?? null, fmtFn: (v: number) => tlmFmt.d1(u.temperature(v)), unit: u.labels.temperature },
        pres: { series: flight.press, value: row?.pres ?? null, fmtFn: (v: number) => tlmFmt.d1(v), unit: 'hPa' },
        spd: { series: flight.speed, value: speedKmh, fmtFn: (v: number) => tlmFmt.int(u.speed(v)), unit: u.labels.speed },
        hdg: { series: flight.heading, value: row?.hdg ?? null, fmtFn: (v: number) => `${Math.round(v)}°`, unit: '' },
        batt: { series: flight.batt, value: batt ?? null, fmtFn: (v: number) => tlmFmt.d2(v), unit: 'V' },
        solar: { series: flight.solar, value: solar ?? null, fmtFn: (v: number) => tlmFmt.d2(v), unit: 'V' },
        lux: { series: flight.lux, value: lux, fmtFn: fmtLux, unit: 'lux' },
        tilt: { series: tiltSeries, value: tilt, fmtFn: (v: number) => `${Math.round(v)}°`, unit: '' },
        gw: { series: flight.gw, value: gwNow, fmtFn: (v: number) => tlmFmt.int(v), unit: '' },
        sats: { series: flight.sats, value: row?.sats ?? null, fmtFn: (v: number) => tlmFmt.int(v), unit: '' },
        rssi: { series: flight.rssi, value: rssi ?? null, fmtFn: (v: number) => tlmFmt.int(v), unit: 'dBm' },
        snr: { series: flight.snr, value: snr ?? null, fmtFn: (v: number) => tlmFmt.d1(v), unit: 'dB' },
    } satisfies Record<ChartKey, { series: (number | null)[]; value: number | null; fmtFn: (v: number) => string; unit: string }>)[chartKey];
    const select = (key: ChartKey) => ({ active: chartKey === key, onSelect: () => toggleChart(key) });


    const altStatus: StatusLevel =
        altVal == null ? 'critical' : altVal >= 8500 && altVal <= 12000 ? 'nominal' : 'warn';

    /* No usable series yet (brand-new or pre-launch device). The HEADER must
     * still render — it holds the balloon selector, and replacing the whole
     * panel stranded users on a data-less device with no way to switch. Only
     * the chart body gives way to the note. */
    const awaiting = rows.length < 2;

    return (
        <>
            {showHeader && (
            <div style={{ borderBottom: compact ? undefined : '1px solid var(--t-border)', flexShrink: 0 }}>
                <div className="dashboard-device-heading"><h1 className="dashboard-device-title">{device ? balloonName(device) : 'Balloon'} <OfficialBadge official={device?.official} /></h1>{device && <BalloonActions deviceId={device.id} />}</div>
                <div className="balloon-byline detail-byline">
                    {device && <BalloonOwner device={device} />}
                    {device?.status && <HeaderStatus color={balloonColor(device.id)} label={String(device.status)} />}
                </div>
                <div
                    style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(72px, 1fr))',
                        gap: compact ? '10px 18px' : '16px 18px',
                        padding: compact ? '11px var(--telemetry-gutter, 18px) 10px' : '16px var(--telemetry-gutter, 18px) 12px',
                    }}
                >
                    <Metric label="Flight time" value={summary.durationMs != null ? fmt.duration(summary.durationMs) : '-'} />
                    <Metric label="Total dist" value={tlmFmt.int(u.distance(summary.distanceKm))} unit={u.labels.distance} />
                    <Metric label="Last contact" value={<LastContactValue lastContactT={device?.lastContactT ?? null} />} />
                </div>

            </div>
            )}

            {awaiting && (
                <div style={{ padding: '24px var(--telemetry-gutter, 18px)', color: 'var(--t-text-3)', fontSize: 12 }} className="mono">
                    Awaiting telemetry packets...
                </div>
            )}

            {showBody && !awaiting && (
            <>
            <Group
                index="01"
                title="Flight path"
                gkey="flight"
            >
                <div style={{ padding: '9px 0' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                        <span className="eyebrow" style={{ color: 'var(--t-text-2)' }}>
                            Altitude <span style={{ color: 'var(--t-text-4)', fontSize: 9 }}>pres</span>
                        </span>
                        <span className="disp mono" style={{ fontSize: 22, fontWeight: 600 }}>
                            {tlmFmt.int(u.altitude(altVal) ?? null)}
                            {altVal != null && <span className="mono" style={{ fontSize: 11, fontWeight: 500, color: 'var(--t-text-3)', marginLeft: 3 }}>{u.labels.altitude}</span>}
                        </span>
                    </div>
                    <LineTrend
                        series={flight.altPres}
                        times={flight.times}
                        band={[8500, 12000]}
                        status={altStatus}
                        fmtFn={(v) => tlmFmt.int(u.altitude(v))}
                        unit={u.labels.altitude}
                        height={58}
                        scrubT={scrubT ?? scrubRow?.t ?? null}
                        onPickTime={onPickTime}
                        onScrubbingChange={onScrubbingChange}
                    />
                </div>
                <Divider />
                <div style={{ padding: '9px 0' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                        <span className="eyebrow" style={{ color: 'var(--t-text-2)' }}>
                            {CHART_TITLES[chartKey]}
                        </span>
                        <span className="disp mono" style={{ fontSize: 22, fontWeight: 600 }}>
                            {chart.value != null ? chart.fmtFn(chart.value) : '-'}
                            {chart.value != null && chart.unit && <span className="mono" style={{ fontSize: 11, fontWeight: 500, color: 'var(--t-text-3)', marginLeft: 3 }}>{chart.unit}</span>}
                        </span>
                    </div>
                    <LineTrend key={chartKey} series={chart.series} times={flight.times} status="nominal" fmtFn={chart.fmtFn} unit={chart.unit} height={44} scrubT={scrubT ?? scrubRow?.t ?? null} onPickTime={onPickTime} onScrubbingChange={onScrubbingChange} />
                </div>
                <Divider />
                <div style={METRIC_ROW}>
                    <Metric label="Temperature" {...select('temp')} value={tlmFmt.d1(u.temperature(row?.temp ?? null))} unit={row?.temp != null ? u.labels.temperature : undefined} />
                    <Metric label="Pressure" {...select('pres')} value={row?.pres != null ? tlmFmt.d1(row.pres) : '-'} unit={row?.pres != null ? 'hPa' : undefined} />
                    <Metric label="Speed" {...select('spd')} value={tlmFmt.int(u.speed(speedKmh))} unit={speedKmh != null ? u.labels.speed : undefined} />
                    <Metric label="Heading" {...select('hdg')} value={row?.hdg != null ? `${Math.round(row.hdg)}°` : '-'} />
                </div>
            </Group>

            <Group
                index="02"
                title="Power & sun"
                gkey="power"
            >
                <div style={METRIC_ROW}>
                    <Metric
                        label="Storage"
                        {...select('batt')}
                        value={batt != null ? tlmFmt.d2(batt) : '-'}
                        unit={batt != null ? 'V' : undefined}
                        icon={batt != null ? <FontAwesomeIcon icon={faBolt} style={{ width: 11, height: 13, color: 'var(--t-text-3)' }} aria-hidden /> : undefined}
                    />
                    <Metric
                        label="Solar"
                        {...select('solar')}
                        value={solar != null ? tlmFmt.d2(solar) : '-'}
                        unit={solar != null ? 'V' : undefined}
                        icon={solar != null ? <SolarIcon color={solar >= 1 ? '#C9922E' : 'var(--t-text-3)'} /> : undefined}
                    />
                    <Metric
                        label="Ambient"
                        {...select('lux')}
                        value={lux != null ? fmtLux(lux) : '-'}
                        unit={lux != null ? 'lux' : undefined}
                        icon={lux != null ? <DaylightIcon lux={lux} /> : undefined}
                    />
                    <Metric
                        label="Orientation"
                        {...select('tilt')}
                        value={tilt != null ? `${Math.round(tilt)}°` : '-'}
                        icon={tilt != null ? <TiltIcon deg={tilt} color={tiltCol} /> : undefined}
                    />
                </div>
            </Group>

            <Group
                index="03"
                title="Link"
                gkey="link"
            >
                <div style={METRIC_ROW}>
                    <Metric label="Gateways" {...select('gw')} value={gwNow != null ? `${gwNow}` : '-'} unit={gwVisible != null ? `/ ${gwVisible}` : undefined} />
                    <Metric label="GPS sats" {...select('sats')} value={row?.sats != null ? `${row.sats}` : '-'} />
                    <Metric label="RSSI" {...select('rssi')} value={rssi != null ? tlmFmt.int(rssi) : '-'} unit={rssi != null ? 'dBm' : undefined} />
                    <Metric label="SNR" {...select('snr')} value={snr != null ? tlmFmt.d1(snr) : '-'} unit={snr != null ? 'dB' : undefined} />
                </div>
            </Group>


            {flight.times.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px var(--telemetry-gutter, 18px) 8px', flexShrink: 0 }}>
                    <span className="mono" style={{ fontSize: 9.5, color: 'var(--t-text-4)' }}>
                        {stamp(flight.times[0])}
                    </span>
                    <span className="eyebrow" style={{ color: 'var(--t-text-4)', fontSize: 9 }}>
                        {rows.length} packets
                    </span>
                    <span className="mono" style={{ fontSize: 9.5, color: 'var(--t-text-4)' }}>
                        {stamp(flight.times[flight.times.length - 1])}
                    </span>
                </div>
            )}
            </>
            )}
        </>
    );
}

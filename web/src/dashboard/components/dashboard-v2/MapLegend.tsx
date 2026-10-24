import { useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown } from '@fortawesome/free-solid-svg-icons';
import { useDashboardControls } from './dashboard-controls';
import { useUnits } from './dashboard-units';
import { ESTIMATED_COLOR } from './shared';

/* Keep legend rows stable while scrubbing and remember the browser's expanded state. */
export default function MapLegend({ hasForecast, hasHindcast, hasEstimated, hasEstimate = false, hasGateways, colorScheme, fleet = false }: { fleet?: boolean; hasForecast: boolean; hasHindcast: boolean; hasEstimated: boolean; /** A fleet balloon is drawn at an estimated position. */ hasEstimate?: boolean; hasGateways: boolean; colorScheme: 'light' | 'dark' }) {
    const { showGateways, showReceivingStations, showFlightTrail, showProjectedPath } = useDashboardControls();
    const showFlightPaths = showFlightTrail && !fleet;
    const u = useUnits();
    const range = (km: number) => `${Math.round(u.distance(km))} ${u.labels.distance}`;
    /* Swatch colors mirror the actual map layers, which shift with the basemap
     * (see V2MissionMap `C` + GatewayLayer COVERAGE_STYLE). */
    const dark = colorScheme === 'dark';
    const L = {
        path: dark ? '#ff5b1f' : '#a11515',
        forecast: dark ? '#5ba8ff' : '#08327d',
        dotCore: dark ? '#e8eaee' : '#fcfcfb',
        receiver: '#7a9b76',
        receiverRing: dark ? 'rgba(255,255,255,0.85)' : '#fcfcfb',
        covFill: dark ? 'rgba(74,140,150,0.20)' : 'rgba(90,92,98,0.10)',
        covStroke: dark ? 'rgba(110,180,190,0.55)' : 'rgba(90,92,98,0.55)',
        sightLine: dark ? 'rgba(110,180,190,0.5)' : 'rgba(90,92,98,0.6)',
    };
    const [expanded, setExpanded] = useState(() => {
        try { return localStorage.getItem('stratolink-dashboard-key-expanded') === 'true'; }
        catch { return false; }
    });
    const toggleExpanded = () => {
        const next = !expanded;
        setExpanded(next);
        try { localStorage.setItem('stratolink-dashboard-key-expanded', String(next)); }
        catch { /* The key still works when browser storage is unavailable. */ }
    };

    /* Swatch primitives — kept visually consistent so labels align. */
    const lineSwatch = (color: string, dashed = false, w = 18) => (
        <span style={{ display: 'inline-block', width: w, height: 0, borderTop: `${dashed ? '1.5px dashed' : '2px solid'} ${color}` }} />
    );
    const boxSwatch = (fill: string, stroke: string) => (
        <span style={{ display: 'inline-block', width: 15, height: 9, background: fill, border: `1px solid ${stroke}` }} />
    );

    return (
        <div className="map-legend" data-expanded={expanded}>
            {/* title bar */}
            <button
                type="button"
                onClick={toggleExpanded}
                aria-expanded={expanded}
                className="map-legend-toggle"
            >
                <span>Key</span>
                <FontAwesomeIcon icon={faChevronDown} className="map-legend-chevron" />
            </button>

            <div className="map-legend-reveal" aria-hidden={!expanded}>
                <div className="map-legend-clip">
                <div className="map-legend-body">
                    {fleet && <LegendRow
                        swatch={<span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#476f83', border: `1.5px solid ${L.dotCore}` }} />}
                        label="balloon"
                    />}
                    {fleet && showFlightTrail && <LegendRow swatch={<span style={{ width: 18, height: 2, background: 'linear-gradient(to right, transparent, #476f83)' }} />} label="flight tail" />}
                    {showFlightPaths && <>
                    <LegendHeading>Flight path</LegendHeading>
                    <LegendRow
                        swatch={<span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: L.dotCore, border: `1.5px solid ${L.path}` }} />}
                        label="transmitted"
                    />
                    {hasHindcast && <LegendRow swatch={lineSwatch(L.path)} label="path" />}
                    {hasEstimated && <LegendRow swatch={lineSwatch(L.path, true)} label="estimated" />}


                    </>}
                    {showProjectedPath && fleet && hasEstimate && <LegendRow swatch={lineSwatch(ESTIMATED_COLOR, true)} label="estimated path" />}
                    {showProjectedPath && !fleet && hasForecast && <LegendRow swatch={lineSwatch(L.forecast, true)} label="projected path" />}
                    {(showGateways || showReceivingStations) && <>
                    <LegendHeading style={{ marginTop: showFlightPaths || showProjectedPath || fleet ? 10 : 0 }}>Gateways</LegendHeading>
                    {hasGateways && showReceivingStations && (
                        <LegendRow
                            swatch={<span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: L.receiver, border: `1px solid ${L.receiverRing}` }} />}
                            label="receiver"
                        />
                    )}
                    {showReceivingStations && hasGateways && <LegendRow swatch={lineSwatch(L.sightLine)} label="reception link" />}
                    {showGateways && <LegendRow swatch={boxSwatch(L.covFill, L.covStroke)} label={`${range(150)} - in range`} />}
                    {showGateways && <LegendRow swatch={lineSwatch(L.sightLine, true, 15)} label={`${range(250)} - sightline`} />}
                    </>}
                    {!fleet && !showGateways && !showReceivingStations && !showFlightPaths && !showProjectedPath && <span>No layers selected</span>}
                </div>
                </div>
            </div>
        </div>
    );
}

function LegendHeading({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
    return (
        <div style={{
            fontSize: 8.5, letterSpacing: '0.16em', textTransform: 'uppercase',
            color: 'var(--sl-text-dim3)', fontWeight: 600, marginBottom: 6, ...style,
        }}>
            {children}
        </div>
    );
}

/* Typeset key row — fixed swatch column so all labels align. */
function LegendRow({ swatch, label }: { swatch: React.ReactNode; label: string }) {
    return (
        <div style={{ display: 'grid', gridTemplateColumns: '20px 1fr', alignItems: 'center', columnGap: 9, height: 18 }}>
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{swatch}</span>
            <span style={{ color: 'var(--sl-text-dim)', letterSpacing: '0.01em' }}>{label}</span>
        </div>
    );
}

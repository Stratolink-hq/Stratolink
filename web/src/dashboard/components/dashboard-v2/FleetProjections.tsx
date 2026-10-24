import { useEffect, useMemo, useState } from 'react';
import { Layer, Source } from 'react-map-gl/mapbox';
import type { Feature, FeatureCollection, LineString } from 'geojson';
import { forecastRequests, type ForecastData } from '@/lib/telemetry/forecastRequests';
import { forecastTimes, type ForecastLegs } from '@/lib/telemetry/forecastTrack';
import { unwrapLngs } from '@/lib/telemetry/flightTail';
import { cleanPath } from './useForecastPath';
import { ESTIMATED_COLOR } from './shared';

function forecastLegs(data: ForecastData | null): ForecastLegs | null {
    const path = cleanPath(data?.nominal_path);
    if (path.length < 2) return null;
    return {
        path,
        predictedHindcast: cleanPath(data?.predicted_hindcast?.path),
        staleGps: Boolean(data?.stale_gps),
        ...forecastTimes(data?.forecast_origin?.time_utc, data?.forecast_horizon_h),
    };
}

/** The flying balloons' forecasts (the light `path` view), keyed by device.
 *  Requests stop for balloons that leave the list. */
export function useFleetForecasts(deviceIds: string[]): Record<string, ForecastLegs> {
    const [forecasts, setForecasts] = useState<Record<string, ForecastLegs>>({});
    const idsKey = JSON.stringify([...deviceIds].sort());
    useEffect(() => {
        const ids = JSON.parse(idsKey) as string[];
        setForecasts(current => Object.keys(current).every(id => ids.includes(id))
            ? current
            : Object.fromEntries(Object.entries(current).filter(([id]) => ids.includes(id))));
        const stops = ids.map(id => forecastRequests.watch(id, result => {
            if (result.status === 202) return;
            const legs = forecastLegs(result.data);
            setForecasts(current => {
                if (JSON.stringify(current[id] ?? null) === JSON.stringify(legs)) return current;
                const next = { ...current };
                if (legs) next[id] = legs;
                else delete next[id];
                return next;
            });
        }, false, 'path'));
        return () => stops.forEach(stop => stop());
    }, [idsKey]);
    return forecasts;
}

/** One map source for the fleet's estimated legs: from each GPS-dark balloon's
 *  last fix to where it is estimated to be now (or at the scrubbed time), in
 *  the estimate grey throughout (blue is kept for the forecast ahead). */
export function FleetProjections({ legs }: { legs: Array<{ drift: Array<[number, number]>; ahead: Array<[number, number]> }> }) {
    const data = useMemo<FeatureCollection<LineString>>(() => ({
        type: 'FeatureCollection',
        features: legs.flatMap(({ drift, ahead }): Feature<LineString>[] => {
            /* The two parts share their meeting vertex. */
            const coordinates = unwrapLngs([...drift, ...ahead.slice(drift.length ? 1 : 0)]);
            return coordinates.length >= 2
                ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } }]
                : [];
        }),
    }), [legs]);
    if (!data.features.length) return null;
    return <Source id="v2-fleet-projections" type="geojson" data={data}>
        <Layer id="v2-fleet-projections-line" type="line" layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': ESTIMATED_COLOR, 'line-width': 2, 'line-opacity': 0.8, 'line-dasharray': [2, 3] }} />
    </Source>;
}
